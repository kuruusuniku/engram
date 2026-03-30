import { describe, it, expect } from "vitest";
import {
  createStorageAdapter,
  resolveMultiTenantPath,
} from "../storage/adapter-factory.js";
import { SQLiteAdapter } from "../storage/sqlite-adapter.js";
import { TursoAdapter } from "../storage/turso-adapter.js";
import { HybridAdapter } from "../storage/hybrid-adapter.js";

describe("Adapter Factory", () => {
  describe("createStorageAdapter", () => {
    it("should create SQLiteAdapter for sqlite type", () => {
      const adapter = createStorageAdapter({
        type: "sqlite",
        dbPath: ":memory:",
        tenantId: "test",
      });
      expect(adapter).toBeInstanceOf(SQLiteAdapter);
    });

    it("should create TursoAdapter for turso type", () => {
      const adapter = createStorageAdapter({
        type: "turso",
        tursoUrl: "file::memory:",
        tenantId: "test",
      });
      expect(adapter).toBeInstanceOf(TursoAdapter);
    });

    it("should create HybridAdapter for hybrid type", () => {
      const adapter = createStorageAdapter({
        type: "hybrid",
        dbPath: ":memory:",
        tursoUrl: "file::memory:",
        tenantId: "test",
      });
      expect(adapter).toBeInstanceOf(HybridAdapter);
    });

    it("should throw for unknown storage type", () => {
      expect(() =>
        createStorageAdapter({
          type: "unknown" as "sqlite",
          tenantId: "test",
        })
      ).toThrow("Unknown storage type");
    });
  });

  describe("resolveMultiTenantPath", () => {
    it("should return tenant-specific path", () => {
      const result = resolveMultiTenantPath("./data/memory.db", "tenant-1");
      expect(result).toBe("./data/tenant-1.db");
    });

    it("should handle paths with directory separator", () => {
      const result = resolveMultiTenantPath("/var/data/memory.db", "org-abc");
      expect(result).toBe("/var/data/org-abc.db");
    });

    it("should not change :memory: path", () => {
      const result = resolveMultiTenantPath(":memory:", "tenant-1");
      expect(result).toBe(":memory:");
    });

    it("should not change file::memory: path", () => {
      const result = resolveMultiTenantPath("file::memory:", "tenant-1");
      expect(result).toBe("file::memory:");
    });

    it("should handle filename-only paths", () => {
      const result = resolveMultiTenantPath("memory.db", "tenant-1");
      expect(result).toBe("./tenant-1.db");
    });
  });
});
