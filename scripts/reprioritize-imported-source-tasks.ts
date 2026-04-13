import "dotenv/config";
import { prisma } from "../src/lib/db";

const PRODUCTIVE_IMPORTED_CONNECTOR_PRIORITY: Record<string, number> = {
  greenhouse: 420,
  lever: 380,
  ashby: 360,
};

const OTHER_IMPORTED_CONNECTOR_PRIORITY: Record<string, number> = {
  workable: 220,
  smartrecruiters: 210,
  taleo: 180,
  workday: 150,
  successfactors: 150,
  icims: 140,
  recruitee: 140,
};

async function main() {
  const now = new Date();

  const [pollTasks, validationTasks] = await Promise.all([
    prisma.sourceTask.findMany({
      where: {
        kind: "CONNECTOR_POLL",
        status: "PENDING",
        companySource: {
          OR: [
            { parserVersion: "csv-import:v1" },
            {
              connectorName: "company-site",
              metadataJson: { path: ["importSource"], equals: "csv-seed" },
            },
          ],
        },
      },
      select: {
        id: true,
        priorityScore: true,
        companySource: {
          select: {
            id: true,
            connectorName: true,
            parserVersion: true,
            sourceType: true,
            pollAttemptCount: true,
            pollSuccessCount: true,
            jobsCreatedCount: true,
            retainedLiveJobCount: true,
            lastJobsCreatedCount: true,
            metadataJson: true,
          },
        },
      },
    }),
    prisma.sourceTask.findMany({
      where: {
        kind: "SOURCE_VALIDATION",
        status: "PENDING",
        companySource: {
          OR: [
            { parserVersion: "csv-import:v1" },
            {
              connectorName: "company-site",
              metadataJson: { path: ["importSource"], equals: "csv-seed" },
            },
          ],
        },
      },
      select: {
        id: true,
        priorityScore: true,
        companySource: {
          select: {
            id: true,
            connectorName: true,
            parserVersion: true,
            sourceType: true,
            pollAttemptCount: true,
            jobsCreatedCount: true,
            retainedLiveJobCount: true,
            metadataJson: true,
          },
        },
      },
    }),
  ]);

  const pollUpdates = pollTasks
    .map((task) => {
      if (!task.companySource) {
        return null;
      }
      const targetPriority = computePollTargetPriority(task.companySource);
      return targetPriority > task.priorityScore
        ? { id: task.id, priorityScore: targetPriority }
        : null;
    })
    .filter((entry): entry is { id: string; priorityScore: number } => entry !== null);

  const validationUpdates = validationTasks
    .map((task) => {
      if (!task.companySource) {
        return null;
      }
      const targetPriority = computeValidationTargetPriority(task.companySource);
      return targetPriority > task.priorityScore
        ? { id: task.id, priorityScore: targetPriority }
        : null;
    })
    .filter((entry): entry is { id: string; priorityScore: number } => entry !== null);

  for (const update of [...pollUpdates, ...validationUpdates]) {
    await prisma.sourceTask.update({
      where: { id: update.id },
      data: {
        priorityScore: update.priorityScore,
        notBeforeAt: now,
      },
    });
  }

  console.log(
    JSON.stringify(
      {
        pollTasksSeen: pollTasks.length,
        pollTasksBoosted: pollUpdates.length,
        validationTasksSeen: validationTasks.length,
        validationTasksBoosted: validationUpdates.length,
      },
      null,
      2
    )
  );
}

function isStructuredImportedCompanySite(source: {
  connectorName: string;
  sourceType: string | null;
  metadataJson: unknown;
}) {
  return (
    source.connectorName === "company-site" &&
    source.sourceType === "COMPANY_JSON" &&
    readImportSource(source.metadataJson) === "csv-seed"
  );
}

function isImportedAts(source: {
  parserVersion: string | null;
  connectorName: string;
}) {
  return source.parserVersion === "csv-import:v1" && source.connectorName !== "company-site";
}

function computePollTargetPriority(source: {
  connectorName: string;
  parserVersion: string | null;
  sourceType: string | null;
  pollAttemptCount: number;
  pollSuccessCount: number;
  jobsCreatedCount: number;
  retainedLiveJobCount: number;
  lastJobsCreatedCount: number;
  metadataJson: unknown;
}) {
  if (isStructuredImportedCompanySite(source)) {
    return 340 + Math.min(60, source.retainedLiveJobCount * 4);
  }

  if (source.connectorName === "company-site" && readImportSource(source.metadataJson) === "csv-seed") {
    return 240;
  }

  if (!isImportedAts(source)) {
    return 0;
  }

  const productiveBase = PRODUCTIVE_IMPORTED_CONNECTOR_PRIORITY[source.connectorName];
  if (productiveBase) {
    return (
      productiveBase +
      Math.min(80, source.retainedLiveJobCount * 3) +
      Math.min(40, source.lastJobsCreatedCount * 6) +
      (source.pollAttemptCount === 0 ? 24 : 0)
    );
  }

  const lowSignal =
    source.pollAttemptCount >= 2 &&
    source.pollSuccessCount >= 1 &&
    source.jobsCreatedCount === 0 &&
    source.retainedLiveJobCount === 0;
  if (lowSignal) {
    return 110;
  }

  return OTHER_IMPORTED_CONNECTOR_PRIORITY[source.connectorName] ?? 160;
}

function computeValidationTargetPriority(source: {
  connectorName: string;
  parserVersion: string | null;
  sourceType: string | null;
  pollAttemptCount: number;
  jobsCreatedCount: number;
  retainedLiveJobCount: number;
  metadataJson: unknown;
}) {
  if (isStructuredImportedCompanySite(source)) {
    return 320 + Math.min(40, source.retainedLiveJobCount * 3);
  }

  if (source.connectorName === "company-site" && readImportSource(source.metadataJson) === "csv-seed") {
    return 200;
  }

  if (!isImportedAts(source)) {
    return 0;
  }

  const productiveBase = PRODUCTIVE_IMPORTED_CONNECTOR_PRIORITY[source.connectorName];
  if (productiveBase) {
    return productiveBase - 80;
  }

  const lowSignal =
    source.pollAttemptCount >= 2 &&
    source.jobsCreatedCount === 0 &&
    source.retainedLiveJobCount === 0;
  if (lowSignal) {
    return 120;
  }

  return (OTHER_IMPORTED_CONNECTOR_PRIORITY[source.connectorName] ?? 160) - 20;
}

function readImportSource(metadataJson: unknown) {
  if (!metadataJson || typeof metadataJson !== "object" || Array.isArray(metadataJson)) {
    return null;
  }

  const importSource = (metadataJson as Record<string, unknown>).importSource;
  return typeof importSource === "string" ? importSource : null;
}

main()
  .catch((error) => {
    console.error("Failed to reprioritize imported source tasks:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
