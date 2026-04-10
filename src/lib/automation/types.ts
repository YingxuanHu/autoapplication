import type { Page } from "playwright";

// ─── Automation modes ────────────────────────────────────────────────────────

/**
 * Controls how deep the automation goes for a given run.
 *
 * - `dry_run`          — Navigate to the form, detect fields, map them, screenshot. Fill nothing.
 * - `fill_only`        — Fill fields and upload resume but do NOT click submit. Screenshot the filled form.
 * - `fill_and_submit`  — Fill and submit. Only allowed for AUTO_SUBMIT_READY + permissive automation mode.
 */
export type AutomationRunMode = "dry_run" | "fill_only" | "fill_and_submit";

// ─── Filler context (passed to each ATS-specific filler) ─────────────────────

export type FillerProfile = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  workAuthorization: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
};

export type FillerResume = {
  label: string;
  /** Absolute path to the resume file on disk, or null if content-only */
  filePath: string | null;
  /** Raw text content for pasting, if no file exists */
  content: string | null;
  /** Cleanup hook for temporary local files materialized from remote storage */
  cleanup?: (() => Promise<void>) | null;
};

export type FillerPackage = {
  coverLetterContent: string | null;
  savedAnswers: Record<string, string>;
  attachedLinks: Record<string, string>;
  whyItMatches: string | null;
};

export type ATSFillerContext = {
  page: Page;
  applyUrl: string;
  jobTitle: string;
  company: string;
  profile: FillerProfile;
  resume: FillerResume;
  applicationPackage: FillerPackage;
  mode: AutomationRunMode;
  /** Directory to save screenshots to */
  screenshotDir: string;
};

// ─── Filler results ─────────────────────────────────────────────────────────

export type FilledField = {
  label: string;
  selector: string;
  value: string;
};

export type UnfillableField = {
  label: string;
  reason: string;
  required: boolean;
};

export type AutomationBlocker = {
  type:
    | "captcha"
    | "login_required"
    | "position_closed"
    | "form_changed"
    | "required_field_unknown"
    | "file_upload_failed"
    | "timeout"
    | "unknown";
  detail: string;
};

export type ATSFillerResult = {
  status: "filled" | "submitted" | "failed" | "blocked";
  atsName: string;
  filledFields: FilledField[];
  unfillableFields: UnfillableField[];
  blockers: AutomationBlocker[];
  screenshots: string[];
  submittedAt: Date | null;
  notes: string;
  durationMs: number;
};

// ─── Filler interface ────────────────────────────────────────────────────────

export type ATSFiller = {
  /** Human-readable ATS name */
  atsName: string;
  /** Regex to match apply URLs this filler can handle */
  urlPattern: RegExp;
  /** Execute the form-fill operation */
  fill(context: ATSFillerContext): Promise<ATSFillerResult>;
};

// ─── Engine-level types ─────────────────────────────────────────────────────

export type AutoApplyCandidate = {
  jobId: string;
  jobTitle: string;
  company: string;
  applyUrl: string;
  submissionCategory: string;
  packageId: string;
  submissionId: string | null;
};

export type AutoApplyRunResult = {
  jobId: string;
  fillerResult: ATSFillerResult | null;
  error: string | null;
};
