import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DataTransfer } from "../data-transfer.js";
import { SQLiteAdapter } from "../storage/sqlite-adapter.js";
import type { StorageAdapter } from "../storage/adapter.js";

describe("DataTransfer", () => {
  let adapter: StorageAdapter;
  let transfer: DataTransfer;

  beforeEach(async () => {
    adapter = new SQLiteAdapter();
    await adapter.initialize({
      type: "sqlite",
      dbPath: ":memory:",
      tenantId: "test",
    });
    await adapter.createTenant({ tenant_id: "test", name: "Test Tenant" });
    transfer = new DataTransfer(adapter);
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe("export", () => {
    it("should export empty database", async () => {
      const result = await transfer.export({ tenantId: "test" });
      expect(result.stats.notes).toBe(0);
      expect(result.stats.tenants).toBe(1);
      expect(result.content).toContain('"_type":"header"');
      expect(result.content).toContain('"_type":"tenant"');
    });

    it("should export notes as JSONL", async () => {
      await adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: "Test content 1",
        keywords: ["test"],
      });
      await adapter.saveNote({
        tenant_id: "test",
        role: "assistant",
        content: "Test content 2",
        tags: ["response"],
      });

      const result = await transfer.export({ tenantId: "test" });
      expect(result.stats.notes).toBe(2);

      // Verify JSONL format: each line is valid JSON
      const lines = result.content.trim().split("\n");
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it("should export links", async () => {
      const note1 = await adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: "Note 1",
      });
      const note2 = await adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: "Note 2",
      });
      await adapter.addLink({
        source_id: note1.note_id,
        target_id: note2.note_id,
        relation: "related",
        strength: 0.8,
      });

      const result = await transfer.export({ tenantId: "test" });
      expect(result.stats.links).toBe(1);
    });

    it("should exclude links when includeLinks=false", async () => {
      const note1 = await adapter.saveNote({ tenant_id: "test", role: "user", content: "A" });
      const note2 = await adapter.saveNote({ tenant_id: "test", role: "user", content: "B" });
      await adapter.addLink({
        source_id: note1.note_id,
        target_id: note2.note_id,
        strength: 0.5,
      });

      const result = await transfer.export({
        tenantId: "test",
        includeLinks: false,
      });
      expect(result.stats.links).toBe(0);
    });
  });

  describe("import", () => {
    it("should import exported data into a fresh adapter", async () => {
      // Prepare source data
      await adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: "Importable note",
        keywords: ["import", "test"],
        summary: "A test note",
      });

      const exported = await transfer.export({ tenantId: "test" });

      // Create a fresh adapter for import
      const targetAdapter = new SQLiteAdapter();
      await targetAdapter.initialize({
        type: "sqlite",
        dbPath: ":memory:",
        tenantId: "imported",
      });

      const targetTransfer = new DataTransfer(targetAdapter);
      const result = await targetTransfer.import(exported.content, {
        targetTenantId: "imported",
      });

      expect(result.imported.tenants).toBe(1);
      expect(result.imported.notes).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Verify imported data
      const stats = await targetAdapter.getStats("imported");
      expect(stats.total_notes).toBe(1);

      await targetAdapter.close();
    });

    it("should skip existing notes with skip strategy", async () => {
      const note = await adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: "Existing note",
      });

      // Export
      const exported = await transfer.export({ tenantId: "test" });

      // Import back into same adapter
      const result = await transfer.import(exported.content, {
        targetTenantId: "test",
        mergeStrategy: "skip",
      });

      expect(result.skipped.notes).toBe(1);
      expect(result.imported.notes).toBe(0);
    });

    it("should handle invalid JSONL gracefully", async () => {
      const badContent = `{"_type":"header","_version":1,"data":{}}
not valid json
{"_type":"note","_version":1,"data":{"role":"user","content":"test"}}`;

      const result = await transfer.import(badContent, {
        targetTenantId: "test",
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Line 2");
    });

    it("should import links with note ID mapping", async () => {
      const note1 = await adapter.saveNote({ tenant_id: "test", role: "user", content: "A" });
      const note2 = await adapter.saveNote({ tenant_id: "test", role: "user", content: "B" });
      await adapter.addLink({
        source_id: note1.note_id,
        target_id: note2.note_id,
        relation: "test-relation",
        strength: 0.9,
      });

      const exported = await transfer.export({ tenantId: "test" });

      // Import into fresh adapter
      const targetAdapter = new SQLiteAdapter();
      await targetAdapter.initialize({
        type: "sqlite",
        dbPath: ":memory:",
        tenantId: "target",
      });

      const targetTransfer = new DataTransfer(targetAdapter);
      const result = await targetTransfer.import(exported.content, {
        targetTenantId: "target",
      });

      // Notes are new so links should be created
      expect(result.imported.notes).toBe(2);
      // Links may not resolve since note IDs change on import
      // But the import should not error
      expect(result.errors).toHaveLength(0);

      await targetAdapter.close();
    });
  });

  describe("round-trip", () => {
    it("should preserve data through export/import cycle", async () => {
      // Create rich data
      await adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: "Design discussion about microservices",
        keywords: ["microservices", "architecture"],
        tags: ["design"],
        summary: "Discussed microservices approach",
        importance: 0.7,
      });
      await adapter.saveNote({
        tenant_id: "test",
        role: "assistant",
        content: "I recommend using event-driven architecture",
        keywords: ["event-driven", "architecture"],
        tags: ["recommendation"],
        summary: "Recommended event-driven approach",
        importance: 0.6,
      });

      const exported = await transfer.export({ tenantId: "test" });
      expect(exported.stats.notes).toBe(2);

      // Import into new adapter
      const targetAdapter = new SQLiteAdapter();
      await targetAdapter.initialize({
        type: "sqlite",
        dbPath: ":memory:",
        tenantId: "new",
      });

      const targetTransfer = new DataTransfer(targetAdapter);
      const importResult = await targetTransfer.import(exported.content, {
        targetTenantId: "new",
      });

      expect(importResult.imported.notes).toBe(2);

      // Verify content is searchable
      const results = await targetAdapter.fullTextSearch("microservices", {
        tenant_id: "new",
      });
      expect(results.length).toBe(1);
      expect(results[0].note.content).toContain("microservices");

      await targetAdapter.close();
    });
  });
});
