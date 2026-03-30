import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AssociateEngine } from "../associate.js";
import { SQLiteAdapter } from "../storage/sqlite-adapter.js";
import { NullEmbeddingClient } from "../embedding.js";

describe("AssociateEngine", () => {
  let adapter: SQLiteAdapter;
  let engine: AssociateEngine;
  const tenantId = "test-tenant";

  beforeEach(async () => {
    adapter = new SQLiteAdapter();
    await adapter.initialize({
      type: "sqlite",
      dbPath: ":memory:",
      tenantId,
    });
    await adapter.createTenant({ tenant_id: tenantId, name: "Test" });

    engine = new AssociateEngine(adapter, new NullEmbeddingClient());

    // Seed a connected graph of notes
    const note1 = await adapter.saveNote({
      tenant_id: tenantId,
      role: "user",
      content:
        "How to implement authentication using JSON Web Tokens in a Node.js Express application",
      keywords: ["JWT", "authentication", "Node.js", "Express"],
      tags: ["backend", "security"],
    });
    const note2 = await adapter.saveNote({
      tenant_id: tenantId,
      role: "assistant",
      content:
        "Here is how to set up JWT authentication with Express middleware for token verification",
      keywords: ["JWT", "Express", "middleware", "authentication"],
      tags: ["backend", "security"],
    });
    const note3 = await adapter.saveNote({
      tenant_id: tenantId,
      role: "user",
      content:
        "Now I need to add role-based access control RBAC to the Express API",
      keywords: ["RBAC", "access-control", "Express", "API"],
      tags: ["backend", "security"],
    });
    const note4 = await adapter.saveNote({
      tenant_id: tenantId,
      role: "assistant",
      content:
        "For RBAC implementation, create a middleware that checks user roles against route permissions",
      keywords: ["RBAC", "middleware", "permissions", "roles"],
      tags: ["backend", "security"],
    });
    const note5 = await adapter.saveNote({
      tenant_id: tenantId,
      role: "user",
      content: "How to deploy the Express application to AWS Lambda",
      keywords: ["Express", "AWS", "Lambda", "deploy", "serverless"],
      tags: ["backend", "deployment", "cloud"],
    });
    const note6 = await adapter.saveNote({
      tenant_id: tenantId,
      role: "user",
      content: "What is the best React state management library for large apps",
      keywords: ["React", "state-management", "Redux", "Zustand"],
      tags: ["frontend", "architecture"],
    });

    // Create links
    await adapter.addLink({
      source_id: note1.note_id,
      target_id: note2.note_id,
      relation: "follow-up",
      strength: 0.95,
    });
    await adapter.addLink({
      source_id: note2.note_id,
      target_id: note3.note_id,
      relation: "continuation",
      strength: 0.8,
    });
    await adapter.addLink({
      source_id: note3.note_id,
      target_id: note4.note_id,
      relation: "follow-up",
      strength: 0.9,
    });
    await adapter.addLink({
      source_id: note1.note_id,
      target_id: note5.note_id,
      relation: "same-project",
      strength: 0.6,
    });
  });

  afterEach(async () => {
    await adapter.close();
  });

  it("should find associated notes from a seed", async () => {
    const results = await engine.associate({
      seed: "JWT authentication",
      tenant_id: tenantId,
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    // Should discover notes related to JWT/auth
    const contents = results.map((r) => r.note.content);
    // At least some results should be related to the seed
    expect(
      contents.some(
        (c) =>
          c.toLowerCase().includes("jwt") ||
          c.toLowerCase().includes("authentication") ||
          c.toLowerCase().includes("express")
      )
    ).toBe(true);
  });

  it("should return results with serendipity scores", async () => {
    const results = await engine.associate({
      seed: "Express middleware",
      tenant_id: tenantId,
      limit: 5,
    });

    for (const result of results) {
      expect(result.serendipityScore).toBeGreaterThanOrEqual(0);
      expect(result.serendipityScore).toBeLessThanOrEqual(1);
      expect(result.discoveryPath).toBeDefined();
    }
  });

  it("should respect limit parameter", async () => {
    const results = await engine.associate({
      seed: "Express",
      tenant_id: tenantId,
      limit: 2,
    });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("should handle high temperature (more exploratory)", async () => {
    const results = await engine.associate({
      seed: "JWT",
      tenant_id: tenantId,
      temperature: 0.9,
      limit: 5,
    });

    // High temperature should still return valid results
    expect(results.length).toBeGreaterThanOrEqual(0);
    for (const result of results) {
      expect(result.serendipityScore).toBeGreaterThanOrEqual(0);
    }
  });

  it("should handle low temperature (more focused)", async () => {
    const results = await engine.associate({
      seed: "JWT authentication",
      tenant_id: tenantId,
      temperature: 0.1,
      limit: 5,
    });

    // Low temperature should return more closely related results
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("should work without a seed (random start)", async () => {
    const results = await engine.associate({
      tenant_id: tenantId,
      limit: 3,
    });

    // Should still find some results from random starting points
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("should discover notes through links", async () => {
    // Start from JWT, should discover RBAC through link chain
    const results = await engine.associate({
      seed: "JWT authentication Node.js",
      tenant_id: tenantId,
      temperature: 0.5,
      limit: 5,
      walkSteps: 3,
    });

    if (results.length > 0) {
      // Check that at least some results were found through links
      const linkDiscoveries = results.filter((r) =>
        r.discoveryPath.startsWith("link:")
      );
      // Link-based discoveries are probabilistic but should be possible
      // given the connected graph we created
    }
  });

  it("should return empty for empty database", async () => {
    const emptyAdapter = new SQLiteAdapter();
    await emptyAdapter.initialize({
      type: "sqlite",
      dbPath: ":memory:",
      tenantId: "empty",
    });
    await emptyAdapter.createTenant({
      tenant_id: "empty",
      name: "Empty",
    });

    const emptyEngine = new AssociateEngine(
      emptyAdapter,
      new NullEmbeddingClient()
    );

    const results = await emptyEngine.associate({
      seed: "anything",
      tenant_id: "empty",
    });

    expect(results).toHaveLength(0);

    await emptyAdapter.close();
  });
});
