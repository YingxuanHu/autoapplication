import { prisma } from "@/lib/db";
import { ingestConnector, reconcileCanonicalLifecycle } from "@/lib/ingestion/pipeline";
import {
  resolveConnectors,
  type ConnectorResolutionArgs,
  type SupportedConnectorName,
} from "@/lib/ingestion/registry";
import type { IngestionSummary } from "@/lib/ingestion/types";

type LaneTargetConfig = {
  key: string;
  laneKey: string;
  label: string;
  segmentKey: string;
  segmentWeight: number;
  connectorName: SupportedConnectorName;
  args: ConnectorResolutionArgs;
  limit: number;
  maxRuntimeMs?: number;
  cooldownMinutes: number;
  lowYieldCooldownMinutes?: number;
  minCreatedToRepeat?: number;
  maxOverlapRatio?: number;
};

type LaneConfig = {
  key: string;
  label: string;
  weight: number;
  maxRunsPerCycle: number;
  maxShareOfCycle: number;
  maxConcurrentTasks: number;
  description: string;
  targets: LaneTargetConfig[];
};

type TargetIntentClass = "growth" | "maintenance" | "exploration";

type IntentClassConfig = {
  key: TargetIntentClass;
  label: string;
  weight: number;
  maxShareOfCycle: number;
};

type SkipReason =
  | "recent_run"
  | "low_recent_yield"
  | "low_marginal_yield"
  | "overlap_heavy_recent"
  | "runtime_capped_recent"
  | "lane_budget_exhausted";

type LastRunSnapshot = {
  id: string;
  status: "SUCCESS" | "FAILED";
  startedAt: string;
  endedAt: string | null;
  fetchedCount: number;
  acceptedCount: number;
  canonicalCreatedCount: number;
  canonicalCreatedCanadaCount: number | null;
  canonicalCreatedCanadaRemoteCount: number | null;
  canonicalUpdatedCount: number;
  dedupedCount: number;
  acceptedCanadaCount: number | null;
  acceptedCanadaRemoteCount: number | null;
  effectiveLimit: number | null;
  checkpoint: unknown;
  checkpointExhausted: boolean;
  checkpointDepthRatio: number | null;
  errorSummary: string | null;
  runtimeMs: number | null;
};

type PlannedTarget = {
  lane: LaneConfig;
  target: LaneTargetConfig;
  connector: ReturnType<typeof resolveSingleConnector>;
  connectorKey: string;
  sourceName: string;
  lastRun: LastRunSnapshot | null;
  performance: TargetPerformanceSnapshot;
  marginalSignal: MarginalSignal;
  intentClass: TargetIntentClass;
  effectiveLimit: number;
  effectiveMaxRuntimeMs: number | null;
  selectionScore: number;
  skipDecision: { reason: SkipReason; notes: string } | null;
};

type TargetPerformanceSnapshot = {
  recentRunCount: number;
  successRunCount: number;
  recentRuntimeCapFailures: number;
  averageCreatedCount: number;
  averageCreatedPerFetch: number;
  averageCreatedPerMinute: number;
  averageOverlapRatio: number;
  averageAcceptedCanadaRatio: number;
  averageCreatedCanadaRatio: number;
  averageCreatedCanadaRemoteRatio: number;
  averageRuntimeMs: number | null;
  latestCreatedCount: number;
  latestCreatedCanadaCount: number;
};

type MarginalSignal = {
  latestCreatedPerFetch: number;
  latestCreatedPerMinute: number;
  latestOverlapRatio: number;
  latestCreatedCanadaRatio: number;
  latestAcceptedCanadaRatio: number;
  checkpointDepthRatio: number | null;
  checkpointExhausted: boolean;
  predictedNextChunkCreated: number;
  growthDebtScore: number;
  freshnessDebtScore: number;
};

export type LaneExecutionResult = {
  laneKey: string;
  laneLabel: string;
  weight: number;
  maxRunsPerCycle: number;
  maxConcurrentTasks: number;
  budgetedSlots: number;
  executedCount: number;
  failedCount: number;
  skippedCount: number;
  executedRuns: Array<{
    runId?: string;
    targetKey: string;
    segmentKey: string;
    intentClass: TargetIntentClass;
    sourceName: string;
    connectorKey: string;
    limit: number;
    maxRuntimeMs: number | null;
    runtimeMs: number | null;
    selectionScore: number;
    predictedCreatedCount: number;
    growthDebtScore: number;
    freshnessDebtScore: number;
    checkpointDepthBefore: number | null;
    checkpointDepthAfter: number | null;
    summary: IngestionSummary;
  }>;
  failedRuns: Array<{
    runId?: string;
    targetKey: string;
    segmentKey: string;
    intentClass: TargetIntentClass;
    sourceName: string;
    connectorKey: string;
    limit: number;
    maxRuntimeMs: number | null;
    runtimeMs: number | null;
    selectionScore: number;
    predictedCreatedCount: number;
    growthDebtScore: number;
    freshnessDebtScore: number;
    checkpointDepthBefore: number | null;
    errorSummary: string;
  }>;
  skippedTargets: Array<{
    targetKey: string;
    segmentKey: string;
    intentClass: TargetIntentClass;
    sourceName: string;
    connectorKey: string;
    selectionScore: number;
    reason: SkipReason;
    notes?: string;
  }>;
};

export type OrchestratedIngestionResult = {
  startedAt: string;
  executedRuns: IngestionSummary[];
  laneResults: LaneExecutionResult[];
  queue: {
    schedulingStrategy: string;
    maxConcurrentTasks: number;
    totalPlannedTasks: number;
    totalExecutedTasks: number;
    totalFailedTasks: number;
    totalSkippedTasks: number;
  };
  planning: {
    laneBudgetScores: Record<string, number>;
    laneSlotCaps: Record<string, number>;
    targetDistinctLanes: number;
    classBudgetScores: Record<TargetIntentClass, number>;
    classAllocatedSlots: Record<TargetIntentClass, number>;
    classSlotCaps: Record<TargetIntentClass, number>;
    targetDistinctClasses: number;
  };
  totals: {
    fetchedCount: number;
    acceptedCount: number;
    canonicalCreatedCount: number;
    canonicalUpdatedCount: number;
    dedupedCount: number;
    rejectedCount: number;
    averageRuntimeMs: number | null;
  };
  lifecycle: {
    liveCount: number;
    staleCount: number;
    expiredCount: number;
    removedCount: number;
    updatedCount: number;
  };
};

