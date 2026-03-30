import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryServer } from "../server.js";
import type { StorageAdapter } from "../storage/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("Memory MCP Server", () => {
  let server: McpServer;
  let adapter: StorageAdapter;

  beforeEach(async () => {
    const result = await createMemoryServer({
      storageConfig: {
        type: "sqlite",
        dbPath: ":memory:",
        tenantId: "test-tenant",
      },
    });
    server = result.server;
    adapter = result.adapter;
  });

  afterEach(async () => {
    await adapter.close();
  });

  it("should create the server successfully", () => {
    expect(server).toBeDefined();
  });

  it("should create default tenant on initialization", async () => {
    const tenant = await adapter.getTenant("test-tenant");
    expect(tenant).not.toBeNull();
    expect(tenant!.tenant_id).toBe("test-tenant");
  });

  describe("memory_save via adapter", () => {
    it("should save a note through the adapter", async () => {
      const note = await adapter.saveNote({
        tenant_id: "test-tenant",
        role: "user",
        content: "Test conversation message",
        keywords: ["test"],
      });

      expect(note.note_id).toBeDefined();
      expect(note.content).toBe("Test conversation message");
    });
  });

  describe("memory_search via adapter", () => {
    it("should search saved notes", async () => {
      await adapter.saveNote({
        tenant_id: "test-tenant",
        role: "user",
        content: "How to configure webpack for production builds",
        keywords: ["webpack", "production", "configuration"],
      });

      await adapter.saveNote({
        tenant_id: "test-tenant",
        role: "assistant",
        content:
          "For webpack production builds, set mode to production and enable optimization plugins",
        keywords: ["webpack", "production", "optimization"],
      });

      const results = await adapter.fullTextSearch("webpack production", {
        tenant_id: "test-tenant",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(
        results.some((r) => r.note.content.includes("webpack"))
      ).toBe(true);
    });
  });

  describe("Integration: save then search", () => {
    it("should find recently saved notes", async () => {
      // Save multiple notes
      const notes = [
        {
          tenant_id: "test-tenant" as const,
          role: "user" as const,
          content: "Let's build a memory system for Claude Code",
          keywords: ["memory", "Claude", "system"],
        },
        {
          tenant_id: "test-tenant" as const,
          role: "assistant" as const,
          content:
            "I'll help you design a memory system. We should use SQLite for local storage and Turso for cloud sync.",
          keywords: ["memory", "SQLite", "Turso", "design"],
        },
        {
          tenant_id: "test-tenant" as const,
          role: "user" as const,
          content:
            "What about using FTS5 for full-text search capabilities?",
          keywords: ["FTS5", "search", "full-text"],
        },
      ];

      for (const note of notes) {
        await adapter.saveNote(note);
      }

      // Search for memory-related notes
      const results = await adapter.fullTextSearch("memory system", {
        tenant_id: "test-tenant",
      });

      expect(results.length).toBeGreaterThan(0);

      // Search for SQLite/Turso
      const tursoResults = await adapter.fullTextSearch("SQLite Turso", {
        tenant_id: "test-tenant",
      });

      expect(tursoResults.length).toBeGreaterThan(0);

      // Verify stats
      const stats = await adapter.getStats("test-tenant");
      expect(stats.total_notes).toBe(3);
    });
  });
});
