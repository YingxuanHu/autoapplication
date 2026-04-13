import "dotenv/config";
import {
  previewConnectorIngestion,
  ingestConnector,
} from "../src/lib/ingestion/pipeline";
import {
  resolveConnectors,
  type ConnectorResolutionArgs,
  type SupportedConnectorName,
} from "../src/lib/ingestion/registry";
import { prisma } from "../src/lib/db";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectorName = (args.connector ?? "greenhouse") as SupportedConnectorName;
  const connectors = resolveConnectors(connectorName, args);
  const summaries = [];
  for (const connector of connectors) {
    const summary = args.dryRun
      ? await previewConnectorIngestion(connector, {
          limit: args.limit,
        })
      : await ingestConnector(connector, {
          limit: args.limit,
          allowOverlappingRuns: args.allowOverlap === true,
        });
    summaries.push(summary);
  }
  // reconcileCanonicalLifecycle() sweeps all 300k+ canonical jobs — only run
  // it from the daemon. The CLI already gets per-run lifecycle tallies from
  // ingestConnector's own refreshCanonicalStatuses call.
  console.log(JSON.stringify({ dryRun: args.dryRun ?? false, summaries }, null, 2));
}

function parseArgs(rawArgs: string[]) {
  const parsedArgs: ConnectorResolutionArgs & {
    connector?: string;
    company?: string;
    companies?: string;
    domain?: string;
    domains?: string;
    source?: string;
    sources?: string;
    account?: string;
    accounts?: string;
    limit?: number;
    dryRun?: boolean;
    allowOverlap?: boolean;
  } = {};

  for (const rawArg of rawArgs) {
    if (!rawArg.startsWith("--") && !parsedArgs.connector) {
      parsedArgs.connector = rawArg;
      continue;
    }

    const [key, value] = rawArg.replace(/^--/, "").split("=");
    if (!key) continue;

    if (key === "dry-run") {
      parsedArgs.dryRun = true;
      continue;
    }

    if (key === "allow-overlap") {
      parsedArgs.allowOverlap = true;
      continue;
    }

    if (value === undefined) continue;

    if (key === "connector") parsedArgs.connector = value;
    if (key === "org") parsedArgs.org = value;
    if (key === "orgs") parsedArgs.orgs = value;
    if (key === "board") parsedArgs.board = value;
    if (key === "boards") parsedArgs.boards = value;
    if (key === "site") parsedArgs.site = value;
    if (key === "sites") parsedArgs.sites = value;
    if (key === "company") parsedArgs.company = value;
    if (key === "companies") parsedArgs.companies = value;
    if (key === "domain") parsedArgs.domain = value;
    if (key === "domains") parsedArgs.domains = value;
    if (key === "source") parsedArgs.source = value;
    if (key === "sources") parsedArgs.sources = value;
    if (key === "account") parsedArgs.account = value;
    if (key === "accounts") parsedArgs.accounts = value;
    if (key === "limit") parsedArgs.limit = Number.parseInt(value, 10);
  }

  if (parsedArgs.limit !== undefined && Number.isNaN(parsedArgs.limit)) {
    throw new Error(`Invalid --limit value "${String(parsedArgs.limit)}"`);
  }

  return parsedArgs;
}

main()
  .catch((error) => {
    console.error("Ingestion failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