const ORCHESTRATION_LANES: LaneConfig[] = [
  {
    key: "adzuna",
    label: "Adzuna",
    weight: 40,
    maxRunsPerCycle: 4,
    maxShareOfCycle: 0.5,
    maxConcurrentTasks: 1,
    description:
      "Primary volume engine. Keep core country runs active and selectively budget specialist slices.",
    targets: [
      {
        key: "adzuna-ca-core",
        laneKey: "adzuna",
        label: "Canada core",
        segmentKey: "core",
        segmentWeight: 18,
        connectorName: "adzuna",
        args: { sources: "ca" },
        limit: 1500,
        maxRuntimeMs: 120000,
        cooldownMinutes: 360,
        lowYieldCooldownMinutes: 1440,
        minCreatedToRepeat: 150,
        maxOverlapRatio: 0.85,
      },
      {
        key: "adzuna-us-core",
        laneKey: "adzuna",
        label: "US core",
        segmentKey: "core",
        segmentWeight: 18,
        connectorName: "adzuna",
        args: { sources: "us" },
        limit: 1500,
        maxRuntimeMs: 120000,
        cooldownMinutes: 360,
        lowYieldCooldownMinutes: 1440,
        minCreatedToRepeat: 200,
        maxOverlapRatio: 0.85,
      },
      {
        key: "adzuna-ca-specialist",
        laneKey: "adzuna",
        label: "Canada specialist",
        segmentKey: "specialist",
        segmentWeight: 10,
        connectorName: "adzuna",
        args: { sources: "ca:specialist" },
        limit: 600,
        maxRuntimeMs: 90000,
        cooldownMinutes: 720,
        lowYieldCooldownMinutes: 1440,
        minCreatedToRepeat: 40,
        maxOverlapRatio: 0.65,
      },
      {
        key: "adzuna-us-specialist",
        laneKey: "adzuna",
        label: "US specialist",
        segmentKey: "specialist",
        segmentWeight: 10,
        connectorName: "adzuna",
        args: { sources: "us:specialist" },
        limit: 600,
        maxRuntimeMs: 90000,
        cooldownMinutes: 720,
        lowYieldCooldownMinutes: 1440,
        minCreatedToRepeat: 40,
        maxOverlapRatio: 0.65,
      },
      {
        key: "adzuna-ca-discovery",
        laneKey: "adzuna",
        label: "Canada discovery",
        segmentKey: "discovery",
        segmentWeight: 4,
        connectorName: "adzuna",
        args: { sources: "ca:discovery" },
        limit: 600,
        maxRuntimeMs: 90000,
        cooldownMinutes: 1440,
        lowYieldCooldownMinutes: 2880,
        minCreatedToRepeat: 45,
        maxOverlapRatio: 0.6,
      },
      {
        key: "adzuna-us-discovery",
        laneKey: "adzuna",
        label: "US discovery",
        segmentKey: "discovery",
        segmentWeight: 2,
        connectorName: "adzuna",
        args: { sources: "us:discovery" },
        limit: 600,
        maxRuntimeMs: 90000,
        cooldownMinutes: 1440,
        lowYieldCooldownMinutes: 2880,
        minCreatedToRepeat: 50,
        maxOverlapRatio: 0.55,
      },
    ],
  },
  {
    key: "workday",
    label: "Workday",
    weight: 25,
    maxRunsPerCycle: 2,
    maxShareOfCycle: 0.5,
    maxConcurrentTasks: 1,
    description:
      "Enterprise lane. Keep proven Canada-heavy boards warm and refresh due high-yield tenants.",
    targets: [
      {
        key: "workday-enbridge",
        laneKey: "workday",
        label: "Enbridge",
        segmentKey: "enterprise",
        segmentWeight: 12,
        connectorName: "workday",
        args: { source: "enbridge.wd3.myworkdayjobs.com|enbridge|enbridge_careers" },
        limit: 100,
        maxRuntimeMs: 60000,
        cooldownMinutes: 1440,
        lowYieldCooldownMinutes: 2880,
        minCreatedToRepeat: 8,
        maxOverlapRatio: 0.75,
      },
      {
        key: "workday-suncor",
        laneKey: "workday",
        label: "Suncor",
        segmentKey: "enterprise",
        segmentWeight: 11,
        connectorName: "workday",
        args: { source: "suncor.wd1.myworkdayjobs.com|suncor|suncor_external" },
        limit: 100,
        maxRuntimeMs: 60000,
        cooldownMinutes: 1440,
        lowYieldCooldownMinutes: 2880,
        minCreatedToRepeat: 8,
        maxOverlapRatio: 0.75,
      },
      {
        key: "workday-tmx",
        laneKey: "workday",
        label: "TMX",
        segmentKey: "enterprise",
        segmentWeight: 5,
        connectorName: "workday",
        args: { source: "tmx.wd3.myworkdayjobs.com|tmx|tmx_careers" },
        limit: 120,
        maxRuntimeMs: 75000,
        cooldownMinutes: 1440,
        lowYieldCooldownMinutes: 4320,
        minCreatedToRepeat: 10,
        maxOverlapRatio: 0.7,
      },
      {
        key: "workday-ia",
        laneKey: "workday",
        label: "iA Financial",
        segmentKey: "enterprise",
        segmentWeight: 4,
        connectorName: "workday",
        args: { source: "ia.wd3.myworkdayjobs.com|ia|professional" },
        limit: 120,
        maxRuntimeMs: 75000,
        cooldownMinutes: 1440,
        lowYieldCooldownMinutes: 4320,
        minCreatedToRepeat: 10,
        maxOverlapRatio: 0.6,
      },
    ],
  },
  {
    key: "themuse",
    label: "The Muse",
    weight: 15,
    maxRunsPerCycle: 1,
    maxShareOfCycle: 0.34,
    maxConcurrentTasks: 1,
    description:
      "Structured aggregator refresh lane with strong prior yield and broad enterprise coverage.",
    targets: [
      {
        key: "themuse-feed",
        laneKey: "themuse",
        label: "Feed",
        segmentKey: "feed",
        segmentWeight: 15,
        connectorName: "themuse",
        args: {},
        limit: 2000,
        maxRuntimeMs: 90000,
        cooldownMinutes: 720,
        lowYieldCooldownMinutes: 1440,
        minCreatedToRepeat: 250,
        maxOverlapRatio: 0.8,
      },
    ],
  },
  {
    key: "smartrecruiters",
    label: "SmartRecruiters",
    weight: 20,
    maxRunsPerCycle: 3,
    maxShareOfCycle: 0.5,
    maxConcurrentTasks: 1,
    description:
      "Parallel board-acquisition lane. Favor Canada-heavy mid-size boards and skip overlap-heavy boards aggressively.",
    targets: [
      {
        key: "smartrecruiters-uhn",
        laneKey: "smartrecruiters",
        label: "University Health Network",
        segmentKey: "board",
        segmentWeight: 10,
        connectorName: "smartrecruiters",
        args: { company: "UniversityHealthNetwork" },
        limit: 200,
        maxRuntimeMs: 60000,
        cooldownMinutes: 1440,
        lowYieldCooldownMinutes: 2880,
        minCreatedToRepeat: 5,
        maxOverlapRatio: 0.75,
      },
      {
        key: "smartrecruiters-ample",
        laneKey: "smartrecruiters",
        label: "Ample Insight",
        segmentKey: "board",
        segmentWeight: 9,
        connectorName: "smartrecruiters",
        args: { company: "AmpleInsightInc" },
        limit: 100,
        maxRuntimeMs: 45000,
        cooldownMinutes: 1440,
        lowYieldCooldownMinutes: 2880,
        minCreatedToRepeat: 3,
        maxOverlapRatio: 0.75,
      },
      {
        key: "smartrecruiters-medfar",
        laneKey: "smartrecruiters",
        label: "Medfar",
        segmentKey: "board",
        segmentWeight: 7,
        connectorName: "smartrecruiters",
        args: { company: "Medfar" },
        limit: 100,
        maxRuntimeMs: 45000,
        cooldownMinutes: 1440,
        lowYieldCooldownMinutes: 2880,
        minCreatedToRepeat: 3,
        maxOverlapRatio: 0.75,
      },
      {
        key: "smartrecruiters-banknote",
        laneKey: "smartrecruiters",
        label: "Canadian Bank Note Company",
        segmentKey: "board",
        segmentWeight: 6,
        connectorName: "smartrecruiters",
        args: { company: "CanadianBankNoteCompany" },
        limit: 100,
        maxRuntimeMs: 45000,
        cooldownMinutes: 1440,
        lowYieldCooldownMinutes: 2880,
        minCreatedToRepeat: 3,
        maxOverlapRatio: 0.75,
      },
      {
        key: "smartrecruiters-houseofcommons",
        laneKey: "smartrecruiters",
        label: "House of Commons",
        segmentKey: "board",
        segmentWeight: 6,
        connectorName: "smartrecruiters",
        args: { company: "HouseOfCommonsCanadaChambreDesCommunesCanada" },
        limit: 100,
        maxRuntimeMs: 45000,
        cooldownMinutes: 1440,
        lowYieldCooldownMinutes: 2880,
        minCreatedToRepeat: 3,
        maxOverlapRatio: 0.75,
      },
      {
        key: "smartrecruiters-wildbrain",
        laneKey: "smartrecruiters",
        label: "WildBrain",
        segmentKey: "board",
        segmentWeight: 5,
        connectorName: "smartrecruiters",
        args: { company: "wildbrain" },
        limit: 100,
        maxRuntimeMs: 45000,
        cooldownMinutes: 1440,
        lowYieldCooldownMinutes: 2880,
        minCreatedToRepeat: 3,
        maxOverlapRatio: 0.75,
      },
      {
        key: "smartrecruiters-visa",
        laneKey: "smartrecruiters",
        label: "Visa",
        segmentKey: "board",
        segmentWeight: 1,
        connectorName: "smartrecruiters",
        args: { company: "visa" },
        limit: 200,
        maxRuntimeMs: 60000,
        cooldownMinutes: 2880,
        lowYieldCooldownMinutes: 4320,
        minCreatedToRepeat: 30,
        maxOverlapRatio: 0.45,
      },
    ],
  },
];

const INTENT_CLASS_CONFIGS: IntentClassConfig[] = [
  {
    key: "growth",
    label: "Growth",
    weight: 50,
    maxShareOfCycle: 0.6,
  },
  {
    key: "maintenance",
    label: "Maintenance",
    weight: 25,
    maxShareOfCycle: 0.4,
  },
  {
    key: "exploration",
    label: "Exploration",
    weight: 25,
    maxShareOfCycle: 0.4,
  },
];

