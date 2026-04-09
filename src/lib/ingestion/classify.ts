import type { EligibilityDraft, NormalizedJobInput } from "@/lib/ingestion/types";

type BuildEligibilityOptions = {
  job: NormalizedJobInput;
  sourceName: string;
};

// ─── Portal classification ───────────────────────────────────────────────────

type PortalTier = "structured" | "semi_structured" | "aggregator" | "unknown";

/**
 * Classify the application portal tier based on source name and apply URL.
 *
 * - **structured**: ATS with known, automatable application forms
 *   (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, Workable, Rippling, Recruitee)
 * - **semi_structured**: Corporate portals that have forms but may vary
 *   (SuccessFactors, Taleo, company career pages)
 * - **aggregator**: Job boards that link out to external application pages
 *   (Adzuna, Himalayas, TheMuse, RemoteOK, Remotive, Jobicy, USAJobs, Job Bank)
 * - **unknown**: Source not recognized
 */
function classifyPortal(sourceName: string, applyUrl: string): PortalTier {
  const src = normalizeText(sourceName);
  const url = normalizeText(applyUrl);

  // Tier 1: Structured ATS portals with standardized application flows
  if (
    src.includes("greenhouse") || url.includes("greenhouse.io") ||
    src.includes("lever") || url.includes("lever.co") || url.includes("jobs.lever.co") ||
    src.includes("ashby") || url.includes("ashbyhq.com") ||
    src.includes("workday") || url.includes("myworkdayjobs.com") ||
    src.includes("smartrecruiters") || url.includes("smartrecruiters.com") ||
    src.includes("icims") || url.includes("icims.com") ||
    src.includes("workable") || url.includes("apply.workable.com") ||
    src.includes("rippling") || url.includes("ats.rippling.com") ||
    src.includes("recruitee") || url.includes("recruitee.com")
  ) {
    return "structured";
  }

  // Tier 2: Semi-structured portals (have forms but less standardized)
  if (
    src.includes("successfactors") || url.includes("successfactors.com") ||
    src.includes("taleo") || url.includes("taleo.net") ||
    src.includes("usajobs") || url.includes("usajobs.gov")
  ) {
    return "semi_structured";
  }

  // Tier 3: Aggregators that link out to external apply pages
  if (
    src.includes("adzuna") ||
    src.includes("himalayas") ||
    src.includes("themuse") ||
    src.includes("remoteok") ||
    src.includes("remotive") ||
    src.includes("jobicy") ||
    src.includes("jobbank")
  ) {
    return "aggregator";
  }

  return "unknown";
}

// ─── Main classifier ─────────────────────────────────────────────────────────

