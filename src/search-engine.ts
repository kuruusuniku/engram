/**
 * SearchEngine - Hybrid search with RRF (Reciprocal Rank Fusion)
 *
 * Combines FTS5 full-text search and vector similarity search
 * into a single ranked result set using RRF scoring.
 */

import type { StorageAdapter } from "./storage/adapter.js";
import type { EmbeddingClient } from "./embedding.js";
import type { SearchOptions, SearchResult } from "./storage/types.js";

export interface HybridSearchOptions extends SearchOptions {
  /** Weight for FTS results in RRF (0-1, default 0.5) */
  ftsWeight?: number;
  /** Weight for vector results in RRF (0-1, default 0.5) */
  vectorWeight?: number;
}

/** RRF constant k (standard value from literature) */
const RRF_K = 60;

export class SearchEngine {
  constructor(
    private adapter: StorageAdapter,
    private embedding: EmbeddingClient
  ) {}

  /**
   * Hybrid search: FTS5 + vector search combined with RRF
   *
   * If embedding is unavailable, falls back to FTS-only search.
   */
  async hybridSearch(
    query: string,
    options: HybridSearchOptions
  ): Promise<SearchResult[]> {
    const limit = options.limit ?? 10;
    const ftsWeight = options.ftsWeight ?? 0.5;
    const vectorWeight = options.vectorWeight ?? 0.5;

    // Fetch more candidates than needed for better fusion
    const candidateLimit = Math.max(limit * 3, 30);

    // Run FTS search
    const ftsResults = await this.adapter.fullTextSearch(query, {
      ...options,
      limit: candidateLimit,
    });

    // Run vector search if embedding is available
    let vectorResults: SearchResult[] = [];
    if (this.embedding.available && this.adapter.vectorSearch) {
      const queryEmbedding = await this.embedding.embed(query);
      if (queryEmbedding) {
        vectorResults = await this.adapter.vectorSearch(queryEmbedding, {
          ...options,
          limit: candidateLimit,
        });
      }
    }

    // If only FTS results available, return them directly
    if (vectorResults.length === 0) {
      return ftsResults.slice(0, limit).map((r) => ({
        ...r,
        match_type: "fts" as const,
      }));
    }

    // Apply RRF fusion
    return this.rrfFusion(ftsResults, vectorResults, ftsWeight, vectorWeight, limit);
  }

  /**
   * Reciprocal Rank Fusion (RRF)
   *
   * score(d) = sum_i( weight_i / (k + rank_i(d)) )
   *
   * Where k=60 (constant), rank_i is 1-indexed rank in each result list.
   */
  private rrfFusion(
    ftsResults: SearchResult[],
    vectorResults: SearchResult[],
    ftsWeight: number,
    vectorWeight: number,
    limit: number
  ): SearchResult[] {
    const scoreMap = new Map<
      string,
      { note: SearchResult["note"]; rrfScore: number }
    >();

    // Add FTS scores
    for (let rank = 0; rank < ftsResults.length; rank++) {
      const result = ftsResults[rank];
      const noteId = result.note.note_id;
      const rrfScore = ftsWeight / (RRF_K + rank + 1);

      const existing = scoreMap.get(noteId);
      if (existing) {
        existing.rrfScore += rrfScore;
      } else {
        scoreMap.set(noteId, { note: result.note, rrfScore });
      }
    }

    // Add vector scores
    for (let rank = 0; rank < vectorResults.length; rank++) {
      const result = vectorResults[rank];
      const noteId = result.note.note_id;
      const rrfScore = vectorWeight / (RRF_K + rank + 1);

      const existing = scoreMap.get(noteId);
      if (existing) {
        existing.rrfScore += rrfScore;
      } else {
        scoreMap.set(noteId, { note: result.note, rrfScore });
      }
    }

    // Sort by RRF score descending
    const sorted = Array.from(scoreMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, limit);

    return sorted.map((item) => ({
      note: item.note,
      score: item.rrfScore,
      match_type: "hybrid" as const,
    }));
  }
}
