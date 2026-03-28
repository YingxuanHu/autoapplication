import type { EligibilityDraft, NormalizedJobInput } from "@/lib/ingestion/types";

type BuildEligibilityOptions = {
  job: NormalizedJobInput;
  sourceName: string;
};

export function buildEligibilityDraft({
  job,
  sourceName,
}: BuildEligibilityOptions): EligibilityDraft {
  const evaluationTime = new Date();
  const lowerSourceName = sourceName.toLowerCase();
  const lowerApplyUrl = job.applyUrl.toLowerCase();
  const lowerDescription = job.description.toLowerCase();
  const isStructuredPortal =
    lowerSourceName.includes("greenhouse") ||
    lowerApplyUrl.includes("greenhouse") ||
    lowerApplyUrl.includes("lever.co") ||
    lowerApplyUrl.includes("ashbyhq.com");
  const requiresCustomWriting =
    /cover letter|essay|statement|why do you want|why are you interested|additional question/.test(
      lowerDescription
    );
  const higherTouchRole =
    job.experienceLevel === "LEAD" ||
    job.experienceLevel === "EXECUTIVE" ||
    /\b(manager|director|principal|staff|lead)\b/i.test(job.title);
  const nonStandardEmployment = job.employmentType !== "FULL_TIME";

  if (!isStructuredPortal) {
    return {
      submissionCategory: "MANUAL_ONLY",
      reasonCode: "unsupported_source_portal",
      reasonDescription:
        "The source does not present a structured portal yet, so the role should stay manual.",
      jobValidityConfidence: 0.78,
      formAutomationConfidence: 0.22,
      packageFitConfidence: 0.64,
      submissionQualityConfidence: 0.52,
      customizationLevel: 3,
      evaluatedAt: evaluationTime,
    };
  }

  if (requiresCustomWriting || higherTouchRole || nonStandardEmployment) {
    return {
      submissionCategory: "AUTO_FILL_REVIEW",
      reasonCode: requiresCustomWriting
        ? "custom_written_response_possible"
        : higherTouchRole
          ? "higher_touch_role_review"
          : "non_standard_employment_review",
      reasonDescription: requiresCustomWriting
        ? "The job appears structured, but the description suggests custom writing or extra review."
        : higherTouchRole
          ? "The role is structured, but seniority or complexity means a human should review before submit."
          : "The job is structured, but employment type makes automated submission too aggressive.",
      jobValidityConfidence: 0.88,
      formAutomationConfidence: 0.74,
      packageFitConfidence: 0.77,
      submissionQualityConfidence: 0.72,
      customizationLevel: 2,
      evaluatedAt: evaluationTime,
    };
  }

  return {
    submissionCategory: "AUTO_SUBMIT_READY",
    reasonCode: "structured_ats_flow",
    reasonDescription:
      "Structured ATS flow detected with standard fields and no obvious custom writing blockers.",
    jobValidityConfidence: 0.94,
    formAutomationConfidence: 0.9,
    packageFitConfidence: 0.86,
    submissionQualityConfidence: 0.84,
    customizationLevel: 1,
    evaluatedAt: evaluationTime,
  };
}
