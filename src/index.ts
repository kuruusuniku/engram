/**
 * Memory MCP Server - Entry Point
 *
 * Starts the MCP server over stdio transport.
 *
 * Storage mode is auto-detected:
 *   - TURSO_DATABASE_URL set → hybrid (local SQLite + Turso cloud sync)
 *   - TURSO_DATABASE_URL unset → sqlite (local only)
 *
 * Environment variables:
 *   MEMORY_DB_PATH       - Path to SQLite database file (default: ./memory.db)
 *   MEMORY_TENANT_ID     - Tenant ID (default: "default")
 *   MEMORY_INDEX_PATH    - Path to MEMORY.md (auto-generated index, optional)
 *   CLAUDE_MD_PATH       - Path to CLAUDE.md (project context, optional)
 *   OPENAI_API_KEY       - OpenAI API key for embeddings + LLM structuring (optional)
 *   TURSO_DATABASE_URL   - Turso database URL (auto-enables hybrid mode)
 *   TURSO_AUTH_TOKEN     - Turso auth token
 *   MEMORY_SYNC_INTERVAL - Hybrid sync interval in ms (default: 30000)
 *   MEMORY_SYNC_ON_WRITE - Sync to cloud on every write (default: false)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemoryServer } from "./server.js";
import type { StorageConfig } from "./storage/index.js";
import { createLogger } from "./logger.js";

const log = createLogger("main");

async function main(): Promise<void> {
  const dbPath = process.env.MEMORY_DB_PATH || "./memory.db";
  const tenantId = process.env.MEMORY_TENANT_ID || "default";
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;

  // Auto-detect: Turso URL present → hybrid, otherwise → sqlite
  const storageType: StorageConfig["type"] = tursoUrl ? "hybrid" : "sqlite";

  const config: StorageConfig = {
    type: storageType,
    dbPath,
    tenantId,
    tursoUrl,
    tursoAuthToken,
    syncIntervalMs: process.env.MEMORY_SYNC_INTERVAL
      ? parseInt(process.env.MEMORY_SYNC_INTERVAL, 10)
      : undefined,
    syncOnWrite: process.env.MEMORY_SYNC_ON_WRITE === "true",
  };

  const memoryIndexPath = process.env.MEMORY_INDEX_PATH || undefined;
  const claudeMdPath = process.env.CLAUDE_MD_PATH || undefined;

  log.info("Starting server", {
    type: config.type,
    db: config.dbPath,
    tenant: config.tenantId,
    turso: tursoUrl ? "connected" : "none",
  });
  if (memoryIndexPath) {
    log.info("MEMORY.md index configured", { path: memoryIndexPath });
  }
  if (claudeMdPath) {
    log.info("CLAUDE.md context configured", { path: claudeMdPath });
  }

  const { server, adapter, sessionManager, embeddingQueue } = await createMemoryServer({
    storageConfig: config,
    memoryIndexPath,
    claudeMdPath,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info("Server running on stdio transport");

  // Handle graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    try {
      await embeddingQueue.cleanup();
    } catch {
      // ignore cleanup errors during shutdown
    }
    try {
      await sessionManager.cleanup();
    } catch {
      // ignore cleanup errors during shutdown
    }
    try {
      await adapter.close();
    } catch {
      // ignore close errors during shutdown
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  log.error("Fatal error", { error: String(error) });
  process.exit(1);
});