export async function runLaneOrchestration(options: {
  now?: Date;
  force?: boolean;
  totalRunSlots?: number;
  maxConcurrentTasks?: number;
} = {}): Promise<OrchestratedIngestionResult> {
  const cycleStartedAt = options.now ?? new Date();
  const totalRunSlots = options.totalRunSlots ?? 8;
  const maxConcurrentTasks = options.maxConcurrentTasks ?? 2;

  const plannedTargets = await Promise.all(
    ORCHESTRATION_LANES.flatMap((lane) =>
      lane.targets.map(async (target) => {
        const connector = resolveSingleConnector(target.connectorName, target.args);
        const recentRuns = await loadRecentRuns(connector.key);
        const lastRun = recentRuns[0] ?? null;
        const performance = buildTargetPerformanceSnapshot(recentRuns);
        const marginalSignal = buildMarginalSignal(
          target,
          performance,
          lastRun,
          cycleStartedAt
        );
        const intentClass = classifyTargetIntent(
          target,
          performance,
          lastRun,
          marginalSignal
        );
        const effectiveMaxRuntimeMs = deriveEffectiveMaxRuntimeMs(
          target,
          performance,
          marginalSignal
        );
        const effectiveLimit = deriveEffectiveLimit(
          target,
          performance,
          marginalSignal
        );
        const selectionScore = computeTargetSelectionScore(
          target,
          performance,
          marginalSignal
        );
        const skipDecision =
          evaluateMarginalSkipDecision(target, lastRun, marginalSignal) ??
          (options.force
            ? null
            : evaluateSkipDecision(cycleStartedAt, target, lastRun));

        return {
          lane,
          target,
          connector,
          connectorKey: connector.key,
          sourceName: connector.sourceName,
          lastRun,
          performance,
          marginalSignal,
          intentClass,
          effectiveLimit,
          effectiveMaxRuntimeMs,
          selectionScore,
          skipDecision,
        } satisfies PlannedTarget;
      })
    )
  );

  const laneResults = ORCHESTRATION_LANES.map(
    (lane): LaneExecutionResult => ({
      laneKey: lane.key,
      laneLabel: lane.label,
      weight: lane.weight,
      maxRunsPerCycle: lane.maxRunsPerCycle,
      maxConcurrentTasks: lane.maxConcurrentTasks,
      budgetedSlots: 0,
      executedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      executedRuns: [],
      failedRuns: [],
      skippedTargets: [],
    })
  );
  const laneResultByKey = new Map(
    laneResults.map((result) => [result.laneKey, result])
  );

  const executableTargets = plannedTargets
    .filter((plannedTarget) => plannedTarget.skipDecision === null)
    .sort((left, right) => {
      if (left.selectionScore !== right.selectionScore) {
        return right.selectionScore - left.selectionScore;
      }
      const leftStartedAt = left.lastRun?.startedAt
        ? new Date(left.lastRun.startedAt).getTime()
        : 0;
      const rightStartedAt = right.lastRun?.startedAt
        ? new Date(right.lastRun.startedAt).getTime()
        : 0;
      return leftStartedAt - rightStartedAt;
    });

  const executableByLane = new Map<string, PlannedTarget[]>();
  for (const lane of ORCHESTRATION_LANES) {
    executableByLane.set(
      lane.key,
      executableTargets.filter((plannedTarget) => plannedTarget.lane.key === lane.key)
    );
  }

  const laneBudgetPlan = allocateLaneBudgets({
    lanes: ORCHESTRATION_LANES,
    executableByLane,
    plannedTargets,
    totalRunSlots,
  });
  const classBudgetPlan = allocateIntentClassBudgets({
    executableTargets,
    totalRunSlots,
  });
  const portfolioSelection = selectPortfolioTargets({
    executableTargets,
    laneSlotCaps: laneBudgetPlan.laneSlotCaps,
    classBudgets: classBudgetPlan.budgets,
    totalRunSlots,
  });

  const selectedByLane = new Map<string, PlannedTarget[]>();
  for (const lane of ORCHESTRATION_LANES) {
    const laneResult = laneResultByKey.get(lane.key)!;
    const selectedTargets = portfolioSelection.selectedTargets.filter(
      (target) => target.lane.key === lane.key
    );
    const budgetedSlots = selectedTargets.length;
    laneResult.budgetedSlots = budgetedSlots;
    const selectedKeys = new Set(selectedTargets.map((target) => target.target.key));
    selectedByLane.set(lane.key, selectedTargets);

    for (const plannedTarget of plannedTargets.filter(
      (target) => target.lane.key === lane.key
    )) {
      if (plannedTarget.skipDecision) {
        laneResult.skippedCount += 1;
        laneResult.skippedTargets.push({
          targetKey: plannedTarget.target.key,
          segmentKey: plannedTarget.target.segmentKey,
          intentClass: plannedTarget.intentClass,
          sourceName: plannedTarget.sourceName,
          connectorKey: plannedTarget.connectorKey,
          selectionScore: roundSelectionScore(plannedTarget.selectionScore),
          reason: plannedTarget.skipDecision.reason,
          notes: plannedTarget.skipDecision.notes,
        });
        continue;
      }

      if (!selectedKeys.has(plannedTarget.target.key)) {
        laneResult.skippedCount += 1;
        laneResult.skippedTargets.push({
          targetKey: plannedTarget.target.key,
          segmentKey: plannedTarget.target.segmentKey,
          intentClass: plannedTarget.intentClass,
          sourceName: plannedTarget.sourceName,
          connectorKey: plannedTarget.connectorKey,
          selectionScore: roundSelectionScore(plannedTarget.selectionScore),
          reason: "lane_budget_exhausted",
          notes: `Portfolio selection capped ${lane.label} at ${budgetedSlots} run(s) this cycle`,
        });
      }
    }
  }

  const queue = buildFairTaskQueue(selectedByLane);
  const executedRuns: IngestionSummary[] = [];

  await executeTaskQueue({
    queue,
    cycleStartedAt,
    maxConcurrentTasks,
    onTaskCompleted: (task, summary, runtimeMs) => {
      executedRuns.push(summary);
      const laneResult = laneResultByKey.get(task.lane.key)!;
      laneResult.executedCount += 1;
      laneResult.executedRuns.push({
        runId: summary.runId,
        targetKey: task.target.key,
        segmentKey: task.target.segmentKey,
        intentClass: task.intentClass,
        sourceName: task.sourceName,
        connectorKey: task.connectorKey,
        limit: task.effectiveLimit,
        maxRuntimeMs: task.effectiveMaxRuntimeMs,
        runtimeMs,
        selectionScore: roundSelectionScore(task.selectionScore),
        predictedCreatedCount: task.marginalSignal.predictedNextChunkCreated,
        growthDebtScore: roundSelectionScore(task.marginalSignal.growthDebtScore),
        freshnessDebtScore: roundSelectionScore(task.marginalSignal.freshnessDebtScore),
        checkpointDepthBefore: task.marginalSignal.checkpointDepthRatio,
        checkpointDepthAfter: estimateCheckpointDepthRatio(
          task.connectorKey,
          summary.checkpoint ?? null
        ),
        summary,
      });
    },
    onTaskFailed: (task, failedRun, runtimeMs, errorSummary) => {
      const laneResult = laneResultByKey.get(task.lane.key)!;
      laneResult.failedCount += 1;
      laneResult.failedRuns.push({
        runId: failedRun?.id,
        targetKey: task.target.key,
        segmentKey: task.target.segmentKey,
        intentClass: task.intentClass,
        sourceName: task.sourceName,
        connectorKey: task.connectorKey,
        limit: task.effectiveLimit,
        maxRuntimeMs: task.effectiveMaxRuntimeMs,
        runtimeMs,
        selectionScore: roundSelectionScore(task.selectionScore),
        predictedCreatedCount: task.marginalSignal.predictedNextChunkCreated,
        growthDebtScore: roundSelectionScore(task.marginalSignal.growthDebtScore),
        freshnessDebtScore: roundSelectionScore(task.marginalSignal.freshnessDebtScore),
        checkpointDepthBefore: task.marginalSignal.checkpointDepthRatio,
        errorSummary,
      });
    },
  });

  const lifecycle = await reconcileCanonicalLifecycle({ now: new Date() });
  const totals = summarizeRuns(
    laneResults.flatMap((result) => result.executedRuns)
  );

  return {
    startedAt: cycleStartedAt.toISOString(),
    executedRuns,
    laneResults,
    queue: {
      schedulingStrategy: "intent_class_budgeting_with_lane_diversity_and_concurrency",
      maxConcurrentTasks,
      totalPlannedTasks: queue.length,
      totalExecutedTasks: executedRuns.length,
      totalFailedTasks: laneResults.reduce(
        (sum, result) => sum + result.failedCount,
        0
      ),
      totalSkippedTasks: laneResults.reduce(
        (sum, result) => sum + result.skippedCount,
        0
      ),
    },
    planning: {
      laneBudgetScores: Object.fromEntries(
        ORCHESTRATION_LANES.map((lane) => [
          lane.key,
          roundSelectionScore(
            laneBudgetPlan.laneBudgetScores.get(lane.key) ?? 0
          ),
        ])
      ),
      laneSlotCaps: Object.fromEntries(
        ORCHESTRATION_LANES.map((lane) => [
          lane.key,
          laneBudgetPlan.laneSlotCaps.get(lane.key) ?? 0,
        ])
      ),
      targetDistinctLanes: laneBudgetPlan.targetDistinctLanes,
      classBudgetScores: Object.fromEntries(
        INTENT_CLASS_CONFIGS.map((intentClass) => [
          intentClass.key,
          roundSelectionScore(
            classBudgetPlan.classBudgetScores.get(intentClass.key) ?? 0
          ),
        ])
      ) as Record<TargetIntentClass, number>,
      classAllocatedSlots: Object.fromEntries(
        INTENT_CLASS_CONFIGS.map((intentClass) => [
          intentClass.key,
          portfolioSelection.classAllocations.get(intentClass.key) ?? 0,
        ])
      ) as Record<TargetIntentClass, number>,
      classSlotCaps: Object.fromEntries(
        INTENT_CLASS_CONFIGS.map((intentClass) => [
          intentClass.key,
          classBudgetPlan.classSlotCaps.get(intentClass.key) ?? 0,
        ])
      ) as Record<TargetIntentClass, number>,
      targetDistinctClasses: classBudgetPlan.targetDistinctClasses,
    },
    totals,
    lifecycle,
  };
}

