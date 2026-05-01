import { availableParallelism } from "node:os";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function readPositiveNumberEnv(name: string) {
  const raw = process.env[name]?.trim();
  if (!raw) return null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readPositiveIntegerEnv(name: string) {
  const parsed = readPositiveNumberEnv(name);
  if (parsed == null) return null;
  return Math.round(parsed);
}

export function readBooleanEnv(name: string) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return null;

  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

export function readNonNegativeIntegerEnv(name: string) {
  const raw = process.env[name]?.trim();
  if (!raw) return null;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.round(parsed);
}

function computeDefaultCapacityScale() {
  if (process.env.NODE_ENV !== "production") {
    return 1;
  }

  const cpuCount = Math.max(1, availableParallelism());
  return clamp(1 + Math.max(0, cpuCount - 1) * 0.6, 1, 3.5);
}

export function getIngestCapacityScale() {
  return clamp(
    readPositiveNumberEnv("INGEST_CAPACITY_SCALE") ?? computeDefaultCapacityScale(),
    0.5,
    3
  );
}

export function resolveScaledInteger(input: {
  base: number;
  absoluteMax: number;
  minimum?: number;
  explicitEnvName?: string;
}) {
  const minimum = input.minimum ?? 1;
  const explicitValue = input.explicitEnvName
    ? readPositiveIntegerEnv(input.explicitEnvName)
    : null;

  if (explicitValue != null) {
    return clamp(explicitValue, minimum, input.absoluteMax);
  }

  return clamp(
    Math.round(input.base * getIngestCapacityScale()),
    minimum,
    input.absoluteMax
  );
}
