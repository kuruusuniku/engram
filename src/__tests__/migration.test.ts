import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteAdapter } from "../storage/sqlite-adapter.js";
import { TursoAdapter } from "../storage/turso-adapter.js";
import type { StorageConfig } from "../storage/types.js";

describe("Data Migration (SQLite -> Turso)", () => {
  let source: SQLiteAdapter;
  let target: TursoAdapter;
  const tenantId = "migration-tenant";

  beforeEach(async () => {
    // Set up source SQLite with test data
    source = new SQLiteAdapter();
    await source.initialize({
      type: "sqlite",
      dbPath: ":memory:",
      tenantId,
    });

    await source.createTenant({
      tenant_id: tenantId,
      name: "Migration Test Tenant",
    });

    // Seed source with notes
    const note1 = await source.saveNote({
      tenant_id: tenantId,
      role: "user",
      content: "First conversation about TypeScript",
      keywords: ["typescript", "programming"],
      tags: ["dev"],
      summary: "Discussion about TypeScript",
      importance: 0.8,
    });

    const note2 = await source.saveNote({
      tenant_id: tenantId,
      role: "assistant",
      content: "TypeScript is a typed superset of JavaScript",
      keywords: ["typescript", "javascript"],
      tags: ["dev", "tutorial"],
      summary: "TypeScript overview",
      importance: 0.7,
    });

    const note3 = await source.saveNote({
      tenant_id: tenantId,
      role: "user",
      content: "How to deploy to Vercel?",
      keywords: ["vercel", "deploy"],
      tags: ["devops"],
      importance: 0.5,
    });

    // Create links
    await source.addLink({
      source_id: note1.note_id,
      target_id: note2.note_id,
      relation: "follow-up",
      strength: 0.9,
    });

    // Create session
    await source.createSession({
      session_id: "migration-session",
      tenant_id: tenantId,
      project: "migration-project",
    });

    // Set up target Turso
    target = new TursoAdapter();
    await target.initialize({
      type: "turso",
      tursoUrl: "file::memory:",
      tenantId,
    });
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it("should migrate tenant", async () => {
    const sourceTenant = await source.getTenant(tenantId);
    expect(sourceTenant).not.toBeNull();

    await target.createTenant({
      tenant_id: sourceTenant!.tenant_id,
      name: sourceTenant!.name,
      config: sourceTenant!.config,
    });

    const targetTenant = await target.getTenant(tenantId);
    expect(targetTenant).not.toBeNull();
    expect(targetTenant!.name).toBe("Migration Test Tenant");
  });

  it("should migrate all notes", async () => {
    // Migrate tenant first
    await target.createTenant({
      tenant_id: tenantId,
      name: "Migration Test Tenant",
    });

    // Get all source notes
    const sourceNotes = await source.getNotesForSummary({
      tenant_id: tenantId,
      limit: 100000,
    });
    expect(sourceNotes).toHaveLength(3);

    // Migrate notes
    for (const note of sourceNotes) {
      await target.saveNote({
        tenant_id: note.tenant_id,
        role: note.role,
        content: note.content,
        summary: note.summary,
        keywords: note.keywords,
        tags: note.tags,
        context_desc: note.context_desc,
        importance: note.importance,
      });
    }

    // Verify target
    const targetStats = await target.getStats(tenantId);
    expect(targetStats.total_notes).toBe(3);
    expect(targetStats.notes_by_role.user).toBe(2);
    expect(targetStats.notes_by_role.assistant).toBe(1);
  });

  it("should preserve note content and metadata during migration", async () => {
    await target.createTenant({
      tenant_id: tenantId,
      name: "Migration Test Tenant",
    });

    const sourceNotes = await source.getNotesForSummary({
      tenant_id: tenantId,
      limit: 100000,
    });

    // Migrate
    const migratedNotes = [];
    for (const note of sourceNotes) {
      const migrated = await target.saveNote({
        tenant_id: note.tenant_id,
        role: note.role,
        content: note.content,
        summary: note.summary,
        keywords: note.keywords,
        tags: note.tags,
        context_desc: note.context_desc,
        importance: note.importance,
      });
      migratedNotes.push(migrated);
    }

    // Verify content preservation
    expect(migratedNotes[0].content).toBe("First conversation about TypeScript");
    expect(migratedNotes[0].keywords).toEqual(["typescript", "programming"]);
    expect(migratedNotes[0].tags).toEqual(["dev"]);
    expect(migratedNotes[0].summary).toBe("Discussion about TypeScript");
    expect(migratedNotes[0].importance).toBe(0.8);
  });

  it("should migrate keywords and verify with getTopKeywords", async () => {
    await target.createTenant({
      tenant_id: tenantId,
      name: "Migration Test Tenant",
    });

    const sourceNotes = await source.getNotesForSummary({
      tenant_id: tenantId,
      limit: 100000,
    });

    for (const note of sourceNotes) {
      await target.saveNote({
        tenant_id: note.tenant_id,
        role: note.role,
        content: note.content,
        keywords: note.keywords,
        tags: note.tags,
        importance: note.importance,
      });
    }

    // Verify keywords migrated correctly
    const sourceKeywords = await source.getTopKeywords(tenantId, 10);
    const targetKeywords = await target.getTopKeywords(tenantId, 10);

    // typescript should be top keyword in both
    expect(sourceKeywords[0].keyword).toBe("typescript");
    expect(targetKeywords[0].keyword).toBe("typescript");
    expect(sourceKeywords[0].count).toBe(targetKeywords[0].count);
  });

  it("should handle search on migrated data", async () => {
    await target.createTenant({
      tenant_id: tenantId,
      name: "Migration Test Tenant",
    });

    const sourceNotes = await source.getNotesForSummary({
      tenant_id: tenantId,
      limit: 100000,
    });

    for (const note of sourceNotes) {
      await target.saveNote({
        tenant_id: note.tenant_id,
        role: note.role,
        content: note.content,
        keywords: note.keywords,
        tags: note.tags,
      });
    }

    // Search in target
    const results = await target.fullTextSearch("TypeScript", {
      tenant_id: tenantId,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.note.content.includes("TypeScript"))).toBe(true);
  });
});
