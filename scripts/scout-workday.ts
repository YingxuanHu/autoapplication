import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WORKDAY_DISCOVERY_SEEDS,
  buildWorkdaySeedCandidates,
  preflightWorkdaySeedCandidates,
} from "../src/lib/ingestion/discovery/workday";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const companies = splitArg(args.companies);
  const candidates = buildWorkdaySeedCandidates({
    companies,
    canadaWeighted: args.canadaWeighted,
  });
  const preflight = await preflightWorkdaySeedCandidates(candidates, {
    limit: args.limit ?? Math.min(60, candidates.length),
    concurrency: args.concurrency,
  });

  const valid = preflight.filter((candidate) => candidate.valid);
  const outputRecords = (args.validOnly ? valid : preflight).map((candidate) => ({
    url: candidate.url,
    sourceToken: candidate.sourceToken,
    companyName: candidate.companyName,
    tenant: candidate.tenant,
    site: candidate.site,
    wdVariant: candidate.wdVariant,
    score: candidate.score,
    scoreReasons: candidate.scoreReasons,
    sectors: candidate.sectors,
    totalCount: candidate.totalCount,
    previewLimitHint: candidate.previewLimitHint,
    valid: candidate.valid,
    firstTitle: candidate.firstTitle,
    notes: candidate.notes ?? null,
    error: candidate.error ?? null,
  }));

  if (args.out) {
    const outputPath = path.resolve(args.out);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(outputRecords, null, 2));
  }

  console.log(
    JSON.stringify(
      {
        canadaWeighted: args.canadaWeighted,
        catalogCompanyCount: WORKDAY_DISCOVERY_SEEDS.length,
        candidateCount: candidates.length,
        preflightedCount: preflight.length,
        validCount: valid.length,
        invalidCount: preflight.length - valid.length,
        outputPath: args.out ? path.resolve(args.out) : null,
        topValid: valid.slice(0, 15),
      },
      null,
      2
    )
  );
}

function parseArgs(rawArgs: string[]) {
  const parsed: {
    companies?: string;
    out?: string;
    limit?: number;
    concurrency?: number;
    canadaWeighted: boolean;
    validOnly: boolean;
  } = {
    canadaWeighted: true,
    validOnly: true,
  };

  for (const rawArg of rawArgs) {
    const [key, value] = rawArg.replace(/^--/, "").split("=");
    if (!key) continue;

    if (key === "no-canada-weight") {
      parsed.canadaWeighted = false;
      continue;
    }
    if (key === "all") {
      parsed.validOnly = false;
      continue;
    }
    if (value === undefined) continue;

    if (key === "companies") parsed.companies = value;
    if (key === "out") parsed.out = value;
    if (key === "limit") parsed.limit = Number.parseInt(value, 10);
    if (key === "concurrency") parsed.concurrency = Number.parseInt(value, 10);
  }

  return parsed;
}

function splitArg(value: string | undefined) {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

main().catch((error) => {
  console.error("Workday scout failed:", error);
  process.exit(1);
});