export function buildEligibilityDraft({
  job,
  sourceName,
}: BuildEligibilityOptions): EligibilityDraft {
  const evaluationTime = new Date();
  const lowerDescription = normalizeText(job.description);
  const portalTier = classifyPortal(sourceName, job.applyUrl);

  // ─── Signal detection ──────────────────────────────────────────────
  const requiresCustomWriting =
    /cover letter|essay|statement of interest|why do you want|why are you interested|additional question|writing sample/.test(
      lowerDescription
    );

  const higherTouchRole =
    job.experienceLevel === "LEAD" ||
    job.experienceLevel === "EXECUTIVE" ||
    /\b(manager|director|principal|staff\s+engineer|distinguished|fellow|chief|cto|cfo|coo|vp\b|vice president|head of)\b/i.test(job.title);

  const nonStandardEmployment = job.employmentType !== "FULL_TIME";

  const isInternship =
    job.roleFamily === "Internship" ||
    /\b(intern|co-op|coop|internship|stagiaire)\b/i.test(job.title);

  // Aggregator jobs often link to external sites we may not be able to automate
  const hasExternalRedirect =
    portalTier === "aggregator" &&
    !job.applyUrl.includes("greenhouse") &&
    !job.applyUrl.includes("lever.co") &&
    !job.applyUrl.includes("ashbyhq.com") &&
    !job.applyUrl.includes("myworkdayjobs.com") &&
    !job.applyUrl.includes("smartrecruiters.com") &&
    !job.applyUrl.includes("icims.com");

  // ─── Classification logic ──────────────────────────────────────────

  // Unknown portals → manual
  if (portalTier === "unknown") {
    return makeManual(
      "unknown_source_portal",
      "Source portal is not yet recognized. Manual application required.",
      evaluationTime,
      { jobValidity: 0.6, formAutomation: 0.15, packageFit: 0.5, submissionQuality: 0.4 }
    );
  }

  // Aggregators with external redirects → manual (we can't control the destination form)
  if (hasExternalRedirect) {
    return makeManual(
      "aggregator_external_redirect",
      "This job was found via an aggregator and links to an external application page we haven't mapped yet.",
      evaluationTime,
      { jobValidity: 0.82, formAutomation: 0.2, packageFit: 0.65, submissionQuality: 0.5 }
    );
  }

  // Aggregators linking to known ATS → classify as if structured
  // (the apply URL points to a known structured portal)
  const effectiveTier = portalTier === "aggregator" ? "semi_structured" : portalTier;

  // Semi-structured portals → review by default, auto-fill if clean
  if (effectiveTier === "semi_structured") {
    if (requiresCustomWriting || higherTouchRole) {
      return makeReview(
        requiresCustomWriting ? "custom_writing_semi_structured" : "senior_role_semi_structured",
        requiresCustomWriting
          ? "Semi-structured portal with custom writing requirements. Human review recommended."
          : "Semi-structured portal with a senior role. Human review recommended before submitting.",
        evaluationTime,
        { jobValidity: 0.84, formAutomation: 0.6, packageFit: 0.72, submissionQuality: 0.65 }
      );
    }
    return makeReview(
      "semi_structured_portal",
      "Application portal has forms but they're less standardized. Auto-fill with human review.",
      evaluationTime,
      { jobValidity: 0.86, formAutomation: 0.68, packageFit: 0.75, submissionQuality: 0.7 }
    );
  }

  // ─── Structured portals ────────────────────────────────────────────

  // Custom writing → review
  if (requiresCustomWriting) {
    return makeReview(
      "custom_written_response_required",
      "Structured ATS flow detected, but the description suggests custom writing or extra questions. Human review recommended.",
      evaluationTime,
      { jobValidity: 0.9, formAutomation: 0.78, packageFit: 0.8, submissionQuality: 0.74 }
    );
  }

  // Senior/exec roles → review
  if (higherTouchRole) {
    return makeReview(
      "higher_touch_role_review",
      "Structured ATS flow, but role seniority means a human should review materials before submitting.",
      evaluationTime,
      { jobValidity: 0.92, formAutomation: 0.82, packageFit: 0.75, submissionQuality: 0.72 }
    );
  }

  // Internships → review (different resume strategy needed)
  if (isInternship) {
    return makeReview(
      "internship_review",
      "Structured ATS flow for an internship/co-op. Review recommended to tailor materials for early-career role.",
      evaluationTime,
      { jobValidity: 0.9, formAutomation: 0.85, packageFit: 0.7, submissionQuality: 0.75 }
    );
  }

  // Non-standard employment → review
  if (nonStandardEmployment) {
    return makeReview(
      "non_standard_employment_review",
      "Structured ATS flow, but non-standard employment type makes full auto-submit too aggressive.",
      evaluationTime,
      { jobValidity: 0.88, formAutomation: 0.82, packageFit: 0.78, submissionQuality: 0.73 }
    );
  }

  // All clear → auto-submit ready
  return {
    submissionCategory: "AUTO_SUBMIT_READY",
    reasonCode: "structured_ats_flow",
    reasonDescription:
      "Structured ATS flow detected with standard fields and no custom writing blockers. Ready for automated submission.",
    jobValidityConfidence: 0.94,
    formAutomationConfidence: 0.9,
    packageFitConfidence: 0.86,
    submissionQualityConfidence: 0.84,
    customizationLevel: 1,
    evaluatedAt: evaluationTime,
  };
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type ConfidenceScores = {
  jobValidity: number;
  formAutomation: number;
  packageFit: number;
  submissionQuality: number;
};

function makeManual(
  reasonCode: string,
  reasonDescription: string,
  evaluatedAt: Date,
  scores: ConfidenceScores
): EligibilityDraft {
  return {
    submissionCategory: "MANUAL_ONLY",
    reasonCode,
    reasonDescription,
    jobValidityConfidence: scores.jobValidity,
    formAutomationConfidence: scores.formAutomation,
    packageFitConfidence: scores.packageFit,
    submissionQualityConfidence: scores.submissionQuality,
    customizationLevel: 3,
    evaluatedAt,
  };
}

function makeReview(
  reasonCode: string,
  reasonDescription: string,
  evaluatedAt: Date,
  scores: ConfidenceScores
): EligibilityDraft {
  return {
    submissionCategory: "AUTO_FILL_REVIEW",
    reasonCode,
    reasonDescription,
    jobValidityConfidence: scores.jobValidity,
    formAutomationConfidence: scores.formAutomation,
    packageFitConfidence: scores.packageFit,
    submissionQualityConfidence: scores.submissionQuality,
    customizationLevel: 2,
    evaluatedAt,
  };
}
