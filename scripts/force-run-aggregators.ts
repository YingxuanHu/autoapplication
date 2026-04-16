/**
 * Force-run aggregator connectors sequentially with full output.
 *
 * Bypasses the scheduler/cadence checks and directly calls ingestConnector
 * so we can see exactly what happens per connector. Useful for debugging
 * why the daemon hasn't been scheduling them.
 *
 *   npx tsx scripts/force-run-aggregators.ts            # run all aggregators
 *   npx tsx scripts/force-run-aggregators.ts --limit=50 # cap jobs per connector
 *   npx tsx scripts/force-run-aggregators.ts --keys=himalayas:feed,remotive:feed
 */
import "dotenv/config";
import { ingestConnector } from "@/lib/ingestion/pipeline";
import {
  createHimalayasConnector,
  createJobicyConnector,
  createMuseConnector,
  createRemoteOkConnector,
  createRemotiveConnector,
  createWeWorkRemotelyConnector,
} from "@/lib/ingestion/connectors";
import { prisma } from "@/lib/db";
import type { SourceConnector } from "@/lib/ingestion/types";

type Entry = { key: string; connector: SourceConnector };

function parseArgs() {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const keysArg = process.argv.find((a) => a.startsWith("--keys="));
  const maxRuntimeArg = process.argv.find((a) =>
    a.startsWith("--max-runtime-ms=")
  );
  return {
    limit: limitArg ? Number(limitArg.split("=")[1]) : undefined,
    keys: keysArg ? keysArg.split("=")[1].split(",") : undefined,
    maxRuntimeMs: maxRuntimeArg
      ? Number(maxRuntimeArg.split("=")[1])
      : 4 * 60 * 1000, // default 4 min/connector
  };
}

async function main() {
  const args = parseArgs();

  // Build up the full set; filter if --keys provided
  const all: Entry[] = [
    { key: "himalayas:feed", connector: createHimalayasConnector({ profile: "global" }) },
    { key: "remotive:feed", connector: createRemotiveConnector() },
    { key: "jobicy:feed", connector: createJobicyConnector() },
    { key: "themuse:feed", connector: createMuseConnector() },
    { key: "remoteok:feed", connector: createRemoteOkConnector() },
    { key: "weworkremotely:feed", connector: createWeWorkRemotelyConnector() },
  ];

  const selected = args.keys ? all.filter((e) => args.keys!.includes(e.key)) : all;
  if (selected.length === 0) {
    console.error("No matching aggregators");
    process.exit(1);
  }

  console.log(
    `[force-run] Running ${selected.length} aggregator(s). limit=${args.limit ?? "none"}, maxRuntimeMs=${args.maxRuntimeMs}`
  );

  let totalFetched = 0;
  let totalAccepted = 0;
  let totalLive = 0;

  for (const { key, connector } of selected) {
    const t0 = Date.now();
    try {
      const result = await ingestConnector(connector, {
        now: new Date(),
        triggerLabel: "force-run-aggregators",
        limit: args.limit,
        maxRuntimeMs: args.maxRuntimeMs,
        allowOverlappingRuns: false,
        runMode: "MANUAL",
      });
      const elapsed = Date.now() - t0;
      totalFetched += result.fetchedCount ?? 0;
      totalAccepted += result.acceptedCount ?? 0;
      totalLive += result.liveCount ?? 0;
      console.log(
        `[${key}] ${result.status} in ${(elapsed / 1000).toFixed(1)}s — fetched ${result.fetchedCount}, accepted ${result.acceptedCount}, live ${result.liveCount}`
      );
    } catch (e: unknown) {
      const elapsed = Date.now() - t0;
      console.error(
        `[${key}] FAILED in ${(elapsed / 1000).toFixed(1)}s — ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  console.log(
    `[force-run] Total: fetched ${totalFetched}, accepted ${totalAccepted}, live ${totalLive}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
