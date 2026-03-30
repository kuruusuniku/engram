import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OpenAIEmbeddingClient,
  NullEmbeddingClient,
  createEmbeddingClient,
} from "../embedding.js";

describe("NullEmbeddingClient", () => {
  it("should always return null for embed", async () => {
    const client = new NullEmbeddingClient();
    const result = await client.embed("test text");
    expect(result).toBeNull();
  });

  it("should return nulls for embedBatch", async () => {
    const client = new NullEmbeddingClient();
    const results = await client.embedBatch(["text1", "text2"]);
    expect(results).toEqual([null, null]);
  });

  it("should report as unavailable", () => {
    const client = new NullEmbeddingClient();
    expect(client.available).toBe(false);
  });

  it("should have default dimension", () => {
    const client = new NullEmbeddingClient();
    expect(client.dimension).toBe(1536);
  });
});

describe("OpenAIEmbeddingClient", () => {
  let client: OpenAIEmbeddingClient;

  beforeEach(() => {
    client = new OpenAIEmbeddingClient({
      apiKey: "test-api-key",
      model: "text-embedding-3-small",
      dimension: 1536,
    });
  });

  it("should report as available when API key is set", () => {
    expect(client.available).toBe(true);
  });

  it("should report as unavailable without API key", () => {
    const noKeyClient = new OpenAIEmbeddingClient({ apiKey: undefined });
    expect(noKeyClient.available).toBe(false);
  });

  it("should call OpenAI API for embed", async () => {
    const mockEmbedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ embedding: mockEmbedding, index: 0 }],
        }),
        { status: 200 }
      )
    );

    const result = await client.embed("test text");
    expect(result).toEqual(mockEmbedding);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const callArgs = fetchSpy.mock.calls[0];
    expect(callArgs[0]).toContain("/embeddings");
    const body = JSON.parse((callArgs[1] as RequestInit).body as string);
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toBe("test text");

    fetchSpy.mockRestore();
  });

  it("should handle API errors gracefully", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 })
    );

    const result = await client.embed("test text");
    expect(result).toBeNull();

    fetchSpy.mockRestore();
  });

  it("should handle network errors gracefully", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("Network error"));

    const result = await client.embed("test text");
    expect(result).toBeNull();

    fetchSpy.mockRestore();
  });

  it("should batch embed multiple texts", async () => {
    const mockEmbeddings = [
      Array.from({ length: 1536 }, () => 0.1),
      Array.from({ length: 1536 }, () => 0.2),
    ];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { embedding: mockEmbeddings[0], index: 0 },
            { embedding: mockEmbeddings[1], index: 1 },
          ],
        }),
        { status: 200 }
      )
    );

    const results = await client.embedBatch(["text1", "text2"]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(mockEmbeddings[0]);
    expect(results[1]).toEqual(mockEmbeddings[1]);

    fetchSpy.mockRestore();
  });
});

describe("createEmbeddingClient", () => {
  it("should return NullEmbeddingClient when no API key", () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const client = createEmbeddingClient();
    expect(client.available).toBe(false);

    if (original) process.env.OPENAI_API_KEY = original;
  });

  it("should return OpenAIEmbeddingClient when API key provided", () => {
    const client = createEmbeddingClient({ apiKey: "test-key" });
    expect(client.available).toBe(true);
  });
});
