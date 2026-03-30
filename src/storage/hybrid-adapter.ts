/**
 * HybridAdapter - Local SQLite + Turso cloud sync
 *
 * Phase 4: Writes go to local SQLite immediately (fast).
 * Structured notes are synced to Turso asynchronously.
 * Reads from local SQLite by default.
 *
 * Sync pipeline:
 * 1. On write: save to local SQLite immediately
 * 2. Queue the operation for Turso sync
 * 3. Sync timer or sync-on-write pushes to Turso
 * 4. On failure: retry with exponential backoff (max 3 retries)
 */

import { SQLiteAdapter } from "./sqlite-adapter.js";
import { TursoAdapter } from "./turso-adapter.js";
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

/** Sync operation queued for Turso */
interface SyncOperation {
  type: "note" | "link" | "tenant" | "session" | "session_end" | "note_update" | "note_delete";
  data: unknown;
  retries: number;
  createdAt: number;
}

/** Sync status information */
export interface SyncStatus {
  pendingOperations: number;
  lastSyncAt: string | null;
  lastError: string | null;
  isSyncing: boolean;
}

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

export class HybridAdapter implements StorageAdapter {
  private local: SQLiteAdapter;
  private remote: TursoAdapter;
  private config: StorageConfig | null = null;
  private syncQueue: SyncOperation[] = [];
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private _isSyncing = false;
  private _lastSyncAt: string | null = null;
  private _lastError: string | null = null;
  private syncOnWrite = false;

  constructor() {
    this.local = new SQLiteAdapter();
    this.remote = new TursoAdapter();
  }

  /** Expose local adapter for testing */
  get localAdapter(): SQLiteAdapter {
    return this.local;
  }

  /** Expose remote adapter for testing */
  get remoteAdapter(): TursoAdapter {
    return this.remote;
  }

  // --- Lifecycle ---

  async initialize(config: StorageConfig): Promise<void> {
    this.config = config;
    this.syncOnWrite = config.syncOnWrite ?? false;

    // Initialize local SQLite adapter
    const localConfig: StorageConfig = {
      ...config,
      type: "sqlite",
    };
    await this.local.initialize(localConfig);

    // Initialize remote Turso adapter
    const remoteConfig: StorageConfig = {
      ...config,
      type: "turso",
    };
    await this.remote.initialize(remoteConfig);

    // Start sync timer if interval is configured
    const syncInterval = config.syncIntervalMs ?? 30000;
    if (syncInterval > 0) {
      this.syncTimer = setInterval(() => {
        this.processSyncQueue().catch((err) => {
          console.error("[hybrid-adapter] Sync error:", err);
        });
      }, syncInterval);
    }
  }

  async close(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    // Process remaining queue before closing
    if (this.syncQueue.length > 0) {
      try {
        await this.processSyncQueue();
      } catch {
        // Best effort sync on close
      }
    }

    await this.local.close();
    await this.remote.close();
  }

  // --- Sync Queue ---

  private enqueue(op: Omit<SyncOperation, "retries" | "createdAt">): void {
    this.syncQueue.push({
      ...op,
      retries: 0,
      createdAt: Date.now(),
    });

    if (this.syncOnWrite) {
      this.processSyncQueue().catch((err) => {
        console.error("[hybrid-adapter] Sync-on-write error:", err);
      });
    }
  }

