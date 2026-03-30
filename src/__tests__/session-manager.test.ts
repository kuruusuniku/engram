import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { SQLiteAdapter } from "../storage/sqlite-adapter.js";

describe("SessionManager", () => {
  let adapter: SQLiteAdapter;
  let sessionManager: SessionManager;
  const tenantId = "test-tenant";

  beforeEach(async () => {
    adapter = new SQLiteAdapter();
    await adapter.initialize({
      type: "sqlite",
      dbPath: ":memory:",
      tenantId,
    });
    await adapter.createTenant({ tenant_id: tenantId, name: "Test" });

    sessionManager = new SessionManager(adapter, null, {
      tenantId,
      sessionTimeoutMs: 1000, // 1 second for testing
      autoUpdateIndex: false,
    });
  });

  afterEach(async () => {
    await sessionManager.cleanup();
    await adapter.close();
  });

  describe("getOrCreateSession", () => {
    it("should create a new session", async () => {
      const session = await sessionManager.getOrCreateSession("test-project");
      expect(session).toBeDefined();
      expect(session.session_id).toBeDefined();
      expect(session.tenant_id).toBe(tenantId);
      expect(session.project).toBe("test-project");
    });

    it("should return the same session on subsequent calls", async () => {
      const session1 = await sessionManager.getOrCreateSession();
      const session2 = await sessionManager.getOrCreateSession();
      expect(session1.session_id).toBe(session2.session_id);
    });

    it("should create new session after timeout", async () => {
      const session1 = await sessionManager.getOrCreateSession();

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const session2 = await sessionManager.getOrCreateSession();
      expect(session2.session_id).not.toBe(session1.session_id);
    });
  });

  describe("getCurrentSessionId", () => {
    it("should return null before any session is created", () => {
      expect(sessionManager.getCurrentSessionId()).toBeNull();
    });

    it("should return session ID after creation", async () => {
      const session = await sessionManager.getOrCreateSession();
      expect(sessionManager.getCurrentSessionId()).toBe(session.session_id);
    });
  });

  describe("endCurrentSession", () => {
    it("should end the current session", async () => {
      const session = await sessionManager.getOrCreateSession();
      await sessionManager.endCurrentSession();

      expect(sessionManager.getCurrentSessionId()).toBeNull();

      // Verify session is ended in DB
      const dbSession = await adapter.getSession(session.session_id);
      expect(dbSession).not.toBeNull();
      expect(dbSession!.ended_at).toBeDefined();
    });

    it("should handle ending when no session exists", async () => {
      // Should not throw
      await sessionManager.endCurrentSession();
      expect(sessionManager.getCurrentSessionId()).toBeNull();
    });
  });

  describe("recordActivity", () => {
    it("should keep session alive", async () => {
      const session = await sessionManager.getOrCreateSession();

      // Record activity before timeout
      await new Promise((resolve) => setTimeout(resolve, 500));
      sessionManager.recordActivity();

      // Wait more but still within timeout from last activity
      await new Promise((resolve) => setTimeout(resolve, 500));

      const session2 = await sessionManager.getOrCreateSession();
      expect(session2.session_id).toBe(session.session_id);
    });
  });

  describe("cleanup", () => {
    it("should end session and clear state", async () => {
      await sessionManager.getOrCreateSession();
      await sessionManager.cleanup();
      expect(sessionManager.getCurrentSessionId()).toBeNull();
    });
  });

  describe("with MemoryIndex auto-update", () => {
    it("should call memoryIndex.update on session end when configured", async () => {
      const mockMemoryIndex = {
        update: vi.fn().mockResolvedValue({ path: "/test", content: "test" }),
        read: vi.fn(),
        gatherData: vi.fn(),
        generateMarkdown: vi.fn(),
      };

      const sm = new SessionManager(
        adapter,
        mockMemoryIndex as any,
        {
          tenantId,
          sessionTimeoutMs: 1000,
          autoUpdateIndex: true,
        }
      );

      await sm.getOrCreateSession();
      await sm.endCurrentSession();

      expect(mockMemoryIndex.update).toHaveBeenCalledOnce();
      await sm.cleanup();
    });
  });
});