function resolveSingleConnector(
  connectorName: SupportedConnectorName,
  args: ConnectorResolutionArgs
) {
  const connectors = resolveConnectors(connectorName, args);
  if (connectors.length !== 1) {
    throw new Error(
      `Lane orchestration target must resolve to exactly one connector. Received ${connectors.length} for ${connectorName}.`
    );
  }
  return connectors[0];
}

function evaluateSkipDecision(
  now: Date,
  target: LaneTargetConfig,
  lastRun: LastRunSnapshot | null
): { reason: SkipReason; notes: string } | null {
  if (!lastRun) return null;

  const minutesSinceLastRun =
    (now.getTime() - new Date(lastRun.startedAt).getTime()) / (1000 * 60);
  if (
    lastRun.status === "FAILED" &&
    typeof target.maxRuntimeMs === "number" &&
    lastRun.errorSummary?.includes("Runtime budget exceeded") &&
    target.lowYieldCooldownMinutes !== undefined &&
    minutesSinceLastRun < target.lowYieldCooldownMinutes
  ) {
    return {
      reason: "runtime_capped_recent",
      notes: `Last run hit runtime cap (${lastRun.runtimeMs ?? "unknown"}ms) within ${target.lowYieldCooldownMinutes} minute(s)`,
    };
  }

  if (minutesSinceLastRun < target.cooldownMinutes) {
    return {
      reason: "recent_run",
      notes: `Last successful run ${Math.floor(minutesSinceLastRun)} minute(s) ago; cooldown ${target.cooldownMinutes} minute(s)`,
    };
  }

  const overlapRatio =
    lastRun.acceptedCount > 0
      ? (lastRun.canonicalUpdatedCount + lastRun.dedupedCount) /
        lastRun.acceptedCount
      : 0;

  if (
    target.minCreatedToRepeat !== undefined &&
    target.lowYieldCooldownMinutes !== undefined &&
    lastRun.canonicalCreatedCount < target.minCreatedToRepeat &&
    minutesSinceLastRun < target.lowYieldCooldownMinutes
  ) {
    return {
      reason: "low_recent_yield",
      notes: `Last run created ${lastRun.canonicalCreatedCount} (< ${target.minCreatedToRepeat}) within ${target.lowYieldCooldownMinutes} minute(s)`,
    };
  }

  if (
    target.maxOverlapRatio !== undefined &&
    overlapRatio > target.maxOverlapRatio &&
    target.minCreatedToRepeat !== undefined &&
    lastRun.canonicalCreatedCount < target.minCreatedToRepeat
  ) {
    return {
      reason: "overlap_heavy_recent",
      notes: `Last run overlap ratio ${(overlapRatio * 100).toFixed(1)}% exceeded ${(target.maxOverlapRatio * 100).toFixed(1)}% with only ${lastRun.canonicalCreatedCount} created`,
    };
  }

  return null;
}

function evaluateMarginalSkipDecision(
  target: LaneTargetConfig,
  lastRun: LastRunSnapshot | null,
  marginalSignal: MarginalSignal
): { reason: SkipReason; notes: string } | null {
  if (!lastRun) return null;

  const minCreated = Math.max(target.minCreatedToRepeat ?? 8, 4);
  const checkpointDepth = marginalSignal.checkpointDepthRatio ?? 0;
  const lowGrowth =
    marginalSignal.growthDebtScore <= 0.12 ||
    marginalSignal.predictedNextChunkCreated < Math.max(2, Math.round(minCreated * 0.25));
  const lateAndOverlapHeavy =
    checkpointDepth >= 0.3 &&
    marginalSignal.latestOverlapRatio >= 0.75 &&
    marginalSignal.latestCreatedPerFetch <= 0.03;
  const lowFreshnessNeed = marginalSignal.freshnessDebtScore < 0.35;

  if (lowGrowth && lowFreshnessNeed && lateAndOverlapHeavy) {
    return {
      reason: "low_marginal_yield",
      notes: `Predicted next chunk ${marginalSignal.predictedNextChunkCreated} with growth debt ${marginalSignal.growthDebtScore.toFixed(2)} at depth ${(checkpointDepth * 100).toFixed(0)}%`,
    };
  }

  return null;
}

function summarizeRuns(
  executedRuns: Array<{
    runtimeMs: number | null;
    summary: {
      fetchedCount: number;
      acceptedCount: number;
      canonicalCreatedCount: number;
      canonicalUpdatedCount: number;
      dedupedCount: number;
      rejectedCount: number;
    };
  }>
) {
  const runtimeValues = executedRuns
    .map((run) => run.runtimeMs)
    .filter((value): value is number => typeof value === "number");

  return executedRuns.reduce(
    (accumulator, run) => ({
      fetchedCount: accumulator.fetchedCount + run.summary.fetchedCount,
      acceptedCount: accumulator.acceptedCount + run.summary.acceptedCount,
      canonicalCreatedCount:
        accumulator.canonicalCreatedCount + run.summary.canonicalCreatedCount,
      canonicalUpdatedCount:
        accumulator.canonicalUpdatedCount + run.summary.canonicalUpdatedCount,
      dedupedCount: accumulator.dedupedCount + run.summary.dedupedCount,
      rejectedCount: accumulator.rejectedCount + run.summary.rejectedCount,
      averageRuntimeMs:
        runtimeValues.length > 0
          ? Math.round(
              runtimeValues.reduce((sum, value) => sum + value, 0) /
                runtimeValues.length
            )
          : null,
    }),
    {
      fetchedCount: 0,
      acceptedCount: 0,
      canonicalCreatedCount: 0,
      canonicalUpdatedCount: 0,
      dedupedCount: 0,
      rejectedCount: 0,
      averageRuntimeMs: null as number | null,
    }
  );
}

async function loadRecentRuns(connectorKey: string): Promise<LastRunSnapshot[]> {
  const recentRuns = await prisma.ingestionRun.findMany({
    where: {
      connectorKey,
      status: {
        in: ["SUCCESS", "FAILED"],
      },
    },
    orderBy: { startedAt: "desc" },
    take: 5,
    select: {
      id: true,
      status: true,
      startedAt: true,
      endedAt: true,
      fetchedCount: true,
      acceptedCount: true,
      canonicalCreatedCount: true,
      canonicalUpdatedCount: true,
      dedupedCount: true,
      errorSummary: true,
      runOptions: true,
    },
  });

  return recentRuns.map((lastRun) => {
    const runOptions = asJsonObject(lastRun.runOptions);
    const resultMetrics = asJsonObject(runOptions?.resultMetrics);
    const runMetadata = asJsonObject(runOptions?.runMetadata);
    const checkpoint = runOptions?.checkpoint ?? null;
    const checkpointExhausted = runOptions?.checkpointExhausted === true;
    const runtimeMs =
      lastRun.endedAt instanceof Date
        ? Math.max(lastRun.endedAt.getTime() - lastRun.startedAt.getTime(), 0)
        : null;

    return {
      id: lastRun.id,
      status:
        lastRun.status === "FAILED"
          ? "FAILED"
          : "SUCCESS",
      startedAt: lastRun.startedAt.toISOString(),
      endedAt: lastRun.endedAt?.toISOString() ?? null,
      fetchedCount: lastRun.fetchedCount,
      acceptedCount: lastRun.acceptedCount,
      canonicalCreatedCount: lastRun.canonicalCreatedCount,
      canonicalCreatedCanadaCount: getMetricCount(
        resultMetrics,
        "canonicalCreatedCanadaCount"
      ),
      canonicalCreatedCanadaRemoteCount: getMetricCount(
        resultMetrics,
        "canonicalCreatedCanadaRemoteCount"
      ),
      canonicalUpdatedCount: lastRun.canonicalUpdatedCount,
      dedupedCount: lastRun.dedupedCount,
      acceptedCanadaCount: getMetricCount(resultMetrics, "acceptedCanadaCount"),
      acceptedCanadaRemoteCount: getMetricCount(
        resultMetrics,
        "acceptedCanadaRemoteCount"
      ),
      effectiveLimit: getMetricCount(runMetadata, "effectiveLimit"),
      checkpoint,
      checkpointExhausted,
      checkpointDepthRatio: estimateCheckpointDepthRatio(connectorKey, checkpoint),
      errorSummary: lastRun.errorSummary,
      runtimeMs,
    };
  });
}

