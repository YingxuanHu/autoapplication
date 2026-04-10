import OpenAI from "openai";

type OpenAIReadiness = {
  configured: boolean;
  missingKeys: string[];
};

const requiredOpenAIEnvKeys = ["OPENAI_API_KEY"] as const;

const globalForOpenAI = globalThis as unknown as {
  openai?: OpenAI;
};

export function getReasoningModel() {
  return process.env.OPENAI_REASONING_MODEL?.trim() || "gpt-5-mini";
}

export function getStandardModel() {
  return process.env.OPENAI_STANDARD_MODEL?.trim() || "gpt-4.1-mini";
}

export function getFastModel() {
  return process.env.OPENAI_FAST_MODEL?.trim() || "gpt-4o-mini";
}

export function getOpenAIReadiness(): OpenAIReadiness {
  const missingKeys = requiredOpenAIEnvKeys.filter(
    (key) => !process.env[key]?.trim()
  );

  return {
    configured: missingKeys.length === 0,
    missingKeys,
  };
}

export function getOpenAIClient() {
  const readiness = getOpenAIReadiness();
  if (!readiness.configured) {
    throw new Error(
      `OpenAI is not configured. Missing: ${readiness.missingKeys.join(", ")}`
    );
  }

  if (!globalForOpenAI.openai) {
    globalForOpenAI.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return globalForOpenAI.openai;
}
