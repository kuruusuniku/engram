/**
 * Embedding Client - OpenAI text-embedding-3-small integration
 *
 * Generates vector embeddings for text content.
 * Falls back gracefully when OPENAI_API_KEY is not set.
 */

export interface EmbeddingClient {
  /** Generate embedding vector for text. Returns null if unavailable. */
  embed(text: string): Promise<number[] | null>;
  /** Generate embeddings for multiple texts. Returns null entries for failures. */
  embedBatch(texts: string[]): Promise<(number[] | null)[]>;
  /** Embedding dimension */
  readonly dimension: number;
  /** Whether the client is available (API key configured) */
  readonly available: boolean;
}

export interface EmbeddingConfig {
  apiKey?: string;
  model?: string;
  dimension?: number;
  baseUrl?: string;
}

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSION = 1536;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export class OpenAIEmbeddingClient implements EmbeddingClient {
  private apiKey: string | undefined;
  private model: string;
  readonly dimension: number;
  private baseUrl: string;

  constructor(config?: EmbeddingConfig) {
    this.apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY;
    this.model = config?.model ?? DEFAULT_MODEL;
    this.dimension = config?.dimension ?? DEFAULT_DIMENSION;
    this.baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
  }

  get available(): boolean {
    return !!this.apiKey;
  }

  async embed(text: string): Promise<number[] | null> {
    if (!this.available) return null;

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
          dimensions: this.dimension,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(
          `[embedding] OpenAI API error ${response.status}: ${errorBody}`
        );
        return null;
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      return data.data[0].embedding;
    } catch (error) {
      console.error("[embedding] Failed to generate embedding:", error);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (!this.available) return texts.map(() => null);
    if (texts.length === 0) return [];

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          dimensions: this.dimension,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(
          `[embedding] OpenAI API batch error ${response.status}: ${errorBody}`
        );
        return texts.map(() => null);
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // Sort by index to maintain order
      const sorted = data.data.sort((a, b) => a.index - b.index);
      return sorted.map((item) => item.embedding);
    } catch (error) {
      console.error("[embedding] Failed to generate batch embeddings:", error);
      return texts.map(() => null);
    }
  }
}

/**
 * Null embedding client - always returns null.
 * Used when no API key is configured.
 */
export class NullEmbeddingClient implements EmbeddingClient {
  readonly dimension = DEFAULT_DIMENSION;
  readonly available = false;

  async embed(): Promise<null> {
    return null;
  }

  async embedBatch(texts: string[]): Promise<null[]> {
    return texts.map(() => null);
  }
}

/**
 * Create an embedding client based on configuration.
 * Returns NullEmbeddingClient if no API key is available.
 */
export function createEmbeddingClient(
  config?: EmbeddingConfig
): EmbeddingClient {
  const apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new NullEmbeddingClient();
  }
  return new OpenAIEmbeddingClient({ ...config, apiKey });
}
