/**
 * SQLiteAdapter - Local SQLite storage backend using better-sqlite3
 *
 * Phase 1: Schema creation, CRUD, FTS5 + BM25 scoring
 * Phase 2: sqlite-vec integration for vector search
 */

import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type { StorageAdapter } from "./adapter.js";
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

/** Embedding dimension for vector search */
const EMBEDDING_DIMENSION = 1536;

export class SQLiteAdapter implements StorageAdapter {
  private db: Database.Database | null = null;
  private config: StorageConfig | null = null;
  private vecEnabled = false;

  // --- Lifecycle ---

  async initialize(config: StorageConfig): Promise<void> {
    this.config = config;
    const dbPath = config.dbPath ?? ":memory:";
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    // Try to load sqlite-vec extension
    this.loadVecExtension();

    this.createSchema();
  }

  /**
   * Attempt to load sqlite-vec extension. Non-fatal if unavailable.
   */
  private loadVecExtension(): void {
    try {
      const require = createRequire(import.meta.url);
      const sqliteVec = require("sqlite-vec");
      sqliteVec.load(this.db);
      this.vecEnabled = true;
    } catch {
      // sqlite-vec not available - vector search will be disabled
      this.vecEnabled = false;
      console.error(
        "[sqlite-adapter] sqlite-vec extension not available. Vector search disabled."
      );
    }
  }

  /** Whether vector search is enabled */
  get vectorSearchEnabled(): boolean {
    return this.vecEnabled;
  }

  /**
   * Ensure FTS5 table uses trigram tokenizer.
   * Migrates from unicode61 to trigram if needed (for Japanese support).
   */
  private ensureFtsTrigram(db: Database.Database): void {
    const ftsExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='notes_fts'"
      )
      .get();

    if (ftsExists) {
      // Check if existing FTS table uses trigram
      const createSql = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='notes_fts'"
        )
        .get() as { sql: string } | undefined;

