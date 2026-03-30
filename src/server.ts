/**
 * Memory MCP Server
 *
 * MCP server that provides memory_save, memory_search, memory_stats,
 * and memory_associate tools for storing and retrieving Claude Code
 * conversation logs with hybrid search and associative retrieval.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { StorageAdapter, StorageConfig } from "./storage/index.js";
import { createStorageAdapter } from "./storage/index.js";
import { HybridAdapter } from "./storage/hybrid-adapter.js";
import { createEmbeddingClient, type EmbeddingClient } from "./embedding.js";
import { createLLMClient, type LLMClient } from "./llm.js";
import { NoteBuilder } from "./note-builder.js";
import { SearchEngine } from "./search-engine.js";
import { AssociateEngine } from "./associate.js";
import { MemoryIndex, type MemoryIndexConfig } from "./memory-index.js";
import { ClaudeContext, type ClaudeContextConfig } from "./claude-context.js";
import { SessionManager, type SessionManagerConfig } from "./session-manager.js";
import { EmbeddingQueue, type EmbeddingQueueConfig } from "./embedding-queue.js";
import { ImportanceScorer, type ImportanceScorerConfig } from "./importance-scorer.js";
import { DataTransfer } from "./data-transfer.js";
import { createLogger } from "./logger.js";

const DEFAULT_TENANT_ID = "default";
const DEFAULT_TENANT_NAME = "Default Tenant";

export interface MemoryServerOptions {
  storageConfig: StorageConfig;
  /** Custom embedding client (for testing) */
  embeddingClient?: EmbeddingClient;
  /** Custom LLM client (for testing) */
  llmClient?: LLMClient;
  /** MEMORY.md index path (null to disable) */
  memoryIndexPath?: string | null;
  /** CLAUDE.md path (null to disable) */
  claudeMdPath?: string | null;
  /** Session timeout in ms (default: 30min) */
  sessionTimeoutMs?: number;
  /** Embedding queue config */
  embeddingQueueConfig?: EmbeddingQueueConfig;
  /** Importance scorer config */
  importanceScorerConfig?: ImportanceScorerConfig;
}

export interface MemoryServerContext {
  server: McpServer;
  adapter: StorageAdapter;
  embeddingClient: EmbeddingClient;
  llmClient: LLMClient;
  noteBuilder: NoteBuilder;
  searchEngine: SearchEngine;
  associateEngine: AssociateEngine;
  memoryIndex: MemoryIndex | null;
  claudeContext: ClaudeContext | null;
  sessionManager: SessionManager;
  embeddingQueue: EmbeddingQueue;
  importanceScorer: ImportanceScorer;
  dataTransfer: DataTransfer;
}

const serverLog = createLogger("server");

