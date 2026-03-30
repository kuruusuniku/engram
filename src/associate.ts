/**
 * AssociateEngine - Serendipity search via TF-IDF random walk + link exploration
 *
 * Implements the A-MEM / Zenn-article inspired associative search:
 * 1. Start from a seed (text or random note)
 * 2. Extract keywords via TF-IDF-like scoring
 * 3. Random walk through keyword matches and note links
 * 4. Apply temperature for exploration breadth
 * 5. Ensure diversity via MMR (Maximal Marginal Relevance)
 */

import type { StorageAdapter } from "./storage/adapter.js";
import type { EmbeddingClient } from "./embedding.js";
import type { Note, SearchResult, SearchOptions } from "./storage/types.js";

export interface AssociateOptions {
  /** Seed text to start association from */
  seed?: string;
  /** Temperature: 0.0 = focused, 1.0 = exploratory (default 0.5) */
  temperature?: number;
  /** Number of results to return (default 5) */
  limit?: number;
  /** Tenant ID */
  tenant_id: string;
  /** Number of random walk steps (default 3) */
  walkSteps?: number;
}

export interface AssociateResult {
  note: Note;
  /** Serendipity score: how "surprising" the connection is */
  serendipityScore: number;
  /** How the note was discovered */
  discoveryPath: string;
}

export class AssociateEngine {
  constructor(
    private adapter: StorageAdapter,
    private embedding: EmbeddingClient
  ) {}

  /**
   * Run associative search from a seed.
   */
  async associate(options: AssociateOptions): Promise<AssociateResult[]> {
    const {
      seed,
      temperature = 0.5,
      limit = 5,
      tenant_id,
      walkSteps = 3,
    } = options;

    const candidates = new Map<string, AssociateResult>();
    const visited = new Set<string>();

    // Step 1: Get seed note(s)
    let seedNotes: Note[];
    if (seed) {
      // Search for notes matching the seed text
      seedNotes = await this.getSeedNotes(seed, tenant_id);
    } else {
      // Pick random notes as seeds
      seedNotes = await this.getRandomNotes(tenant_id, 3);
    }

    if (seedNotes.length === 0) {
      return [];
    }

    // Mark seeds as visited
    for (const n of seedNotes) {
      visited.add(n.note_id);
    }

    // Step 2: Extract keywords from seed notes (TF-IDF-like)
    const seedKeywords = this.extractKeywords(seedNotes);

    // Step 3: Random walk
    let currentNotes = seedNotes;
    for (let step = 0; step < walkSteps; step++) {
      const nextNotes: Note[] = [];

      for (const current of currentNotes) {
        // Strategy 1: Follow links
        const linkDiscoveries = await this.exploreLinks(
          current,
          visited,
          temperature
        );
        for (const disc of linkDiscoveries) {
          if (!candidates.has(disc.note.note_id)) {
            candidates.set(disc.note.note_id, disc);
            nextNotes.push(disc.note);
          }
          visited.add(disc.note.note_id);
        }

        // Strategy 2: Keyword-based jump
        const keywordDiscoveries = await this.keywordJump(
          seedKeywords,
          tenant_id,
          visited,
          temperature,
          step
        );
        for (const disc of keywordDiscoveries) {
          if (!candidates.has(disc.note.note_id)) {
            candidates.set(disc.note.note_id, disc);
            nextNotes.push(disc.note);
          }
          visited.add(disc.note.note_id);
        }

        // Strategy 3: Vector-based exploration (with noise based on temperature)
        if (this.embedding.available && this.adapter.vectorSearch && current.embedding) {
          const vectorDiscoveries = await this.vectorExplore(
            current,
            tenant_id,
            visited,
            temperature
          );
          for (const disc of vectorDiscoveries) {
            if (!candidates.has(disc.note.note_id)) {
              candidates.set(disc.note.note_id, disc);
              nextNotes.push(disc.note);
            }
            visited.add(disc.note.note_id);
          }
        }
      }

      // Probabilistically select which notes to continue walking from
      currentNotes = this.selectWalkContinuation(nextNotes, temperature, 3);
    }

    // Step 4: Score and rank candidates by serendipity
    const scoredCandidates = this.scoreSerendipity(
      Array.from(candidates.values()),
      seedNotes,
      seedKeywords,
      temperature
    );

    // Step 5: Apply MMR for diversity
    const diverse = this.applyMMR(scoredCandidates, limit, 0.7);

    return diverse;
  }

  /**
   * Get notes matching seed text
   */
  private async getSeedNotes(
    seed: string,
    tenantId: string
  ): Promise<Note[]> {
    try {
      const results = await this.adapter.fullTextSearch(seed, {
        tenant_id: tenantId,
        limit: 3,
      });
      return results.map((r) => r.note);
    } catch {
      return [];
    }
  }

