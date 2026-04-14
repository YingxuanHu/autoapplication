import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { buildDiscoveredSourceKey, buildDiscoveredSourceName, buildDiscoveredSourceUrl } from "@/lib/ingestion/discovery/sources";

const ATS_TENANT_CONNECTORS = [
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "icims",
  "teamtailor",
  "jobvite",
] as const;

type PriorityAtsConnectorName = (typeof ATS_TENANT_CONNECTORS)[number];

type ProductiveSourceCandidate = {
  connectorName: PriorityAtsConnectorName;
  token: string;
  sourceName: string;
  boardUrl: string;
  yieldScore: number;
  priorityScore: number;
  retainedLiveJobCount: number;
  jobsFetchedCount: number;
  jobsAcceptedCount: number;
  jobsDedupedCount: number;
  jobsCreatedCount: number;
  lastJobsFetchedCount: number;
  lastJobsAcceptedCount: number;
  lastJobsDedupedCount: number;
  lastJobsCreatedCount: number;
  pollSuccessCount: number;
  pollAttemptCount: number;
  validationSuccessCount: number;
  validationAttemptCount: number;
  lastValidatedAt: Date | null;
  lastSuccessfulPollAt: Date | null;
  company: {
    name: string;
    companyKey: string;
    careersUrl: string | null;
  } | null;
};

type DiscoveryStoreEntry = {
  connectorName: string;
  token: string;
  sourceKey: string;
  sourceName?: string;
  boardUrl?: string;
  status?: string;
  firstDiscoveredAt?: string;
  lastDiscoveredAt?: string;
  discoveredFrom?: Array<{
    type: string;
    value: string;
    discoveredAt: string;
  }>;
  decisionReason?: string | null;
  promotedAt?: string | null;
  rejectedAt?: string | null;
  lastValidatedAt?: string | null;
  validation?: Record<string, unknown>;
};

type DiscoveryStore = {
  updatedAt?: string;
  entries?: DiscoveryStoreEntry[];
};

type AtsTenantInventoryFile = {
  updatedAt: string;
  source: "company-source.productive-v1";
  summary: {
    connectorCounts: Record<PriorityAtsConnectorName, number>;
    promotedCount: number;
    demotedCount: number;
  };
  entries: Array<{
    connectorName: PriorityAtsConnectorName;
    token: string;
    sourceKey: string;
    sourceName: string;
    boardUrl: string;
    companyName: string | null;
    companyKey: string | null;
    careersUrl: string | null;
    yieldScore: number;
    priorityScore: number;
    retainedLiveJobCount: number;
    jobsFetchedCount: number;
    jobsAcceptedCount: number;
    jobsDedupedCount: number;
    jobsCreatedCount: number;
    lastJobsFetchedCount: number;
    lastJobsAcceptedCount: number;
    lastJobsDedupedCount: number;
    lastJobsCreatedCount: number;
    pollSuccessCount: number;
    pollAttemptCount: number;
    validationSuccessCount: number;
    validationAttemptCount: number;
    lastValidatedAt: string | null;
    lastSuccessfulPollAt: string | null;
  }>;
};

type SyncOptions = {
  now?: Date;
  dryRun?: boolean;
};

type SyncResult = {
  candidateCount: number;
  promotedCount: number;
  demotedCount: number;
  inventoryPath: string;
  discoveryStorePath: string;
  connectorCounts: Record<PriorityAtsConnectorName, number>;
};

const DISCOVERY_STORE_PATH = path.resolve(
  process.cwd(),
  "data/discovery/source-candidates.json"
);

const ATS_TENANT_INVENTORY_PATH = path.resolve(
  process.cwd(),
  "data/discovery/ats-tenant-inventory.json"
);

const CONNECTOR_LIMITS: Record<PriorityAtsConnectorName, number> = {
  greenhouse: 400,
  lever: 300,
  ashby: 250,
  smartrecruiters: 200,
  icims: 150,
  teamtailor: 150,
  jobvite: 150,
};