function allocateLaneBudgets({
  lanes,
  executableByLane,
  plannedTargets,
  totalRunSlots,
}: {
  lanes: LaneConfig[];
  executableByLane: Map<string, PlannedTarget[]>;
  plannedTargets: PlannedTarget[];
  totalRunSlots: number;
}) {
  const activeLanes = lanes.filter(
    (lane) =>
      Math.min(
        lane.maxRunsPerCycle,
        executableByLane.get(lane.key)?.length ?? 0
      ) > 0
  );
  const budgets = new Map<string, number>();
  const laneBudgetScores = new Map<string, number>();
  const laneSlotCaps = new Map<string, number>();

  for (const lane of activeLanes) {
    const laneCapacity = Math.min(
      lane.maxRunsPerCycle,
      executableByLane.get(lane.key)?.length ?? 0
    );
    laneBudgetScores.set(
      lane.key,
      computeLaneBudgetScore(
        lane,
        plannedTargets.filter(
          (plannedTarget) =>
            plannedTarget.lane.key === lane.key && plannedTarget.skipDecision === null
        )
      )
    );
    laneSlotCaps.set(
      lane.key,
      Math.min(
        laneCapacity,
        Math.max(1, Math.ceil(totalRunSlots * lane.maxShareOfCycle))
      )
    );
    budgets.set(lane.key, 0);
  }

  let allocated = 0;
  const targetDistinctLanes = Math.min(3, totalRunSlots, activeLanes.length);
  const guaranteedLanes = [...activeLanes]
    .sort(
      (left, right) =>
        (laneBudgetScores.get(right.key) ?? 0) - (laneBudgetScores.get(left.key) ?? 0)
    )
    .slice(0, targetDistinctLanes);

  for (const lane of guaranteedLanes) {
    const cap = laneSlotCaps.get(lane.key) ?? 0;
    if (cap <= 0) continue;
    budgets.set(lane.key, 1);
    allocated += 1;
  }

  while (allocated < totalRunSlots) {
    const nextLane = activeLanes
      .filter((lane) => {
        const cap = laneSlotCaps.get(lane.key) ?? 0;
        return (budgets.get(lane.key) ?? 0) < cap;
      })
      .map((lane) => ({
        lane,
        adjustedScore: computeLaneAllocationScore(
          laneBudgetScores.get(lane.key) ?? 0,
          budgets.get(lane.key) ?? 0
        ),
      }))
      .sort((left, right) => right.adjustedScore - left.adjustedScore)[0];

    if (!nextLane || nextLane.adjustedScore <= 0) break;
    budgets.set(nextLane.lane.key, (budgets.get(nextLane.lane.key) ?? 0) + 1);
    allocated += 1;
  }

  for (const lane of lanes) {
    if (!budgets.has(lane.key)) budgets.set(lane.key, 0);
  }

  return {
    budgets,
    laneBudgetScores,
    laneSlotCaps,
    targetDistinctLanes,
  };
}

function allocateIntentClassBudgets({
  executableTargets,
  totalRunSlots,
}: {
  executableTargets: PlannedTarget[];
  totalRunSlots: number;
}) {
  const executableByClass = new Map<TargetIntentClass, PlannedTarget[]>();
  for (const intentClass of INTENT_CLASS_CONFIGS) {
    executableByClass.set(
      intentClass.key,
      executableTargets.filter((target) => target.intentClass === intentClass.key)
    );
  }

  const activeClasses = INTENT_CLASS_CONFIGS.filter(
    (intentClass) => (executableByClass.get(intentClass.key)?.length ?? 0) > 0
  );
  const budgets = new Map<TargetIntentClass, number>();
  const classBudgetScores = new Map<TargetIntentClass, number>();
  const classSlotCaps = new Map<TargetIntentClass, number>();

  for (const intentClass of activeClasses) {
    const capacity = executableByClass.get(intentClass.key)?.length ?? 0;
    classBudgetScores.set(
      intentClass.key,
      computeIntentClassBudgetScore(executableByClass.get(intentClass.key) ?? [])
    );
    classSlotCaps.set(
      intentClass.key,
      Math.min(
        capacity,
        Math.max(1, Math.ceil(totalRunSlots * intentClass.maxShareOfCycle))
      )
    );
    budgets.set(intentClass.key, 0);
  }

  let allocated = 0;
  const targetDistinctClasses = Math.min(3, totalRunSlots, activeClasses.length);

  const hasExploration = (executableByClass.get("exploration")?.length ?? 0) > 0;
  const hasMaintenance = (executableByClass.get("maintenance")?.length ?? 0) > 0;
  const hasGrowth = (executableByClass.get("growth")?.length ?? 0) > 0;
  const growthScore = classBudgetScores.get("growth") ?? 0;
  const maintenanceScore = classBudgetScores.get("maintenance") ?? 0;
  const maintenanceNeed = computeMaintenanceNeed(
    executableByClass.get("maintenance") ?? []
  );
  const shouldReserveMaintenance =
    hasMaintenance &&
    maintenanceNeed >= 0.7 &&
    (maintenanceScore >= 8 || maintenanceScore >= growthScore * 0.28);

  if (hasExploration && allocated < totalRunSlots) {
    budgets.set("exploration", Math.min((budgets.get("exploration") ?? 0) + 1, classSlotCaps.get("exploration") ?? 0));
    allocated = [...budgets.values()].reduce((sum, value) => sum + value, 0);
  }

  if (hasGrowth && allocated < totalRunSlots) {
    budgets.set("growth", Math.min((budgets.get("growth") ?? 0) + 1, classSlotCaps.get("growth") ?? 0));
    allocated = [...budgets.values()].reduce((sum, value) => sum + value, 0);
  }

  if (shouldReserveMaintenance && allocated < totalRunSlots) {
    budgets.set(
      "maintenance",
      Math.min((budgets.get("maintenance") ?? 0) + 1, classSlotCaps.get("maintenance") ?? 0)
    );
    allocated = [...budgets.values()].reduce((sum, value) => sum + value, 0);
  }

  while (
    allocated < Math.min(targetDistinctClasses, totalRunSlots) &&
    [...activeClasses].some(
      (intentClass) =>
        (budgets.get(intentClass.key) ?? 0) === 0 &&
        (classSlotCaps.get(intentClass.key) ?? 0) > 0
    )
  ) {
    const nextDistinctClass = activeClasses
      .filter(
        (intentClass) =>
          (budgets.get(intentClass.key) ?? 0) === 0 &&
          (classSlotCaps.get(intentClass.key) ?? 0) > 0
      )
      .sort(
        (left, right) =>
          (classBudgetScores.get(right.key) ?? 0) -
          (classBudgetScores.get(left.key) ?? 0)
      )[0];

    if (!nextDistinctClass) break;
    budgets.set(nextDistinctClass.key, 1);
    allocated += 1;
  }

  while (allocated < totalRunSlots) {
    const nextClass = activeClasses
      .filter(
        (intentClass) =>
          (budgets.get(intentClass.key) ?? 0) <
          (classSlotCaps.get(intentClass.key) ?? 0)
      )
      .map((intentClass) => ({
        intentClass,
        adjustedScore: computeAdaptiveIntentClassAllocationScore({
          intentClass: intentClass.key,
          baseScore: classBudgetScores.get(intentClass.key) ?? 0,
          allocatedSlots: budgets.get(intentClass.key) ?? 0,
          growthScore,
          maintenanceScore,
          maintenanceNeed,
          shouldReserveMaintenance,
        }),
      }))
      .sort((left, right) => right.adjustedScore - left.adjustedScore)[0];

    if (!nextClass || nextClass.adjustedScore <= 0) break;
    budgets.set(
      nextClass.intentClass.key,
      (budgets.get(nextClass.intentClass.key) ?? 0) + 1
    );
    allocated += 1;
  }

  for (const intentClass of INTENT_CLASS_CONFIGS) {
    if (!budgets.has(intentClass.key)) budgets.set(intentClass.key, 0);
    if (!classBudgetScores.has(intentClass.key)) classBudgetScores.set(intentClass.key, 0);
    if (!classSlotCaps.has(intentClass.key)) classSlotCaps.set(intentClass.key, 0);
  }

  return {
    budgets,
    classBudgetScores,
    classSlotCaps,
    targetDistinctClasses,
  };
}

