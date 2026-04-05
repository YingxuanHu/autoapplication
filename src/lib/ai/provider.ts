/**
 * Provider-agnostic AI abstraction.
 *
 * Currently backed by Anthropic Claude. Swap the implementation here
 * to change providers without touching callers.
 *
 * The SDK is imported lazily to avoid Next.js bundling issues with
 * TransformStream internals during module analysis.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null;

async function getClient() {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env to enable AI features."
      );
    }
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic({ apiKey });
  }
  return client;
}

export type AIMessage = { role: "user" | "assistant"; content: string };

export type AICompletionOptions = {
  system?: string;
  messages: AIMessage[];
  maxTokens?: number;
  temperature?: number;
};

/**
 * Send a completion request and return the text response.
 * Throws if the API key is missing or the request fails.
 */
export async function aiComplete(opts: AICompletionOptions): Promise<string> {
  const anthropic = await getClient();
  const response = await anthropic.messages.create({
    model: process.env.AI_MODEL ?? "claude-sonnet-4-20250514",
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0,
    ...(opts.system ? { system: opts.system } : {}),
    messages: opts.messages,
  });

  const textBlock = response.content.find(
    (b: { type: string }) => b.type === "text"
  );
  return textBlock?.text ?? "";
}