const MIN_PRODUCTIVE_RETAINED: Record<PriorityAtsConnectorName, number> = {
  greenhouse: 3,
  lever: 3,
  ashby: 3,
  smartrecruiters: 2,
  icims: 2,
  teamtailor: 2,
  jobvite: 2,
};

export async function syncProductiveAtsTenantsToDiscoveryStore(
  options: SyncOptions = {}
): Promise<SyncResult> {
  const now = options.now ?? new Date();
  const candidates = await loadProductiveSourceCandidates();
  const discoveryStore = await loadDiscoveryStore();
  const entryMap = new Map(
    (discoveryStore.entries ?? []).map((entry) => [entry.sourceKey, entry] as const)
  );

  let promotedCount = 0;
  let demotedCount = 0;
  const promotedKeys = new Set<string>();
  const connectorCounts = buildConnectorCounts();

  for (const candidate of candidates) {
    const sourceKey = buildDiscoveredSourceKey(candidate.connectorName, candidate.token);
    promotedKeys.add(sourceKey);
    connectorCounts[candidate.connectorName] += 1;

    const existing = entryMap.get(sourceKey);
    const nextEntry = existing ?? {
      connectorName: candidate.connectorName,
      token: candidate.token,
      sourceKey,
      firstDiscoveredAt: now.toISOString(),
      discoveredFrom: [],
    };

    const wasPromoted = nextEntry.status === "promoted";
    nextEntry.connectorName = candidate.connectorName;
    nextEntry.token = candidate.token;
    nextEntry.sourceName = candidate.sourceName;
    nextEntry.boardUrl = candidate.boardUrl;
    nextEntry.status = "promoted";
    nextEntry.lastDiscoveredAt = now.toISOString();
    nextEntry.decisionReason = "productive_company_source";
    nextEntry.promotedAt = nextEntry.promotedAt ?? now.toISOString();
    nextEntry.rejectedAt = null;
    nextEntry.lastValidatedAt = candidate.lastValidatedAt?.toISOString() ?? null;
    nextEntry.validation = {
      valid: true,
      recommendedPromotion: true,
      threshold: MIN_PRODUCTIVE_RETAINED[candidate.connectorName],
      retainedLiveJobCount: candidate.retainedLiveJobCount,
      jobsAcceptedCount: candidate.jobsAcceptedCount,
      jobsCreatedCount: candidate.jobsCreatedCount,
      jobsDedupedCount: candidate.jobsDedupedCount,
      jobsFetchedCount: candidate.jobsFetchedCount,
      yieldScore: roundMetric(candidate.yieldScore),
      priorityScore: roundMetric(candidate.priorityScore),
      companyName: candidate.company?.name ?? null,
      companyKey: candidate.company?.companyKey ?? null,
      careersUrl: candidate.company?.careersUrl ?? null,
      lastSuccessfulPollAt: candidate.lastSuccessfulPollAt?.toISOString() ?? null,
    };
    appendDiscoverySource(nextEntry, {
      type: "productive_company_source",
      value: candidate.sourceName,
      discoveredAt: now.toISOString(),
    });

    if (!existing) {
      (discoveryStore.entries ??= []).push(nextEntry);
      entryMap.set(sourceKey, nextEntry);
    }

    if (!wasPromoted) {
      promotedCount += 1;
    }
  }

  for (const entry of discoveryStore.entries ?? []) {
    if (
      !isPriorityAtsConnector(entry.connectorName) ||
      entry.status !== "promoted" ||
      entry.decisionReason !== "productive_company_source" ||
      promotedKeys.has(entry.sourceKey)
    ) {
      continue;
    }

    entry.status = "pending";
    entry.decisionReason = "demoted_low_yield";
    demotedCount += 1;
  }

  const inventoryFile: AtsTenantInventoryFile = {
    updatedAt: now.toISOString(),
    source: "company-source.productive-v1",
    summary: {
      connectorCounts,
      promotedCount,
      demotedCount,
    },
    entries: candidates.map((candidate) => ({
      connectorName: candidate.connectorName,
      token: candidate.token,
      sourceKey: buildDiscoveredSourceKey(candidate.connectorName, candidate.token),
      sourceName: candidate.sourceName,
      boardUrl: candidate.boardUrl,
      companyName: candidate.company?.name ?? null,
      companyKey: candidate.company?.companyKey ?? null,
      careersUrl: candidate.company?.careersUrl ?? null,
      yieldScore: roundMetric(candidate.yieldScore),
      priorityScore: roundMetric(candidate.priorityScore),
      retainedLiveJobCount: candidate.retainedLiveJobCount,
      jobsFetchedCount: candidate.jobsFetchedCount,
      jobsAcceptedCount: candidate.jobsAcceptedCount,
      jobsDedupedCount: candidate.jobsDedupedCount,
      jobsCreatedCount: candidate.jobsCreatedCount,
      lastJobsFetchedCount: candidate.lastJobsFetchedCount,
      lastJobsAcceptedCount: candidate.lastJobsAcceptedCount,
      lastJobsDedupedCount: candidate.lastJobsDedupedCount,
      lastJobsCreatedCount: candidate.lastJobsCreatedCount,
      pollSuccessCount: candidate.pollSuccessCount,
      pollAttemptCount: candidate.pollAttemptCount,
      validationSuccessCount: candidate.validationSuccessCount,
      validationAttemptCount: candidate.validationAttemptCount,
      lastValidatedAt: candidate.lastValidatedAt?.toISOString() ?? null,
      lastSuccessfulPollAt: candidate.lastSuccessfulPollAt?.toISOString() ?? null,
    })),
  };

  if (!options.dryRun) {
    discoveryStore.updatedAt = now.toISOString();
    await mkdir(path.dirname(DISCOVERY_STORE_PATH), { recursive: true });
    await mkdir(path.dirname(ATS_TENANT_INVENTORY_PATH), { recursive: true });
    await writeFile(
      DISCOVERY_STORE_PATH,
      `${JSON.stringify(discoveryStore, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      ATS_TENANT_INVENTORY_PATH,
      `${JSON.stringify(inventoryFile, null, 2)}\n`,
      "utf8"
    );
  }

  return {
    candidateCount: candidates.length,
    promotedCount,
    demotedCount,
    inventoryPath: ATS_TENANT_INVENTORY_PATH,
    discoveryStorePath: DISCOVERY_STORE_PATH,
    connectorCounts,
  };
}

async function loadProductiveSourceCandidates() {
  const candidates: ProductiveSourceCandidate[] = [];

  for (const connectorName of ATS_TENANT_CONNECTORS) {
    const rows = await prisma.companySource.findMany({
      where: {
        connectorName,
        validationState: "VALIDATED",
        pollState: {
          not: "QUARANTINED",
        },
        token: {
          not: "",
        },
        OR: [
          {
            retainedLiveJobCount: {
              gte: MIN_PRODUCTIVE_RETAINED[connectorName],
            },
          },
          {
            lastJobsAcceptedCount: {
              gte: MIN_PRODUCTIVE_RETAINED[connectorName],
            },
          },
          {
            jobsAcceptedCount: {
              gte: MIN_PRODUCTIVE_RETAINED[connectorName] * 2,
            },
          },
          {
            AND: [
              {
                yieldScore: {
                  gte: 0.72,
                },
              },
              {
                pollSuccessCount: {
                  gte: 2,
                },
              },
            ],
          },
        ],
      },
      orderBy: [
        { retainedLiveJobCount: "desc" },
        { yieldScore: "desc" },
        { jobsAcceptedCount: "desc" },
        { lastSuccessfulPollAt: "desc" },
      ],
      take: CONNECTOR_LIMITS[connectorName],
      select: {
        connectorName: true,
        token: true,
        sourceName: true,
        boardUrl: true,
        yieldScore: true,
        priorityScore: true,
        retainedLiveJobCount: true,
        jobsFetchedCount: true,
        jobsAcceptedCount: true,
        jobsDedupedCount: true,
        jobsCreatedCount: true,
        lastJobsFetchedCount: true,
        lastJobsAcceptedCount: true,
        lastJobsDedupedCount: true,
        lastJobsCreatedCount: true,
        pollSuccessCount: true,
        pollAttemptCount: true,
        validationSuccessCount: true,
        validationAttemptCount: true,
        lastValidatedAt: true,
        lastSuccessfulPollAt: true,
        company: {
          select: {
            name: true,
            companyKey: true,
            careersUrl: true,
          },
        },
      },
    });

    for (const row of rows) {
      const token = row.token.trim().toLowerCase();
      if (!token) continue;

      candidates.push({
        connectorName,
        token,
        sourceName:
          row.sourceName && row.sourceName.trim().length > 0
            ? row.sourceName
            : buildDiscoveredSourceName(connectorName, token),
        boardUrl:
          row.boardUrl && row.boardUrl.trim().length > 0
            ? row.boardUrl
            : buildDiscoveredSourceUrl(connectorName, token),
        yieldScore: row.yieldScore,
        priorityScore: row.priorityScore,
        retainedLiveJobCount: row.retainedLiveJobCount,
        jobsFetchedCount: row.jobsFetchedCount,
        jobsAcceptedCount: row.jobsAcceptedCount,
        jobsDedupedCount: row.jobsDedupedCount,
        jobsCreatedCount: row.jobsCreatedCount,
        lastJobsFetchedCount: row.lastJobsFetchedCount,
        lastJobsAcceptedCount: row.lastJobsAcceptedCount,
        lastJobsDedupedCount: row.lastJobsDedupedCount,
        lastJobsCreatedCount: row.lastJobsCreatedCount,
        pollSuccessCount: row.pollSuccessCount,
        pollAttemptCount: row.pollAttemptCount,
        validationSuccessCount: row.validationSuccessCount,
        validationAttemptCount: row.validationAttemptCount,
        lastValidatedAt: row.lastValidatedAt,
        lastSuccessfulPollAt: row.lastSuccessfulPollAt,
        company: row.company,
      });
    }
  }

  return candidates;
}

async function loadDiscoveryStore(): Promise<DiscoveryStore> {
  try {
    const raw = await readFile(DISCOVERY_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as DiscoveryStore;
    return {
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      entries: parsed.entries ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        updatedAt: new Date(0).toISOString(),
        entries: [],
      };
    }

    throw error;
  }
}

function buildConnectorCounts(): Record<PriorityAtsConnectorName, number> {
  return {
    greenhouse: 0,
    lever: 0,
    ashby: 0,
    smartrecruiters: 0,
    icims: 0,
    teamtailor: 0,
    jobvite: 0,
  };
}

function isPriorityAtsConnector(
  connectorName: string | undefined
): connectorName is PriorityAtsConnectorName {
  return ATS_TENANT_CONNECTORS.includes(
    connectorName as PriorityAtsConnectorName
  );
}

function appendDiscoverySource(
  entry: DiscoveryStoreEntry,
  source: {
    type: string;
    value: string;
    discoveredAt: string;
  }
) {
  const discoveredFrom = (entry.discoveredFrom ??= []);
  const existing = discoveredFrom.find(
    (candidate) => candidate.type === source.type && candidate.value === source.value
  );
  if (existing) {
    existing.discoveredAt = source.discoveredAt;
    return;
  }

  discoveredFrom.push(source);
  if (discoveredFrom.length > 25) {
    discoveredFrom.splice(0, discoveredFrom.length - 25);
  }
}

function roundMetric(value: number) {
  return Math.round(value * 1000) / 1000;
}