function selectPortfolioTargets({
  executableTargets,
  laneSlotCaps,
  classBudgets,
  totalRunSlots,
}: {
  executableTargets: PlannedTarget[];
  laneSlotCaps: Map<string, number>;
  classBudgets: Map<TargetIntentClass, number>;
  totalRunSlots: number;
}) {
  const selectedTargets: PlannedTarget[] = [];
  const selectedKeys = new Set<string>();
  const laneAllocations = new Map<string, number>();
  const classAllocations = new Map<TargetIntentClass, number>();

  const classQueue = buildIntentClassQueue(classBudgets);

  for (const intentClass of classQueue) {
    const candidate = pickBestPortfolioCandidate({
      executableTargets,
      selectedKeys,
      laneAllocations,
      classAllocations,
      laneSlotCaps,
      intentClass,
      classBudgets,
      allowClassOverflow: false,
    });
    if (!candidate) continue;
    selectedTargets.push(candidate);
    selectedKeys.add(candidate.target.key);
    laneAllocations.set(
      candidate.lane.key,
      (laneAllocations.get(candidate.lane.key) ?? 0) + 1
    );
    classAllocations.set(
      candidate.intentClass,
      (classAllocations.get(candidate.intentClass) ?? 0) + 1
    );
  }

  while (selectedTargets.length < totalRunSlots) {
    const candidate = pickBestPortfolioCandidate({
      executableTargets,
      selectedKeys,
      laneAllocations,
      classAllocations,
      laneSlotCaps,
      classBudgets,
      allowClassOverflow: false,
    }) ?? pickBestPortfolioCandidate({
      executableTargets,
      selectedKeys,
      laneAllocations,
      classAllocations,
      laneSlotCaps,
      classBudgets,
      allowClassOverflow: true,
    });

    if (!candidate) break;
    selectedTargets.push(candidate);
    selectedKeys.add(candidate.target.key);
    laneAllocations.set(
      candidate.lane.key,
      (laneAllocations.get(candidate.lane.key) ?? 0) + 1
    );
    classAllocations.set(
      candidate.intentClass,
      (classAllocations.get(candidate.intentClass) ?? 0) + 1
    );
  }

  return {
    selectedTargets,
    laneAllocations,
    classAllocations,
  };
}

function buildIntentClassQueue(classBudgets: Map<TargetIntentClass, number>) {
  const queue: TargetIntentClass[] = [];
  const remaining = new Map(classBudgets);
  const classOrder = INTENT_CLASS_CONFIGS.map((intentClass) => intentClass.key);

  while ([...remaining.values()].some((value) => value > 0)) {
    for (const intentClass of classOrder) {
      const slots = remaining.get(intentClass) ?? 0;
      if (slots <= 0) continue;
      queue.push(intentClass);
      remaining.set(intentClass, slots - 1);
    }
  }

  return queue;
}

function pickBestPortfolioCandidate({
  executableTargets,
  selectedKeys,
  laneAllocations,
  classAllocations,
  laneSlotCaps,
  intentClass,
  classBudgets,
  allowClassOverflow,
}: {
  executableTargets: PlannedTarget[];
  selectedKeys: Set<string>;
  laneAllocations: Map<string, number>;
  classAllocations: Map<TargetIntentClass, number>;
  laneSlotCaps: Map<string, number>;
  intentClass?: TargetIntentClass;
  classBudgets: Map<TargetIntentClass, number>;
  allowClassOverflow: boolean;
}) {
  return executableTargets
    .filter((target) => {
      if (selectedKeys.has(target.target.key)) return false;
      if (intentClass && target.intentClass !== intentClass) return false;
      const laneCap = laneSlotCaps.get(target.lane.key) ?? 0;
      if ((laneAllocations.get(target.lane.key) ?? 0) >= laneCap) return false;
      if (!allowClassOverflow) {
        const classBudget = classBudgets.get(target.intentClass) ?? 0;
        if ((classAllocations.get(target.intentClass) ?? 0) >= classBudget) {
          return false;
        }
      }
      return true;
    })
    .map((target) => ({
      target,
      adjustedScore: computePortfolioAdjustedScore(
        target,
        laneAllocations.get(target.lane.key) ?? 0,
        classAllocations.get(target.intentClass) ?? 0,
        classBudgets.get(target.intentClass) ?? 0,
        allowClassOverflow
      ),
    }))
    .sort((left, right) => right.adjustedScore - left.adjustedScore)[0]?.target;
}

function computePortfolioAdjustedScore(
  target: PlannedTarget,
  allocatedLaneSlots: number,
  allocatedClassSlots: number,
  classBudget: number,
  allowClassOverflow: boolean
) {
  const lanePenalty = Math.pow(allocatedLaneSlots + 1, 0.9);
  const classPenalty =
    !allowClassOverflow || allocatedClassSlots < classBudget
      ? Math.pow(allocatedClassSlots + 1, 0.55)
      : 1.6 + (allocatedClassSlots - classBudget + 1) * 0.6;

  return target.selectionScore / (lanePenalty * classPenalty);
}

function buildTargetPerformanceSnapshot(
  recentRuns: LastRunSnapshot[]
): TargetPerformanceSnapshot {
  const successRuns = recentRuns.filter((run) => run.status === "SUCCESS");
  const recentRuntimeCapFailures = recentRuns.filter(
    (run) =>
      run.status === "FAILED" &&
      run.errorSummary?.includes("Runtime budget exceeded")
  ).length;

  return {
    recentRunCount: recentRuns.length,
    successRunCount: successRuns.length,
    recentRuntimeCapFailures,
    averageCreatedCount: average(
      successRuns.map((run) => run.canonicalCreatedCount)
    ),
    averageCreatedPerFetch: average(
      successRuns.map((run) =>
        run.fetchedCount > 0 ? run.canonicalCreatedCount / run.fetchedCount : 0
      )
    ),
    averageCreatedPerMinute: average(
      successRuns.map((run) =>
        run.runtimeMs && run.runtimeMs > 0
          ? run.canonicalCreatedCount / (run.runtimeMs / 60000)
          : 0
      )
    ),
    averageOverlapRatio: average(
      successRuns.map((run) =>
        run.acceptedCount > 0
          ? clamp(run.canonicalUpdatedCount / run.acceptedCount, 0, 1)
          : 0
      )
    ),
    averageAcceptedCanadaRatio: average(
      successRuns
        .filter((run) => run.acceptedCanadaCount !== null)
        .map((run) =>
          run.acceptedCount > 0 && run.acceptedCanadaCount !== null
            ? clamp(run.acceptedCanadaCount / run.acceptedCount, 0, 1)
            : 0
        )
    ),
    averageCreatedCanadaRatio: average(
      successRuns
        .filter((run) => run.canonicalCreatedCanadaCount !== null)
        .map((run) =>
          run.canonicalCreatedCount > 0 && run.canonicalCreatedCanadaCount !== null
            ? clamp(run.canonicalCreatedCanadaCount / run.canonicalCreatedCount, 0, 1)
            : 0
        )
    ),
    averageCreatedCanadaRemoteRatio: average(
      successRuns
        .filter((run) => run.canonicalCreatedCanadaRemoteCount !== null)
        .map((run) =>
          run.canonicalCreatedCount > 0 &&
          run.canonicalCreatedCanadaRemoteCount !== null
            ? clamp(
                run.canonicalCreatedCanadaRemoteCount / run.canonicalCreatedCount,
                0,
                1
              )
            : 0
        )
    ),
    averageRuntimeMs: averageNullable(
      successRuns.map((run) => run.runtimeMs)
    ),
    latestCreatedCount: recentRuns[0]?.canonicalCreatedCount ?? 0,
    latestCreatedCanadaCount: recentRuns[0]?.canonicalCreatedCanadaCount ?? 0,
  };
}

function computeTargetSelectionScore(
  target: LaneTargetConfig,
  performance: TargetPerformanceSnapshot,
  marginalSignal: MarginalSignal
) {
  const fetchYield = clamp(performance.averageCreatedPerFetch / 0.12, 0, 1.5);
  const minuteYield = clamp(performance.averageCreatedPerMinute / 40, 0, 1.5);
  const predictedYield = clamp(
    marginalSignal.predictedNextChunkCreated /
      Math.max(target.minCreatedToRepeat ?? 8, 8),
    0,
    1.5
  );
  const overlapPenalty = performance.averageOverlapRatio * 0.75;
  const runtimePenalty = performance.recentRuntimeCapFailures * 0.5;
  const recentCreateBonus = performance.latestCreatedCount > 0 ? 0.25 : 0;
  const recentCanadaBonus = performance.latestCreatedCanadaCount > 0 ? 0.15 : 0;
  const marginalGrowthBonus =
    marginalSignal.growthDebtScore * 0.75 + predictedYield * 0.9;
  const freshnessBonus = marginalSignal.freshnessDebtScore * 0.2;
  const marginalDecayPenalty =
    marginalSignal.latestOverlapRatio > 0.85 &&
    marginalSignal.latestCreatedPerFetch < 0.03
      ? 0.6
      : 0;
  const hardMarginalPenalty =
    marginalSignal.predictedNextChunkCreated === 0 &&
    marginalSignal.growthDebtScore < 0.15
      ? 1.1
      : marginalSignal.predictedNextChunkCreated < 3 &&
          marginalSignal.growthDebtScore < 0.25
        ? 0.55
        : 0;
  const canadaValueBonus =
    performance.averageCreatedCanadaRatio * 0.9 +
    performance.averageCreatedCanadaRemoteRatio * 0.4 +
    performance.averageAcceptedCanadaRatio * 0.35;
  const lowCanadaPenalty =
    performance.successRunCount > 0
      ? clamp((0.25 - performance.averageAcceptedCanadaRatio) * 0.35, 0, 0.2)
      : 0;
  const multiplier = clamp(
    0.45 +
      fetchYield * 0.65 +
      minuteYield * 0.45 +
      recentCreateBonus +
      recentCanadaBonus +
      marginalGrowthBonus +
      freshnessBonus +
      canadaValueBonus -
      overlapPenalty -
      runtimePenalty -
      lowCanadaPenalty -
      marginalDecayPenalty -
      hardMarginalPenalty,
    0.1,
    3
  );

  return target.segmentWeight * multiplier;
}

