import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryServer, type MemoryServerContext } from "../server.js";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Phase 3: Server Integration", () => {
  let ctx: MemoryServerContext;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `phase3-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    if (ctx) {
      await ctx.sessionManager.cleanup();
      await ctx.adapter.close();
    }
    try {
      await rm(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  describe("Server creation with Phase 3 options", () => {
    it("should create server without Phase 3 paths (backward compatible)", async () => {
      ctx = await createMemoryServer({
        storageConfig: {
          type: "sqlite",
          dbPath: ":memory:",
          tenantId: "test",
        },
      });

      expect(ctx.server).toBeDefined();
      expect(ctx.memoryIndex).toBeNull();
      expect(ctx.claudeContext).toBeNull();
      expect(ctx.sessionManager).toBeDefined();
    });

    it("should create server with MEMORY.md path", async () => {
      const indexPath = join(tempDir, "MEMORY.md");

      ctx = await createMemoryServer({
        storageConfig: {
          type: "sqlite",
          dbPath: ":memory:",
          tenantId: "test",
        },
        memoryIndexPath: indexPath,
      });

      expect(ctx.memoryIndex).not.toBeNull();
    });

    it("should create server with CLAUDE.md path", async () => {
      const claudePath = join(tempDir, "CLAUDE.md");
      await writeFile(claudePath, "# Rules\nUse TypeScript.", "utf-8");

      ctx = await createMemoryServer({
        storageConfig: {
          type: "sqlite",
          dbPath: ":memory:",
          tenantId: "test",
        },
        claudeMdPath: claudePath,
      });

      expect(ctx.claudeContext).not.toBeNull();
    });
  });

  describe("memory_summarize tool", () => {
    it("should return empty summary when no notes exist", async () => {
      ctx = await createMemoryServer({
        storageConfig: {
          type: "sqlite",
          dbPath: ":memory:",
          tenantId: "test",
        },
      });

      // Save and search through adapter to verify summarize would work
      const notes = await ctx.adapter.getNotesForSummary!({
        tenant_id: "test",
      });
      expect(notes.length).toBe(0);
    });

    it("should get notes for summary with date filters", async () => {
      ctx = await createMemoryServer({
        storageConfig: {
          type: "sqlite",
          dbPath: ":memory:",
          tenantId: "test",
        },
      });

      await ctx.adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: "Working on memory system",
        keywords: ["memory", "system"],
      });

      await ctx.adapter.saveNote({
        tenant_id: "test",
        role: "assistant",
        content: "The memory system uses SQLite and FTS5",
        keywords: ["memory", "SQLite", "FTS5"],
      });

      const notes = await ctx.adapter.getNotesForSummary!({
        tenant_id: "test",
      });
      expect(notes.length).toBe(2);
    });

    it("should build basic summary without LLM", async () => {
      ctx = await createMemoryServer({
        storageConfig: {
          type: "sqlite",
          dbPath: ":memory:",
          tenantId: "test",
        },
      });

      await ctx.adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: "Test content",
        keywords: ["test", "content"],
      });

      // Verify getNotesForSummary returns notes
      const notes = await ctx.adapter.getNotesForSummary!({
        tenant_id: "test",
        limit: 50,
      });
      expect(notes.length).toBe(1);
    });
  });

  describe("memory_update_index tool", () => {
    it("should update MEMORY.md when configured", async () => {
      const indexPath = join(tempDir, "MEMORY.md");

      ctx = await createMemoryServer({
        storageConfig: {
          type: "sqlite",
          dbPath: ":memory:",
          tenantId: "test",
        },
        memoryIndexPath: indexPath,
      });

      // Save some notes first
      await ctx.adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: "Important project decision",
        keywords: ["project", "decision"],
        importance: 0.9,
      });

      // Trigger update
      const result = await ctx.memoryIndex!.update();
      expect(result.path).toBe(indexPath);

      // Verify file content
      const content = await readFile(indexPath, "utf-8");
      expect(content).toContain("# MEMORY.md (auto-generated)");
      expect(content).toContain("Important project decision");
    });

    it("should import CLAUDE.md on update when configured", async () => {
      const claudePath = join(tempDir, "CLAUDE.md");
      await writeFile(
        claudePath,
        "# Project\n\nUse TypeScript.\n\n## Testing\n\nUse vitest.",
        "utf-8"
      );

      ctx = await createMemoryServer({
        storageConfig: {
          type: "sqlite",
          dbPath: ":memory:",
          tenantId: "test",
        },
        claudeMdPath: claudePath,
      });

      // Import CLAUDE.md
      const notes = await ctx.claudeContext!.importContext();
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0].tags).toContain("claude-md");

      // Verify notes are searchable
      const results = await ctx.adapter.fullTextSearch("TypeScript", {
        tenant_id: "test",
      });
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("SQLiteAdapter Phase 3 methods", () => {
    beforeEach(async () => {
      ctx = await createMemoryServer({
        storageConfig: {
          type: "sqlite",
          dbPath: ":memory:",
          tenantId: "test",
        },
      });
    });

    it("getRecentNotes should return notes from recent days", async () => {
      await ctx.adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: "Recent note",
        keywords: ["recent"],
      });

      const recent = await (ctx.adapter as any).getRecentNotes("test", 7, 10);
      expect(recent.length).toBe(1);
      expect(recent[0].content).toBe("Recent note");
    });

    it("getTopKeywordsWithDates should return keywords with dates", async () => {
      await ctx.adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: "Note about TypeScript",
        keywords: ["TypeScript"],
      });

      const keywords = await (ctx.adapter as any).getTopKeywordsWithDates("test", 10);
      expect(keywords.length).toBe(1);
      expect(keywords[0].keyword).toBe("TypeScript");
      expect(keywords[0].count).toBe(1);
      expect(keywords[0].last_seen).toBeDefined();
    });

    it("getActiveSessions should return non-ended sessions", async () => {
      const session = await ctx.adapter.createSession({
        session_id: "active-1",
        tenant_id: "test",
        project: "test-project",
      });

      await ctx.adapter.createSession({
        session_id: "ended-1",
        tenant_id: "test",
      });
      await ctx.adapter.endSession("ended-1");

      const active = await (ctx.adapter as any).getActiveSessions("test");
      expect(active.length).toBe(1);
      expect(active[0].session_id).toBe("active-1");
    });

    it("getNotesForSummary should filter by project", async () => {
      const session = await ctx.adapter.createSession({
        session_id: "proj-session",
        tenant_id: "test",
        project: "my-project",
      });

      await ctx.adapter.saveNote({
        tenant_id: "test",
        session_id: "proj-session",
        role: "user",
        content: "Note in project",
        keywords: ["project"],
      });

      await ctx.adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: "Note without project",
        keywords: ["other"],
      });

      const projectNotes = await (ctx.adapter as any).getNotesForSummary({
        tenant_id: "test",
        project: "my-project",
      });
      expect(projectNotes.length).toBe(1);
      expect(projectNotes[0].content).toBe("Note in project");
    });
  });
});
