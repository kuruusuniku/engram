import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ImportanceScorer } from "../importance-scorer.js";
import { SQLiteAdapter } from "../storage/sqlite-adapter.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { Note } from "../storage/types.js";

describe("ImportanceScorer", () => {
  let adapter: StorageAdapter;
  let scorer: ImportanceScorer;

  beforeEach(async () => {
    adapter = new SQLiteAdapter();
    await adapter.initialize({
      type: "sqlite",
      dbPath: ":memory:",
      tenantId: "test",
    });
    await adapter.createTenant({ tenant_id: "test", name: "Test" });
    scorer = new ImportanceScorer();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it("should score a basic note between 0 and 1", async () => {
    const note = await adapter.saveNote({
      tenant_id: "test",
      role: "user",
      content: "Hello world",
    });

    const score = await scorer.score(note, adapter);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("should score system notes higher than user notes", async () => {
    const userNote = await adapter.saveNote({
      tenant_id: "test",
      role: "user",
      content: "A simple message",
    });
    const systemNote = await adapter.saveNote({
      tenant_id: "test",
      role: "system",
      content: "A simple message",
    });

    const userScore = await scorer.score(userNote, adapter);
    const systemScore = await scorer.score(systemNote, adapter);

    expect(systemScore).toBeGreaterThan(userScore);
  });

  it("should score notes with keywords higher", async () => {
    const plain = await adapter.saveNote({
      tenant_id: "test",
      role: "user",
      content: "Hello world",
    });
    const rich = await adapter.saveNote({
      tenant_id: "test",
      role: "user",
      content: "Hello world",
      keywords: ["hello", "world"],
      tags: ["greeting"],
      summary: "A greeting message",
    });

    const plainScore = await scorer.score(plain, adapter);
    const richScore = await scorer.score(rich, adapter);

    expect(richScore).toBeGreaterThan(plainScore);
  });

  it("should score longer content higher (diminishing returns)", async () => {
    const short = await adapter.saveNote({
      tenant_id: "test",
      role: "user",
      content: "Short",
    });
    const long = await adapter.saveNote({
      tenant_id: "test",
      role: "user",
      content: "A".repeat(2000),
    });

    const shortScore = await scorer.score(short, adapter);
    const longScore = await scorer.score(long, adapter);

    expect(longScore).toBeGreaterThan(shortScore);
  });

  it("should score notes with important keywords higher", async () => {
    const normal = await adapter.saveNote({
      tenant_id: "test",
      role: "user",
      content: "Let me tell you about cats and dogs",
    });
    const important = await adapter.saveNote({
      tenant_id: "test",
      role: "user",
      content: "We decided on the architecture design for the deployment migration",
    });

    const normalScore = await scorer.score(normal, adapter);
    const importantScore = await scorer.score(important, adapter);

    expect(importantScore).toBeGreaterThan(normalScore);
  });

  it("should score notes with links higher", async () => {
    const isolated = await adapter.saveNote({
      tenant_id: "test",
      role: "user",
      content: "Isolated note",
    });
    const connected = await adapter.saveNote({
      tenant_id: "test",
      role: "user",
      content: "Connected note",
    });

    // Add links to the connected note
    const other1 = await adapter.saveNote({ tenant_id: "test", role: "user", content: "other 1" });
    const other2 = await adapter.saveNote({ tenant_id: "test", role: "user", content: "other 2" });
    await adapter.addLink({ source_id: connected.note_id, target_id: other1.note_id, strength: 0.8 });
    await adapter.addLink({ source_id: connected.note_id, target_id: other2.note_id, strength: 0.7 });

    const isolatedScore = await scorer.score(isolated, adapter);
    const connectedScore = await scorer.score(connected, adapter);

    expect(connectedScore).toBeGreaterThan(isolatedScore);
  });

  it("should allow custom weight configuration", async () => {
    const customScorer = new ImportanceScorer({
      contentWeight: 0.0,
      linkWeight: 0.0,
      freshnessWeight: 0.0,
      roleWeight: 1.0,
    });

    const user = await adapter.saveNote({ tenant_id: "test", role: "user", content: "test" });
    const system = await adapter.saveNote({ tenant_id: "test", role: "system", content: "test" });

    const userScore = await customScorer.score(user, adapter);
    const systemScore = await customScorer.score(system, adapter);

    // With only role weight, the difference should be very pronounced
    expect(systemScore).toBeGreaterThan(userScore);
    expect(systemScore / userScore).toBeGreaterThan(1.5);
  });

  it("should rescore all notes", async () => {
    await adapter.saveNote({ tenant_id: "test", role: "user", content: "note 1" });
    await adapter.saveNote({ tenant_id: "test", role: "system", content: "note 2 with decision and architecture" });
    await adapter.saveNote({ tenant_id: "test", role: "assistant", content: "note 3" });

    const updated = await scorer.rescoreAll(adapter, "test");
    expect(updated).toBeGreaterThan(0);
  });
});