export async function createMemoryServer(
  options: MemoryServerOptions
): Promise<MemoryServerContext> {
  const { storageConfig } = options;

  // Initialize storage adapter using factory
  const adapter: StorageAdapter = createStorageAdapter(storageConfig);

  await adapter.initialize(storageConfig);

  // Ensure default tenant exists
  const existingTenant = await adapter.getTenant(
    storageConfig.tenantId || DEFAULT_TENANT_ID
  );
  if (!existingTenant) {
    await adapter.createTenant({
      tenant_id: storageConfig.tenantId || DEFAULT_TENANT_ID,
      name: DEFAULT_TENANT_NAME,
    });
  }

  const tenantId = storageConfig.tenantId || DEFAULT_TENANT_ID;

  // Initialize Phase 2 components
  const embeddingClient = options.embeddingClient ?? createEmbeddingClient();
  const llmClient = options.llmClient ?? createLLMClient();
  const noteBuilder = new NoteBuilder(llmClient, embeddingClient, adapter);
  const searchEngine = new SearchEngine(adapter, embeddingClient);
  const associateEngine = new AssociateEngine(adapter, embeddingClient);

  // Initialize Phase 5 components
  const embeddingQueue = new EmbeddingQueue(embeddingClient, adapter, options.embeddingQueueConfig);
  const importanceScorer = new ImportanceScorer(options.importanceScorerConfig);
  const dataTransfer = new DataTransfer(adapter);

  // Initialize Phase 3 components
  let memoryIndex: MemoryIndex | null = null;
  if (options.memoryIndexPath) {
    const indexConfig: MemoryIndexConfig = {
      indexPath: options.memoryIndexPath,
      tenantId,
    };
    memoryIndex = new MemoryIndex(adapter, llmClient, indexConfig);
  }

  let claudeContext: ClaudeContext | null = null;
  if (options.claudeMdPath) {
    const contextConfig: ClaudeContextConfig = {
      claudeMdPath: options.claudeMdPath,
      tenantId,
    };
    claudeContext = new ClaudeContext(adapter, contextConfig);
  }

  const sessionManagerConfig: SessionManagerConfig = {
    tenantId,
    sessionTimeoutMs: options.sessionTimeoutMs,
    autoUpdateIndex: !!memoryIndex,
  };
  const sessionManager = new SessionManager(adapter, memoryIndex, sessionManagerConfig);

  // Create MCP server
  const server = new McpServer({
    name: "memory-mcp-server",
    version: "0.5.0",
  });

  // --- Tool: memory_save ---
  server.tool(
    "memory_save",
    "Save a conversation message as a memory note. Automatically generates summary, keywords, tags, embeddings, and links using LLM and embedding models when available.",
    {
      content: z.string().describe("The content to save as a memory note"),
      role: z
        .enum(["user", "assistant", "system", "summary"])
        .describe("The role of the message sender"),
      session_id: z
        .string()
        .optional()
        .describe("Session ID to associate this note with"),
      project: z
        .string()
        .optional()
        .describe("Project name or path to associate this note with"),
      keywords: z
        .array(z.string())
        .optional()
        .describe("Keywords for this note (auto-generated if not provided)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags for categorization (auto-generated if not provided)"),
    },
    async (params) => {
      try {
        // If session_id provided, ensure session exists
        if (params.session_id) {
          const session = await adapter.getSession(params.session_id);
          if (!session) {
            await adapter.createSession({
              session_id: params.session_id,
              tenant_id: tenantId,
              project: params.project,
            });
          }
        }

        // Phase 2: Enhance note with LLM structuring
        let noteInput: import("./storage/types.js").CreateNoteInput = {
          tenant_id: tenantId,
          session_id: params.session_id,
          role: params.role as "user" | "assistant" | "system" | "summary",
          content: params.content,
          keywords: params.keywords,
          tags: params.tags,
        };

        noteInput = await noteBuilder.enhance(noteInput);

        const note = await adapter.saveNote(noteInput);

        // Phase 2: Post-process (embedding + links) in background
        const postResult = await noteBuilder.postProcess(note, {
          tenant_id: tenantId,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  note_id: note.note_id,
                  created_at: note.created_at,
                  summary: note.summary,
                  keywords: note.keywords,
                  tags: note.tags,
                  embedding_generated: postResult.embeddingGenerated,
                  links_created: postResult.linksCreated,
                  message: "Memory saved successfully.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool: memory_search ---
  server.tool(
    "memory_search",
    "Search past memories using hybrid search (FTS5 full-text + vector similarity with RRF fusion). Returns relevant conversation logs and notes matching the query.",
    {
      query: z
        .string()
        .describe(
          "Search query (keywords or natural language). Supports FTS5 syntax: AND, OR, NOT, quotes for phrases."
        ),
      date_from: z
        .string()
        .optional()
        .describe("Filter: earliest date (ISO 8601 format)"),
      date_to: z
        .string()
        .optional()
        .describe("Filter: latest date (ISO 8601 format)"),
      project: z
        .string()
        .optional()
        .describe("Filter: project name"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Filter: tags to match"),
      session_id: z
        .string()
        .optional()
        .describe("Filter: specific session ID"),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe("Maximum number of results (default: 10)"),
    },
    async (params) => {
      try {
        // Phase 2: Use hybrid search (FTS + vector + RRF)
        const results = await searchEngine.hybridSearch(params.query, {
          tenant_id: tenantId,
          date_from: params.date_from,
          date_to: params.date_to,
          project: params.project,
          tags: params.tags,
          session_id: params.session_id,
          limit: params.limit,
        });

        const formattedResults = results.map((r) => ({
          note_id: r.note.note_id,
          role: r.note.role,
          content: r.note.content,
          summary: r.note.summary,
          keywords: r.note.keywords,
          tags: r.note.tags,
          score: r.score,
          match_type: r.match_type,
          created_at: r.note.created_at,
          session_id: r.note.session_id,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  count: formattedResults.length,
                  results: formattedResults,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool: memory_associate ---
  server.tool(
    "memory_associate",
    "Discover related memories through associative search (serendipity search). Uses TF-IDF random walk, note link exploration, and vector space exploration to find surprising connections.",
    {
      seed: z
        .string()
        .optional()
        .describe(
          "Seed text to start association from. If omitted, starts from random notes."
        ),
      temperature: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.5)
        .describe(
          "Association temperature: 0.0 = focused/similar, 1.0 = exploratory/surprising (default: 0.5)"
        ),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe("Maximum number of results (default: 5)"),
    },
    async (params) => {
      try {
        const results = await associateEngine.associate({
          seed: params.seed,
          temperature: params.temperature,
          limit: params.limit,
          tenant_id: tenantId,
        });

        const formattedResults = results.map((r) => ({
          note_id: r.note.note_id,
          role: r.note.role,
          content: r.note.content,
          summary: r.note.summary,
          keywords: r.note.keywords,
          tags: r.note.tags,
          serendipity_score: r.serendipityScore,
          discovery_path: r.discoveryPath,
          created_at: r.note.created_at,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  count: formattedResults.length,
                  seed: params.seed ?? "(random)",
                  temperature: params.temperature,
                  results: formattedResults,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool: memory_stats ---
  server.tool(
    "memory_stats",
    "Get statistics about stored memories: total notes, sessions, links, date range, etc.",
    {},
    async () => {
      try {
        const stats = await adapter.getStats(tenantId);
        const topKeywords = await adapter.getTopKeywords(tenantId, 20);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  stats,
                  top_keywords: topKeywords,
                  capabilities: {
                    vector_search: embeddingClient.available,
                    llm_structuring: llmClient.available,
                    embedding_dimension: embeddingClient.dimension,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool: memory_summarize ---
  server.tool(
    "memory_summarize",
    "Summarize memories for a given period or project. Uses LLM to create a coherent summary from stored notes.",
    {
      project: z
        .string()
        .optional()
        .describe("Filter by project name"),
      date_from: z
        .string()
        .optional()
        .describe("Start date for summary period (ISO 8601)"),
      date_to: z
        .string()
        .optional()
        .describe("End date for summary period (ISO 8601)"),
    },
    async (params) => {
      try {
        // Get notes for the specified period/project
        let notes: import("./storage/types.js").Note[] = [];
        if (adapter.getNotesForSummary) {
          notes = await adapter.getNotesForSummary({
            tenant_id: tenantId,
            date_from: params.date_from,
            date_to: params.date_to,
            project: params.project,
            limit: 50,
          });
        }

        if (notes.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  summary: "No memories found for the specified criteria.",
                  note_count: 0,
                }),
              },
            ],
          };
        }

        // Build summary using LLM if available
        let summary: string;
        if (llmClient.available) {
          const notesText = notes
            .map(
              (n) =>
                `[${n.created_at}] (${n.role}) ${n.summary ?? n.content.slice(0, 300)}`
            )
            .join("\n");

          const prompt = `Summarize the following conversation memories into a coherent overview. Focus on key decisions, topics discussed, and outcomes.\n\n${notesText}`;
          const systemPrompt =
            "You are a summarization assistant. Create a concise but comprehensive summary of the provided conversation memories. Respond in the same language as the input. Use bullet points for key topics.";

          const llmSummary = await llmClient.complete(prompt, systemPrompt);
          summary = llmSummary ?? buildBasicSummary(notes);
        } else {
          summary = buildBasicSummary(notes);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  summary,
                  note_count: notes.length,
                  period: {
                    from: params.date_from ?? notes[0]?.created_at ?? null,
                    to:
                      params.date_to ??
                      notes[notes.length - 1]?.created_at ??
                      null,
                  },
                  project: params.project ?? null,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool: memory_update_index ---
  server.tool(
    "memory_update_index",
    "Update the MEMORY.md index file with latest memory data. Also optionally imports CLAUDE.md content as searchable context.",
    {},
    async () => {
      try {
        const results: Record<string, unknown> = { success: true };

        // Update MEMORY.md
        if (memoryIndex) {
          const indexResult = await memoryIndex.update();
          results.memory_md = {
            updated: true,
            path: indexResult.path,
            content_length: indexResult.content.length,
          };
        } else {
          results.memory_md = {
            updated: false,
            reason: "MEMORY_INDEX_PATH not configured",
          };
        }

        // Import CLAUDE.md context
        if (claudeContext) {
          const hasChanged = await claudeContext.hasChanged();
          if (hasChanged) {
            const importedNotes = await claudeContext.importContext();
            results.claude_md = {
              imported: true,
              sections: importedNotes.length,
            };
          } else {
            results.claude_md = {
              imported: false,
              reason: "No changes detected",
            };
          }
        } else {
          results.claude_md = {
            imported: false,
            reason: "CLAUDE_MD_PATH not configured",
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool: memory_migrate ---
  server.tool(
    "memory_migrate",
    "Migrate memory data from one storage backend to another (e.g., SQLite to Turso). Creates the target adapter, copies all tenants, sessions, notes, and links.",
    {
      target_type: z
        .enum(["sqlite", "turso"])
        .describe("Target storage type to migrate to"),
      target_db_path: z
        .string()
        .optional()
        .describe("Target SQLite database path (for sqlite target)"),
      target_turso_url: z
        .string()
        .optional()
        .describe("Target Turso database URL (for turso target)"),
      target_turso_token: z
        .string()
        .optional()
        .describe("Target Turso auth token (for turso target)"),
    },
    async (params) => {
      try {
        const { TursoAdapter } = await import("./storage/turso-adapter.js");
        const { SQLiteAdapter } = await import("./storage/sqlite-adapter.js");

        // Create target adapter
        let targetAdapter: StorageAdapter;
        if (params.target_type === "turso") {
          targetAdapter = new TursoAdapter();
          await targetAdapter.initialize({
            type: "turso",
            tenantId,
            tursoUrl: params.target_turso_url,
            tursoAuthToken: params.target_turso_token,
          });
        } else {
          targetAdapter = new SQLiteAdapter();
          await targetAdapter.initialize({
            type: "sqlite",
            tenantId,
            dbPath: params.target_db_path,
          });
        }

        // Migrate tenant
        const sourceTenant = await adapter.getTenant(tenantId);
        if (sourceTenant) {
          const existingTarget = await targetAdapter.getTenant(tenantId);
          if (!existingTarget) {
            await targetAdapter.createTenant({
              tenant_id: sourceTenant.tenant_id,
              name: sourceTenant.name,
              config: sourceTenant.config,
            });
          }
        }

        // Get all source notes
        let notes: import("./storage/types.js").Note[] = [];
        if (adapter.getNotesForSummary) {
          notes = await adapter.getNotesForSummary({
            tenant_id: tenantId,
            limit: 100000,
          });
        }

        // Migrate notes
        let migratedNotes = 0;
        for (const note of notes) {
          try {
            await targetAdapter.saveNote({
              tenant_id: note.tenant_id,
              session_id: note.session_id,
              role: note.role,
              content: note.content,
              summary: note.summary,
              keywords: note.keywords,
              tags: note.tags,
              context_desc: note.context_desc,
              importance: note.importance,
            });
            migratedNotes++;
          } catch {
            // Skip notes that fail (e.g., duplicate)
          }
        }

        // Get stats for verification
        const targetStats = await targetAdapter.getStats(tenantId);
        await targetAdapter.close();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  migrated_notes: migratedNotes,
                  target_type: params.target_type,
                  target_stats: targetStats,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool: memory_export ---
  server.tool(
    "memory_export",
    "Export memory data as JSON Lines (JSONL) format. Includes notes, links, and sessions for backup or migration.",
    {
      date_from: z
        .string()
        .optional()
        .describe("Export notes from this date (ISO 8601)"),
      date_to: z
        .string()
        .optional()
        .describe("Export notes until this date (ISO 8601)"),
      include_links: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include note links in export (default: true)"),
      include_sessions: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include sessions in export (default: true)"),
    },
    async (params) => {
      try {
        const result = await dataTransfer.export({
          tenantId,
          dateFrom: params.date_from,
          dateTo: params.date_to,
          includeLinks: params.include_links,
          includeSessions: params.include_sessions,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  stats: result.stats,
                  format: "jsonl",
                  data: result.content,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool: memory_import ---
  server.tool(
    "memory_import",
    "Import memory data from JSON Lines (JSONL) format. Restores notes, links, and sessions from a previous export.",
    {
      data: z
        .string()
        .describe("JSONL content to import (from a previous memory_export)"),
      merge_strategy: z
        .enum(["skip", "overwrite"])
        .optional()
        .default("skip")
        .describe("How to handle duplicate notes: skip (default) or overwrite"),
    },
    async (params) => {
      try {
        const result = await dataTransfer.import(params.data, {
          targetTenantId: tenantId,
          mergeStrategy: params.merge_strategy,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  imported: result.imported,
                  skipped: result.skipped,
                  errors:
                    result.errors.length > 0
                      ? result.errors.slice(0, 10)
                      : undefined,
                  error_count: result.errors.length,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool: memory_sync_status ---
  if (adapter instanceof HybridAdapter) {
    server.tool(
      "memory_sync_status",
      "Get the current sync status of the hybrid adapter (pending operations, last sync time, errors).",
      {},
      async () => {
        const status = (adapter as HybridAdapter).getSyncStatus();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: true, sync_status: status },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  }

  return {
    server,
    adapter,
    embeddingClient,
    llmClient,
    noteBuilder,
    searchEngine,
    associateEngine,
    memoryIndex,
    claudeContext,
    sessionManager,
    embeddingQueue,
    importanceScorer,
    dataTransfer,
  };
}

/**
 * Build a basic summary without LLM
 */
function buildBasicSummary(notes: import("./storage/types.js").Note[]): string {
  const topicCounts = new Map<string, number>();
  for (const note of notes) {
    if (note.keywords) {
      for (const kw of note.keywords) {
        topicCounts.set(kw, (topicCounts.get(kw) || 0) + 1);
      }
    }
  }

  const topTopics = Array.from(topicCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic, count]) => `${topic} (${count}x)`);

  const roleBreakdown: Record<string, number> = {};
  for (const note of notes) {
    roleBreakdown[note.role] = (roleBreakdown[note.role] || 0) + 1;
  }

  const lines = [
    `Summary of ${notes.length} memories:`,
    `Period: ${notes[0]?.created_at ?? "N/A"} to ${notes[notes.length - 1]?.created_at ?? "N/A"}`,
    `Roles: ${Object.entries(roleBreakdown).map(([r, c]) => `${r}(${c})`).join(", ")}`,
    `Top topics: ${topTopics.join(", ")}`,
  ];

  return lines.join("\n");
}
