import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EmbeddingQueue } from "../embedding-queue.js";
import type { EmbeddingClient } from "../embedding.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { SQLiteAdapter } from "../storage/sqlite-adapter.js";

describe("EmbeddingQueue", () => {
  let adapter: StorageAdapter;
  let mockEmbeddingClient: EmbeddingClient;
  let queue: EmbeddingQueue;

  beforeEach(async () => {
    adapter = new SQLiteAdapter();
    await adapter.initialize({
      type: "sqlite",
      dbPath: ":memory:",
      tenantId: "test",
    });

    await adapter.createTenant({ tenant_id: "test", name: "Test" });

    mockEmbeddingClient = {
      embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
      embedBatch: vi.fn().mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => new Array(1536).fill(0.1)))
      ),
      dimension: 1536,
      available: true,
    };

    queue = new EmbeddingQueue(mockEmbeddingClient, adapter, {
      batchSize: 3,
      flushDelayMs: 50,
      maxQueueSize: 10,
    });
  });

  afterEach(async () => {
    await queue.cleanup();
    await adapter.close();
  });

  it("should report initial status", () => {
    const status = queue.getStatus();
    expect(status.pending).toBe(0);
    expect(status.processing).toBe(false);
    expect(status.totalProcessed).toBe(0);
    expect(status.totalFailed).toBe(0);
  });

  it("should process a single item after flush delay", async () => {
    const note = await adapter.saveNote({
      tenant_id: "test",
      role: "user",
      content: "Test content",
    });

    const result = await queue.enqueue(note.note_id, "Test content");
    expect(result).toBe(true);

    const status = queue.getStatus();
    expect(status.totalProcessed).toBe(1);
  });

  it("should batch multiple items", async () => {
    const notes = [];
    for (let i = 0; i < 3; i++) {
      const note = await adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: `Content ${i}`,
      });
      notes.push(note);
    }

    // Enqueue all 3 (= batchSize), should trigger immediate flush
    const results = await Promise.all(
      notes.map((n) => queue.enqueue(n.note_id, n.content))
    );

    expect(results.every((r) => r === true)).toBe(true);
    expect(mockEmbeddingClient.embedBatch).toHaveBeenCalledTimes(1);
    expect((mockEmbeddingClient.embedBatch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(3);
  });

  it("should return false when client is unavailable", async () => {
    const unavailableClient: EmbeddingClient = {
      embed: vi.fn().mockResolvedValue(null),
      embedBatch: vi.fn().mockResolvedValue([]),
      dimension: 1536,
      available: false,
    };
    const q = new EmbeddingQueue(unavailableClient, adapter);

    const result = await q.enqueue("note-1", "text");
    expect(result).toBe(false);
    await q.cleanup();
  });

  it("should reject when queue is full", async () => {
    const slowClient: EmbeddingClient = {
      embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
      embedBatch: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 1000))
      ),
      dimension: 1536,
      available: true,
    };
    const q = new EmbeddingQueue(slowClient, adapter, {
      maxQueueSize: 2,
      batchSize: 100,
      flushDelayMs: 10000,
    });

    // Fill the queue (no flush triggered yet since batchSize=100)
    const note1 = await adapter.saveNote({ tenant_id: "test", role: "user", content: "a" });
    const note2 = await adapter.saveNote({ tenant_id: "test", role: "user", content: "b" });
    const note3 = await adapter.saveNote({ tenant_id: "test", role: "user", content: "c" });

    // Don't await -- these are queued
    q.enqueue(note1.note_id, "a");
    q.enqueue(note2.note_id, "b");

    // Third should be rejected since queue is full
    const result = await q.enqueue(note3.note_id, "c");
    expect(result).toBe(false);

    await q.cleanup();
  });

  it("should drain all pending items", async () => {
    const notes = [];
    for (let i = 0; i < 5; i++) {
      const note = await adapter.saveNote({
        tenant_id: "test",
        role: "user",
        content: `Content ${i}`,
      });
      notes.push(note);
    }

    // Enqueue all without awaiting individual results
    const promises = notes.map((n) => queue.enqueue(n.note_id, n.content));
    await Promise.all(promises);

    await queue.drain();

    const status = queue.getStatus();
    expect(status.pending).toBe(0);
    expect(status.processing).toBe(false);
    expect(status.totalProcessed).toBe(5);
  });

  it("should handle embedding failures gracefully", async () => {
    const failClient: EmbeddingClient = {
      embed: vi.fn().mockResolvedValue(null),
      embedBatch: vi.fn().mockResolvedValue([null, null]),
      dimension: 1536,
      available: true,
    };
    const q = new EmbeddingQueue(failClient, adapter, { batchSize: 2, flushDelayMs: 50 });

    const note1 = await adapter.saveNote({ tenant_id: "test", role: "user", content: "a" });
    const note2 = await adapter.saveNote({ tenant_id: "test", role: "user", content: "b" });

    const results = await Promise.all([
      q.enqueue(note1.note_id, "a"),
      q.enqueue(note2.note_id, "b"),
    ]);

    expect(results).toEqual([false, false]);

    const status = q.getStatus();
    expect(status.totalFailed).toBe(2);

    await q.cleanup();
  });
});
