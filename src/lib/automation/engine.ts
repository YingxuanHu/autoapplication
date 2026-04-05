/**
 * Auto-apply engine orchestrator.
 *
 * Coordinates the full automation flow:
 *   1. Query for eligible jobs (LIVE + AUTO_SUBMIT_READY/AUTO_FILL_REVIEW + has package)
 *   2. Resolve ATS filler per job
 *   3. Create browser context, run filler, capture results
 *   4. Record results to ApplicationSubmission
 *
 * Safety:
 *   - Rate-limited (configurable max per hour)
 *   - Never submits MANUAL_ONLY jobs
 *   - fill_and_submit only for AUTO_SUBMIT_READY + STRICT_AUTO_APPLY user mode
 *   - Screenshots captured at every stage
 *   - All errors caught and recorded, never crash the batch
 */
import { prisma } from "@/lib/db";
import { DEMO_USER_ID } from "@/lib/constants";
import { resolvePath } from "@/lib/storage";
import { createAutomationPage, disposeAutomationBrowser } from "./browser";
import { resolveATSFiller } from "./fillers";
import { ensureScreenshotDir } from "./screenshots";
import type {
  AutomationRunMode,
  ATSFillerResult,
  AutoApplyCandidate,
  AutoApplyRunResult,
  FillerProfile,
  FillerResume,
  FillerPackage,
} from "./types";

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_MAX_PER_HOUR = 10;
const DEFAULT_DELAY_BETWEEN_MS = 15_000; // 15s between applications

export type EngineOptions = {
  /** Limit to a specific job ID (single-job mode) */
  jobId?: string;
  /** Override the automation mode for all jobs */
  mode?: AutomationRunMode;
  /** Max applications per run. Default 10. */
  maxPerRun?: number;
  /** Delay between applications in ms. Default 15s. */
  delayBetweenMs?: number;
  /** Only process jobs from these ATS types */
  atsFilter?: string[];
  /** Log function */
  log?: (message: string) => void;
};

// ─── Main entry point ────────────────────────────────────────────────────────

export async function runAutoApply(options: EngineOptions = {}): Promise<AutoApplyRunResult[]> {
  const {
    jobId,
    mode: modeOverride,
    maxPerRun = DEFAULT_MAX_PER_HOUR,
    delayBetweenMs = DEFAULT_DELAY_BETWEEN_MS,
    log = console.log,
  } = options;

  const results: AutoApplyRunResult[] = [];

  try {
    // ─── Load user profile ─────────────────────────────────────────
    const profile = await loadProfile();
    if (!profile) {
      log("ERROR: No user profile found. Cannot proceed.");
      return [];
    }

    // ─── Get candidates ────────────────────────────────────────────
    const candidates = jobId
      ? await getSingleCandidate(jobId)
      : await getEligibleCandidates(maxPerRun);

    if (candidates.length === 0) {
      log("No eligible candidates found.");
      return [];
    }

    log(`Found ${candidates.length} candidate(s) for automation.`);

    // ─── Process each candidate ────────────────────────────────────
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];

      // Resolve ATS filler
      const filler = resolveATSFiller(candidate.applyUrl);
      if (!filler) {
        log(`  [${i + 1}/${candidates.length}] ${candidate.company} — ${candidate.jobTitle}: No filler for URL, skipping.`);
        results.push({ jobId: candidate.jobId, fillerResult: null, error: "No ATS filler for this URL" });
        continue;
      }

      // Skip if ATS filter is set and doesn't match
      if (options.atsFilter && !options.atsFilter.includes(filler.atsName.toLowerCase())) {
        continue;
      }

      // Determine run mode
      const runMode = modeOverride ?? resolveRunMode(candidate.submissionCategory, profile.automationMode);

      log(`  [${i + 1}/${candidates.length}] ${filler.atsName} | ${candidate.company} — ${candidate.jobTitle} | mode=${runMode}`);

      // Run the filler
      const result = await runSingleJob(candidate, filler, profile, runMode, log);
      results.push(result);

      // Record result to database
      await recordAutomationResult(candidate, result, runMode);

      // Rate limiting delay
      if (i < candidates.length - 1) {
        log(`  Waiting ${delayBetweenMs / 1000}s before next...`);
        await sleep(delayBetweenMs);
      }
    }
  } finally {
    await disposeAutomationBrowser();
  }

  // ─── Summary ─────────────────────────────────────────────────────
  const submitted = results.filter((r) => r.fillerResult?.status === "submitted").length;
  const filled = results.filter((r) => r.fillerResult?.status === "filled").length;
  const failed = results.filter((r) => r.fillerResult?.status === "failed" || r.error).length;
  const blocked = results.filter((r) => r.fillerResult?.status === "blocked").length;

  log(`\nRun complete: ${submitted} submitted, ${filled} filled, ${blocked} blocked, ${failed} failed.`);

  return results;
}

// ─── Single job runner ───────────────────────────────────────────────────────