function deriveEffectiveMaxRuntimeMs(
  target: LaneTargetConfig,
  performance: TargetPerformanceSnapshot,
  marginalSignal: MarginalSignal
) {
  if (typeof target.maxRuntimeMs !== "number") return null;
  if (typeof performance.averageRuntimeMs !== "number") return target.maxRuntimeMs;

  const floorMs = 15000;
  let adaptiveCap = Math.max(
    floorMs,
    Math.round(performance.averageRuntimeMs * 1.75)
  );
  adaptiveCap = Math.min(adaptiveCap, target.maxRuntimeMs);

  if (performance.recentRuntimeCapFailures > 0) {
    adaptiveCap = Math.min(
      adaptiveCap,
      Math.max(floorMs, Math.round(target.maxRuntimeMs * 0.85))
    );
  }

  if (marginalSignal.growthDebtScore < 0.35) {
    adaptiveCap = Math.max(floorMs, Math.round(adaptiveCap * 0.6));
  } else if (marginalSignal.growthDebtScore > 0.85) {
    adaptiveCap = Math.min(target.maxRuntimeMs, Math.round(adaptiveCap * 1.15));
  }

  return adaptiveCap;
}

function deriveEffectiveLimit(
  target: LaneTargetConfig,
  performance: TargetPerformanceSnapshot,
  marginalSignal: MarginalSignal
) {
  let effectiveLimit = target.limit;

  if (marginalSignal.growthDebtScore < 0.2) {
    effectiveLimit = Math.max(25, Math.round(effectiveLimit * 0.25));
  } else if (marginalSignal.growthDebtScore < 0.4) {
    effectiveLimit = Math.max(25, Math.round(effectiveLimit * 0.45));
  } else if (
    performance.latestCreatedCount === 0 &&
    performance.averageOverlapRatio > 0.75
  ) {
    effectiveLimit = Math.max(25, Math.round(effectiveLimit * 0.5));
  } else if (
    performance.averageCreatedPerFetch < 0.05 &&
    performance.averageOverlapRatio > 0.6
  ) {
    effectiveLimit = Math.max(25, Math.round(effectiveLimit * 0.7));
  } else if (
    performance.averageCreatedPerFetch > 0.12 &&
    performance.averageOverlapRatio < 0.45
  ) {
    effectiveLimit = target.limit;
  }

  if (performance.recentRuntimeCapFailures > 0) {
    effectiveLimit = Math.max(25, Math.round(effectiveLimit * 0.8));
  }

  if (marginalSignal.growthDebtScore > 0.9 && marginalSignal.latestCreatedPerFetch > 0.08) {
    effectiveLimit = target.limit;
  }

  return effectiveLimit;
}

function computeLaneBudgetScore(lane: LaneConfig, plannedTargets: PlannedTarget[]) {
  if (plannedTargets.length === 0) return 0;

  const topScores = plannedTargets
    .map((plannedTarget) => plannedTarget.selectionScore)
    .sort((left, right) => right - left)
    .slice(0, lane.maxRunsPerCycle);

  return lane.weight * average(topScores);
}

function computeIntentClassBudgetScore(plannedTargets: PlannedTarget[]) {
  if (plannedTargets.length === 0) return 0;

  const topScores = plannedTargets
    .map((plannedTarget) => plannedTarget.selectionScore)
    .sort((left, right) => right - left)
    .slice(0, 3);

  return average(topScores);
}

function computeLaneAllocationScore(baseScore: number, allocatedSlots: number) {
  if (baseScore <= 0) return 0;
  const diversityPenalty = Math.pow(allocatedSlots + 1, 0.9);
  return baseScore / diversityPenalty;
}

function classifyTargetIntent(
  target: LaneTargetConfig,
  performance: TargetPerformanceSnapshot,
  lastRun: LastRunSnapshot | null,
  marginalSignal: MarginalSignal
): TargetIntentClass {
  if (!lastRun || performance.successRunCount <= 1 || performance.recentRunCount <= 1) {
    return "exploration";
  }

  if (marginalSignal.growthDebtScore >= 0.7) {
    return "growth";
  }

  if (marginalSignal.growthDebtScore <= 0.18) {
    return marginalSignal.freshnessDebtScore >= 0.35 ? "maintenance" : "maintenance";
  }

  if (marginalSignal.growthDebtScore <= 0.25 && marginalSignal.freshnessDebtScore >= 0.45) {
    return "maintenance";
  }

  const strongGrowthSignal =
    performance.latestCreatedCount >= Math.max(12, target.minCreatedToRepeat ?? 8) ||
    (performance.averageCreatedPerFetch >= 0.05 &&
      performance.averageCreatedCount >= Math.max(6, Math.round((target.minCreatedToRepeat ?? 8) * 0.5)));
  if (strongGrowthSignal) {
    return "growth";
  }

  const lowYieldThreshold = Math.max(3, Math.round((target.minCreatedToRepeat ?? 8) * 0.35));
  const looksLikeMaintenance =
    performance.latestCreatedCount === 0 ||
    performance.averageOverlapRatio >= 0.7 ||
    performance.averageCreatedPerFetch < 0.03 ||
    performance.averageCreatedCount < lowYieldThreshold;

  if (looksLikeMaintenance) {
    return "maintenance";
  }

  return "growth";
}

function computeMaintenanceNeed(plannedTargets: PlannedTarget[]) {
  if (plannedTargets.length === 0) return 0;

  return Math.max(
    ...plannedTargets.map((target) => {
      const minutesSinceLastRun = target.lastRun?.startedAt
        ? (Date.now() - new Date(target.lastRun.startedAt).getTime()) / (1000 * 60)
        : target.target.cooldownMinutes;
      const freshnessPressure = clamp(
        minutesSinceLastRun / Math.max(target.target.cooldownMinutes, 60),
        0,
        2
      );
      const overlapPressure = target.performance.averageOverlapRatio;
      const updatePressure =
        target.performance.successRunCount > 0 &&
        target.performance.averageCreatedPerFetch < 0.04
          ? 0.35
          : 0;
      return freshnessPressure * 0.6 + overlapPressure * 0.5 + updatePressure;
    })
  );
}

function buildMarginalSignal(
  target: LaneTargetConfig,
  performance: TargetPerformanceSnapshot,
  lastRun: LastRunSnapshot | null,
  now: Date
): MarginalSignal {
  const latestCreatedPerFetch =
    lastRun && lastRun.fetchedCount > 0
      ? lastRun.canonicalCreatedCount / lastRun.fetchedCount
      : performance.averageCreatedPerFetch;
  const latestCreatedPerMinute =
    lastRun?.runtimeMs && lastRun.runtimeMs > 0
      ? lastRun.canonicalCreatedCount / (lastRun.runtimeMs / 60000)
      : performance.averageCreatedPerMinute;
  const latestOverlapRatio =
    lastRun && lastRun.acceptedCount > 0
      ? clamp(lastRun.canonicalUpdatedCount / lastRun.acceptedCount, 0, 1)
      : performance.averageOverlapRatio;
  const latestAcceptedCanadaRatio =
    lastRun && lastRun.acceptedCount > 0 && lastRun.acceptedCanadaCount !== null
      ? clamp(lastRun.acceptedCanadaCount / lastRun.acceptedCount, 0, 1)
      : performance.averageAcceptedCanadaRatio;
  const latestCreatedCanadaRatio =
    lastRun &&
    lastRun.canonicalCreatedCount > 0 &&
    lastRun.canonicalCreatedCanadaCount !== null
      ? clamp(
          lastRun.canonicalCreatedCanadaCount / lastRun.canonicalCreatedCount,
          0,
          1
        )
      : performance.averageCreatedCanadaRatio;
  const checkpointDepthRatio = lastRun?.checkpointDepthRatio ?? null;
  const checkpointExhausted = lastRun?.checkpointExhausted ?? false;
  const minutesSinceLastRun = lastRun?.startedAt
    ? (now.getTime() - new Date(lastRun.startedAt).getTime()) / (1000 * 60)
    : target.cooldownMinutes;
  const freshnessDebtScore = clamp(
    minutesSinceLastRun / Math.max(target.cooldownMinutes, 60),
    0,
    1.5
  );
  const decayPenalty = checkpointDepthRatio === null ? 0.9 : 1 - checkpointDepthRatio * 0.7;
  const overlapPenalty = 1 - latestOverlapRatio * 0.85;
  const canadaBoost = 0.7 + latestCreatedCanadaRatio * 0.45 + latestAcceptedCanadaRatio * 0.2;
  const speedBoost = clamp(latestCreatedPerMinute / 40, 0.2, 1.4);
  const rawPrediction =
    latestCreatedPerFetch *
    Math.max(lastRun?.effectiveLimit ?? target.limit, 25) *
    decayPenalty *
    overlapPenalty *
    canadaBoost *
    speedBoost;
  const predictedNextChunkCreated = Math.max(0, Math.round(rawPrediction));

  let growthDebtScore = clamp(
    predictedNextChunkCreated / Math.max(target.minCreatedToRepeat ?? 8, 8),
    0,
    1.5
  );

  if (checkpointExhausted) {
    growthDebtScore *= 0.35;
  }
  if (latestOverlapRatio > 0.9 && latestCreatedPerFetch < 0.02) {
    growthDebtScore *= 0.2;
  }
  if (lastRun && lastRun.canonicalCreatedCount >= (target.minCreatedToRepeat ?? 8)) {
    growthDebtScore = Math.max(growthDebtScore, 0.75);
  }

  return {
    latestCreatedPerFetch,
    latestCreatedPerMinute,
    latestOverlapRatio,
    latestCreatedCanadaRatio,
    latestAcceptedCanadaRatio,
    checkpointDepthRatio,
    checkpointExhausted,
    predictedNextChunkCreated,
    growthDebtScore,
    freshnessDebtScore,
  };
}