  /** Process all queued sync operations */
  async processSyncQueue(): Promise<void> {
    if (this._isSyncing || this.syncQueue.length === 0) return;

    this._isSyncing = true;
    const failedOps: SyncOperation[] = [];

    try {
      while (this.syncQueue.length > 0) {
        const op = this.syncQueue.shift()!;
        try {
          await this.executeSyncOp(op);
        } catch (error) {
          if (op.retries < MAX_RETRIES) {
            op.retries++;
            failedOps.push(op);
            this._lastError = error instanceof Error ? error.message : String(error);
          } else {
            console.error(
              `[hybrid-adapter] Dropping sync op after ${MAX_RETRIES} retries:`,
              op.type,
              error
            );
            this._lastError = `Dropped after max retries: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      }

      this._lastSyncAt = new Date().toISOString();
    } finally {
      // Re-queue failed operations
      this.syncQueue.push(...failedOps);
      this._isSyncing = false;
    }
  }

  private async executeSyncOp(op: SyncOperation): Promise<void> {
    // Exponential backoff delay for retries
    if (op.retries > 0) {
      const delay = BASE_RETRY_DELAY_MS * Math.pow(2, op.retries - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    switch (op.type) {
      case "tenant": {
        const data = op.data as Omit<Tenant, "created_at">;
        const existing = await this.remote.getTenant(data.tenant_id);
        if (!existing) {
          await this.remote.createTenant(data);
        }
        break;
      }
      case "session": {
        const data = op.data as Omit<Session, "started_at" | "ended_at">;
        const existing = await this.remote.getSession(data.session_id);
        if (!existing) {
          await this.remote.createSession(data);
        }
        break;
      }
      case "session_end": {
        const sessionId = op.data as string;
        await this.remote.endSession(sessionId);
        break;
      }
      case "note": {
        const note = op.data as Note;
        // Use importNote to preserve the original note_id
        await this.remote.importNote(note);
        break;
      }
      case "note_update": {
        const data = op.data as { noteId: string; updates: Partial<CreateNoteInput> };
        const existing = await this.remote.getNote(data.noteId);
        if (existing) {
          await this.remote.updateNote(data.noteId, data.updates);
        }
        break;
      }
      case "note_delete": {
        const noteId = op.data as string;
        await this.remote.deleteNote(noteId);
        break;
      }
      case "link": {
        const data = op.data as Omit<NoteLink, "link_id" | "created_at">;
        await this.remote.addLink(data);
        break;
      }
    }
  }

  /** Get current sync status */
  getSyncStatus(): SyncStatus {
    return {
      pendingOperations: this.syncQueue.length,
      lastSyncAt: this._lastSyncAt,
      lastError: this._lastError,
      isSyncing: this._isSyncing,
    };
  }

  // --- Tenant Management ---

  async createTenant(
    input: Omit<Tenant, "created_at">
  ): Promise<Tenant> {
    const tenant = await this.local.createTenant(input);
    this.enqueue({ type: "tenant", data: input });
    return tenant;
  }

  async getTenant(tenantId: string): Promise<Tenant | null> {
    return this.local.getTenant(tenantId);
  }

  // --- Session Management ---

  async createSession(
    input: Omit<Session, "started_at" | "ended_at">
  ): Promise<Session> {
    const session = await this.local.createSession(input);
    this.enqueue({ type: "session", data: input });
    return session;
  }

  async endSession(sessionId: string): Promise<void> {
    await this.local.endSession(sessionId);
    this.enqueue({ type: "session_end", data: sessionId });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.local.getSession(sessionId);
  }

  // --- Note CRUD ---

  async saveNote(input: CreateNoteInput): Promise<Note> {
    const note = await this.local.saveNote(input);
    // Enqueue the full note (with generated note_id) for remote sync
    this.enqueue({ type: "note", data: note });
    return note;
  }

  async getNote(noteId: string): Promise<Note | null> {
    return this.local.getNote(noteId);
  }

  async updateNote(
    noteId: string,
    updates: Partial<CreateNoteInput>
  ): Promise<Note> {
    const note = await this.local.updateNote(noteId, updates);
    this.enqueue({ type: "note_update", data: { noteId, updates } });
    return note;
  }

  async deleteNote(noteId: string): Promise<void> {
    await this.local.deleteNote(noteId);
    this.enqueue({ type: "note_delete", data: noteId });
  }

  // --- Note Links ---

  async addLink(
    input: Omit<NoteLink, "link_id" | "created_at">
  ): Promise<NoteLink> {
    const link = await this.local.addLink(input);
    this.enqueue({ type: "link", data: input });
    return link;
  }

  async getLinks(noteId: string): Promise<NoteLink[]> {
    return this.local.getLinks(noteId);
  }

  // --- Search (delegates to local) ---

  async fullTextSearch(
    query: string,
    options: SearchOptions
  ): Promise<SearchResult[]> {
    return this.local.fullTextSearch(query, options);
  }

  // Vector search delegates to local adapter if available
  async saveEmbedding(noteId: string, embedding: number[]): Promise<void> {
    if (this.local.saveEmbedding) {
      await this.local.saveEmbedding(noteId, embedding);
    }
  }

  async vectorSearch(
    embedding: number[],
    options: SearchOptions
  ): Promise<SearchResult[]> {
    if (this.local.vectorSearch) {
      return this.local.vectorSearch(embedding, options);
    }
    return [];
  }

  // --- Stats ---

  async getStats(tenantId: string): Promise<MemoryStats> {
    return this.local.getStats(tenantId);
  }

  async getTopKeywords(
    tenantId: string,
    limit: number
  ): Promise<KeywordCount[]> {
    return this.local.getTopKeywords(tenantId, limit);
  }

  // --- Phase 3: Extended queries ---

  async getRecentNotes(tenantId: string, days: number, limit: number): Promise<Note[]> {
    return this.local.getRecentNotes(tenantId, days, limit);
  }

  async getTopKeywordsWithDates(tenantId: string, limit: number): Promise<KeywordWithDate[]> {
    return this.local.getTopKeywordsWithDates(tenantId, limit);
  }

  async getHubNotes(tenantId: string, limit: number): Promise<HubNote[]> {
    return this.local.getHubNotes(tenantId, limit);
  }

  async getNotesForSummary(options: SummaryOptions): Promise<Note[]> {
    return this.local.getNotesForSummary(options);
  }

  async getActiveSessions(tenantId: string): Promise<Session[]> {
    return this.local.getActiveSessions(tenantId);
  }
}
