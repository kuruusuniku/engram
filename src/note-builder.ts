/**
 * NoteBuilder - A-MEM style note structuring
 *
 * Automatically generates:
 * - Summary (LLM)
 * - Keywords (LLM)
 * - Tags (LLM)
 * - Context description (LLM)
 * - Embedding vector
 * - Inter-note links
 */

import type { LLMClient } from "./llm.js";
import type { EmbeddingClient } from "./embedding.js";
import type { StorageAdapter } from "./storage/adapter.js";
import type { Note, CreateNoteInput, SearchOptions } from "./storage/types.js";

export interface NoteStructure {
  summary: string;
  keywords: string[];
  tags: string[];
  context_desc: string;
}

export interface LinkSuggestion {
  target_id: string;
  relation: string;
  strength: number;
}

const STRUCTURING_SYSTEM_PROMPT = `You are a note structuring assistant. Given a conversation message, extract structured metadata.

Respond ONLY with valid JSON in this exact format:
{
  "summary": "1-2 sentence summary of the content",
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "tags": ["tag1", "tag2"],
  "context_desc": "Brief description of the context and purpose of this message"
}

Rules:
- summary: Concise, captures the essence. Max 2 sentences.
- keywords: 3-7 specific, meaningful keywords. Include technical terms.
- tags: 2-5 broad category tags. Examples: programming, architecture, debugging, deployment, design, etc.
- context_desc: 1 sentence describing when/why this message matters.
- Always respond in the same language as the input text.`;

const LINK_SYSTEM_PROMPT = `You are a note linking assistant. Given a new note and a list of existing notes, identify the most relevant connections.

Respond ONLY with valid JSON array:
[
  {"target_id": "note-id-here", "relation": "brief relation description", "strength": 0.8}
]

Rules:
- Only include genuinely related notes (strength > 0.5)
- strength: 0.5 = loosely related, 0.7 = related, 0.9 = strongly related, 1.0 = direct continuation
- relation: brief description like "follow-up", "same-topic", "contrasts-with", "builds-on", "references"
- Maximum 5 links per note
- If no notes are related, return empty array []`;

export class NoteBuilder {
  constructor(
    private llm: LLMClient,
    private embedding: EmbeddingClient,
    private adapter: StorageAdapter
  ) {}

  /**
   * Structure a note: generate summary, keywords, tags, context_desc using LLM
   */
  async structureNote(content: string, role: string): Promise<NoteStructure | null> {
    if (!this.llm.available) return null;

    const prompt = `Role: ${role}\nContent:\n${content}`;

    try {
      const response = await this.llm.complete(prompt, STRUCTURING_SYSTEM_PROMPT);
      if (!response) return null;

      // Parse JSON from response (handle potential markdown wrapping)
      const jsonStr = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(jsonStr) as NoteStructure;

      // Validate structure
      if (
        typeof parsed.summary !== "string" ||
        !Array.isArray(parsed.keywords) ||
        !Array.isArray(parsed.tags) ||
        typeof parsed.context_desc !== "string"
      ) {
        console.error("[note-builder] Invalid LLM response structure");
        return null;
      }

      return parsed;
    } catch (error) {
      console.error("[note-builder] Failed to structure note:", error);
      return null;
    }
  }

  /**
   * Generate embedding for note content
   */
  async generateEmbedding(content: string, summary?: string): Promise<number[] | null> {
    // Combine content with summary for richer embedding
    const textForEmbedding = summary
      ? `${summary}\n\n${content}`
      : content;

    return this.embedding.embed(textForEmbedding);
  }