function estimateCheckpointDepthRatio(
  connectorKey: string,
  checkpoint: unknown
): number | null {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return null;
  }
  const record = checkpoint as Record<string, unknown>;

  if (connectorKey.startsWith("adzuna:")) {
    const states = Array.isArray(record.categoryStates)
      ? record.categoryStates
      : null;
    if (!states || states.length === 0) return null;
    const progress = states
      .filter((state): state is Record<string, unknown> => Boolean(state) && typeof state === "object" && !Array.isArray(state))
      .map((state) => {
        if (state.exhausted === true) return 1;
        const page = typeof state.page === "number" ? state.page : 1;
        return clamp(page / 20, 0, 1);
      });
    return progress.length > 0 ? average(progress) : null;
  }

  if (connectorKey.startsWith("themuse:")) {
    const categoryIndex = typeof record.categoryIndex === "number" ? record.categoryIndex : 0;
    const page = typeof record.page === "number" ? record.page : 0;
    const totalPositions = 10 * 50;
    return clamp((categoryIndex * 50 + page) / totalPositions, 0, 1);
  }

  if (connectorKey.startsWith("workday:")) {
    const offset = typeof record.offset === "number" ? record.offset : null;
    if (offset === null) return null;
    return clamp(offset / 240, 0, 1);
  }

  return null;
}

function computeAdaptiveIntentClassAllocationScore({
  intentClass,
  baseScore,
  allocatedSlots,
  growthScore,
  maintenanceScore,
  maintenanceNeed,
  shouldReserveMaintenance,
}: {
  intentClass: TargetIntentClass;
  baseScore: number;
  allocatedSlots: number;
  growthScore: number;
  maintenanceScore: number;
  maintenanceNeed: number;
  shouldReserveMaintenance: boolean;
}) {
  if (baseScore <= 0) return 0;

  let adjustedScore = computeLaneAllocationScore(baseScore, allocatedSlots);

  if (intentClass === "growth") {
    const dominanceBoost =
      growthScore > maintenanceScore * 1.25 ? 1.3 : growthScore > maintenanceScore ? 1.15 : 1;
    adjustedScore *= dominanceBoost;
  }

  if (intentClass === "maintenance") {
    if (!shouldReserveMaintenance && allocatedSlots >= 1) {
      adjustedScore *= 0.4;
    } else if (maintenanceNeed < 0.9) {
      adjustedScore *= 0.75;
    }
  }

  if (intentClass === "exploration") {
    adjustedScore *= allocatedSlots === 0 ? 1.15 : 0.85;
  }

  return adjustedScore;
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageNullable(values: Array<number | null>) {
  const numbers = values.filter((value): value is number => typeof value === "number");
  if (numbers.length === 0) return null;
  return average(numbers);
}

function asJsonObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getMetricCount(
  metrics: Record<string, unknown> | null,
  key: string
) {
  if (!metrics || !(key in metrics)) return null;
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function roundSelectionScore(value: number) {
  return Math.round(value * 100) / 100;
}

function buildFairTaskQueue(selectedByLane: Map<string, PlannedTarget[]>) {
  const laneQueues = new Map(
    [...selectedByLane.entries()].map(([laneKey, tasks]) => [laneKey, [...tasks]])
  );
  const laneOrder = ORCHESTRATION_LANES.map((lane) => lane.key);
  const queue: PlannedTarget[] = [];

  while (
    [...laneQueues.values()].some((tasks) => Array.isArray(tasks) && tasks.length > 0)
  ) {
    for (const laneKey of laneOrder) {
      const tasks = laneQueues.get(laneKey);
      if (!tasks || tasks.length === 0) continue;
      const nextTask = tasks.shift();
      if (nextTask) queue.push(nextTask);
    }
  }

  return queue;
}

async function executeTaskQueue({
  queue,
  cycleStartedAt,
  maxConcurrentTasks,
  onTaskCompleted,
  onTaskFailed,
}: {
  queue: PlannedTarget[];
  cycleStartedAt: Date;
  maxConcurrentTasks: number;
  onTaskCompleted: (
    task: PlannedTarget,
    summary: IngestionSummary,
    runtimeMs: number | null
  ) => void;
  onTaskFailed: (
    task: PlannedTarget,
    failedRun: LastRunSnapshot | null,
    runtimeMs: number | null,
    errorSummary: string
  ) => void;
}) {
  const pending = [...queue];
  const active = new Set<Promise<void>>();
  const activeByLane = new Map<string, number>();

  while (pending.length > 0 || active.size > 0) {
    while (active.size < maxConcurrentTasks) {
      const nextIndex = pending.findIndex((task) => {
        const laneActiveCount = activeByLane.get(task.lane.key) ?? 0;
        return laneActiveCount < task.lane.maxConcurrentTasks;
      });

      if (nextIndex === -1) break;

      const [task] = pending.splice(nextIndex, 1);
      activeByLane.set(task.lane.key, (activeByLane.get(task.lane.key) ?? 0) + 1);

      const taskPromise = executeQueuedTask(task, cycleStartedAt)
        .then((result) => {
          if (result.kind === "success") {
            onTaskCompleted(task, result.summary, result.runtimeMs);
            return;
          }

          onTaskFailed(
            task,
            result.failedRun,
            result.runtimeMs,
            result.errorSummary
          );
        })
        .finally(() => {
          active.delete(taskPromise);
          activeByLane.set(
            task.lane.key,
            Math.max((activeByLane.get(task.lane.key) ?? 1) - 1, 0)
          );
        });

      active.add(taskPromise);
    }

    if (active.size === 0) break;
    await Promise.race(active);
  }
}

async function executeQueuedTask(task: PlannedTarget, cycleStartedAt: Date) {
  try {
    const summary = await ingestConnector(task.connector, {
      limit: task.effectiveLimit,
      maxRuntimeMs: task.effectiveMaxRuntimeMs ?? undefined,
      runMode: "SCHEDULED",
      allowOverlappingRuns: false,
      triggerLabel: `orchestrator.${task.lane.key}.${task.target.segmentKey}`,
      runMetadata: {
        cycleStartedAt: cycleStartedAt.toISOString(),
        laneKey: task.lane.key,
        targetKey: task.target.key,
        segmentKey: task.target.segmentKey,
        intentClass: task.intentClass,
        selectionScore: roundSelectionScore(task.selectionScore),
        effectiveLimit: task.effectiveLimit,
        maxRuntimeMs: task.effectiveMaxRuntimeMs ?? null,
        predictedCreatedCount: task.marginalSignal.predictedNextChunkCreated,
        growthDebtScore: roundSelectionScore(task.marginalSignal.growthDebtScore),
        freshnessDebtScore: roundSelectionScore(task.marginalSignal.freshnessDebtScore),
        checkpointDepthBefore:
          task.marginalSignal.checkpointDepthRatio === null
            ? null
            : roundSelectionScore(task.marginalSignal.checkpointDepthRatio),
      },
    });

    return {
      kind: "success" as const,
      summary,
      runtimeMs: await getRunRuntimeMs(summary.runId),
    };
  } catch (error) {
    const failedRun = (await loadRecentRuns(task.connector.key))[0] ?? null;
    return {
      kind: "failed" as const,
      failedRun,
      runtimeMs: failedRun?.runtimeMs ?? null,
      errorSummary:
        error instanceof Error ? error.message : String(error),
    };
  }
}

async function getRunRuntimeMs(runId: string | undefined) {
  if (!runId) return null;

  const run = await prisma.ingestionRun.findUnique({
    where: { id: runId },
    select: { startedAt: true, endedAt: true },
  });

  if (!run?.endedAt) return null;
  return Math.max(run.endedAt.getTime() - run.startedAt.getTime(), 0);
}
