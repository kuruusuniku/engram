/**
 * DataTransfer - Export/Import functionality for memory data
 *
 * Format: JSON Lines (.jsonl) - one JSON object per line
 * Each line represents a note with all its metadata.
 */

import type { StorageAdapter } from "./storage/adapter.js";
import type { Note, NoteLink, Session, Tenant } from "./storage/types.js";
import { createLogger } from "./logger.js";

const log = createLogger("data-transfer");

/** Schema version for export format compatibility */
const EXPORT_VERSION = 1;

export interface ExportLine {
  _type: "header" | "tenant" | "session" | "note" | "link";
  _version: number;
  data: Record<string, unknown>;
}

export interface ExportOptions {
  tenantId: string;
  /** Include note links (default: true) */
  includeLinks?: boolean;
  /** Include sessions (default: true) */
  includeSessions?: boolean;
  /** Date range filter */
  dateFrom?: string;
  dateTo?: string;
}

export interface ExportResult {
  content: string;
  stats: {
    tenants: number;
    sessions: number;
    notes: number;
    links: number;
  };
}

export interface ImportOptions {
  /** Target tenant ID (overrides tenant in data) */
  targetTenantId?: string;
  /** Skip existing notes (default: true) */
  skipExisting?: boolean;
  /** Merge strategy for duplicates: "skip" | "overwrite" (default: "skip") */
  mergeStrategy?: "skip" | "overwrite";
}

export interface ImportResult {
  imported: {
    tenants: number;
    sessions: number;
    notes: number;
    links: number;
  };
  skipped: {
    notes: number;
    links: number;
  };
  errors: string[];
}

export class DataTransfer {
  constructor(private adapter: StorageAdapter) {}

  /**
   * Export memory data as JSONL string
   */
  async export(options: ExportOptions): Promise<ExportResult> {
    const lines: string[] = [];
    const stats = { tenants: 0, sessions: 0, notes: 0, links: 0 };

    // Header line
    const header: ExportLine = {
      _type: "header",
      _version: EXPORT_VERSION,
      data: {
        exported_at: new Date().toISOString(),
        tenant_id: options.tenantId,
      },
    };
    lines.push(JSON.stringify(header));

    // Export tenant
    const tenant = await this.adapter.getTenant(options.tenantId);
    if (tenant) {
      const tenantLine: ExportLine = {
        _type: "tenant",
        _version: EXPORT_VERSION,
        data: tenant as unknown as Record<string, unknown>,
      };
      lines.push(JSON.stringify(tenantLine));
      stats.tenants++;
    }

    // Export sessions
    if (options.includeSessions !== false && this.adapter.getActiveSessions) {
      // Get all sessions (active ones)
      const sessions = await this.adapter.getActiveSessions(options.tenantId);
      for (const session of sessions) {
        const sessionLine: ExportLine = {
          _type: "session",
          _version: EXPORT_VERSION,
          data: session as unknown as Record<string, unknown>,
        };
        lines.push(JSON.stringify(sessionLine));
        stats.sessions++;
      }
    }

    // Export notes
    if (this.adapter.getNotesForSummary) {
      const notes = await this.adapter.getNotesForSummary({
        tenant_id: options.tenantId,
        date_from: options.dateFrom,
        date_to: options.dateTo,
        limit: 100000,
      });

      for (const note of notes) {
        const noteData: Record<string, unknown> = {
          note_id: note.note_id,
          tenant_id: note.tenant_id,
          session_id: note.session_id,
          role: note.role,
          content: note.content,
          summary: note.summary,
          keywords: note.keywords,
          tags: note.tags,
          context_desc: note.context_desc,
          importance: note.importance,
          created_at: note.created_at,
          updated_at: note.updated_at,
        };

        const noteLine: ExportLine = {
          _type: "note",
          _version: EXPORT_VERSION,
          data: noteData,
        };
        lines.push(JSON.stringify(noteLine));
        stats.notes++;

        // Export links for this note
        if (options.includeLinks !== false) {
          const links = await this.adapter.getLinks(note.note_id);
          for (const link of links) {
            // Only export links where this note is the source to avoid duplicates
            if (link.source_id === note.note_id) {
              const linkLine: ExportLine = {
                _type: "link",
                _version: EXPORT_VERSION,
                data: link as unknown as Record<string, unknown>,
              };
              lines.push(JSON.stringify(linkLine));
              stats.links++;
            }
          }
        }
      }
    }

    log.info("Export completed", { stats });

    return {
      content: lines.join("\n") + "\n",
      stats,
    };
  }

