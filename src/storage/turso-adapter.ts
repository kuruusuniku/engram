/**
 * TursoAdapter - Turso/libSQL cloud storage backend
 *
 * Phase 4: Uses @libsql/client for Turso cloud or local libSQL.
 * Schema is identical to SQLiteAdapter (libSQL is SQLite-compatible).
 * FTS5 is NOT available in Turso cloud, so full-text search uses LIKE fallback.
 * Vector search (sqlite-vec) is NOT available in Turso.
 */

import { createClient, type Client, type InStatement } from "@libsql/client";
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

export class TursoAdapter implements StorageAdapter {
  private client: Client | null = null;
  private config: StorageConfig | null = null;

  // --- Lifecycle ---

  async initialize(config: StorageConfig): Promise<void> {
    this.config = config;

    const url = config.tursoUrl || config.dbPath || "file::memory:";
    this.client = createClient({
      url,
      authToken: config.tursoAuthToken,
    });

    await this.createSchema();
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }

  private getClient(): Client {
    if (!this.client) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    return this.client;
  }

  private async createSchema(): Promise<void> {
    const client = this.getClient();

    await client.executeMultiple(`
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
  }

  // --- Tenant Management ---

  async createTenant(
    input: Omit<Tenant, "created_at">
  ): Promise<Tenant> {
    const client = this.getClient();
    const tenant: Tenant = {
      ...input,
      tenant_id: input.tenant_id || uuidv4(),
      created_at: new Date().toISOString(),
    };

    await client.execute({
      sql: `INSERT INTO tenants (tenant_id, name, created_at, config)
            VALUES (?, ?, ?, ?)`,
      args: [
        tenant.tenant_id,
        tenant.name,
        tenant.created_at,
        tenant.config ? JSON.stringify(tenant.config) : null,
      ],
    });

    return tenant;
  }

  async getTenant(tenantId: string): Promise<Tenant | null> {
    const client = this.getClient();
    const rs = await client.execute({
      sql: "SELECT * FROM tenants WHERE tenant_id = ?",
      args: [tenantId],
    });

    if (rs.rows.length === 0) return null;
    return this.rowToTenant(rs.rows[0]);
  }

  // --- Session Management ---

  async createSession(
    input: Omit<Session, "started_at" | "ended_at">
  ): Promise<Session> {
    const client = this.getClient();
    const session: Session = {
      ...input,
      session_id: input.session_id || uuidv4(),
      started_at: new Date().toISOString(),
    };

    await client.execute({
      sql: `INSERT INTO sessions (session_id, tenant_id, project, started_at, metadata)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        session.session_id,
        session.tenant_id,
        session.project ?? null,
        session.started_at,
        session.metadata ? JSON.stringify(session.metadata) : null,
      ],
    });

    return session;
  }

  async endSession(sessionId: string): Promise<void> {
    const client = this.getClient();
    await client.execute({
      sql: "UPDATE sessions SET ended_at = datetime('now') WHERE session_id = ?",
      args: [sessionId],
    });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const client = this.getClient();
    const rs = await client.execute({
      sql: "SELECT * FROM sessions WHERE session_id = ?",
      args: [sessionId],
    });

    if (rs.rows.length === 0) return null;
    return this.rowToSession(rs.rows[0]);
  }

  // --- Note CRUD ---

  async saveNote(input: CreateNoteInput): Promise<Note> {
    const client = this.getClient();
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

    await client.execute({
      sql: `INSERT INTO notes (note_id, tenant_id, session_id, role, content, summary, keywords, tags, context_desc, importance, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        note.note_id,
        note.tenant_id,
        note.session_id ?? null,
        note.role,
        note.content,
        note.summary ?? null,
        note.keywords ? JSON.stringify(note.keywords) : null,
        note.tags ? JSON.stringify(note.tags) : null,
        note.context_desc ?? null,
        note.importance,
        note.created_at,
        note.updated_at,
      ],
    });

    return note;
  }

  async getNote(noteId: string): Promise<Note | null> {
    const client = this.getClient();
    const rs = await client.execute({
      sql: "SELECT * FROM notes WHERE note_id = ?",
      args: [noteId],
    });

    if (rs.rows.length === 0) return null;
    return this.rowToNote(rs.rows[0]);
  }

  async updateNote(
    noteId: string,
    updates: Partial<CreateNoteInput>
  ): Promise<Note> {
    const client = this.getClient();
    const existing = await this.getNote(noteId);
    if (!existing) {
      throw new Error(`Note not found: ${noteId}`);
    }

    const fields: string[] = ["updated_at = datetime('now')"];
    const args: Array<string | number | null> = [];

    if (updates.content !== undefined) {
      fields.push("content = ?");
      args.push(updates.content);
    }
    if (updates.summary !== undefined) {
      fields.push("summary = ?");
      args.push(updates.summary);
    }
    if (updates.keywords !== undefined) {
      fields.push("keywords = ?");
      args.push(JSON.stringify(updates.keywords));
    }
    if (updates.tags !== undefined) {
      fields.push("tags = ?");
      args.push(JSON.stringify(updates.tags));
    }
    if (updates.context_desc !== undefined) {
      fields.push("context_desc = ?");
      args.push(updates.context_desc);
    }
    if (updates.importance !== undefined) {
      fields.push("importance = ?");
      args.push(updates.importance);
    }

    args.push(noteId);

    await client.execute({
      sql: `UPDATE notes SET ${fields.join(", ")} WHERE note_id = ?`,
      args,
    });

    return (await this.getNote(noteId))!;
  }

  async deleteNote(noteId: string): Promise<void> {
    const client = this.getClient();
    await client.execute({
      sql: "DELETE FROM notes WHERE note_id = ?",
      args: [noteId],
    });
  }

  // --- Note Links ---

  async addLink(
    input: Omit<NoteLink, "link_id" | "created_at">
  ): Promise<NoteLink> {
    const client = this.getClient();
    const link: NoteLink = {
      link_id: uuidv4(),
      ...input,
      created_at: new Date().toISOString(),
    };

    await client.execute({
      sql: `INSERT INTO note_links (link_id, source_id, target_id, relation, strength, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        link.link_id,
        link.source_id,
        link.target_id,
        link.relation ?? null,
        link.strength,
        link.created_at,
      ],
    });

    return link;
  }

  async getLinks(noteId: string): Promise<NoteLink[]> {
    const client = this.getClient();
    const rs = await client.execute({
      sql: "SELECT * FROM note_links WHERE source_id = ? OR target_id = ?",
      args: [noteId, noteId],
    });

    return rs.rows.map((row) => this.rowToNoteLink(row));
  }

  // --- Search ---

  /**
   * Full-text search using LIKE fallback (FTS5 not available in Turso cloud).
   * Searches content and summary fields.
   */
  async fullTextSearch(
    query: string,
    options: SearchOptions
  ): Promise<SearchResult[]> {
    const client = this.getClient();
    const limit = options.limit ?? 10;
    const likeQuery = `%${query}%`;

    const conditions: string[] = ["tenant_id = ?"];
    const args: Array<string | number | null> = [options.tenant_id];

    if (options.date_from) {
      conditions.push("created_at >= ?");
      args.push(options.date_from);
    }
    if (options.date_to) {
      conditions.push("created_at <= ?");
      args.push(options.date_to);
    }
    if (options.session_id) {
      conditions.push("session_id = ?");
      args.push(options.session_id);
    }

    const whereClause = conditions.join(" AND ");

    args.push(likeQuery, likeQuery, likeQuery, limit);

    const rs = await client.execute({
      sql: `SELECT *, 1.0 as score FROM notes
            WHERE ${whereClause}
              AND (content LIKE ? OR summary LIKE ? OR keywords LIKE ?)
            ORDER BY created_at DESC
            LIMIT ?`,
      args,
    });

    return rs.rows.map((row) => ({
      note: this.rowToNote(row),
      score: Number(row.score ?? 1.0),
      match_type: "fts" as const,
    }));
  }

  // Vector search is not available in Turso (no sqlite-vec extension)
  // The optional vectorSearch method is intentionally not implemented.

  // --- Stats ---

  async getStats(tenantId: string): Promise<MemoryStats> {
    const client = this.getClient();

    const [notesRs, sessionsRs, linksRs, roleRs, dateRs] = await Promise.all([
      client.execute({
        sql: "SELECT COUNT(*) as count FROM notes WHERE tenant_id = ?",
        args: [tenantId],
      }),
      client.execute({
        sql: "SELECT COUNT(*) as count FROM sessions WHERE tenant_id = ?",
        args: [tenantId],
      }),
      client.execute({
        sql: `SELECT COUNT(*) as count FROM note_links nl
              JOIN notes n ON nl.source_id = n.note_id
              WHERE n.tenant_id = ?`,
        args: [tenantId],
      }),
      client.execute({
        sql: "SELECT role, COUNT(*) as count FROM notes WHERE tenant_id = ? GROUP BY role",
        args: [tenantId],
      }),
      client.execute({
        sql: "SELECT MIN(created_at) as earliest, MAX(created_at) as latest FROM notes WHERE tenant_id = ?",
        args: [tenantId],
      }),
    ]);

    const notesByRole: Record<string, number> = {};
    for (const row of roleRs.rows) {
      notesByRole[row.role as string] = Number(row.count);
    }

    return {
      total_notes: Number(notesRs.rows[0].count),
      total_sessions: Number(sessionsRs.rows[0].count),
      total_links: Number(linksRs.rows[0].count),
      notes_by_role: notesByRole,
      date_range: {
        earliest: (dateRs.rows[0].earliest as string) ?? null,
        latest: (dateRs.rows[0].latest as string) ?? null,
      },
    };
  }

  async getTopKeywords(
    tenantId: string,
    limit: number
  ): Promise<KeywordCount[]> {
    const client = this.getClient();

    const rs = await client.execute({
      sql: `SELECT value as keyword, COUNT(*) as count
            FROM notes, json_each(notes.keywords)
            WHERE notes.tenant_id = ? AND notes.keywords IS NOT NULL
            GROUP BY value
            ORDER BY count DESC
            LIMIT ?`,
      args: [tenantId, limit],
    });

    return rs.rows.map((row) => ({
      keyword: row.keyword as string,
      count: Number(row.count),
    }));
  }

  // --- Phase 3: Extended queries ---

  async getRecentNotes(tenantId: string, days: number, limit: number): Promise<Note[]> {
    const client = this.getClient();
    const rs = await client.execute({
      sql: `SELECT * FROM notes
            WHERE tenant_id = ? AND created_at >= datetime('now', '-' || ? || ' days')
            ORDER BY importance DESC, created_at DESC
            LIMIT ?`,
      args: [tenantId, days, limit],
    });

    return rs.rows.map((row) => this.rowToNote(row));
  }

  async getTopKeywordsWithDates(tenantId: string, limit: number): Promise<KeywordWithDate[]> {
    const client = this.getClient();
    const rs = await client.execute({
      sql: `SELECT value as keyword, COUNT(*) as count, MAX(n.created_at) as last_seen
            FROM notes n, json_each(n.keywords)
            WHERE n.tenant_id = ? AND n.keywords IS NOT NULL
            GROUP BY value
            ORDER BY count DESC
            LIMIT ?`,
      args: [tenantId, limit],
    });

    return rs.rows.map((row) => ({
      keyword: row.keyword as string,
      count: Number(row.count),
      last_seen: row.last_seen as string,
    }));
  }

  async getHubNotes(tenantId: string, limit: number): Promise<HubNote[]> {
    const client = this.getClient();
    const rs = await client.execute({
      sql: `SELECT n.note_id, n.keywords,
              (SELECT COUNT(*) FROM note_links nl
               WHERE nl.source_id = n.note_id OR nl.target_id = n.note_id) as link_count
            FROM notes n
            WHERE n.tenant_id = ?
              AND (SELECT COUNT(*) FROM note_links nl
                   WHERE nl.source_id = n.note_id OR nl.target_id = n.note_id) > 0
            ORDER BY link_count DESC
            LIMIT ?`,
      args: [tenantId, limit],
    });

    return rs.rows.map((row) => ({
      note_id: row.note_id as string,
      keywords: row.keywords ? JSON.parse(row.keywords as string) : [],
      link_count: Number(row.link_count),
    }));
  }

  async getNotesForSummary(options: SummaryOptions): Promise<Note[]> {
    const client = this.getClient();
    const limit = options.limit ?? 50;

    const conditions: string[] = ["n.tenant_id = ?"];
    const args: Array<string | number | null> = [options.tenant_id];

    if (options.date_from) {
      conditions.push("n.created_at >= ?");
      args.push(options.date_from);
    }
    if (options.date_to) {
      conditions.push("n.created_at <= ?");
      args.push(options.date_to);
    }
    if (options.project) {
      conditions.push(
        "n.session_id IN (SELECT session_id FROM sessions WHERE project = ?)"
      );
      args.push(options.project);
    }

    const whereClause = conditions.join(" AND ");
    args.push(limit);

    const rs = await client.execute({
      sql: `SELECT n.* FROM notes n
            WHERE ${whereClause}
            ORDER BY n.created_at ASC
            LIMIT ?`,
      args,
    });

    return rs.rows.map((row) => this.rowToNote(row));
  }

  async getActiveSessions(tenantId: string): Promise<Session[]> {
    const client = this.getClient();
    const rs = await client.execute({
      sql: "SELECT * FROM sessions WHERE tenant_id = ? AND ended_at IS NULL ORDER BY started_at DESC",
      args: [tenantId],
    });

    return rs.rows.map((row) => this.rowToSession(row));
  }

  // --- Bulk operations for migration ---

  /**
   * Import a note preserving its original note_id (used by sync/migration).
   * Skips if a note with the same note_id already exists.
   */
  async importNote(note: Note): Promise<void> {
    const client = this.getClient();

    // Check if note already exists
    const existing = await this.getNote(note.note_id);
    if (existing) return;

    await client.execute({
      sql: `INSERT INTO notes (note_id, tenant_id, session_id, role, content, summary, keywords, tags, context_desc, importance, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        note.note_id,
        note.tenant_id,
        note.session_id ?? null,
        note.role,
        note.content,
        note.summary ?? null,
        note.keywords ? JSON.stringify(note.keywords) : null,
        note.tags ? JSON.stringify(note.tags) : null,
        note.context_desc ?? null,
        note.importance,
        note.created_at,
        note.updated_at,
      ],
    });
  }

  /**
   * Get all notes for a tenant (used by migration tool)
   */
  async getAllNotes(tenantId: string): Promise<Note[]> {
    const client = this.getClient();
    const rs = await client.execute({
      sql: "SELECT * FROM notes WHERE tenant_id = ? ORDER BY created_at ASC",
      args: [tenantId],
    });
    return rs.rows.map((row) => this.rowToNote(row));
  }

  /**
   * Get all links for notes belonging to a tenant
   */
  async getAllLinks(tenantId: string): Promise<NoteLink[]> {
    const client = this.getClient();
    const rs = await client.execute({
      sql: `SELECT nl.* FROM note_links nl
            JOIN notes n ON nl.source_id = n.note_id
            WHERE n.tenant_id = ?`,
      args: [tenantId],
    });
    return rs.rows.map((row) => this.rowToNoteLink(row));
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
      importance: Number(row.importance ?? 0.0),
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
      strength: Number(row.strength ?? 1.0),
      created_at: row.created_at as string,
    };
  }
}