  /**
   * Get random notes from the database
   */
  private async getRandomNotes(
    tenantId: string,
    count: number
  ): Promise<Note[]> {
    // Use a broad search to get some notes, then randomly select
    try {
      const stats = await this.adapter.getStats(tenantId);
      if (stats.total_notes === 0) return [];

      // Get top keywords and search for them
      const topKeywords = await this.adapter.getTopKeywords(tenantId, 10);
      if (topKeywords.length === 0) return [];

      // Pick random keywords
      const shuffled = topKeywords.sort(() => Math.random() - 0.5);
      const keyword = shuffled[0].keyword;

      const results = await this.adapter.fullTextSearch(keyword, {
        tenant_id: tenantId,
        limit: count * 3,
      });

      // Random selection
      const notes = results.map((r) => r.note);
      return this.randomSample(notes, count);
    } catch {
      return [];
    }
  }

  /**
   * Extract significant keywords from notes (TF-IDF-like scoring)
   */
  private extractKeywords(notes: Note[]): string[] {
    const keywordCounts = new Map<string, number>();

    for (const note of notes) {
      // Collect explicit keywords
      if (note.keywords) {
        for (const kw of note.keywords) {
          keywordCounts.set(kw, (keywordCounts.get(kw) || 0) + 1);
        }
      }

      // Extract words from content (simple TF approximation)
      const words = note.content
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .filter((w) => !STOP_WORDS.has(w));

      for (const word of words) {
        keywordCounts.set(word, (keywordCounts.get(word) || 0) + 1);
      }
    }

    // Sort by frequency and take top keywords
    return Array.from(keywordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([kw]) => kw);
  }

  /**
   * Explore links from a note
   */
  private async exploreLinks(
    note: Note,
    visited: Set<string>,
    temperature: number
  ): Promise<AssociateResult[]> {
    const results: AssociateResult[] = [];

    try {
      const links = await this.adapter.getLinks(note.note_id);

      for (const link of links) {
        const targetId =
          link.source_id === note.note_id ? link.target_id : link.source_id;

        if (visited.has(targetId)) continue;

        // Temperature affects whether we follow weak links
        const threshold = 0.3 + (1 - temperature) * 0.4; // 0.3 at temp=1, 0.7 at temp=0
        if (link.strength < threshold && Math.random() > temperature) continue;

        const targetNote = await this.adapter.getNote(targetId);
        if (targetNote) {
          results.push({
            note: targetNote,
            serendipityScore: 0, // Will be scored later
            discoveryPath: `link:${link.relation ?? "related"}`,
          });
        }
      }
    } catch (error) {
      console.error("[associate] Link exploration failed:", error);
    }

    return results;
  }

  /**
   * Jump to notes via keyword search
   */
  private async keywordJump(
    keywords: string[],
    tenantId: string,
    visited: Set<string>,
    temperature: number,
    step: number
  ): Promise<AssociateResult[]> {
    if (keywords.length === 0) return [];

    // Pick keywords based on temperature
    // Low temp: pick top keywords; High temp: pick random keywords
    const numKeywords = Math.max(
      1,
      Math.floor(keywords.length * (0.3 + temperature * 0.7))
    );
    const selectedKeywords =
      temperature > 0.5
        ? this.randomSample(keywords, numKeywords)
        : keywords.slice(0, numKeywords);

    const query = selectedKeywords.join(" OR ");

    try {
      const results = await this.adapter.fullTextSearch(query, {
        tenant_id: tenantId,
        limit: 5,
      });

      return results
        .filter((r) => !visited.has(r.note.note_id))
        .slice(0, 3)
        .map((r) => ({
          note: r.note,
          serendipityScore: 0,
          discoveryPath: `keyword-jump:step${step}:${selectedKeywords.join(",")}`,
        }));
    } catch {
      return [];
    }
  }

  /**
   * Vector-based exploration with noise injection
   */
  private async vectorExplore(
    note: Note,
    tenantId: string,
    visited: Set<string>,
    temperature: number
  ): Promise<AssociateResult[]> {
    if (!note.embedding || !this.adapter.vectorSearch) return [];

    try {
      // Add random noise proportional to temperature
      const noisyEmbedding = Array.from(note.embedding).map((v) => {
        const noise = (Math.random() - 0.5) * 2 * temperature * 0.3;
        return v + noise;
      });

      const results = await this.adapter.vectorSearch(noisyEmbedding, {
        tenant_id: tenantId,
        limit: 5,
      });

      return results
        .filter((r) => !visited.has(r.note.note_id))
        .slice(0, 2)
        .map((r) => ({
          note: r.note,
          serendipityScore: 0,
          discoveryPath: `vector-explore:temp${temperature.toFixed(1)}`,
        }));
    } catch {
      return [];
    }
  }

  /**
   * Probabilistically select notes to continue walking from
   */
  private selectWalkContinuation(
    notes: Note[],
    temperature: number,
    count: number
  ): Note[] {
    if (notes.length <= count) return notes;

    if (temperature > 0.7) {
      // High temperature: random selection
      return this.randomSample(notes, count);
    }

    // Lower temperature: prefer notes with more keywords/links (more connected)
    const scored = notes.map((n) => ({
      note: n,
      connectivity: (n.keywords?.length ?? 0) + (n.tags?.length ?? 0),
    }));
    scored.sort((a, b) => b.connectivity - a.connectivity);

    // Mix top connected with some random picks
    const topCount = Math.max(1, Math.floor(count * (1 - temperature)));
    const randomCount = count - topCount;

    const top = scored.slice(0, topCount).map((s) => s.note);
    const remaining = scored.slice(topCount).map((s) => s.note);
    const random = this.randomSample(remaining, randomCount);

    return [...top, ...random];
  }

