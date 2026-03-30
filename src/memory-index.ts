/**
 * MemoryIndex - MEMORY.md auto-generation and update logic
 *
 * Generates MEMORY.md content based on the memory database:
 * - Recent important memories (last 7 days)
 * - Frequent topics (with counts and last-seen dates)
 * - User preferences/tendencies
 * - Associative search seed candidates (hub node keywords)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { StorageAdapter } from "./storage/adapter.js";
import type { Note, KeywordWithDate, HubNote } from "./storage/types.js";
import type { LLMClient } from "./llm.js";

export interface MemoryIndexConfig {
  /** Path to MEMORY.md file */
  indexPath: string;
  /** Tenant ID */
  tenantId: string;
  /** Number of recent days to include (default: 7) */
  recentDays?: number;
  /** Max recent notes to show (default: 10) */
  maxRecentNotes?: number;
  /** Max topics to show (default: 15) */
  maxTopics?: number;
  /** Max hub keywords to show (default: 10) */
  maxHubKeywords?: number;
}

export interface MemoryIndexData {
  recentNotes: Note[];
  topKeywords: KeywordWithDate[];
  hubNotes: HubNote[];
  preferences: string[];
}

const PREFERENCE_SYSTEM_PROMPT = `You are a user behavior analyst. Given a list of conversation notes, identify the user's preferences and tendencies.

Respond ONLY with a JSON array of strings, each being a concise preference statement.
Example: ["Prefers TypeScript over JavaScript", "Uses vitest for testing", "Communicates in Japanese"]

Rules:
- Maximum 5 preferences
- Be specific and actionable
- Focus on technical and communication patterns
- Respond in the same language as the majority of the input texts`;

export class MemoryIndex {
  private config: MemoryIndexConfig;
  private adapter: StorageAdapter;
  private llm: LLMClient;

  constructor(
    adapter: StorageAdapter,
    llm: LLMClient,
    config: MemoryIndexConfig
  ) {
    this.adapter = adapter;
    this.llm = llm;
    this.config = config;
  }

  /**
   * Gather data from the database for MEMORY.md generation
   */
  async gatherData(): Promise<MemoryIndexData> {
    const {
      tenantId,
      recentDays = 7,
      maxRecentNotes = 10,
      maxTopics = 15,
      maxHubKeywords = 10,
    } = this.config;

    // Gather recent notes
    let recentNotes: Note[] = [];
    if (this.adapter.getRecentNotes) {
      recentNotes = await this.adapter.getRecentNotes(
        tenantId,
        recentDays,
        maxRecentNotes
      );
    }

    // Gather top keywords with dates
    let topKeywords: KeywordWithDate[] = [];
    if (this.adapter.getTopKeywordsWithDates) {
      topKeywords = await this.adapter.getTopKeywordsWithDates(
        tenantId,
        maxTopics
      );
    }

    // Gather hub notes
    let hubNotes: HubNote[] = [];
    if (this.adapter.getHubNotes) {
      hubNotes = await this.adapter.getHubNotes(tenantId, maxHubKeywords);
    }

    // Extract preferences using LLM
    const preferences = await this.extractPreferences(recentNotes);

    return { recentNotes, topKeywords, hubNotes, preferences };
  }

  /**
   * Extract user preferences from recent notes using LLM
   */
  private async extractPreferences(notes: Note[]): Promise<string[]> {
    if (!this.llm.available || notes.length === 0) return [];

    const userNotes = notes
      .filter((n) => n.role === "user")
      .slice(0, 20);

    if (userNotes.length === 0) return [];

    const prompt = userNotes
      .map((n) => `[${n.created_at}] ${n.summary ?? n.content.slice(0, 200)}`)
      .join("\n");

    try {
      const response = await this.llm.complete(prompt, PREFERENCE_SYSTEM_PROMPT);
      if (!response) return [];

      const jsonStr = response
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      const parsed = JSON.parse(jsonStr);

      if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
        return parsed;
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Generate MEMORY.md content from gathered data
   */
  generateMarkdown(data: MemoryIndexData): string {
    const lines: string[] = [];

    lines.push("# MEMORY.md (auto-generated)");
    lines.push("");
    lines.push(
      `> Last updated: ${new Date().toISOString().replace("T", " ").slice(0, 19)}`
    );
    lines.push("");

    // Recent important memories
    lines.push("## Recent Important Memories");
    lines.push("");
    if (data.recentNotes.length === 0) {
      lines.push("No recent memories found.");
    } else {
      for (const note of data.recentNotes) {
        const date = note.created_at.slice(0, 10);
        const summary = note.summary ?? note.content.slice(0, 100);
        lines.push(`- [${date}] ${summary}`);
      }
    }
    lines.push("");

    // Frequent topics
    lines.push("## Frequent Topics");
    lines.push("");
    if (data.topKeywords.length === 0) {
      lines.push("No topics found.");
    } else {
      for (const kw of data.topKeywords) {
        const lastSeen = kw.last_seen.slice(0, 10);
        lines.push(
          `- ${kw.keyword} (count: ${kw.count}, last: ${lastSeen})`
        );
      }
    }
    lines.push("");

    // User preferences
    lines.push("## User Preferences & Tendencies");
    lines.push("");
    if (data.preferences.length === 0) {
      lines.push("Not enough data to determine preferences.");
    } else {
      for (const pref of data.preferences) {
        lines.push(`- ${pref}`);
      }
    }
    lines.push("");

    // Associative search seeds
    lines.push("## Associative Search Seeds");
    lines.push("");
    if (data.hubNotes.length === 0) {
      lines.push("No hub nodes found.");
    } else {
      const allHubKeywords = new Set<string>();
      for (const hub of data.hubNotes) {
        for (const kw of hub.keywords) {
          allHubKeywords.add(kw);
        }
      }
      lines.push(
        `Hub keywords: ${Array.from(allHubKeywords).join(", ")}`
      );
    }
    lines.push("");

    return lines.join("\n");
  }

  /**
   * Update MEMORY.md: gather data, generate, and write to file
   */
  async update(): Promise<{ path: string; content: string }> {
    const data = await this.gatherData();
    const content = this.generateMarkdown(data);

    // Ensure directory exists
    const dir = dirname(this.config.indexPath);
    await mkdir(dir, { recursive: true });

    await writeFile(this.config.indexPath, content, "utf-8");

    return { path: this.config.indexPath, content };
  }

  /**
   * Read existing MEMORY.md content
   */
  async read(): Promise<string | null> {
    try {
      return await readFile(this.config.indexPath, "utf-8");
    } catch {
      return null;
    }
  }
}
