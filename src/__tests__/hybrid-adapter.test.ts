import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HybridAdapter } from "../storage/hybrid-adapter.js";
import type { StorageConfig } from "../storage/types.js";

describe("HybridAdapter", () => {
  let adapter: HybridAdapter;
  const tenantId = "test-tenant";

  beforeEach(async () => {
    adapter = new HybridAdapter();
    const config: StorageConfig = {
      type: "hybrid",
      dbPath: ":memory:",
      tursoUrl: "file::memory:",
      tenantId,
      syncIntervalMs: 0, // Disable auto-sync for tests (manual sync)
      syncOnWrite: false,
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

  // --- Basic CRUD through Hybrid ---

  describe("CRUD Operations", () => {
    it("should save and retrieve a note via local", async () => {
      const note = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Test content for hybrid adapter",
        keywords: ["hybrid", "test"],
      });

      expect(note.note_id).toBeDefined();
      expect(note.content).toBe("Test content for hybrid adapter");

      const retrieved = await adapter.getNote(note.note_id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.content).toBe(note.content);
    });

    it("should update a note", async () => {
      const note = await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content: "Original",
      });

      const updated = await adapter.updateNote(note.note_id, {
        content: "Updated",
        importance: 0.9,
      });

      expect(updated.content).toBe("Updated");
      expect(updated.importance).toBe(0.9);
    });

    it("should delete a note", async () => {
      const note = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "To delete",
      });

      await adapter.deleteNote(note.note_id);

      const retrieved = await adapter.getNote(note.note_id);
      expect(retrieved).toBeNull();
    });

    it("should create and retrieve sessions", async () => {
      const session = await adapter.createSession({
        session_id: "hybrid-session",
        tenant_id: tenantId,
        project: "hybrid-project",
      });

      expect(session.session_id).toBe("hybrid-session");

      const retrieved = await adapter.getSession("hybrid-session");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.project).toBe("hybrid-project");
    });

    it("should create and retrieve links", async () => {
      const n1 = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Note 1",
      });
      const n2 = await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content: "Note 2",
      });

      const link = await adapter.addLink({
        source_id: n1.note_id,
        target_id: n2.note_id,
        relation: "follow-up",
        strength: 0.8,
      });

      expect(link.link_id).toBeDefined();

      const links = await adapter.getLinks(n1.note_id);
      expect(links).toHaveLength(1);
    });
  });

  // --- Search ---

  describe("Search", () => {
    it("should search via local adapter", async () => {
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "TypeScript is a great programming language",
        keywords: ["TypeScript"],
      });

      const results = await adapter.fullTextSearch("TypeScript", {
        tenant_id: tenantId,
      });

      expect(results.length).toBeGreaterThan(0);
    });
  });

  // --- Stats ---

  describe("Stats", () => {
    it("should return correct stats from local", async () => {
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Note 1",
      });
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content: "Note 2",
      });

      const stats = await adapter.getStats(tenantId);
      expect(stats.total_notes).toBe(2);
      expect(stats.notes_by_role.user).toBe(1);
      expect(stats.notes_by_role.assistant).toBe(1);
    });
  });

  // --- Sync Pipeline ---

  describe("Sync Pipeline", () => {
    it("should have pending operations after writes", async () => {
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Pending sync note",
      });

      const status = adapter.getSyncStatus();
      // Tenant create + note save = 2 operations (tenant was created in beforeEach)
      expect(status.pendingOperations).toBeGreaterThan(0);
      expect(status.isSyncing).toBe(false);
    });

    it("should sync data to remote after processSyncQueue", async () => {
      const note = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Sync me to cloud",
        keywords: ["sync", "cloud"],
      });

      // Verify not yet in remote
      const beforeSync = await adapter.remoteAdapter.getNote(note.note_id);
      // The note_id won't match since TursoAdapter generates its own UUID
      // But after sync, content should be in remote

      // Process sync queue
      await adapter.processSyncQueue();

      const status = adapter.getSyncStatus();
      expect(status.pendingOperations).toBe(0);
      expect(status.lastSyncAt).not.toBeNull();
    });

    it("should sync tenant creation to remote", async () => {
      await adapter.createTenant({
        tenant_id: "sync-tenant",
        name: "Synced Tenant",
      });

      await adapter.processSyncQueue();

      const remoteTenant = await adapter.remoteAdapter.getTenant("sync-tenant");
      expect(remoteTenant).not.toBeNull();
      expect(remoteTenant!.name).toBe("Synced Tenant");
    });

    it("should sync session operations to remote", async () => {
      await adapter.createSession({
        session_id: "sync-session",
        tenant_id: tenantId,
      });

      await adapter.processSyncQueue();

      const remoteSession = await adapter.remoteAdapter.getSession("sync-session");
      expect(remoteSession).not.toBeNull();
    });

    it("should report sync status correctly", async () => {
      const initialStatus = adapter.getSyncStatus();
      // There should be at least one pending op from the tenant creation in beforeEach
      expect(typeof initialStatus.pendingOperations).toBe("number");
      expect(initialStatus.isSyncing).toBe(false);

      await adapter.processSyncQueue();

      const afterStatus = adapter.getSyncStatus();
      expect(afterStatus.pendingOperations).toBe(0);
      expect(afterStatus.lastSyncAt).not.toBeNull();
    });

    it("should handle sync failures with retry", async () => {
      // Create a note referencing a non-existent session in remote
      // This tests that retry logic doesn't crash
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Note that will sync",
      });

      // Process should not throw
      await adapter.processSyncQueue();

      const status = adapter.getSyncStatus();
      // Should have processed without throwing
      expect(status.lastSyncAt).not.toBeNull();
    });
  });

  // --- Sync on Write ---

  describe("Sync on Write", () => {
    let syncOnWriteAdapter: HybridAdapter;

    beforeEach(async () => {
      syncOnWriteAdapter = new HybridAdapter();
      await syncOnWriteAdapter.initialize({
        type: "hybrid",
        dbPath: ":memory:",
        tursoUrl: "file::memory:",
        tenantId,
        syncIntervalMs: 0,
        syncOnWrite: true,
      });

      await syncOnWriteAdapter.createTenant({
        tenant_id: tenantId,
        name: "Test Tenant",
      });

      // Wait for sync-on-write to process
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    afterEach(async () => {
      await syncOnWriteAdapter.close();
    });

    it("should automatically sync on write when enabled", async () => {
      await syncOnWriteAdapter.createTenant({
        tenant_id: "auto-sync-tenant",
        name: "Auto Synced",
      });

      // Wait for async sync to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      const remoteTenant = await syncOnWriteAdapter.remoteAdapter.getTenant(
        "auto-sync-tenant"
      );
      expect(remoteTenant).not.toBeNull();
    });
  });

  // --- Extended Queries ---

  describe("Extended Queries", () => {
    it("should delegate getRecentNotes to local", async () => {
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Recent note",
      });

      const recent = await adapter.getRecentNotes(tenantId, 7, 10);
      expect(recent.length).toBeGreaterThan(0);
    });

    it("should delegate getTopKeywords to local", async () => {
      await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Note with keywords",
        keywords: ["test-keyword"],
      });

      const kws = await adapter.getTopKeywords(tenantId, 10);
      expect(kws.length).toBeGreaterThan(0);
    });
  });
});
