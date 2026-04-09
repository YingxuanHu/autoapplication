import type {
  EmploymentType,
  ExperienceLevel,
  IngestionRunMode,
  IngestionRunStatus,
  Industry,
  Prisma,
  Region,
  SourceTier,
  SubmissionCategory,
  WorkMode,
} from "@/generated/prisma/client";

export type ConnectorFreshnessMode = "FULL_SNAPSHOT" | "INCREMENTAL";

export type SourceConnectorJob = {
  sourceId: string;
  sourceUrl: string | null;
  title: string;
  company: string;
  location: string;
  description: string;
  applyUrl: string;
  postedAt: Date | null;
  deadline: Date | null;
  employmentType: EmploymentType | null;
  workMode: WorkMode | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  metadata: Prisma.InputJsonValue;
};

export type SourceConnectorFetchOptions = {
  now: Date;
  limit?: number;
  signal?: AbortSignal;
  deadlineAt?: Date;
  maxRuntimeMs?: number;
  checkpoint?: Prisma.InputJsonValue | null;
  onCheckpoint?: (checkpoint: Prisma.InputJsonValue | null) => Promise<void> | void;
  /** Optional structured logger. Defaults to console.log inside connectors. */
  log?: (message: string) => void;
};

export type SourceConnectorFetchResult = {
  jobs: SourceConnectorJob[];
  metadata?: Prisma.InputJsonValue;
  checkpoint?: Prisma.InputJsonValue | null;
  exhausted?: boolean;
};

export type SourceConnector = {
  key: string;
  sourceName: string;
  sourceTier: SourceTier;
  freshnessMode: ConnectorFreshnessMode;
  fetchJobs(options: SourceConnectorFetchOptions): Promise<SourceConnectorFetchResult>;
};

export type NormalizedJobInput = {
  title: string;
  company: string;
  companyKey: string;
  titleKey: string;
  titleCoreKey: string;
  descriptionFingerprint: string;
  location: string;
  locationKey: string;
  /** null = geography could not be resolved to a known NA region */
  region: Region | null;
  /** UNKNOWN = work arrangement could not be confidently inferred */
  workMode: WorkMode;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  /** UNKNOWN = employment type could not be confidently inferred */
  employmentType: EmploymentType;
  /** UNKNOWN = career stage could not be confidently inferred */
  experienceLevel: ExperienceLevel;
  description: string;
  shortSummary: string;
  /** null = role did not match a known industry pattern */
  industry: Industry | null;
  /** "Unknown" when title did not match any role-family pattern */
  roleFamily: string;
  applyUrl: string;
  applyUrlKey: string | null;
  postedAt: Date;
  deadline: Date | null;
  duplicateClusterId: string;
};

export type NormalizationResult =
  | {
      kind: "accepted";
      job: NormalizedJobInput;
    }
  | {
      kind: "rejected";
      reason: string;
    };

export type EligibilityDraft = {
  submissionCategory: SubmissionCategory;
  reasonCode: string;
  reasonDescription: string;
  jobValidityConfidence: number;
  formAutomationConfidence: number;
  packageFitConfidence: number;
  submissionQualityConfidence: number;
  customizationLevel: number;
  evaluatedAt: Date;
};

export type IngestionSummary = {
  runId?: string;
  runMode: IngestionRunMode;
  status: IngestionRunStatus;
  connectorKey: string;
  sourceName: string;
  sourceTier: SourceTier;
  freshnessMode: ConnectorFreshnessMode;
  fetchedCount: number;
  /** Phase-1 broad-intake alias for acceptedCount */
  minimallyAcceptedCount: number;
  acceptedCount: number;
  acceptedCanadaCount: number;
  acceptedCanadaRemoteCount: number;
  rejectedCount: number;
  rawCreatedCount: number;
  rawUpdatedCount: number;
  canonicalCreatedCount: number;
  canonicalCreatedCanadaCount: number;
  canonicalCreatedCanadaRemoteCount: number;
  canonicalUpdatedCount: number;
  dedupedCount: number;
  sourceMappingCreatedCount: number;
  sourceMappingUpdatedCount: number;
  sourceMappingsRemovedCount: number;
  /** Phase-1 downstream visibility alias for liveCount */
  visibleLiveCount: number;
  liveCount: number;
  staleCount: number;
  expiredCount: number;
  removedCount: number;
  skippedReasons: Record<string, number>;
  checkpoint?: Prisma.InputJsonValue | null;
  checkpointExhausted?: boolean;
};

export type IngestionRunListItem = {
  id: string;
  connectorKey: string;
  sourceName: string;
  sourceTier: SourceTier;
  runMode: IngestionRunMode;
  status: IngestionRunStatus;
  startedAt: string;
  endedAt: string | null;
  fetchedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  rawCreatedCount: number;
  rawUpdatedCount: number;
  canonicalCreatedCount: number;
  canonicalUpdatedCount: number;
  dedupedCount: number;
  sourceMappingCreatedCount: number;
  sourceMappingUpdatedCount: number;
  sourceMappingsRemovedCount: number;
  liveCount: number;
  staleCount: number;
  expiredCount: number;
  removedCount: number;
  errorSummary: string | null;
};

export type IngestionSourceCoverage = {
  sourceName: string;
  rawCount: number;
  activeMappingCount: number;
  liveCanonicalCount: number;
  staleCanonicalCount: number;
  removedMappingCount: number;
  lastRunStatus: IngestionRunStatus | null;
  lastRunStartedAt: string | null;
  lastSuccessfulRunAt: string | null;
  scheduleCadenceMinutes: number | null;
  isScheduled: boolean;
};

export type IngestionOverview = {
  rawCount: number;
  canonicalCount: number;
  sourceMappingCount: number;
  liveCount: number;
  agingCount: number;
  staleCount: number;
  expiredCount: number;
  removedCount: number;
  autoEligibleCount: number;
  reviewRequiredCount: number;
  manualOnlyCount: number;
  recentRunCount: number;
  sources: IngestionSourceCoverage[];
  recentRuns: IngestionRunListItem[];
};
