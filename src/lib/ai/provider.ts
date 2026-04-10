/**
 * Shared AI completion wrapper backed by OpenAI.
 */

import {
  getFastModel,
  getOpenAIClient,
  getReasoningModel,
  getStandardModel,
} from "@/lib/openai";

export type AIMessage = { role: "user" | "assistant"; content: string };
export type AIModelFlavor = "standard" | "fast" | "reasoning";

export type AICompletionOptions = {
  system?: string;
  messages: AIMessage[];
  maxTokens?: number;
  temperature?: number;
  modelFlavor?: AIModelFlavor;
};

function selectModel(flavor: AIModelFlavor) {
  switch (flavor) {
    case "fast":
      return getFastModel();
    case "reasoning":
      return getReasoningModel();
    case "standard":
    default:
      return getStandardModel();
  }
}

export async function aiComplete(opts: AICompletionOptions): Promise<string> {
  const openai = getOpenAIClient();
  const response = await openai.chat.completions.create({
    model: selectModel(opts.modelFlavor ?? "standard"),
    messages: [
      ...(opts.system
        ? [{ role: "system" as const, content: opts.system }]
        : []),
      ...opts.messages,
    ],
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0,
  });

  return response.choices[0]?.message?.content ?? "";
}
