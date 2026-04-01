/**
 * Benchmark: SQLite vs Turso vs Hybrid search performance
 *
 * Measures:
 * - saveNote latency
 * - fullTextSearch latency
 * - getStats latency
 * - getRecentNotes latency
 *
 * Data sizes: 10, 100, 1000 notes
 * Adapters: SQLite (local FTS5), Turso (LIKE fallback), Hybrid (local read + cloud sync)
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { SQLiteAdapter } from "../storage/sqlite-adapter.js";
import { TursoAdapter } from "../storage/turso-adapter.js";
import { HybridAdapter } from "../storage/hybrid-adapter.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { StorageConfig } from "../storage/types.js";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// --- Config ---
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const DATA_SIZES = [10, 100, 1000];
const SEARCH_ITERATIONS = 20;
const TENANT_ID = "bench-tenant";

// Sample content for realistic data
const TOPICS = [
  "React", "TypeScript", "Node.js", "GraphQL", "REST API",
  "Docker", "Kubernetes", "AWS", "PostgreSQL", "Redis",
  "Next.js", "Tailwind CSS", "Prisma", "Vitest", "CI/CD",
  "WebSocket", "OAuth", "JWT", "SQLite", "Turso",
];

const SENTENCES = [
  "How do I implement authentication with {topic}?",
  "Best practices for {topic} in production environments",
  "Debugging {topic} performance issues in large-scale applications",
  "Migrating from legacy system to {topic} architecture",
  "Setting up {topic} with TypeScript and modern tooling",
  "Optimizing {topic} queries for better response times",
  "Implementing caching strategies with {topic}",
  "Error handling patterns in {topic} applications",
  "Testing strategies for {topic} integration",
  "Deploying {topic} services to cloud infrastructure",
];

function generateContent(index: number): string {
  const topic = TOPICS[index % TOPICS.length];
  const sentence = SENTENCES[index % SENTENCES.length];
  const base = sentence.replace("{topic}", topic);
  // Add some bulk to make content realistic (200-500 chars)
  return `${base}. This is note number ${index}. ` +
    `Keywords include ${topic.toLowerCase()}, development, engineering. ` +
    `Context: working on a SaaS project that requires ${topic} integration. ` +
    `Additional details about the implementation approach and considerations.`;
}

function generateKeywords(index: number): string[] {
  const topic = TOPICS[index % TOPICS.length];
  return [topic.toLowerCase(), "development", "engineering", `tag-${index % 10}`];
}

// --- Timing helpers ---
interface TimingResult {
  label: string;
  adapter: string;
  dataSize: number;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
}

function calcStats(times: number[]): { avg: number; min: number; max: number; p50: number; p95: number } {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    avg: times.reduce((a, b) => a + b, 0) / times.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
  };
}

async function timeOperation(fn: () => Promise<void>, iterations: number): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return times;
}

// --- Adapter factories ---
interface AdapterSetup {
  name: string;
  create: () => Promise<StorageAdapter>;
  cleanup: (adapter: StorageAdapter) => Promise<void>;
  skip?: boolean;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-bench-"));

const adapters: AdapterSetup[] = [
  {
    name: "SQLite (local)",
    create: async () => {
      const adapter = new SQLiteAdapter();
      await adapter.initialize({
        type: "sqlite",
        dbPath: path.join(tmpDir, `sqlite-${randomUUID()}.db`),
        tenantId: TENANT_ID,
      });
      return adapter;
    },
    cleanup: async (adapter) => adapter.close(),
  },
  {
    name: "Turso (cloud)",
    skip: !TURSO_URL || !TURSO_TOKEN,
    create: async () => {
      const adapter = new TursoAdapter();
      await adapter.initialize({
        type: "turso",
        tursoUrl: TURSO_URL,
        tursoAuthToken: TURSO_TOKEN,
        tenantId: TENANT_ID,
      });
      return adapter;
    },
    cleanup: async (adapter) => adapter.close(),
  },
  {
    name: "Hybrid (local+cloud)",
    skip: !TURSO_URL || !TURSO_TOKEN,
    create: async () => {
      const adapter = new HybridAdapter();
      await adapter.initialize({
        type: "hybrid",
        dbPath: path.join(tmpDir, `hybrid-${randomUUID()}.db`),
        tursoUrl: TURSO_URL,
        tursoAuthToken: TURSO_TOKEN,
        syncIntervalMs: 0, // disable timer, manual sync only
        syncOnWrite: false,
        tenantId: TENANT_ID,
      });
      return adapter;
    },
    cleanup: async (adapter) => adapter.close(),
  },
];

// --- Results collection ---
const allResults: TimingResult[] = [];

function recordResult(label: string, adapterName: string, dataSize: number, times: number[]) {
  const stats = calcStats(times);
  allResults.push({
    label,
    adapter: adapterName,
    dataSize,
    iterations: times.length,
    totalMs: times.reduce((a, b) => a + b, 0),
    avgMs: stats.avg,
    minMs: stats.min,
    maxMs: stats.max,
    p50Ms: stats.p50,
    p95Ms: stats.p95,
  });
}

// --- Benchmark suite ---
describe("Benchmark: SQLite vs Turso vs Hybrid", { timeout: 300_000 }, () => {
  afterAll(() => {
    // Print results table
    console.log("\n\n" + "=".repeat(100));
    console.log("BENCHMARK RESULTS");
    console.log("=".repeat(100));

    // Group by operation
    const operations = [...new Set(allResults.map(r => r.label))];
    for (const op of operations) {
      console.log(`\n--- ${op} ---`);
      console.log(
        "| Adapter".padEnd(22) +
        "| Data Size".padEnd(13) +
        "| Avg (ms)".padEnd(13) +
        "| P50 (ms)".padEnd(13) +
        "| P95 (ms)".padEnd(13) +
        "| Min (ms)".padEnd(13) +
        "| Max (ms)".padEnd(13) + "|"
      );
      console.log("|" + "-".repeat(21) + "|" + ("-".repeat(12) + "|").repeat(5) + "-".repeat(12) + "|");

      const rows = allResults.filter(r => r.label === op).sort((a, b) => a.dataSize - b.dataSize || a.adapter.localeCompare(b.adapter));
      for (const r of rows) {
        console.log(
          `| ${r.adapter}`.padEnd(22) +
          `| ${r.dataSize}`.padEnd(13) +
          `| ${r.avgMs.toFixed(2)}`.padEnd(13) +
          `| ${r.p50Ms.toFixed(2)}`.padEnd(13) +
          `| ${r.p95Ms.toFixed(2)}`.padEnd(13) +
          `| ${r.minMs.toFixed(2)}`.padEnd(13) +
          `| ${r.maxMs.toFixed(2)}`.padEnd(13) + "|"
        );
      }
    }

    // Write results to JSON
    const reportPath = path.join(tmpDir, "benchmark-results.json");
    fs.writeFileSync(reportPath, JSON.stringify(allResults, null, 2));
    console.log(`\nResults saved to: ${reportPath}`);

    // Cleanup tmp dir
    console.log(`Temp dir: ${tmpDir}`);
  });

  for (const setup of adapters) {
    const descFn = setup.skip ? describe.skip : describe;

    descFn(`${setup.name}`, () => {
      for (const dataSize of DATA_SIZES) {
        describe(`${dataSize} notes`, () => {
          let adapter: StorageAdapter;

          beforeAll(async () => {
            adapter = await setup.create();
            // Seed tenant
            await adapter.createTenant({ tenant_id: TENANT_ID, name: "Bench Tenant" });
            // Seed session
            await adapter.createSession({ session_id: "bench-session", tenant_id: TENANT_ID, project: "benchmark" });
          });

          afterAll(async () => {
            await setup.cleanup(adapter);
          });

          it(`saveNote x${dataSize}`, async () => {
            const times: number[] = [];
            for (let i = 0; i < dataSize; i++) {
              const start = performance.now();
              await adapter.saveNote({
                tenant_id: TENANT_ID,
                session_id: "bench-session",
                role: i % 2 === 0 ? "user" : "assistant",
                content: generateContent(i),
                keywords: generateKeywords(i),
                tags: ["benchmark"],
                importance: Math.random(),
              });
              times.push(performance.now() - start);
            }
            recordResult("saveNote", setup.name, dataSize, times);

            const stats = calcStats(times);
            console.log(`[${setup.name}] saveNote x${dataSize}: avg=${stats.avg.toFixed(2)}ms p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms`);
          });

          it(`fullTextSearch (exact keyword) x${SEARCH_ITERATIONS}`, async () => {
            const times = await timeOperation(async () => {
              await adapter.fullTextSearch("TypeScript", { tenant_id: TENANT_ID, limit: 10 });
            }, SEARCH_ITERATIONS);
            recordResult("fullTextSearch (keyword)", setup.name, dataSize, times);

            const stats = calcStats(times);
            console.log(`[${setup.name}] FTS keyword x${SEARCH_ITERATIONS} (${dataSize} notes): avg=${stats.avg.toFixed(2)}ms p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms`);
          });

          it(`fullTextSearch (phrase) x${SEARCH_ITERATIONS}`, async () => {
            const times = await timeOperation(async () => {
              await adapter.fullTextSearch("authentication production", { tenant_id: TENANT_ID, limit: 10 });
            }, SEARCH_ITERATIONS);
            recordResult("fullTextSearch (phrase)", setup.name, dataSize, times);

            const stats = calcStats(times);
            console.log(`[${setup.name}] FTS phrase x${SEARCH_ITERATIONS} (${dataSize} notes): avg=${stats.avg.toFixed(2)}ms p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms`);
          });

          it(`fullTextSearch (no match) x${SEARCH_ITERATIONS}`, async () => {
            const times = await timeOperation(async () => {
              await adapter.fullTextSearch("xyznonexistent", { tenant_id: TENANT_ID, limit: 10 });
            }, SEARCH_ITERATIONS);
            recordResult("fullTextSearch (no match)", setup.name, dataSize, times);

            const stats = calcStats(times);
            console.log(`[${setup.name}] FTS no-match x${SEARCH_ITERATIONS} (${dataSize} notes): avg=${stats.avg.toFixed(2)}ms p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms`);
          });

          it(`getStats x${SEARCH_ITERATIONS}`, async () => {
            const times = await timeOperation(async () => {
              await adapter.getStats(TENANT_ID);
            }, SEARCH_ITERATIONS);
            recordResult("getStats", setup.name, dataSize, times);

            const stats = calcStats(times);
            console.log(`[${setup.name}] getStats x${SEARCH_ITERATIONS} (${dataSize} notes): avg=${stats.avg.toFixed(2)}ms p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms`);
          });

          it(`getRecentNotes x${SEARCH_ITERATIONS}`, async () => {
            if (!adapter.getRecentNotes) return;
            const times = await timeOperation(async () => {
              await adapter.getRecentNotes!(TENANT_ID, 7, 20);
            }, SEARCH_ITERATIONS);
            recordResult("getRecentNotes", setup.name, dataSize, times);

            const stats = calcStats(times);
            console.log(`[${setup.name}] getRecentNotes x${SEARCH_ITERATIONS} (${dataSize} notes): avg=${stats.avg.toFixed(2)}ms p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms`);
          });

          it(`getTopKeywords x${SEARCH_ITERATIONS}`, async () => {
            const times = await timeOperation(async () => {
              await adapter.getTopKeywords(TENANT_ID, 10);
            }, SEARCH_ITERATIONS);
            recordResult("getTopKeywords", setup.name, dataSize, times);

            const stats = calcStats(times);
            console.log(`[${setup.name}] getTopKeywords x${SEARCH_ITERATIONS} (${dataSize} notes): avg=${stats.avg.toFixed(2)}ms p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms`);
          });
        });
      }
    });
  }
});
