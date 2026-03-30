import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NoteBuilder } from "../note-builder.js";
import { SQLiteAdapter } from "../storage/sqlite-adapter.js";
import { NullEmbeddingClient, OpenAIEmbeddingClient } from "../embedding.js";
import { NullLLMClient, OpenAILLMClient } from "../llm.js";
import type { StorageConfig, Note } from "../storage/types.js";

describe("NoteBuilder", () => {
  let adapter: SQLiteAdapter;
  const tenantId = "test-tenant";

  beforeEach(async () => {
    adapter = new SQLiteAdapter();
    await adapter.initialize({
      type: "sqlite",
      dbPath: ":memory:",
      tenantId,
    });
    await adapter.createTenant({ tenant_id: tenantId, name: "Test" });
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe("with NullClients (no API key)", () => {
    it("should pass through input unchanged when LLM is unavailable", async () => {
      const builder = new NoteBuilder(
        new NullLLMClient(),
        new NullEmbeddingClient(),
        adapter
      );

      const input = {
        tenant_id: tenantId,
        role: "user" as const,
        content: "Test content",
      };

      const enhanced = await builder.enhance(input);
      expect(enhanced.content).toBe("Test content");
      // No LLM = no auto-generated fields
      expect(enhanced.summary).toBeUndefined();
      expect(enhanced.keywords).toBeUndefined();
    });

    it("should skip embedding generation when unavailable", async () => {
      const builder = new NoteBuilder(
        new NullLLMClient(),
        new NullEmbeddingClient(),
        adapter
      );

      const note = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Test",
      });

      const result = await builder.postProcess(note, {
        tenant_id: tenantId,
      });

      expect(result.embeddingGenerated).toBe(false);
      expect(result.linksCreated).toBe(0);
    });
  });

  describe("with mocked LLM", () => {
    it("should structure note with LLM-generated metadata", async () => {
      const mockLLM = new OpenAILLMClient({ apiKey: "test-key" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "A question about binary search implementation",
                    keywords: ["binary search", "algorithm", "implementation"],
                    tags: ["programming", "data-structures"],
                    context_desc:
                      "User seeking help with a fundamental CS algorithm",
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        )
      );

      const builder = new NoteBuilder(
        mockLLM,
        new NullEmbeddingClient(),
        adapter
      );

      const enhanced = await builder.enhance({
        tenant_id: tenantId,
        role: "user",
        content: "How do I implement a binary search tree?",
      });

      expect(enhanced.summary).toBe(
        "A question about binary search implementation"
      );
      expect(enhanced.keywords).toEqual([
        "binary search",
        "algorithm",
        "implementation",
      ]);
      expect(enhanced.tags).toEqual(["programming", "data-structures"]);
      expect(enhanced.context_desc).toBe(
        "User seeking help with a fundamental CS algorithm"
      );

      fetchSpy.mockRestore();
    });

    it("should not overwrite existing keywords/tags", async () => {
      const mockLLM = new OpenAILLMClient({ apiKey: "test-key" });
      // LLM should not be called since keywords are already provided
      const builder = new NoteBuilder(
        mockLLM,
        new NullEmbeddingClient(),
        adapter
      );

      const enhanced = await builder.enhance({
        tenant_id: tenantId,
        role: "user",
        content: "Test",
        summary: "Pre-existing summary",
        keywords: ["existing-keyword"],
        tags: ["existing-tag"],
      });

      expect(enhanced.summary).toBe("Pre-existing summary");
      expect(enhanced.keywords).toEqual(["existing-keyword"]);
      expect(enhanced.tags).toEqual(["existing-tag"]);
    });

    it("should handle LLM errors gracefully", async () => {
      const mockLLM = new OpenAILLMClient({ apiKey: "test-key" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("API error"));

      const builder = new NoteBuilder(
        mockLLM,
        new NullEmbeddingClient(),
        adapter
      );

      const enhanced = await builder.enhance({
        tenant_id: tenantId,
        role: "user",
        content: "Test content",
      });

      // Should not crash, just return input without enhancements
      expect(enhanced.content).toBe("Test content");
      expect(enhanced.summary).toBeUndefined();

      fetchSpy.mockRestore();
    });
  });

  describe("with mocked Embedding", () => {
    it("should generate and save embedding during postProcess", async () => {
      if (!adapter.vectorSearchEnabled) return;

      const mockEmbedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);
      const mockEmbClient = new OpenAIEmbeddingClient({ apiKey: "test-key" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ embedding: mockEmbedding, index: 0 }],
          }),
          { status: 200 }
        )
      );

      const builder = new NoteBuilder(
        new NullLLMClient(),
        mockEmbClient,
        adapter
      );

      const note = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Test embedding generation",
      });

      const result = await builder.postProcess(note, {
        tenant_id: tenantId,
      });

      expect(result.embeddingGenerated).toBe(true);

      // Verify we can now vector search for this note
      const vecResults = await adapter.vectorSearch!(mockEmbedding, {
        tenant_id: tenantId,
        limit: 5,
      });
      expect(vecResults.length).toBeGreaterThan(0);
      expect(vecResults[0].note.note_id).toBe(note.note_id);

      fetchSpy.mockRestore();
    });
  });

  describe("link suggestions", () => {
    it("should suggest links based on keyword overlap", async () => {
      // Create some related notes
      const note1 = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "How to implement authentication with JWT",
        keywords: ["JWT", "authentication", "security"],
        tags: ["backend"],
      });
      const note2 = await adapter.saveNote({
        tenant_id: tenantId,
        role: "assistant",
        content: "JWT authentication implementation guide",
        keywords: ["JWT", "authentication", "implementation"],
        tags: ["backend"],
      });
      const note3 = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "Deploy React to production",
        keywords: ["React", "deploy", "production"],
        tags: ["frontend"],
      });

      const builder = new NoteBuilder(
        new NullLLMClient(),
        new NullEmbeddingClient(),
        adapter
      );

      const newNote: Note = {
        note_id: "new-note",
        tenant_id: tenantId,
        role: "user",
        content: "JWT token refresh strategy for authentication",
        keywords: ["JWT", "authentication", "token-refresh"],
        importance: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // We need to actually save this note first for FTS to find it
      const saved = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: "JWT token refresh strategy for authentication",
        keywords: ["JWT", "authentication", "token-refresh"],
      });

      const links = await builder.suggestLinks(
        { ...saved, keywords: ["JWT", "authentication", "token-refresh"] },
        { tenant_id: tenantId }
      );

      // Should find links to JWT/auth related notes, not React deploy
      expect(links.length).toBeGreaterThan(0);
      const targetIds = links.map((l) => l.target_id);
      // Should link to note1 or note2 (JWT related), probably not note3 (React)
      expect(
        targetIds.includes(note1.note_id) || targetIds.includes(note2.note_id)
      ).toBe(true);
    });
  });
});