      if (createSql && !createSql.sql.includes("trigram")) {
        // Migrate: drop old unicode61 FTS and rebuild with trigram
        db.exec(`
          DROP TRIGGER IF EXISTS notes_ai;
          DROP TRIGGER IF EXISTS notes_ad;
          DROP TRIGGER IF EXISTS notes_au;
          DROP TABLE notes_fts;
        `);
        // Fall through to create new FTS table below
      } else {
        return; // Already trigram, nothing to do
      }
    }

    db.exec(`
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        content,
        summary,
        keywords,
        tags,
        context_desc,
        content=notes,
        content_rowid=rowid,
        tokenize='trigram'
      );

      -- Triggers to keep FTS index in sync
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, content, summary, keywords, tags, context_desc)
        VALUES (new.rowid, new.content, new.summary, new.keywords, new.tags, new.context_desc);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, content, summary, keywords, tags, context_desc)
        VALUES ('delete', old.rowid, old.content, old.summary, old.keywords, old.tags, old.context_desc);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, content, summary, keywords, tags, context_desc)
        VALUES ('delete', old.rowid, old.content, old.summary, old.keywords, old.tags, old.context_desc);
        INSERT INTO notes_fts(rowid, content, summary, keywords, tags, context_desc)
        VALUES (new.rowid, new.content, new.summary, new.keywords, new.tags, new.context_desc);
      END;

      -- Backfill existing notes into new FTS index
      INSERT INTO notes_fts(rowid, content, summary, keywords, tags, context_desc)
      SELECT rowid, content, summary, keywords, tags, context_desc FROM notes;
    `);
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): Database.Database {
    if (!this.db) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    return this.db;
  }

  private createSchema(): void {
    const db = this.getDb();

    db.exec(`
      -- Tenant management
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id   TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        config      TEXT
      );

      -- Conversation sessions
      CREATE TABLE IF NOT EXISTS sessions (
        session_id  TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
        project     TEXT,
        started_at  TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at    TEXT,
        metadata    TEXT
      );

      -- Memory notes (A-MEM style)
      CREATE TABLE IF NOT EXISTS notes (
        note_id     TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
        session_id  TEXT REFERENCES sessions(session_id),
        role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'summary')),
        content     TEXT NOT NULL,
        summary     TEXT,
        keywords    TEXT,
        tags        TEXT,
        context_desc TEXT,
        importance  REAL DEFAULT 0.0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Note links (A-MEM style bidirectional links)
      CREATE TABLE IF NOT EXISTS note_links (
        link_id     TEXT PRIMARY KEY,
        source_id   TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
        target_id   TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
        relation    TEXT,
        strength    REAL DEFAULT 1.0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_notes_tenant ON notes(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id);
      CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at);
      CREATE INDEX IF NOT EXISTS idx_notes_role ON notes(role);
      CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links(source_id);
      CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_id);
    `);

    // FTS5 virtual table with trigram tokenizer (supports Japanese and all Unicode)
    this.ensureFtsTrigram(db);

    // Vector search table (sqlite-vec)
    if (this.vecEnabled) {
      const vecExists = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='notes_vec'"
        )
        .get();

      if (!vecExists) {
        db.exec(
          `CREATE VIRTUAL TABLE notes_vec USING vec0(embedding float[${EMBEDDING_DIMENSION}])`
        );
      }
    }
  }

  // --- Tenant Management ---

  async createTenant(
    input: Omit<Tenant, "created_at">
  ): Promise<Tenant> {
    const db = this.getDb();
    const tenant: Tenant = {
      ...input,
      tenant_id: input.tenant_id || uuidv4(),
      created_at: new Date().toISOString(),
    };

    db.prepare(
      `INSERT INTO tenants (tenant_id, name, created_at, config)
       VALUES (@tenant_id, @name, @created_at, @config)`
    ).run({
      tenant_id: tenant.tenant_id,
      name: tenant.name,
      created_at: tenant.created_at,
      config: tenant.config ? JSON.stringify(tenant.config) : null,
    });

    return tenant;
  }

  async getTenant(tenantId: string): Promise<Tenant | null> {
    const db = this.getDb();
    const row = db
      .prepare("SELECT * FROM tenants WHERE tenant_id = ?")
      .get(tenantId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToTenant(row);
  }

  // --- Session Management ---

  async createSession(
    input: Omit<Session, "started_at" | "ended_at">
  ): Promise<Session> {
    const db = this.getDb();
    const session: Session = {
      ...input,
      session_id: input.session_id || uuidv4(),
      started_at: new Date().toISOString(),
    };

    db.prepare(
      `INSERT INTO sessions (session_id, tenant_id, project, started_at, metadata)
       VALUES (@session_id, @tenant_id, @project, @started_at, @metadata)`
    ).run({
      session_id: session.session_id,
      tenant_id: session.tenant_id,
      project: session.project ?? null,
      started_at: session.started_at,
      metadata: session.metadata ? JSON.stringify(session.metadata) : null,
    });

    return session;
  }

  async endSession(sessionId: string): Promise<void> {
    const db = this.getDb();
    db.prepare(
      "UPDATE sessions SET ended_at = datetime('now') WHERE session_id = ?"
    ).run(sessionId);
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const db = this.getDb();
    const row = db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToSession(row);
  }

  // --- Note CRUD ---

  async saveNote(input: CreateNoteInput): Promise<Note> {
    const db = this.getDb();
    const now = new Date().toISOString();
    const note: Note = {
      note_id: uuidv4(),
      tenant_id: input.tenant_id,
      session_id: input.session_id,
      role: input.role,
      content: input.content,
      summary: input.summary,
      keywords: input.keywords,
      tags: input.tags,
      context_desc: input.context_desc,
      importance: input.importance ?? 0.0,
      created_at: now,
      updated_at: now,
    };

    db.prepare(
      `INSERT INTO notes (note_id, tenant_id, session_id, role, content, summary, keywords, tags, context_desc, importance, created_at, updated_at)
       VALUES (@note_id, @tenant_id, @session_id, @role, @content, @summary, @keywords, @tags, @context_desc, @importance, @created_at, @updated_at)`
    ).run({
      note_id: note.note_id,
      tenant_id: note.tenant_id,
      session_id: note.session_id ?? null,
      role: note.role,
      content: note.content,
      summary: note.summary ?? null,
      keywords: note.keywords ? JSON.stringify(note.keywords) : null,
      tags: note.tags ? JSON.stringify(note.tags) : null,
      context_desc: note.context_desc ?? null,
      importance: note.importance,
      created_at: note.created_at,
      updated_at: note.updated_at,
    });

    return note;
  }

  async getNote(noteId: string): Promise<Note | null> {
    const db = this.getDb();
    const row = db
      .prepare("SELECT * FROM notes WHERE note_id = ?")
      .get(noteId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToNote(row);
  }

  async updateNote(
    noteId: string,
    updates: Partial<CreateNoteInput>
  ): Promise<Note> {
    const db = this.getDb();
    const existing = await this.getNote(noteId);
    if (!existing) {
      throw new Error(`Note not found: ${noteId}`);
    }

    const fields: string[] = ["updated_at = datetime('now')"];
    const params: Record<string, unknown> = { note_id: noteId };

    if (updates.content !== undefined) {
      fields.push("content = @content");
      params.content = updates.content;
    }
    if (updates.summary !== undefined) {
      fields.push("summary = @summary");
      params.summary = updates.summary;
    }
    if (updates.keywords !== undefined) {
      fields.push("keywords = @keywords");
      params.keywords = JSON.stringify(updates.keywords);
    }
    if (updates.tags !== undefined) {
      fields.push("tags = @tags");
      params.tags = JSON.stringify(updates.tags);
    }
    if (updates.context_desc !== undefined) {
      fields.push("context_desc = @context_desc");
      params.context_desc = updates.context_desc;
    }
    if (updates.importance !== undefined) {
      fields.push("importance = @importance");
      params.importance = updates.importance;
    }

    db.prepare(
      `UPDATE notes SET ${fields.join(", ")} WHERE note_id = @note_id`
    ).run(params);

    return (await this.getNote(noteId))!;
  }

  async deleteNote(noteId: string): Promise<void> {
    const db = this.getDb();
    db.prepare("DELETE FROM notes WHERE note_id = ?").run(noteId);
  }

  // --- Note Links ---

  async addLink(
    input: Omit<NoteLink, "link_id" | "created_at">
  ): Promise<NoteLink> {
    const db = this.getDb();
    const link: NoteLink = {
      link_id: uuidv4(),
      ...input,
      created_at: new Date().toISOString(),
    };

    db.prepare(
      `INSERT INTO note_links (link_id, source_id, target_id, relation, strength, created_at)
       VALUES (@link_id, @source_id, @target_id, @relation, @strength, @created_at)`
    ).run({
      link_id: link.link_id,
      source_id: link.source_id,
      target_id: link.target_id,
      relation: link.relation ?? null,
      strength: link.strength,
      created_at: link.created_at,
    });

    return link;
  }

  async getLinks(noteId: string): Promise<NoteLink[]> {
    const db = this.getDb();
    const rows = db
      .prepare(
        "SELECT * FROM note_links WHERE source_id = ? OR target_id = ?"
      )
      .all(noteId, noteId) as Record<string, unknown>[];

    return rows.map(this.rowToNoteLink);
  }

  // --- Search ---

  async fullTextSearch(
    query: string,
    options: SearchOptions
  ): Promise<SearchResult[]> {
    const db = this.getDb();
    const limit = options.limit ?? 10;

    // Build WHERE conditions for filtering
    const conditions: string[] = ["n.tenant_id = @tenant_id"];
    const params: Record<string, unknown> = {
      tenant_id: options.tenant_id,
      query,
      limit,
    };

    if (options.date_from) {
      conditions.push("n.created_at >= @date_from");
      params.date_from = options.date_from;
    }
    if (options.date_to) {
      conditions.push("n.created_at <= @date_to");
      params.date_to = options.date_to;
    }
    if (options.session_id) {
      conditions.push("n.session_id = @session_id");
      params.session_id = options.session_id;
    }

    const whereClause = conditions.join(" AND ");

    // Build trigram-compatible FTS5 query
    const ftsQuery = this.buildTrigramQuery(query);

    // If all terms were too short for trigram, use LIKE fallback
    if (!ftsQuery) {
      return this.fallbackSearch(query, options);
    }

    params.query = ftsQuery;

    // FTS5 search with BM25 scoring
    const sql = `
      SELECT n.*,
             bm25(notes_fts, 1.0, 0.8, 0.6, 0.6, 0.5) as score
      FROM notes_fts
      JOIN notes n ON notes_fts.rowid = n.rowid
      WHERE notes_fts MATCH @query
        AND ${whereClause}
      ORDER BY score ASC
      LIMIT @limit
    `;

    try {
      const rows = db.prepare(sql).all(params) as Array<
        Record<string, unknown> & { score: number }
      >;

      let results = rows.map((row) => ({
        note: this.rowToNote(row),
        score: Math.abs(row.score as number), // BM25 returns negative values in SQLite
        match_type: "fts" as const,
      }));

      // If FTS returned no results, fall back to LIKE search
      if (results.length === 0) {
        results = this.fallbackSearch(query, options);
      }

      return results;
    } catch (error) {
      // If the query syntax is invalid for FTS5, try a simple LIKE fallback
      if (
        error instanceof Error &&
        error.message.includes("fts5: syntax error")
      ) {
        return this.fallbackSearch(query, options);
      }
      throw error;
    }
  }

  /**
   * Build a trigram-compatible FTS5 MATCH query.
   *
   * If the query already contains FTS5 operators (AND, OR, NOT, quotes),
   * pass it through as-is. Otherwise, split on whitespace, filter to terms
   * with 3+ characters (trigram minimum), wrap each in quotes, and join with AND.
   *
   * Returns null if no terms are long enough for trigram (caller should use LIKE fallback).
   *
   * Examples:
   *   "記憶検索 仕組み engram" → '"記憶検索" AND "仕組み" AND "engram"'
   *   "React TypeScript"      → '"React" AND "TypeScript"'
   *   '"auth" OR "token"'     → '"auth" OR "token"'  (pass-through)
   *   "AI 技術"               → null  (all terms < 3 chars)
   */
  private buildTrigramQuery(query: string): string | null {
    // If query already contains FTS5 operators or quotes, pass through
    if (/\b(AND|OR|NOT)\b/.test(query) || query.includes('"')) {
      return query;
    }

    const terms = query
      .trim()
      .split(/\s+/)
      .filter((t) => t.length >= 3); // trigram requires 3+ characters

    if (terms.length === 0) return null;

    return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
  }

  /**
   * Fallback search using LIKE when FTS5 query syntax is invalid
   */
  private fallbackSearch(
    query: string,
    options: SearchOptions
  ): SearchResult[] {
    const db = this.getDb();
    const limit = options.limit ?? 10;
    const likeQuery = `%${query}%`;

    const conditions: string[] = ["tenant_id = @tenant_id"];
    const params: Record<string, unknown> = {
      tenant_id: options.tenant_id,
      query: likeQuery,
      limit,
    };

    if (options.date_from) {
      conditions.push("created_at >= @date_from");
      params.date_from = options.date_from;
    }
    if (options.date_to) {
      conditions.push("created_at <= @date_to");
      params.date_to = options.date_to;
    }

    const whereClause = conditions.join(" AND ");

    const rows = db
      .prepare(
        `SELECT *, 1.0 as score FROM notes
         WHERE ${whereClause} AND (content LIKE @query OR summary LIKE @query)
         ORDER BY created_at DESC
         LIMIT @limit`
      )
      .all(params) as Array<Record<string, unknown> & { score: number }>;

    return rows.map((row) => ({
      note: this.rowToNote(row),
      score: row.score,
      match_type: "fts" as const,
    }));
  }

  // --- Vector Search (Phase 2) ---

  /**
   * Save embedding vector for a note.
   * Uses the note's rowid to map to the vec0 virtual table.
   */
  async saveEmbedding(noteId: string, embedding: number[]): Promise<void> {
    if (!this.vecEnabled) {
      throw new Error("Vector search not available: sqlite-vec extension not loaded");
    }
    const db = this.getDb();

    // Get the rowid for the note
    const row = db
      .prepare("SELECT rowid FROM notes WHERE note_id = ?")
      .get(noteId) as { rowid: number } | undefined;

    if (!row) {
      throw new Error(`Note not found: ${noteId}`);
    }

    const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);
    const rowid = BigInt(row.rowid);

    // Delete existing embedding if any (upsert)
    db.prepare("DELETE FROM notes_vec WHERE rowid = ?").run(rowid);

    db.prepare("INSERT INTO notes_vec(rowid, embedding) VALUES (?, ?)").run(
      rowid,
      vecBuffer
    );
  }

  /**
   * Vector similarity search using sqlite-vec.
   * Returns notes ordered by L2 distance (closest first).
   */
  async vectorSearch(
    embedding: number[],
    options: SearchOptions
  ): Promise<SearchResult[]> {
    if (!this.vecEnabled) {
      return [];
    }
    const db = this.getDb();
    const limit = options.limit ?? 10;

    const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);

    // Query vec0 table joined with notes for filtering
    const conditions: string[] = ["n.tenant_id = @tenant_id"];
    const params: Record<string, unknown> = {
      tenant_id: options.tenant_id,
      query_vec: vecBuffer,
      k: limit * 3, // Fetch extra to account for filtering
    };

    if (options.date_from) {
      conditions.push("n.created_at >= @date_from");
      params.date_from = options.date_from;
    }
    if (options.date_to) {
      conditions.push("n.created_at <= @date_to");
      params.date_to = options.date_to;
    }
    if (options.session_id) {
      conditions.push("n.session_id = @session_id");
      params.session_id = options.session_id;
    }

    const whereClause = conditions.join(" AND ");

    try {
      const sql = `
        SELECT n.*, v.distance
        FROM notes_vec v
        JOIN notes n ON n.rowid = v.rowid
        WHERE v.embedding MATCH @query_vec
          AND v.k = @k
          AND ${whereClause}
        ORDER BY v.distance
        LIMIT ${limit}
      `;

      const rows = db.prepare(sql).all(params) as Array<
        Record<string, unknown> & { distance: number }
      >;

      return rows.map((row) => ({
        note: this.rowToNote(row),
        score: row.distance,
        match_type: "vector" as const,
      }));
    } catch (error) {
      console.error("[sqlite-adapter] Vector search failed:", error);
      return [];
    }
  }

  // --- Stats ---

  async getStats(tenantId: string): Promise<MemoryStats> {
    const db = this.getDb();

    const notesCount = db
      .prepare("SELECT COUNT(*) as count FROM notes WHERE tenant_id = ?")
      .get(tenantId) as { count: number };

    const sessionsCount = db
      .prepare("SELECT COUNT(*) as count FROM sessions WHERE tenant_id = ?")
      .get(tenantId) as { count: number };

    const linksCount = db
      .prepare(
        `SELECT COUNT(*) as count FROM note_links nl
         JOIN notes n ON nl.source_id = n.note_id
         WHERE n.tenant_id = ?`
      )
      .get(tenantId) as { count: number };

    const roleRows = db
      .prepare(
        "SELECT role, COUNT(*) as count FROM notes WHERE tenant_id = ? GROUP BY role"
      )
      .all(tenantId) as Array<{ role: string; count: number }>;

    const dateRange = db
      .prepare(
        "SELECT MIN(created_at) as earliest, MAX(created_at) as latest FROM notes WHERE tenant_id = ?"
      )
      .get(tenantId) as { earliest: string | null; latest: string | null };

    const notesByRole: Record<string, number> = {};
    for (const row of roleRows) {
      notesByRole[row.role] = row.count;
    }

    return {
      total_notes: notesCount.count,
      total_sessions: sessionsCount.count,
      total_links: linksCount.count,
      notes_by_role: notesByRole,
      date_range: {
        earliest: dateRange.earliest,
        latest: dateRange.latest,
      },
    };
  }

  async getTopKeywords(
    tenantId: string,
    limit: number
  ): Promise<KeywordCount[]> {
    const db = this.getDb();

    // Extract keywords from JSON arrays and count them
    const rows = db
      .prepare(
        `SELECT value as keyword, COUNT(*) as count
         FROM notes, json_each(notes.keywords)
         WHERE notes.tenant_id = ? AND notes.keywords IS NOT NULL
         GROUP BY value
         ORDER BY count DESC
         LIMIT ?`
      )
      .all(tenantId, limit) as Array<{ keyword: string; count: number }>;

    return rows.map((row) => ({
      keyword: row.keyword,
      count: row.count,
    }));
  }

  // --- Phase 3: Extended queries ---

  async getRecentNotes(tenantId: string, days: number, limit: number): Promise<Note[]> {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT * FROM notes
         WHERE tenant_id = ? AND created_at >= datetime('now', '-' || ? || ' days')
         ORDER BY importance DESC, created_at DESC
         LIMIT ?`
      )
      .all(tenantId, days, limit) as Record<string, unknown>[];

    return rows.map((r) => this.rowToNote(r));
  }

  async getTopKeywordsWithDates(tenantId: string, limit: number): Promise<KeywordWithDate[]> {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT value as keyword, COUNT(*) as count, MAX(n.created_at) as last_seen
         FROM notes n, json_each(n.keywords)
         WHERE n.tenant_id = ? AND n.keywords IS NOT NULL
         GROUP BY value
         ORDER BY count DESC
         LIMIT ?`
      )
      .all(tenantId, limit) as Array<{ keyword: string; count: number; last_seen: string }>;

    return rows.map((row) => ({
      keyword: row.keyword,
      count: row.count,
      last_seen: row.last_seen,
    }));
  }

  async getHubNotes(tenantId: string, limit: number): Promise<HubNote[]> {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT n.note_id, n.keywords,
                (SELECT COUNT(*) FROM note_links nl
                 WHERE nl.source_id = n.note_id OR nl.target_id = n.note_id) as link_count
         FROM notes n
         WHERE n.tenant_id = ?
           AND (SELECT COUNT(*) FROM note_links nl
                WHERE nl.source_id = n.note_id OR nl.target_id = n.note_id) > 0
         ORDER BY link_count DESC
         LIMIT ?`
      )
      .all(tenantId, limit) as Array<{ note_id: string; keywords: string | null; link_count: number }>;

    return rows.map((row) => ({
      note_id: row.note_id,
      keywords: row.keywords ? JSON.parse(row.keywords) : [],
      link_count: row.link_count,
    }));
  }

  async getNotesForSummary(options: SummaryOptions): Promise<Note[]> {
    const db = this.getDb();
    const limit = options.limit ?? 50;

    const conditions: string[] = ["n.tenant_id = @tenant_id"];
    const params: Record<string, unknown> = {
      tenant_id: options.tenant_id,
      limit,
    };

    if (options.date_from) {
      conditions.push("n.created_at >= @date_from");
      params.date_from = options.date_from;
    }
    if (options.date_to) {
      conditions.push("n.created_at <= @date_to");
      params.date_to = options.date_to;
    }
    if (options.project) {
      conditions.push(
        "n.session_id IN (SELECT session_id FROM sessions WHERE project = @project)"
      );
      params.project = options.project;
    }

    const whereClause = conditions.join(" AND ");

    const rows = db
      .prepare(
        `SELECT n.* FROM notes n
         WHERE ${whereClause}
         ORDER BY n.created_at ASC
         LIMIT @limit`
      )
      .all(params) as Record<string, unknown>[];

    return rows.map((r) => this.rowToNote(r));
  }

  async getActiveSessions(tenantId: string): Promise<Session[]> {
    const db = this.getDb();
    const rows = db
      .prepare(
        "SELECT * FROM sessions WHERE tenant_id = ? AND ended_at IS NULL ORDER BY started_at DESC"
      )
      .all(tenantId) as Record<string, unknown>[];

    return rows.map((r) => this.rowToSession(r));
  }

  // --- Row conversion helpers ---

  private rowToTenant(row: Record<string, unknown>): Tenant {
    return {
      tenant_id: row.tenant_id as string,
      name: row.name as string,
      created_at: row.created_at as string,
      config: row.config
        ? JSON.parse(row.config as string)
        : undefined,
    };
  }

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      session_id: row.session_id as string,
      tenant_id: row.tenant_id as string,
      project: (row.project as string) ?? undefined,
      started_at: row.started_at as string,
      ended_at: (row.ended_at as string) ?? undefined,
      metadata: row.metadata
        ? JSON.parse(row.metadata as string)
        : undefined,
    };
  }

  private rowToNote(row: Record<string, unknown>): Note {
    return {
      note_id: row.note_id as string,
      tenant_id: row.tenant_id as string,
      session_id: (row.session_id as string) ?? undefined,
      role: row.role as Note["role"],
      content: row.content as string,
      summary: (row.summary as string) ?? undefined,
      keywords: row.keywords
        ? JSON.parse(row.keywords as string)
        : undefined,
      tags: row.tags ? JSON.parse(row.tags as string) : undefined,
      context_desc: (row.context_desc as string) ?? undefined,
      importance: (row.importance as number) ?? 0.0,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  private rowToNoteLink(row: Record<string, unknown>): NoteLink {
    return {
      link_id: row.link_id as string,
      source_id: row.source_id as string,
      target_id: row.target_id as string,
      relation: (row.relation as string) ?? undefined,
      strength: (row.strength as number) ?? 1.0,
      created_at: row.created_at as string,
    };
  }
}