async function runSingleJob(
  candidate: AutoApplyCandidate,
  filler: ReturnType<typeof resolveATSFiller> & {},
  profile: ProfileData,
  mode: AutomationRunMode,
  log: (msg: string) => void
): Promise<AutoApplyRunResult> {
  const automationPage = await createAutomationPage();

  try {
    const screenshotDir = ensureScreenshotDir(candidate.jobId);

    const fillerProfile = buildFillerProfile(profile);
    const fillerResume = await buildFillerResume(profile);
    const fillerPackage = await buildFillerPackage(candidate.packageId);

    const result = await filler.fill({
      page: automationPage.page,
      applyUrl: candidate.applyUrl,
      jobTitle: candidate.jobTitle,
      company: candidate.company,
      profile: fillerProfile,
      resume: fillerResume,
      applicationPackage: fillerPackage,
      mode,
      screenshotDir,
    });

    log(`    → ${result.status} | ${result.filledFields.length} filled, ${result.unfillableFields.length} unfillable, ${result.blockers.length} blockers | ${result.durationMs}ms`);

    if (result.blockers.length > 0) {
      for (const b of result.blockers) {
        log(`    → Blocker: [${b.type}] ${b.detail}`);
      }
    }

    return { jobId: candidate.jobId, fillerResult: result, error: null };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`    → ERROR: ${msg}`);
    return { jobId: candidate.jobId, fillerResult: null, error: msg };
  } finally {
    await automationPage.dispose();
  }
}

// ─── Mode resolution ─────────────────────────────────────────────────────────

function resolveRunMode(
  submissionCategory: string,
  userAutomationMode: string
): AutomationRunMode {
  // Never auto-submit unless both the job and user settings allow it
  if (
    submissionCategory === "AUTO_SUBMIT_READY" &&
    userAutomationMode === "STRICT_AUTO_APPLY"
  ) {
    return "fill_and_submit";
  }

  if (
    submissionCategory === "AUTO_SUBMIT_READY" &&
    userAutomationMode === "REVIEW_BEFORE_SUBMIT"
  ) {
    return "fill_only";
  }

  if (submissionCategory === "AUTO_FILL_REVIEW") {
    return "fill_only";
  }

  // DISCOVERY_ONLY or ASSIST → dry run only
  return "dry_run";
}

// ─── Database queries ────────────────────────────────────────────────────────

type ProfileData = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  workAuthorization: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  automationMode: string;
  resumeVariants: Array<{
    id: string;
    label: string;
    fileUrl: string | null;
    content: string | null;
    isDefault: boolean;
    targetRoleFamily: string | null;
    document: { storageKey: string } | null;
  }>;
};

async function loadProfile(): Promise<ProfileData | null> {
  return prisma.userProfile.findUnique({
    where: { id: DEMO_USER_ID },
    include: {
      resumeVariants: {
        orderBy: { createdAt: "desc" },
        include: { document: { select: { storageKey: true } } },
      },
    },
  });
}

