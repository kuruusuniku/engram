/**
 * LLM Client - OpenAI integration for note structuring
 *
 * Used by NoteBuilder to auto-generate:
 * - Summary
 * - Keywords
 * - Tags
 * - Context description
 * - Link suggestions
 */

export interface LLMClient {
  /** Generate a structured completion. Returns null if unavailable. */
  complete(prompt: string, systemPrompt?: string): Promise<string | null>;
  /** Whether the client is available */
  readonly available: boolean;
}

export interface LLMConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MAX_TOKENS = 500;

export class OpenAILLMClient implements LLMClient {
  private apiKey: string | undefined;
  private model: string;
  private baseUrl: string;
  private maxTokens: number;

  constructor(config?: LLMConfig) {
    this.apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY;
    this.model = config?.model ?? DEFAULT_MODEL;
    this.baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
    this.maxTokens = config?.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  get available(): boolean {
    return !!this.apiKey;
  }

  async complete(prompt: string, systemPrompt?: string): Promise<string | null> {
    if (!this.available) return null;

    try {
      const messages: Array<{ role: string; content: string }> = [];
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      messages.push({ role: "user", content: prompt });

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: this.maxTokens,
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(
          `[llm] OpenAI API error ${response.status}: ${errorBody}`
        );
        return null;
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices[0]?.message?.content ?? null;
    } catch (error) {
      console.error("[llm] Failed to complete:", error);
      return null;
    }
  }
}

/**
 * Null LLM client - always returns null.
 */
export class NullLLMClient implements LLMClient {
  readonly available = false;

  async complete(): Promise<null> {
    return null;
  }
}

/**
 * Create an LLM client based on configuration.
 */
export function createLLMClient(config?: LLMConfig): LLMClient {
  const apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new NullLLMClient();
  }
  return new OpenAILLMClient({ ...config, apiKey });
}
