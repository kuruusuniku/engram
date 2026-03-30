/**
 * ClaudeContext - CLAUDE.md reading and context utilization
 *
 * Reads CLAUDE.md content and integrates it into the memory system:
 * - Imports CLAUDE.md as a system note for project context
 * - Makes project rules/context searchable via the memory system
 */

import { readFile, stat } from "node:fs/promises";
import type { StorageAdapter } from "./storage/adapter.js";
import type { Note } from "./storage/types.js";

export interface ClaudeContextConfig {
  /** Path to CLAUDE.md file */
  claudeMdPath: string;
  /** Tenant ID */
  tenantId: string;
  /** Session ID to associate with (optional) */
  sessionId?: string;
}

/** Sentinel note_id prefix for CLAUDE.md-sourced notes */
const CLAUDE_MD_NOTE_PREFIX = "claude-md-context-";

export class ClaudeContext {
  private config: ClaudeContextConfig;
  private adapter: StorageAdapter;
  private lastImportedHash: string | null = null;

  constructor(adapter: StorageAdapter, config: ClaudeContextConfig) {
    this.adapter = adapter;
    this.config = config;
  }

  /**
   * Read CLAUDE.md file content
   */
  async readClaudeMd(): Promise<string | null> {
    try {
      return await readFile(this.config.claudeMdPath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Check if CLAUDE.md exists and has been modified since last import
   */
  async hasChanged(): Promise<boolean> {
    try {
      const fileStat = await stat(this.config.claudeMdPath);
      const currentHash = fileStat.mtimeMs.toString();
      return currentHash !== this.lastImportedHash;
    } catch {
      return false;
    }
  }

  /**
   * Import CLAUDE.md content as a system note.
   * Splits into sections for better searchability.
   */
  async importContext(): Promise<Note[]> {
    const content = await this.readClaudeMd();
    if (!content) return [];

    // Parse sections from markdown
    const sections = this.parseSections(content);
    const importedNotes: Note[] = [];

    for (const section of sections) {
      // Check if this section already exists (by content hash)
      const sectionId = this.generateSectionId(section.heading);

      // Try to find existing note for this section
      const existingNote = await this.adapter.getNote(sectionId);

      if (existingNote) {
        // Update if content changed
        if (existingNote.content !== section.content) {
          const updated = await this.adapter.updateNote(sectionId, {
            content: section.content,
            summary: `CLAUDE.md section: ${section.heading}`,
            keywords: this.extractKeywordsFromSection(section.content),
            tags: ["claude-md", "project-context"],
          });
          importedNotes.push(updated);
        } else {
          importedNotes.push(existingNote);
        }
      } else {
        // Create new note
        const note = await this.adapter.saveNote({
          tenant_id: this.config.tenantId,
          session_id: this.config.sessionId,
          role: "system",
          content: section.content,
          summary: `CLAUDE.md section: ${section.heading}`,
          keywords: this.extractKeywordsFromSection(section.content),
          tags: ["claude-md", "project-context"],
          importance: 0.8, // High importance for project context
        });
        importedNotes.push(note);
      }
    }

    // Mark import time
    try {
      const fileStat = await stat(this.config.claudeMdPath);
      this.lastImportedHash = fileStat.mtimeMs.toString();
    } catch {
      // ignore
    }

    return importedNotes;
  }

  /**
   * Parse markdown into sections
   */
  private parseSections(
    content: string
  ): Array<{ heading: string; content: string }> {
    const sections: Array<{ heading: string; content: string }> = [];
    const lines = content.split("\n");

    let currentHeading = "CLAUDE.md";
    let currentContent: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^#{1,3}\s+(.+)/);
      if (headingMatch) {
        // Save previous section if it has content
        if (currentContent.length > 0) {
          const trimmed = currentContent.join("\n").trim();
          if (trimmed.length > 0) {
            sections.push({
              heading: currentHeading,
              content: trimmed,
            });
          }
        }
        currentHeading = headingMatch[1].trim();
        currentContent = [];
      } else {
        currentContent.push(line);
      }
    }

    // Don't forget the last section
    if (currentContent.length > 0) {
      const trimmed = currentContent.join("\n").trim();
      if (trimmed.length > 0) {
        sections.push({
          heading: currentHeading,
          content: trimmed,
        });
      }
    }

    // If no sections found, treat entire content as one section
    if (sections.length === 0 && content.trim().length > 0) {
      sections.push({
        heading: "CLAUDE.md",
        content: content.trim(),
      });
    }

    return sections;
  }

  /**
   * Generate a deterministic section ID
   */
  private generateSectionId(heading: string): string {
    const slug = heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `${CLAUDE_MD_NOTE_PREFIX}${slug}`;
  }

  /**
   * Extract keywords from a markdown section
   */
  private extractKeywordsFromSection(content: string): string[] {
    // Extract code-like terms, capitalized words, and technical terms
    const words = content
      .split(/[\s,;:()[\]{}]+/)
      .filter((w) => w.length > 2)
      .filter((w) => /^[A-Z]/.test(w) || /[_-]/.test(w) || /\.\w+/.test(w))
      .map((w) => w.replace(/[`*#]/g, ""))
      .filter((w) => w.length > 2);

    // Deduplicate and limit
    return [...new Set(words)].slice(0, 10);
  }
}
