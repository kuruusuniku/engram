/**
 * StorageAdapter - Abstract interface for storage backends
 *
 * Implementations:
 * - SQLiteAdapter: Local SQLite file (Phase 1)
 * - TursoAdapter: Turso cloud (Phase 4)
 * - HybridAdapter: Local SQLite + Turso sync (Phase 4)
 */

import type {
  Tenant,
  Session,
  Note,
  CreateNoteInput,
  NoteLink,
  SearchOptions,
  SearchResult,
  MemoryStats,
  KeywordCount,
  KeywordWithDate,
  HubNote,
  SummaryOptions,
  StorageConfig,
} from "./types.js";

export interface StorageAdapter {
  // --- Lifecycle ---

  /** Initialize the storage backend (create tables, connect, etc.) */
  initialize(config: StorageConfig): Promise<void>;

  /** Close the storage backend */
  close(): Promise<void>;

  // --- Tenant Management ---

  createTenant(tenant: Omit<Tenant, "created_at">): Promise<Tenant>;
  getTenant(tenantId: string): Promise<Tenant | null>;

  // --- Session Management ---

  createSession(
    session: Omit<Session, "started_at" | "ended_at">
  ): Promise<Session>;
  endSession(sessionId: string): Promise<void>;
  getSession(sessionId: string): Promise<Session | null>;

  // --- Note CRUD ---

  saveNote(input: CreateNoteInput): Promise<Note>;
  getNote(noteId: string): Promise<Note | null>;
  updateNote(noteId: string, updates: Partial<CreateNoteInput>): Promise<Note>;
  deleteNote(noteId: string): Promise<void>;

  // --- Note Links ---

  addLink(
    link: Omit<NoteLink, "link_id" | "created_at">
  ): Promise<NoteLink>;
  getLinks(noteId: string): Promise<NoteLink[]>;

  // --- Search ---

  /** Full-text search using FTS5 / tsvector */
  fullTextSearch(
    query: string,
    options: SearchOptions
  ): Promise<SearchResult[]>;

  /** Vector similarity search (Phase 2+) */
  vectorSearch?(
    embedding: number[],
    options: SearchOptions
  ): Promise<SearchResult[]>;

  // --- Vectors (Phase 2+) ---

  saveEmbedding?(noteId: string, embedding: number[]): Promise<void>;

  // --- Stats ---

  getStats(tenantId: string): Promise<MemoryStats>;
  getTopKeywords(tenantId: string, limit: number): Promise<KeywordCount[]>;

  // --- Phase 3: Extended queries ---

  /** Get recent notes (within last N days) */
  getRecentNotes?(tenantId: string, days: number, limit: number): Promise<Note[]>;

  /** Get top keywords with last-seen date */
  getTopKeywordsWithDates?(tenantId: string, limit: number): Promise<KeywordWithDate[]>;

  /** Get hub notes (highest link count) */
  getHubNotes?(tenantId: string, limit: number): Promise<HubNote[]>;

  /** Get notes for summarization */
  getNotesForSummary?(options: SummaryOptions): Promise<Note[]>;

  /** Get active (non-ended) sessions */
  getActiveSessions?(tenantId: string): Promise<Session[]>;
}
