import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SearchEngine } from "../search-engine.js";
import { SQLiteAdapter } from "../storage/sqlite-adapter.js";
import { NullEmbeddingClient, OpenAIEmbeddingClient } from "../embedding.js";
import type { StorageConfig } from "../storage/types.js";

describe("SearchEngine", () => {
  let adapter: SQLiteAdapter;
  let engine: SearchEngine;
  const tenantId = "test-tenant";

  describe("FTS-only mode (no embedding)", () => {
    beforeEach(async () => {
      adapter = new SQLiteAdapter();
      await adapter.initialize({
        type: "sqlite",
        dbPath: ":memory:",
        tenantId,
      });

      await adapter.createTenant({ tenant_id: tenantId, name: "Test" });

      const nullEmbedding = new NullEmbeddingClient();
      engine = new SearchEngine(adapter, nullEmbedding);

      // Seed test data
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "How to implement authentication with JWT tokens in Node.js",
        keywords: ["JWT", "authentication", "Node.js"],
        tags: ["backend", "security"],
      });
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content:
          "Here is how to implement JWT authentication. First install jsonwebtoken package.",
        keywords: ["JWT", "jsonwebtoken", "authentication"],
        tags: ["backend", "security"],
      });
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "How to set up a PostgreSQL database with TypeScript ORM",
        keywords: ["PostgreSQL", "TypeScript", "ORM", "database"],
        tags: ["backend", "database"],
      });
    });

    afterEach(async () => {
      await adapter.close();
    });

    it("should return FTS results when embedding is unavailable", async () => {
      const results = await engine.hybridSearch("JWT authentication", {
        tenant_id: tenantId,
      });

      expect(results.length).toBeGreaterThan(0);
      // Without vector search, results should be FTS type
      expect(results[0].match_type).toBe("fts");
    });

    it("should respect limit parameter", async () => {
      const results = await engine.hybridSearch("backend", {
        tenant_id: tenantId,
        limit: 1,
      });

      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("should return empty for non-matching query", async () => {
      const results = await engine.hybridSearch("quantum computing", {
        tenant_id: tenantId,
      });

      expect(results).toHaveLength(0);
    });
  });

  describe("Hybrid mode (with vector search)", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      adapter = new SQLiteAdapter();
      await adapter.initialize({
        type: "sqlite",
        dbPath: ":memory:",
        tenantId,
      });

      await adapter.createTenant({ tenant_id: tenantId, name: "Test" });

      // Seed notes and embeddings
      const note1 = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Implement REST API with Express",
        keywords: ["REST", "API", "Express"],
      });
      const note2 = await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content: "Use Express router for REST endpoints",
        keywords: ["Express", "router", "REST"],
      });
      const note3 = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Deploy React app to production",
        keywords: ["React", "deploy", "production"],
      });

      // Save embeddings if vec is enabled
      if (adapter.vectorSearchEnabled) {
        // Create distinct embeddings for each note
        const emb1 = Array.from({ length: 1536 }, (_, i) => Math.sin(i * 0.01));
        const emb2 = Array.from({ length: 1536 }, (_, i) => Math.sin(i * 0.01 + 0.1));
        const emb3 = Array.from({ length: 1536 }, (_, i) => Math.cos(i * 0.01));

        await adapter.saveEmbedding(note1.note_id, emb1);
        await adapter.saveEmbedding(note2.note_id, emb2);
        await adapter.saveEmbedding(note3.note_id, emb3);
      }
    });

    afterEach(async () => {
      if (fetchSpy) fetchSpy.mockRestore();
      await adapter.close();
    });

    it("should perform hybrid search when embedding is available", async () => {
      if (!adapter.vectorSearchEnabled) {
        // Skip if sqlite-vec not available
        return;
      }

      const mockQueryEmbedding = Array.from({ length: 1536 }, (_, i) =>
        Math.sin(i * 0.01)
      );

      const embeddingClient = new OpenAIEmbeddingClient({
        apiKey: "test-key",
      });

      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ embedding: mockQueryEmbedding, index: 0 }],
          }),
          { status: 200 }
        )
      );

      engine = new SearchEngine(adapter, embeddingClient);

      const results = await engine.hybridSearch("Express REST API", {
        tenant_id: tenantId,
        limit: 10,
      });

      expect(results.length).toBeGreaterThan(0);
      // Hybrid mode should return hybrid match type
      expect(results[0].match_type).toBe("hybrid");
    });
  });

  describe("RRF scoring", () => {
    it("should boost notes that appear in both FTS and vector results", async () => {
      adapter = new SQLiteAdapter();
      await adapter.initialize({
        type: "sqlite",
        dbPath: ":memory:",
        tenantId,
      });
      await adapter.createTenant({ tenant_id: tenantId, name: "Test" });

      if (!adapter.vectorSearchEnabled) {
        await adapter.close();
        return;
      }

      // Create notes
      const noteA = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "TypeScript interfaces and type safety",
        keywords: ["TypeScript", "interfaces", "type-safety"],
      });
      const noteB = await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content: "TypeScript generics for reusable components",
        keywords: ["TypeScript", "generics", "components"],
      });

      // Both notes get embeddings close to query
      const embA = Array.from({ length: 1536 }, (_, i) => Math.sin(i * 0.01));
      const embB = Array.from({ length: 1536 }, (_, i) => Math.sin(i * 0.01 + 2));

      await adapter.saveEmbedding(noteA.note_id, embA);
      await adapter.saveEmbedding(noteB.note_id, embB);

      const mockQueryEmb = Array.from({ length: 1536 }, (_, i) =>
        Math.sin(i * 0.01)
      );

      const embeddingClient = new OpenAIEmbeddingClient({
        apiKey: "test-key",
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ embedding: mockQueryEmb, index: 0 }],
          }),
          { status: 200 }
        )
      );

      engine = new SearchEngine(adapter, embeddingClient);

      const results = await engine.hybridSearch("TypeScript", {
        tenant_id: tenantId,
        limit: 10,
      });

      expect(results.length).toBe(2);
      // Both should be hybrid
      for (const r of results) {
        expect(r.match_type).toBe("hybrid");
        expect(r.score).toBeGreaterThan(0);
      }
      // First result should have higher RRF score (appeared high in both lists)
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);

      fetchSpy.mockRestore();
      await adapter.close();
    });
  });
});