  /**
   * Score candidates by serendipity
   * Sweet spot: surprising enough to be interesting, but not so random as to be useless
   */
  private scoreSerendipity(
    candidates: AssociateResult[],
    seedNotes: Note[],
    seedKeywords: string[],
    temperature: number
  ): AssociateResult[] {
    const seedKeywordSet = new Set(seedKeywords.map((k) => k.toLowerCase()));

    for (const candidate of candidates) {
      const note = candidate.note;

      // Factor 1: Keyword overlap (lower overlap = more serendipitous)
      const noteKeywords = (note.keywords ?? []).map((k) => k.toLowerCase());
      const overlap = noteKeywords.filter((k) => seedKeywordSet.has(k)).length;
      const overlapRatio = noteKeywords.length > 0
        ? overlap / noteKeywords.length
        : 0;

      // Sweet spot: some overlap (0.1-0.4) is ideal
      const overlapScore =
        overlapRatio < 0.1
          ? 0.3 // Too distant
          : overlapRatio > 0.6
          ? 0.4 // Too similar
          : 0.8 + (0.5 - Math.abs(overlapRatio - 0.3)) * 0.5; // Sweet spot

      // Factor 2: Discovery path depth (more steps = more serendipitous)
      const pathSteps = (candidate.discoveryPath.match(/step\d/g) || []).length;
      const depthScore = Math.min(1, 0.3 + pathSteps * 0.2);

      // Factor 3: Content diversity (different role from seeds = bonus)
      const seedRoles = new Set(seedNotes.map((n) => n.role));
      const roleBonus = seedRoles.has(note.role) ? 0 : 0.2;

      // Combine scores with temperature influence
      candidate.serendipityScore =
        overlapScore * (0.5 + temperature * 0.3) +
        depthScore * (0.3 + temperature * 0.2) +
        roleBonus;

      // Normalize to 0-1
      candidate.serendipityScore = Math.min(
        1,
        Math.max(0, candidate.serendipityScore)
      );
    }

    return candidates.sort(
      (a, b) => b.serendipityScore - a.serendipityScore
    );
  }

  /**
   * Maximal Marginal Relevance (MMR) for result diversity
   *
   * score = lambda * relevance - (1 - lambda) * max_similarity_to_selected
   */
  private applyMMR(
    candidates: AssociateResult[],
    limit: number,
    lambda: number
  ): AssociateResult[] {
    if (candidates.length <= limit) return candidates;

    const selected: AssociateResult[] = [];
    const remaining = [...candidates];

    // Pick the highest scored one first
    selected.push(remaining.shift()!);

    while (selected.length < limit && remaining.length > 0) {
      let bestIdx = -1;
      let bestMMRScore = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        const relevance = candidate.serendipityScore;

        // Calculate max similarity to already selected (using keyword overlap as proxy)
        let maxSim = 0;
        for (const sel of selected) {
          const sim = this.keywordSimilarity(
            candidate.note.keywords ?? [],
            sel.note.keywords ?? []
          );
          maxSim = Math.max(maxSim, sim);
        }

        const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
        if (mmrScore > bestMMRScore) {
          bestMMRScore = mmrScore;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        selected.push(remaining.splice(bestIdx, 1)[0]);
      } else {
        break;
      }
    }

    return selected;
  }

  /**
   * Calculate keyword-based similarity between two notes (Jaccard index)
   */
  private keywordSimilarity(kw1: string[], kw2: string[]): number {
    if (kw1.length === 0 && kw2.length === 0) return 0;

    const set1 = new Set(kw1.map((k) => k.toLowerCase()));
    const set2 = new Set(kw2.map((k) => k.toLowerCase()));

    const intersection = [...set1].filter((k) => set2.has(k)).length;
    const union = new Set([...set1, ...set2]).size;

    return union > 0 ? intersection / union : 0;
  }

  /**
   * Random sample without replacement
   */
  private randomSample<T>(arr: T[], count: number): T[] {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }
}

/** Common English stop words to filter out from keyword extraction */
const STOP_WORDS = new Set([
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "i",
  "it", "for", "not", "on", "with", "he", "as", "you", "do", "at",
  "this", "but", "his", "by", "from", "they", "we", "say", "her",
  "she", "or", "an", "will", "my", "one", "all", "would", "there",
  "their", "what", "so", "up", "out", "if", "about", "who", "get",
  "which", "go", "me", "when", "make", "can", "like", "time", "no",
  "just", "him", "know", "take", "people", "into", "year", "your",
  "good", "some", "could", "them", "see", "other", "than", "then",
  "now", "look", "only", "come", "its", "over", "think", "also",
  "back", "after", "use", "two", "how", "our", "work", "first",
  "well", "way", "even", "new", "want", "because", "any", "these",
  "give", "day", "most", "us", "should", "been", "here", "was",
  "were", "had", "are", "has", "more", "very", "much", "does",
]);
