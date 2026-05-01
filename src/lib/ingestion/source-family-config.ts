import { readBooleanEnv, readNonNegativeIntegerEnv } from "@/lib/ingestion/capacity";

function normalizeSourceFamilyName(sourceFamily: string) {
  return sourceFamily.trim().replace(/[^a-z0-9]+/gi, "_").toUpperCase();
}

function buildEnvCandidates(sourceFamily: string) {
  const normalized = normalizeSourceFamilyName(sourceFamily);
  return [
    `${normalized}_ENABLED`,
    `SOURCE_${normalized}_ENABLED`,
    `INGEST_${normalized}_ENABLED`,
  ];
}

export function isSourceFamilyEnabled(
  sourceFamily: string,
  defaultValue = true
) {
  for (const envName of buildEnvCandidates(sourceFamily)) {
    const explicit = readBooleanEnv(envName);
    if (explicit != null) {
      return explicit;
    }
  }

  return defaultValue;
}

export function assertSourceFamilyEnabled(sourceFamily: string) {
  if (isSourceFamilyEnabled(sourceFamily)) {
    return;
  }

  throw new Error(
    `Source family "${sourceFamily}" is disabled. Set ${normalizeSourceFamilyName(sourceFamily)}_ENABLED=true to enable it.`
  );
}

export function readCsvEnv(
  envName: string,
  fallback: string[]
) {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    return [...fallback];
  }

  if (raw.toUpperCase() === "ALL") {
    return ["ALL"];
  }

  return raw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

export function readStringEnv(envName: string, fallback: string) {
  const raw = process.env[envName]?.trim();
  return raw && raw.length > 0 ? raw : fallback;
}

export function readPositiveIntEnv(envName: string, fallback: number) {
  const parsed = readNonNegativeIntegerEnv(envName);
  return parsed != null && parsed > 0 ? parsed : fallback;
}
