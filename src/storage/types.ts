/**
 * Memory MCP Server - Type Definitions
 * A-MEM (Zettelkasten) style note structure with Turso hybrid support
 */

// --- Tenant ---

export interface Tenant {
  tenant_id: string;
  name: string;
  created_at: string;
  config?: Record<string, unknown>;
}

// --- Session ---

export interface Session {
  session_id: string;
  tenant_id: string;
  project?: string;
  started_at: string;
  ended_at?: string;
  metadata?: Record<string, unknown>;
}

// --- Note (A-MEM style) ---

export interface Note {
  note_id: string;
  tenant_id: string;
  session_id?: string;
  role: "user" | "assistant" | "system" | "summary";
  content: string;
  summary?: string;
  keywords?: string[];
  tags?: string[];
  context_desc?: string;
  embedding?: Float32Array;
  importance: number;
  created_at: string;
  updated_at: string;
}

export interface CreateNoteInput {
  tenant_id: string;
  session_id?: string;
  role: "user" | "assistant" | "system" | "summary";
  content: string;
  summary?: string;
  keywords?: string[];
  tags?: string[];
  context_desc?: string;
  importance?: number;
}

// --- Note Link ---

export interface NoteLink {
  link_id: string;
  source_id: string;
  target_id: string;
  relation?: string;
  strength: number;
  created_at: string;
}

// --- Search ---

export interface SearchOptions {
  tenant_id: string;
  date_from?: string;
  date_to?: string;
  project?: string;
  tags?: string[];
  session_id?: string;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  note: Note;
  score: number;
  match_type: "fts" | "vector" | "hybrid";
}

// --- Stats ---

export interface MemoryStats {
  total_notes: number;
  total_sessions: number;
  total_links: number;
  notes_by_role: Record<string, number>;
  date_range: {
    earliest: string | null;
    latest: string | null;
  };
}

export interface KeywordCount {
  keyword: string;
  count: number;
}

// --- Phase 3: Extended keyword stats ---

export interface KeywordWithDate {
  keyword: string;
  count: number;
  last_seen: string;
}

export interface HubNote {
  note_id: string;
  keywords: string[];
  link_count: number;
}

export interface SummaryOptions {
  tenant_id: string;
  date_from?: string;
  date_to?: string;
  project?: string;
  limit?: number;
}

// --- Config ---

export interface StorageConfig {
  type: "sqlite" | "turso" | "hybrid";
  /** Local SQLite file path */
  dbPath?: string;
  /** Turso cloud URL */
  tursoUrl?: string;
  /** Turso auth token */
  tursoAuthToken?: string;
  /** Hybrid sync interval in ms (default: 30000) */
  syncIntervalMs?: number;
  /** Sync to cloud on every write (default: false) */
  syncOnWrite?: boolean;
  /** Tenant ID */
  tenantId: string;
}
