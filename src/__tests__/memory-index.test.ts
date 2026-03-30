import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryIndex } from "../memory-index.js";
import { SQLiteAdapter } from "../storage/sqlite-adapter.js";
import { NullLLMClient } from "../llm.js";
import type { LLMClient } from "../llm.js";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("MemoryIndex", () => {
  let adapter: SQLiteAdapter;
  let llm: LLMClient;
  let memoryIndex: MemoryIndex;
  let tempDir: string;
  let indexPath: string;
  const tenantId = "test-tenant";

  beforeEach(async () => {
    adapter = new SQLiteAdapter();
    await adapter.initialize({
      type: "sqlite",
      dbPath: ":memory:",
      tenantId,
    });
    await adapter.createTenant({ tenant_id: tenantId, name: "Test" });

    llm = new NullLLMClient();
    tempDir = join(tmpdir(), `memory-test-${Date.now()}`);
    indexPath = join(tempDir, "MEMORY.md");

    memoryIndex = new MemoryIndex(adapter, llm, {
      indexPath,
      tenantId,
    });
  });

  afterEach(async () => {
    await adapter.close();
    try {
      await rm(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  describe("gatherData", () => {
    it("should return empty data when no notes exist", async () => {
      const data = await memoryIndex.gatherData();
      expect(data.recentNotes).toEqual([]);
      expect(data.topKeywords).toEqual([]);
      expect(data.hubNotes).toEqual([]);
      expect(data.preferences).toEqual([]);
    });

    it("should gather recent notes", async () => {
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Test memory content",
        keywords: ["test", "memory"],
        tags: ["testing"],
        importance: 0.8,
      });

      const data = await memoryIndex.gatherData();
      expect(data.recentNotes.length).toBe(1);
      expect(data.recentNotes[0].content).toBe("Test memory content");
    });

    it("should gather top keywords with dates", async () => {
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "TypeScript is great",
        keywords: ["TypeScript", "programming"],
      });
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content: "TypeScript with Node.js",
        keywords: ["TypeScript", "Node.js"],
      });

      const data = await memoryIndex.gatherData();
      expect(data.topKeywords.length).toBeGreaterThan(0);
      expect(data.topKeywords[0].keyword).toBe("TypeScript");
      expect(data.topKeywords[0].count).toBe(2);
      expect(data.topKeywords[0].last_seen).toBeDefined();
    });

    it("should gather hub notes", async () => {
      const note1 = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Hub note",
        keywords: ["hub", "central"],
      });
      const note2 = await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content: "Connected note 1",
        keywords: ["connected"],
      });
      const note3 = await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content: "Connected note 2",
        keywords: ["connected"],
      });

      await adapter.addLink({
        source_id: note1.note_id,
        target_id: note2.note_id,
        strength: 0.8,
      });
      await adapter.addLink({
        source_id: note1.note_id,
        target_id: note3.note_id,
        strength: 0.7,
      });

      const data = await memoryIndex.gatherData();
      expect(data.hubNotes.length).toBeGreaterThan(0);
      expect(data.hubNotes[0].link_count).toBe(2);
    });
  });

  describe("generateMarkdown", () => {
    it("should generate valid markdown with empty data", () => {
      const md = memoryIndex.generateMarkdown({
        recentNotes: [],
        topKeywords: [],
        hubNotes: [],
        preferences: [],
      });

      expect(md).toContain("# MEMORY.md (auto-generated)");
      expect(md).toContain("## Recent Important Memories");
      expect(md).toContain("## Frequent Topics");
      expect(md).toContain("## User Preferences & Tendencies");
      expect(md).toContain("## Associative Search Seeds");
    });

    it("should include recent notes in markdown", () => {
      const md = memoryIndex.generateMarkdown({
        recentNotes: [
          {
            note_id: "1",
            tenant_id: tenantId,
            role: "user",
            content: "Full content here",
            summary: "Short summary of the note",
            importance: 0.8,
            created_at: "2026-03-29T10:00:00Z",
            updated_at: "2026-03-29T10:00:00Z",
          },
        ],
        topKeywords: [
          { keyword: "TypeScript", count: 10, last_seen: "2026-03-30T10:00:00Z" },
        ],
        hubNotes: [
          { note_id: "hub1", keywords: ["architecture", "design"], link_count: 5 },
        ],
        preferences: ["Prefers TypeScript"],
      });

      expect(md).toContain("[2026-03-29] Short summary of the note");
      expect(md).toContain("TypeScript (count: 10, last: 2026-03-30)");
      expect(md).toContain("Prefers TypeScript");
      expect(md).toContain("architecture");
      expect(md).toContain("design");
    });
  });

  describe("update", () => {
    it("should write MEMORY.md to disk", async () => {
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Test memory",
        keywords: ["test"],
      });

      const result = await memoryIndex.update();

      expect(result.path).toBe(indexPath);
      expect(result.content).toContain("# MEMORY.md (auto-generated)");

      // Verify file was written
      const fileContent = await readFile(indexPath, "utf-8");
      expect(fileContent).toBe(result.content);
    });
  });

  describe("read", () => {
    it("should return null when file does not exist", async () => {
      const content = await memoryIndex.read();
      expect(content).toBeNull();
    });

    it("should read existing MEMORY.md", async () => {
      // First write
      await memoryIndex.update();

      // Then read
      const content = await memoryIndex.read();
      expect(content).toContain("# MEMORY.md (auto-generated)");
    });
  });

  describe("with LLM for preferences", () => {
    it("should extract preferences when LLM is available", async () => {
      // Create a mock LLM client
      const mockLlm: LLMClient = {
        available: true,
        complete: vi.fn().mockResolvedValue(
          JSON.stringify(["Prefers TypeScript", "Uses vitest for testing"])
        ),
      };

      const indexWithLlm = new MemoryIndex(adapter, mockLlm, {
        indexPath,
        tenantId,
      });

      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "I want to use TypeScript for this",
        keywords: ["TypeScript"],
      });

      const data = await indexWithLlm.gatherData();
      expect(data.preferences).toEqual([
        "Prefers TypeScript",
        "Uses vitest for testing",
      ]);
    });
  });
});
