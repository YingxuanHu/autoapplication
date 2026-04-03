import "dotenv/config";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CliArgs = {
  "corpus-limit": number;
  "min-canada-count": number;
  "min-live-count": number;
  "batch-size": number;
  "batch-count": number;
  "start-offset": number;
  "preview-limit": number;
  "ingest-limit": number;
  "out-dir": string;
  "no-ingest"?: boolean;
};

type AggregateSummary = {
  companiesProcessed: number;
  careerPagesDetected: number;
  directAtsUrlsDetected: number;
  candidatesDiscovered: number;
  newCandidates: number;
  promotedSources: number;
  fetchedCount: number;
  acceptedCount: number;
  canonicalCreatedCount: number;
  canonicalUpdatedCount: number;
  dedupedCount: number;
  canonicalCreatedCanadaCount: number;
  canonicalCreatedCanadaRemoteCount: number;
};

const args = parseArgs(process.argv.slice(2));

async function main() {
  const outDir = path.resolve(args["out-dir"]);
  await mkdir(outDir, { recursive: true });

  const summaries: Array<Record<string, unknown>> = [];

  for (let index = 0; index < args["batch-count"]; index++) {
    const offset = args["start-offset"] + index * args["batch-size"];
    const outputPath = path.join(
      outDir,
      `company-corpus-official-${String(offset).padStart(4, "0")}-${String(
        args["batch-size"]
      ).padStart(4, "0")}.json`
    );

    const cliArgs = [
      "-r",
      "dotenv/config",
      "scripts/discover-company-corpus.ts",
      `--corpus-limit=${args["corpus-limit"]}`,
      `--min-canada-count=${args["min-canada-count"]}`,
      `--min-live-count=${args["min-live-count"]}`,
      `--limit=${args["batch-size"]}`,
      `--offset=${offset}`,
      `--preview-limit=${args["preview-limit"]}`,
      `--ingest-limit=${args["ingest-limit"]}`,
      `--out=${outputPath}`,
    ];

    if (args["no-ingest"] === true) {
      cliArgs.push("--no-ingest");
    }

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [path.resolve("node_modules/tsx/dist/cli.mjs"), ...cliArgs],
      {
        cwd: process.cwd(),
        maxBuffer: 20 * 1024 * 1024,
      }
    );

    if (stderr.trim().length > 0) {
      process.stderr.write(stderr);
    }

    const summary = JSON.parse(stdout.trim()) as Record<string, unknown>;
    summaries.push(summary);
  }

  const aggregate = summaries.reduce<AggregateSummary>(
    (accumulator, summary) => {
      const promoted = Array.isArray(summary.promotedSources)
        ? summary.promotedSources.length
        : 0;
      const ingestSummaries = Array.isArray(summary.ingestSummaries)
        ? summary.ingestSummaries
        : [];

      accumulator.companiesProcessed += toNumber(summary.companiesProcessed);
      accumulator.careerPagesDetected += toNumber(summary.careerPagesDetected);
      accumulator.directAtsUrlsDetected += toNumber(summary.directAtsUrlsDetected);
      accumulator.candidatesDiscovered += toNumber(summary.candidatesDiscovered);
      accumulator.newCandidates += toNumber(summary.newCandidates);
      accumulator.promotedSources += promoted;

      for (const ingestSummary of ingestSummaries) {
        if (!ingestSummary || typeof ingestSummary !== "object") continue;
        accumulator.fetchedCount += toNumber((ingestSummary as Record<string, unknown>).fetchedCount);
        accumulator.acceptedCount += toNumber(
          (ingestSummary as Record<string, unknown>).acceptedCount
        );
        accumulator.canonicalCreatedCount += toNumber(
          (ingestSummary as Record<string, unknown>).canonicalCreatedCount
        );
        accumulator.canonicalUpdatedCount += toNumber(
          (ingestSummary as Record<string, unknown>).canonicalUpdatedCount
        );
        accumulator.dedupedCount += toNumber((ingestSummary as Record<string, unknown>).dedupedCount);
        accumulator.canonicalCreatedCanadaCount += toNumber(
          (ingestSummary as Record<string, unknown>).canonicalCreatedCanadaCount
        );
        accumulator.canonicalCreatedCanadaRemoteCount += toNumber(
          (ingestSummary as Record<string, unknown>).canonicalCreatedCanadaRemoteCount
        );
      }

      return accumulator;
    },
    {
      companiesProcessed: 0,
      careerPagesDetected: 0,
      directAtsUrlsDetected: 0,
      candidatesDiscovered: 0,
      newCandidates: 0,
      promotedSources: 0,
      fetchedCount: 0,
      acceptedCount: 0,
      canonicalCreatedCount: 0,
      canonicalUpdatedCount: 0,
      dedupedCount: 0,
      canonicalCreatedCanadaCount: 0,
      canonicalCreatedCanadaRemoteCount: 0,
    } satisfies AggregateSummary
  );

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        batchSize: args["batch-size"],
        batchCount: args["batch-count"],
        startOffset: args["start-offset"],
        outDir,
        summaries,
        aggregate,
      },
      null,
      2
    )
  );
}

function parseArgs(rawArgs: string[]): CliArgs {
  const parsed: Partial<CliArgs> = {
    "corpus-limit": 4000,
    "min-canada-count": 0,
    "min-live-count": 1,
    "batch-size": 250,
    "batch-count": 4,
    "start-offset": 0,
    "preview-limit": 100,
    "ingest-limit": 200,
    "out-dir": "data/discovery/seeds",
  };

  for (const rawArg of rawArgs) {
    if (!rawArg.startsWith("--")) continue;
    const [key, value] = rawArg.slice(2).split("=");
    if (!key) continue;
    if (key === "no-ingest") {
      parsed["no-ingest"] = true;
      continue;
    }
    if (value === undefined) continue;
    if (
      key === "corpus-limit" ||
      key === "min-canada-count" ||
      key === "min-live-count" ||
      key === "batch-size" ||
      key === "batch-count" ||
      key === "start-offset" ||
      key === "preview-limit" ||
      key === "ingest-limit"
    ) {
      (parsed as Record<string, number>)[key] = Number.parseInt(value, 10);
      continue;
    }
    if (key === "out-dir") {
      parsed["out-dir"] = value;
    }
  }

  return parsed as CliArgs;
}

function toNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

main().catch((error) => {
  console.error("Company corpus batch run failed:", error);
  process.exitCode = 1;
});
