/**
 * ImportanceScorer - Enhanced importance scoring for memory notes
 *
 * Calculates importance based on multiple signals:
 * 1. Content signals: length, has code, has decisions
 * 2. Access frequency: how often a note is accessed via search
 * 3. Link count: how connected the note is
 * 4. Freshness: recency decay factor
 * 5. Role weight: system/summary notes have higher base importance
 */

import type { StorageAdapter } from "./storage/adapter.js";
import type { Note } from "./storage/types.js";
import { createLogger } from "./logger.js";

const log = createLogger("importance-scorer");

export interface ImportanceScorerConfig {
  /** Weight for content-based signals (default: 0.25) */
  contentWeight?: number;
  /** Weight for link count signal (default: 0.25) */
  linkWeight?: number;
  /** Weight for freshness signal (default: 0.25) */
  freshnessWeight?: number;
  /** Weight for role-based signal (default: 0.25) */
  roleWeight?: number;
  /** Freshness half-life in days (default: 30) */
  freshnessHalfLifeDays?: number;
}

const ROLE_BASE_IMPORTANCE: Record<string, number> = {
  system: 0.9,
  summary: 0.8,
  assistant: 0.5,
  user: 0.4,
};

/** Keywords indicating important content */
const IMPORTANCE_INDICATORS = [
  "decision",
  "decided",
  "conclusion",
  "important",
  "critical",
  "todo",
  "action",
  "fix",
  "bug",
  "error",
  "architecture",
  "design",
  "deploy",
  "release",
  "migration",
  "security",
  "performance",
  "breaking",
  "config",
  "setup",
];

export class ImportanceScorer {
  private config: Required<ImportanceScorerConfig>;

  constructor(config?: ImportanceScorerConfig) {
    this.config = {
      contentWeight: config?.contentWeight ?? 0.25,
      linkWeight: config?.linkWeight ?? 0.25,
      freshnessWeight: config?.freshnessWeight ?? 0.25,
      roleWeight: config?.roleWeight ?? 0.25,
      freshnessHalfLifeDays: config?.freshnessHalfLifeDays ?? 30,
    };
  }

  /**
   * Calculate importance score for a note.
   * Returns a value between 0.0 and 1.0.
   */
  async score(note: Note, adapter: StorageAdapter): Promise<number> {
    const contentScore = this.scoreContent(note);
    const linkScore = await this.scoreLinkCount(note, adapter);
    const freshnessScore = this.scoreFreshness(note);
    const roleScore = this.scoreRole(note);

    const totalScore =
      contentScore * this.config.contentWeight +
      linkScore * this.config.linkWeight +
      freshnessScore * this.config.freshnessWeight +
      roleScore * this.config.roleWeight;

    // Normalize to 0-1
    const normalized = Math.min(1.0, Math.max(0.0, totalScore));

    log.debug("Scored note importance", {
      noteId: note.note_id,
      contentScore,
      linkScore,
      freshnessScore,
      roleScore,
      totalScore: normalized,
    });

    return normalized;
  }

  /**
   * Batch re-score all notes for a tenant
   */
  async rescoreAll(adapter: StorageAdapter, tenantId: string): Promise<number> {
    let updated = 0;

    if (!adapter.getNotesForSummary) return 0;

    const notes = await adapter.getNotesForSummary({
      tenant_id: tenantId,
      limit: 100000,
    });

    for (const note of notes) {
      try {
        const newImportance = await this.score(note, adapter);
        if (Math.abs(newImportance - note.importance) > 0.01) {
          await adapter.updateNote(note.note_id, { importance: newImportance });
          updated++;
        }
      } catch (error) {
        log.error("Failed to rescore note", {
          noteId: note.note_id,
          error: String(error),
        });
      }
    }

    log.info("Rescored notes", { tenantId, total: notes.length, updated });
    return updated;
  }

  /**
   * Score based on content characteristics
   */
  private scoreContent(note: Note): number {
    let score = 0;

    // Length factor (longer = more substantial, with diminishing returns)
    const length = note.content.length;
    score += Math.min(0.3, length / 3000);

    // Has code blocks
    if (note.content.includes("```") || note.content.includes("    ")) {
      score += 0.15;
    }

    // Contains important keywords
    const lowerContent = note.content.toLowerCase();
    const indicatorCount = IMPORTANCE_INDICATORS.filter((kw) =>
      lowerContent.includes(kw)
    ).length;
    score += Math.min(0.3, indicatorCount * 0.06);

    // Has keywords/tags (structured = higher quality)
    if (note.keywords && note.keywords.length > 0) {
      score += 0.1;
    }
    if (note.tags && note.tags.length > 0) {
      score += 0.05;
    }

    // Has summary (processed = higher quality)
    if (note.summary) {
      score += 0.1;
    }

    return Math.min(1.0, score);
  }

  /**
   * Score based on link connectivity
   */
  private async scoreLinkCount(note: Note, adapter: StorageAdapter): Promise<number> {
    try {
      const links = await adapter.getLinks(note.note_id);
      const linkCount = links.length;

      // Logarithmic scaling: 0 links = 0, 1 link = 0.3, 5 links = 0.7, 10+ links = 1.0
      if (linkCount === 0) return 0;
      return Math.min(1.0, Math.log(linkCount + 1) / Math.log(11));
    } catch {
      return 0;
    }
  }

  /**
   * Score based on freshness (recency)
   */
  private scoreFreshness(note: Note): number {
    const createdAt = new Date(note.created_at).getTime();
    const now = Date.now();
    const ageDays = (now - createdAt) / (1000 * 60 * 60 * 24);

    // Exponential decay with configurable half-life
    const halfLife = this.config.freshnessHalfLifeDays;
    return Math.exp((-Math.LN2 * ageDays) / halfLife);
  }

  /**
   * Score based on role
   */
  private scoreRole(note: Note): number {
    return ROLE_BASE_IMPORTANCE[note.role] ?? 0.5;
  }
}
