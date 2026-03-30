import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteAdapter } from "../storage/sqlite-adapter.js";

describe("SQLiteAdapter - Vector Search (sqlite-vec)", () => {
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

  it("should have sqlite-vec extension loaded", () => {
    expect(adapter.vectorSearchEnabled).toBe(true);
  });

  it("should save and retrieve embedding", async () => {
    const note = await adapter.saveNote({
      tenant_id: tenantId,
      role: "user",
      content: "Test note for embedding",
    });

    const embedding = Array.from({ length: 1536 }, (_, i) => Math.sin(i * 0.01));
    await adapter.saveEmbedding(note.note_id, embedding);

    // Search with same embedding should find the note
    const results = await adapter.vectorSearch!(embedding, {
      tenant_id: tenantId,
      limit: 5,
    });

    expect(results.length).toBe(1);
    expect(results[0].note.note_id).toBe(note.note_id);
    expect(results[0].score).toBeCloseTo(0, 1); // Distance should be ~0 for identical vector
    expect(results[0].match_type).toBe("vector");
  });

  it("should return nearest neighbors ordered by distance", async () => {
    const note1 = await adapter.saveNote({
      tenant_id: tenantId,
      role: "user",
      content: "Note A",
    });
    const note2 = await adapter.saveNote({
      tenant_id: tenantId,
      role: "user",
      content: "Note B",
    });
    const note3 = await adapter.saveNote({
      tenant_id: tenantId,
      role: "user",
      content: "Note C",
    });

    // Create embeddings with known distances
    const baseEmb = Array.from({ length: 1536 }, () => 0.5);
    const closeEmb = Array.from({ length: 1536 }, () => 0.51); // Very close to base
    const farEmb = Array.from({ length: 1536 }, () => 0.9); // Far from base

    await adapter.saveEmbedding(note1.note_id, baseEmb);
    await adapter.saveEmbedding(note2.note_id, closeEmb);
    await adapter.saveEmbedding(note3.note_id, farEmb);

    // Search for base embedding
    const results = await adapter.vectorSearch!(baseEmb, {
      tenant_id: tenantId,
      limit: 10,
    });

    expect(results.length).toBe(3);
    // First result should be the exact match (distance ~0)
    expect(results[0].note.note_id).toBe(note1.note_id);
    // Second should be close
    expect(results[1].note.note_id).toBe(note2.note_id);
    // Third should be farthest
    expect(results[2].note.note_id).toBe(note3.note_id);

    // Distances should be in ascending order
    expect(results[0].score).toBeLessThanOrEqual(results[1].score);
    expect(results[1].score).toBeLessThanOrEqual(results[2].score);
  });

  it("should respect limit parameter", async () => {
    // Create 5 notes with embeddings
    for (let i = 0; i < 5; i++) {
      const note = await adapter.saveNote({
        tenant_id: tenantId,
        role: "user",
        content: `Note ${i}`,
      });
      const emb = Array.from({ length: 1536 }, () => Math.random());
      await adapter.saveEmbedding(note.note_id, emb);
    }

    const query = Array.from({ length: 1536 }, () => 0.5);
    const results = await adapter.vectorSearch!(query, {
      tenant_id: tenantId,
      limit: 2,
    });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("should filter by tenant_id", async () => {
    // Create second tenant
    await adapter.createTenant({
      tenant_id: "other-tenant",
      name: "Other",
    });

    const note1 = await adapter.saveNote({
      tenant_id: tenantId,
      role: "user",
      content: "Note for test tenant",
    });
    const note2 = await adapter.saveNote({
      tenant_id: "other-tenant",
      role: "user",
      content: "Note for other tenant",
    });

    const emb = Array.from({ length: 1536 }, () => 0.5);
    await adapter.saveEmbedding(note1.note_id, emb);
    await adapter.saveEmbedding(note2.note_id, emb);

    const results = await adapter.vectorSearch!(emb, {
      tenant_id: tenantId,
      limit: 10,
    });

    expect(results.length).toBe(1);
    expect(results[0].note.tenant_id).toBe(tenantId);
  });

  it("should handle upsert (update existing embedding)", async () => {
    const note = await adapter.saveNote({
      tenant_id: tenantId,
      role: "user",
      content: "Note with updated embedding",
    });

    const emb1 = Array.from({ length: 1536 }, () => 0.1);
    const emb2 = Array.from({ length: 1536 }, () => 0.9);

    await adapter.saveEmbedding(note.note_id, emb1);
    // Update with new embedding
    await adapter.saveEmbedding(note.note_id, emb2);

    // Search should find it closer to emb2
    const resultsForEmb2 = await adapter.vectorSearch!(emb2, {
      tenant_id: tenantId,
      limit: 5,
    });

    expect(resultsForEmb2.length).toBe(1);
    expect(resultsForEmb2[0].score).toBeCloseTo(0, 1);
  });

  it("should throw when saving embedding for non-existent note", async () => {
    const emb = Array.from({ length: 1536 }, () => 0.5);
    await expect(
      adapter.saveEmbedding("non-existent-id", emb)
    ).rejects.toThrow("Note not found");
  });

  it("should return empty array when no embeddings exist", async () => {
    await adapter.saveNote({
      tenant_id: tenantId,
      role: "user",
      content: "Note without embedding",
    });

    const query = Array.from({ length: 1536 }, () => 0.5);
    const results = await adapter.vectorSearch!(query, {
      tenant_id: tenantId,
      limit: 5,
    });

    expect(results).toHaveLength(0);
  });
});