async function getEligibleCandidates(limit: number): Promise<AutoApplyCandidate[]> {
  // Find jobs that:
  //   1. Are LIVE
  //   2. Have AUTO_SUBMIT_READY or AUTO_FILL_REVIEW eligibility
  //   3. Have an ApplicationPackage prepared
  //   4. Do NOT already have a SUBMITTED/CONFIRMED submission
  //   5. Have an applyUrl pointing to a supported ATS
  const jobs = await prisma.jobCanonical.findMany({
    where: {
      status: "LIVE",
      eligibility: {
        submissionCategory: { in: ["AUTO_SUBMIT_READY", "AUTO_FILL_REVIEW"] },
      },
      applicationPackages: {
        some: { userId: DEMO_USER_ID },
      },
      applicationSubmissions: {
        none: {
          userId: DEMO_USER_ID,
          status: { in: ["SUBMITTED", "CONFIRMED"] },
        },
      },
    },
    select: {
      id: true,
      title: true,
      company: true,
      applyUrl: true,
      eligibility: { select: { submissionCategory: true } },
      applicationPackages: {
        where: { userId: DEMO_USER_ID },
        orderBy: { updatedAt: "desc" },
        take: 1,
        select: { id: true },
      },
      applicationSubmissions: {
        where: { userId: DEMO_USER_ID },
        orderBy: { updatedAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
    orderBy: { postedAt: "desc" },
    take: limit,
  });

  return jobs
    .filter((j) => j.eligibility && j.applicationPackages.length > 0)
    .map((j) => ({
      jobId: j.id,
      jobTitle: j.title,
      company: j.company,
      applyUrl: j.applyUrl,
      submissionCategory: j.eligibility!.submissionCategory,
      packageId: j.applicationPackages[0].id,
      submissionId: j.applicationSubmissions[0]?.id ?? null,
    }));
}

async function getSingleCandidate(jobId: string): Promise<AutoApplyCandidate[]> {
  const job = await prisma.jobCanonical.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      title: true,
      company: true,
      applyUrl: true,
      status: true,
      eligibility: { select: { submissionCategory: true } },
      applicationPackages: {
        where: { userId: DEMO_USER_ID },
        orderBy: { updatedAt: "desc" },
        take: 1,
        select: { id: true },
      },
      applicationSubmissions: {
        where: { userId: DEMO_USER_ID },
        orderBy: { updatedAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
  });

  if (!job) return [];

  // For single-job mode, allow even without a package (we'll still do dry_run)
  return [
    {
      jobId: job.id,
      jobTitle: job.title,
      company: job.company,
      applyUrl: job.applyUrl,
      submissionCategory: job.eligibility?.submissionCategory ?? "MANUAL_ONLY",
      packageId: job.applicationPackages[0]?.id ?? "",
      submissionId: job.applicationSubmissions[0]?.id ?? null,
    },
  ];
}

// ─── Profile → Filler data mappers ──────────────────────────────────────────

function buildFillerProfile(profile: ProfileData): FillerProfile {
  const nameParts = profile.name.split(/\s+/);
  return {
    firstName: nameParts[0] ?? "",
    lastName: nameParts.slice(1).join(" ") || (nameParts[0] ?? ""),
    email: profile.email,
    phone: profile.phone,
    linkedinUrl: profile.linkedinUrl,
    githubUrl: profile.githubUrl,
    portfolioUrl: profile.portfolioUrl,
    workAuthorization: profile.workAuthorization,
    salaryMin: profile.salaryMin,
    salaryMax: profile.salaryMax,
    salaryCurrency: profile.salaryCurrency,
  };
}

async function buildFillerResume(profile: ProfileData): Promise<FillerResume> {
  const defaultResume =
    profile.resumeVariants.find((r) => r.isDefault) ??
    profile.resumeVariants[0] ??
    null;

  if (!defaultResume) {
    return { label: "None", filePath: null, content: null };
  }

  // Prefer uploaded document file, fall back to legacy fileUrl
  const filePath = defaultResume.document
    ? resolvePath(defaultResume.document.storageKey)
    : defaultResume.fileUrl;

  return {
    label: defaultResume.label,
    filePath,
    content: defaultResume.content,
  };
}

async function buildFillerPackage(packageId: string): Promise<FillerPackage> {
  if (!packageId) {
    return { coverLetterContent: null, savedAnswers: {}, attachedLinks: {}, whyItMatches: null };
  }

  const pkg = await prisma.applicationPackage.findUnique({
    where: { id: packageId },
    select: {
      coverLetterContent: true,
      savedAnswers: true,
      attachedLinks: true,
      whyItMatches: true,
    },
  });

  if (!pkg) {
    return { coverLetterContent: null, savedAnswers: {}, attachedLinks: {}, whyItMatches: null };
  }

  return {
    coverLetterContent: pkg.coverLetterContent,
    savedAnswers: jsonToRecord(pkg.savedAnswers),
    attachedLinks: jsonToRecord(pkg.attachedLinks),
    whyItMatches: pkg.whyItMatches,
  };
}

function jsonToRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") result[k] = v;
  }
  return result;
}

// ─── Result recording ────────────────────────────────────────────────────────

async function recordAutomationResult(
  candidate: AutoApplyCandidate,
  result: AutoApplyRunResult,
  mode: AutomationRunMode
) {
  const fillerResult = result.fillerResult;
  if (!fillerResult) {
    // Error case — record failure if we have a submission
    if (candidate.submissionId) {
      await prisma.applicationSubmission.update({
        where: { id: candidate.submissionId },
        data: {
          status: "FAILED",
          notes: `Automation error: ${result.error ?? "Unknown error"}`,
        },
      }).catch(() => {});
    }
    return;
  }

  const automationLog = {
    atsName: fillerResult.atsName,
    mode,
    status: fillerResult.status,
    filledFieldCount: fillerResult.filledFields.length,
    unfillableFieldCount: fillerResult.unfillableFields.length,
    blockers: fillerResult.blockers,
    durationMs: fillerResult.durationMs,
    screenshots: fillerResult.screenshots,
    notes: fillerResult.notes,
  };

  const submissionStatus =
    fillerResult.status === "submitted" ? "SUBMITTED" as const :
    fillerResult.status === "filled" ? "READY" as const :
    "FAILED" as const;

  if (candidate.submissionId) {
    // Update existing submission
    await prisma.applicationSubmission.update({
      where: { id: candidate.submissionId },
      data: {
        status: submissionStatus,
        submissionMethod: `auto:${fillerResult.atsName.toLowerCase()}`,
        submittedAt: fillerResult.submittedAt,
        notes: JSON.stringify(automationLog),
      },
    });
  } else if (candidate.packageId) {
    // Create new submission
    await prisma.applicationSubmission.create({
      data: {
        userId: DEMO_USER_ID,
        canonicalJobId: candidate.jobId,
        packageId: candidate.packageId,
        status: submissionStatus,
        submissionMethod: `auto:${fillerResult.atsName.toLowerCase()}`,
        submittedAt: fillerResult.submittedAt,
        notes: JSON.stringify(automationLog),
      },
    });
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
