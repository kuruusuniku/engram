/**
 * Adapter Factory - Creates the appropriate StorageAdapter based on config
 *
 * Phase 4: Supports sqlite, turso, and hybrid storage types.
 * Multi-tenant: file separation for SQLite, DB-per-tenant for Turso.
 */

import type { StorageAdapter } from "./adapter.js";
import type { StorageConfig } from "./types.js";
import { SQLiteAdapter } from "./sqlite-adapter.js";
import { TursoAdapter } from "./turso-adapter.js";
import { HybridAdapter } from "./hybrid-adapter.js";

/**
 * Create a storage adapter based on configuration.
 *
 * For multi-tenant scenarios:
 * - SQLite: uses {dbPath}/{tenantId}.db file separation
 * - Turso: uses per-tenant database URL
 * - Hybrid: local SQLite file + Turso cloud
 */
export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  switch (config.type) {
    case "sqlite":
      return new SQLiteAdapter();

    case "turso":
      return new TursoAdapter();

    case "hybrid":
      return new HybridAdapter();

    default:
      throw new Error(`Unknown storage type: ${(config as StorageConfig).type}`);
  }
}

/**
 * Resolve the database path for multi-tenant SQLite.
 * Converts a base path to a tenant-specific path.
 *
 * Examples:
 *   resolveMultiTenantPath("./data/memory.db", "tenant-1") => "./data/tenant-1.db"
 *   resolveMultiTenantPath(":memory:", "tenant-1") => ":memory:" (no change for in-memory)
 */
export function resolveMultiTenantPath(
  basePath: string,
  tenantId: string
): string {
  if (basePath === ":memory:" || basePath === "file::memory:") {
    return basePath;
  }

  // Replace the filename with tenant-specific name
  const lastSlash = Math.max(basePath.lastIndexOf("/"), basePath.lastIndexOf("\\"));
  const dir = lastSlash >= 0 ? basePath.substring(0, lastSlash + 1) : "./";
  return `${dir}${tenantId}.db`;
}
