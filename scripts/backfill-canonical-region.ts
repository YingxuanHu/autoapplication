import "dotenv/config";
import { prisma } from "../src/lib/db";
import { inferGeoScope } from "../src/lib/geo-scope";
import { inferRegion } from "../src/lib/ingestion/normalize";

type CliArgs = {
  apply: boolean;
  limit: number;
  batchSize: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const canonicals = await prisma.jobCanonical.findMany({
    where: {
      status: { in: ["LIVE", "AGING"] },
      region: null,
    },
    select: {
      id: true,
      location: true,
      status: true,
    },
    orderBy: [{ postedAt: "desc" }, { updatedAt: "desc" }],
    take: args.limit,
  });

  const usIds: string[] = [];
  const caIds: string[] = [];
  const unknownByScope = new Map<string, number>();

  for (const canonical of canonicals) {
    const region = inferRegion(canonical.location);
    if (region === "US") {
      usIds.push(canonical.id);
      continue;
    }
    if (region === "CA") {
      caIds.push(canonical.id);
      continue;
    }

    const scope = inferGeoScope(canonical.location, null);
    unknownByScope.set(scope, (unknownByScope.get(scope) ?? 0) + 1);
  }

  if (args.apply) {
    await updateRegionBatch(usIds, "US", args.batchSize);
    await updateRegionBatch(caIds, "CA", args.batchSize);
  }

  console.log(
    JSON.stringify(
      {
        mode: args.apply ? "apply" : "dry-run",
        inspected: canonicals.length,
        updatedUs: usIds.length,
        updatedCa: caIds.length,
        stillUnknown: canonicals.length - usIds.length - caIds.length,
        unknownByScope: Object.fromEntries(
          [...unknownByScope.entries()].sort((left, right) => right[1] - left[1])
        ),
      },
      null,
      2
    )
  );
}

async function updateRegionBatch(
  ids: string[],
  region: "US" | "CA",
  batchSize: number
) {
  for (let index = 0; index < ids.length; index += batchSize) {
    const batch = ids.slice(index, index + batchSize);
    await prisma.jobCanonical.updateMany({
      where: {
        id: { in: batch },
        region: null,
      },
      data: { region },
    });
  }
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    apply: false,
    limit: 100_000,
    batchSize: 1_000,
  };

  for (const rawArg of argv) {
    if (rawArg === "--apply") {
      parsed.apply = true;
      continue;
    }

    if (rawArg.startsWith("--limit=")) {
      parsed.limit = parsePositiveInt(rawArg.split("=", 2)[1], parsed.limit);
      continue;
    }

    if (rawArg.startsWith("--batch-size=")) {
      parsed.batchSize = parsePositiveInt(rawArg.split("=", 2)[1], parsed.batchSize);
    }
  }

  return parsed;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

main()
  .catch((error) => {
    console.error("Failed to backfill canonical regions:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