  /**
   * Find and create links between a new note and existing notes.
   * Uses both vector similarity and LLM-based relation analysis.
   */
  async suggestLinks(
    note: Note,
    options: SearchOptions
  ): Promise<LinkSuggestion[]> {
    const suggestions: LinkSuggestion[] = [];

    // Strategy 1: Vector-based similarity (if embedding available)
    if (note.embedding && this.adapter.vectorSearch) {
      try {
        const vectorResults = await this.adapter.vectorSearch(
          Array.from(note.embedding),
          { ...options, limit: 10 }
        );

        // Filter out self and convert to link suggestions
        for (const result of vectorResults) {
          if (result.note.note_id !== note.note_id && result.score > 0) {
            // Convert distance to similarity (lower distance = higher similarity)
            // sqlite-vec returns L2 distance, convert to 0-1 strength
            const strength = Math.max(0, Math.min(1, 1 - result.score / 10));
            if (strength > 0.3) {
              suggestions.push({
                target_id: result.note.note_id,
                relation: "similar-content",
                strength,
              });
            }
          }
        }
      } catch (error) {
        console.error("[note-builder] Vector link search failed:", error);
      }
    }

    // Strategy 2: Keyword overlap
    if (note.keywords && note.keywords.length > 0) {
      try {
        // Search for notes with matching keywords using FTS
        // Quote each keyword to avoid FTS5 syntax issues with special characters
        const keywordQuery = note.keywords
          .map((k) => `"${k.replace(/"/g, "")}"`)
          .join(" OR ");
        const ftsResults = await this.adapter.fullTextSearch(keywordQuery, {
          ...options,
          limit: 10,
        });

        for (const result of ftsResults) {
          if (
            result.note.note_id !== note.note_id &&
            !suggestions.find((s) => s.target_id === result.note.note_id)
          ) {
            // Calculate keyword overlap strength
            const targetKeywords = result.note.keywords ?? [];
            const overlap = note.keywords!.filter((k) =>
              targetKeywords.includes(k)
            ).length;
            const strength = Math.min(1, overlap / Math.max(note.keywords!.length, 1) + 0.3);

            if (strength > 0.4) {
              suggestions.push({
                target_id: result.note.note_id,
                relation: "shared-keywords",
                strength: Math.min(1, strength),
              });
            }
          }
        }
      } catch (error) {
        console.error("[note-builder] Keyword link search failed:", error);
      }
    }

    // Sort by strength descending and limit to top 5
    return suggestions
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5);
  }

  /**
   * Full pipeline: structure note, generate embedding, create links.
   * Returns the enhanced CreateNoteInput.
   */
  async enhance(
    input: CreateNoteInput
  ): Promise<CreateNoteInput> {
    const enhanced = { ...input };

    // Step 1: LLM structuring (if no keywords/summary already provided)
    if (!enhanced.summary || !enhanced.keywords || !enhanced.tags) {
      const structure = await this.structureNote(input.content, input.role);
      if (structure) {
        if (!enhanced.summary) enhanced.summary = structure.summary;
        if (!enhanced.keywords) enhanced.keywords = structure.keywords;
        if (!enhanced.tags) enhanced.tags = structure.tags;
        if (!enhanced.context_desc) enhanced.context_desc = structure.context_desc;
      }
    }

    return enhanced;
  }

  /**
   * After a note is saved: generate embedding, save it, and create links.
   */
  async postProcess(
    note: Note,
    options: SearchOptions
  ): Promise<{ embeddingGenerated: boolean; linksCreated: number }> {
    let embeddingGenerated = false;
    let linksCreated = 0;

    // Generate and save embedding
    const embeddingVector = await this.generateEmbedding(
      note.content,
      note.summary
    );
    if (embeddingVector && this.adapter.saveEmbedding) {
      await this.adapter.saveEmbedding(note.note_id, embeddingVector);
      embeddingGenerated = true;

      // Update in-memory note for link suggestion
      note.embedding = new Float32Array(embeddingVector);
    }

    // Suggest and create links
    const linkSuggestions = await this.suggestLinks(note, options);
    for (const suggestion of linkSuggestions) {
      try {
        await this.adapter.addLink({
          source_id: note.note_id,
          target_id: suggestion.target_id,
          relation: suggestion.relation,
          strength: suggestion.strength,
        });
        linksCreated++;
      } catch (error) {
        console.error("[note-builder] Failed to create link:", error);
      }
    }

    return { embeddingGenerated, linksCreated };
  }
}