  /**
   * Import memory data from JSONL string
   */
  async import(content: string, options?: ImportOptions): Promise<ImportResult> {
    const result: ImportResult = {
      imported: { tenants: 0, sessions: 0, notes: 0, links: 0 },
      skipped: { notes: 0, links: 0 },
      errors: [],
    };

    const skipExisting = options?.skipExisting !== false;
    const targetTenantId = options?.targetTenantId;
    const mergeStrategy = options?.mergeStrategy ?? "skip";

    const lines = content.trim().split("\n").filter((line) => line.trim().length > 0);

    // Map from old note_id to new note_id (for link resolution)
    const noteIdMap = new Map<string, string>();

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      try {
        const parsed = JSON.parse(lines[lineNum]) as ExportLine;

        switch (parsed._type) {
          case "header":
            // Validate version compatibility
            if (parsed._version > EXPORT_VERSION) {
              result.errors.push(
                `Warning: Export version ${parsed._version} is newer than supported version ${EXPORT_VERSION}`
              );
            }
            break;

          case "tenant":
            await this.importTenant(parsed.data as unknown as Tenant, targetTenantId, result);
            break;

          case "session":
            await this.importSession(
              parsed.data as unknown as Session,
              targetTenantId,
              result
            );
            break;

          case "note":
            await this.importNote(
              parsed.data as unknown as Note,
              targetTenantId,
              skipExisting,
              mergeStrategy,
              noteIdMap,
              result
            );
            break;

          case "link":
            await this.importLink(
              parsed.data as unknown as NoteLink,
              noteIdMap,
              result
            );
            break;

          default:
            // Skip unknown types for forward compatibility
            break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`Line ${lineNum + 1}: ${message}`);
      }
    }

    log.info("Import completed", {
      imported: result.imported,
      skipped: result.skipped,
      errorCount: result.errors.length,
    });

    return result;
  }

  private async importTenant(
    tenant: Tenant,
    targetTenantId: string | undefined,
    result: ImportResult
  ): Promise<void> {
    const tenantId = targetTenantId ?? tenant.tenant_id;
    const existing = await this.adapter.getTenant(tenantId);

    if (!existing) {
      await this.adapter.createTenant({
        tenant_id: tenantId,
        name: tenant.name,
        config: tenant.config,
      });
      result.imported.tenants++;
    }
  }

  private async importSession(
    session: Session,
    targetTenantId: string | undefined,
    result: ImportResult
  ): Promise<void> {
    try {
      const existing = await this.adapter.getSession(session.session_id);
      if (existing) return;

      await this.adapter.createSession({
        session_id: session.session_id,
        tenant_id: targetTenantId ?? session.tenant_id,
        project: session.project,
      });
      result.imported.sessions++;
    } catch {
      // Skip session import errors (e.g., tenant not found)
    }
  }

  private async importNote(
    noteData: Note,
    targetTenantId: string | undefined,
    skipExisting: boolean,
    mergeStrategy: "skip" | "overwrite",
    noteIdMap: Map<string, string>,
    result: ImportResult
  ): Promise<void> {
    const tenantId = targetTenantId ?? noteData.tenant_id;

    // Check if note already exists
    const existing = await this.adapter.getNote(noteData.note_id);
    if (existing) {
      if (skipExisting || mergeStrategy === "skip") {
        noteIdMap.set(noteData.note_id, noteData.note_id);
        result.skipped.notes++;
        return;
      }
      // Overwrite
      await this.adapter.updateNote(noteData.note_id, {
        content: noteData.content,
        summary: noteData.summary,
        keywords: noteData.keywords,
        tags: noteData.tags,
        context_desc: noteData.context_desc,
        importance: noteData.importance,
      });
      noteIdMap.set(noteData.note_id, noteData.note_id);
      result.imported.notes++;
      return;
    }

    // Create new note
    const savedNote = await this.adapter.saveNote({
      tenant_id: tenantId,
      session_id: noteData.session_id,
      role: noteData.role,
      content: noteData.content,
      summary: noteData.summary,
      keywords: noteData.keywords,
      tags: noteData.tags,
      context_desc: noteData.context_desc,
      importance: noteData.importance,
    });

    noteIdMap.set(noteData.note_id, savedNote.note_id);
    result.imported.notes++;
  }

  private async importLink(
    linkData: NoteLink,
    noteIdMap: Map<string, string>,
    result: ImportResult
  ): Promise<void> {
    const sourceId = noteIdMap.get(linkData.source_id);
    const targetId = noteIdMap.get(linkData.target_id);

    if (!sourceId || !targetId) {
      result.skipped.links++;
      return;
    }

    try {
      await this.adapter.addLink({
        source_id: sourceId,
        target_id: targetId,
        relation: linkData.relation,
        strength: linkData.strength,
      });
      result.imported.links++;
    } catch {
      result.skipped.links++;
    }
  }
}
