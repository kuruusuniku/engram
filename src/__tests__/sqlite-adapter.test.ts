import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteAdapter } from "../storage/sqlite-adapter.js";
import type { StorageConfig } from "../storage/types.js";

describe("SQLiteAdapter", () => {
  let adapter: SQLiteAdapter;
  const tenantId = "test-tenant";

  beforeEach(async () => {
    adapter = new SQLiteAdapter();
    const config: StorageConfig = {
      type: "sqlite",
      dbPath: ":memory:",
      tenantId,
    };
    await adapter.initialize(config);

    // Create test tenant
    await adapter.createTenant({
      tenant_id: tenantId,
      name: "Test Tenant",
    });
  });

  afterEach(async () => {
    await adapter.close();
  });

  // --- Tenant Tests ---

  describe("Tenant Management", () => {
    it("should create and retrieve a tenant", async () => {
      const tenant = await adapter.createTenant({
        tenant_id: "tenant-2",
        name: "Another Tenant",
      });

      expect(tenant.tenant_id).toBe("tenant-2");
      expect(tenant.name).toBe("Another Tenant");
      expect(tenant.created_at).toBeDefined();

      const retrieved = await adapter.getTenant("tenant-2");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("Another Tenant");
    });

    it("should return null for non-existent tenant", async () => {
      const result = await adapter.getTenant("non-existent");
      expect(result).toBeNull();
    });

    it("should store tenant config as JSON", async () => {
      await adapter.createTenant({
        tenant_id: "tenant-config",
        name: "Config Tenant",
        config: { plan: "pro", features: ["vector-search"] },
      });

      const retrieved = await adapter.getTenant("tenant-config");
      expect(retrieved!.config).toEqual({
        plan: "pro",
        features: ["vector-search"],
      });
    });
  });

  // --- Session Tests ---

  describe("Session Management", () => {
    it("should create and retrieve a session", async () => {
      const session = await adapter.createSession({
        session_id: "session-1",
        tenant_id: tenantId,
        project: "my-project",
      });

      expect(session.session_id).toBe("session-1");
      expect(session.tenant_id).toBe(tenantId);
      expect(session.project).toBe("my-project");
      expect(session.started_at).toBeDefined();
      expect(session.ended_at).toBeUndefined();

      const retrieved = await adapter.getSession("session-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.project).toBe("my-project");
    });

    it("should end a session", async () => {
      await adapter.createSession({
        session_id: "session-end",
        tenant_id: tenantId,
      });

      await adapter.endSession("session-end");

      const session = await adapter.getSession("session-end");
      expect(session!.ended_at).toBeDefined();
    });
  });

  // --- Note CRUD Tests ---

  describe("Note CRUD", () => {
    it("should save and retrieve a note", async () => {
      const note = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "How do I implement a binary search tree?",
        keywords: ["binary search tree", "data structure", "algorithm"],
        tags: ["programming", "cs-fundamentals"],
      });

      expect(note.note_id).toBeDefined();
      expect(note.role).toBe("user");
      expect(note.content).toBe(
        "How do I implement a binary search tree?"
      );
      expect(note.keywords).toEqual([
        "binary search tree",
        "data structure",
        "algorithm",
      ]);
      expect(note.tags).toEqual(["programming", "cs-fundamentals"]);

      const retrieved = await adapter.getNote(note.note_id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.content).toBe(note.content);
      expect(retrieved!.keywords).toEqual(note.keywords);
    });

    it("should update a note", async () => {
      const note = await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content: "Original content",
      });

      const updated = await adapter.updateNote(note.note_id, {
        content: "Updated content",
        summary: "A brief summary",
        importance: 0.8,
      });

      expect(updated.content).toBe("Updated content");
      expect(updated.summary).toBe("A brief summary");
      expect(updated.importance).toBe(0.8);
    });

    it("should delete a note", async () => {
      const note = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "To be deleted",
      });

      await adapter.deleteNote(note.note_id);

      const retrieved = await adapter.getNote(note.note_id);
      expect(retrieved).toBeNull();
    });

    it("should throw when updating non-existent note", async () => {
      await expect(
        adapter.updateNote("non-existent", { content: "test" })
      ).rejects.toThrow("Note not found");
    });
  });

  // --- Note Links Tests ---

  describe("Note Links", () => {
    it("should create and retrieve links", async () => {
      const note1 = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "First note",
      });
      const note2 = await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content: "Second note",
      });

      const link = await adapter.addLink({
        source_id: note1.note_id,
        target_id: note2.note_id,
        relation: "follow-up",
        strength: 0.9,
      });

      expect(link.link_id).toBeDefined();
      expect(link.relation).toBe("follow-up");
      expect(link.strength).toBe(0.9);

      const links = await adapter.getLinks(note1.note_id);
      expect(links).toHaveLength(1);
      expect(links[0].target_id).toBe(note2.note_id);

      // Also retrievable from target side
      const reverseLinks = await adapter.getLinks(note2.note_id);
      expect(reverseLinks).toHaveLength(1);
    });
  });

  // --- Full Text Search Tests ---

  describe("Full Text Search", () => {
    beforeEach(async () => {
      // Seed test data
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content:
          "I need help implementing a REST API with Express and TypeScript",
        keywords: ["REST", "API", "Express", "TypeScript"],
        tags: ["backend"],
      });
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content:
          "Here is how to set up an Express server with TypeScript. First install the dependencies.",
        keywords: ["Express", "TypeScript", "server"],
        tags: ["backend", "tutorial"],
      });
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "How do I deploy a React application to Vercel?",
        keywords: ["React", "Vercel", "deploy"],
        tags: ["frontend", "deployment"],
      });
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content:
          "To deploy React to Vercel, connect your GitHub repository and configure the build settings.",
        keywords: ["React", "Vercel", "GitHub", "deploy"],
        tags: ["frontend", "deployment"],
      });
    });

    it("should find notes matching a search query", async () => {
      const results = await adapter.fullTextSearch("Express TypeScript", {
        tenant_id: tenantId,
      });

      expect(results.length).toBeGreaterThan(0);
      // Results should contain Express/TypeScript related notes
      const contents = results.map((r) => r.note.content);
      expect(
        contents.some((c) => c.includes("Express"))
      ).toBe(true);
    });

    it("should find notes about React deployment", async () => {
      const results = await adapter.fullTextSearch("React deploy Vercel", {
        tenant_id: tenantId,
      });

      expect(results.length).toBeGreaterThan(0);
      const contents = results.map((r) => r.note.content);
      expect(
        contents.some((c) => c.includes("Vercel"))
      ).toBe(true);
    });

    it("should return empty for non-matching query", async () => {
      const results = await adapter.fullTextSearch("quantum computing", {
        tenant_id: tenantId,
      });

      expect(results).toHaveLength(0);
    });

    it("should respect limit parameter", async () => {
      const results = await adapter.fullTextSearch("TypeScript", {
        tenant_id: tenantId,
        limit: 1,
      });

      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("should have BM25 scores", async () => {
      const results = await adapter.fullTextSearch("Express TypeScript", {
        tenant_id: tenantId,
      });

      for (const result of results) {
        expect(result.score).toBeGreaterThan(0);
        expect(result.match_type).toBe("fts");
      }
    });

    it("should handle special characters gracefully", async () => {
      // Should fallback to LIKE search for invalid FTS syntax
      const results = await adapter.fullTextSearch("C++ && Java", {
        tenant_id: tenantId,
      });

      // Should not throw, may return empty results
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // --- Stats Tests ---

  describe("Stats", () => {
    it("should return correct stats", async () => {
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Test note 1",
        keywords: ["test", "one"],
      });
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content: "Test note 2",
        keywords: ["test", "two"],
      });
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Test note 3",
        keywords: ["test", "one"],
      });

      const stats = await adapter.getStats(tenantId);
      expect(stats.total_notes).toBe(3);
      expect(stats.notes_by_role.user).toBe(2);
      expect(stats.notes_by_role.assistant).toBe(1);
      expect(stats.date_range.earliest).toBeDefined();
      expect(stats.date_range.latest).toBeDefined();
    });

    it("should return top keywords", async () => {
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Note 1",
        keywords: ["typescript", "react"],
      });
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Note 2",
        keywords: ["typescript", "node"],
      });
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Note 3",
        keywords: ["typescript", "react", "next"],
      });

      const topKeywords = await adapter.getTopKeywords(tenantId, 5);
      expect(topKeywords[0].keyword).toBe("typescript");
      expect(topKeywords[0].count).toBe(3);
    });
  });
});
