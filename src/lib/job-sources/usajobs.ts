import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";
import {
  extractSkills,
  getRequestTimeoutMs,
  inferWorkMode,
  isLikelyCanadianLocation,
  matchesJobSearch,
  summarizeText,
} from "./utils";

const USAJOBS_API_BASE = "https://data.usajobs.gov/api/historicjoa";
const DEFAULT_MAX_PAGES = 20;
const HARD_MAX_PAGES = 40;
const DEFAULT_LOOKBACK_DAYS = 60;
const DEFAULT_USER_AGENT = "Mozilla/5.0 AutoApplicationBot/1.0";
const DEFAULT_ANNOUNCEMENT_TIMEOUT_MS = 4_000;

interface UsaJobsPaging {
  metadata?: {
    continuationToken?: string;
  };
  next?: string;
}

interface UsaJobsResponse<T> {
  paging?: UsaJobsPaging;
  data?: T[];
}

interface UsaJobsLocation {
  positionLocationCity?: string;
  positionLocationState?: string;
  positionLocationCountry?: string;
}

interface UsaJobsHistoricJob {
  usajobsControlNumber: number;
  hiringAgencyName?: string;
  hiringDepartmentName?: string;
  appointmentType?: string;
  workSchedule?: string;
  salaryType?: string;
  teleworkEligible?: string;
  positionOpenDate?: string;
  positionCloseDate?: string;
  positionTitle?: string;
  minimumSalary?: number;
  maximumSalary?: number;
  disableAppyOnline?: string;
  positionOpeningStatus?: string;
  positionlocations?: UsaJobsLocation[];
}

interface UsaJobsAnnouncementText {
  usajobsControlNumber: number;
  summary?: string;
  duties?: string;
  requirementsConditionsOfEmployment?: string;
  requirementsQualifications?: string;
  requirementsEducation?: string;
  requiredDocuments?: string;
  howToApply?: string;
  benefits?: string;
  otherInformation?: string;
}

function getUserAgent(): string {
  const configured = process.env.USAJOBS_USER_AGENT?.trim();
  return configured || DEFAULT_USER_AGENT;
}

function getMaxPages(): number {
  const raw = Number.parseInt(process.env.USAJOBS_MAX_PAGES ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_MAX_PAGES;
  return Math.min(raw, HARD_MAX_PAGES);
}

function getLookbackDays(): number {
  const raw = Number.parseInt(process.env.USAJOBS_LOOKBACK_DAYS ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_LOOKBACK_DAYS;
  return raw;
}

function getRecentOpenDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - getLookbackDays());
  return date.toISOString().slice(0, 10);
}

function getOpenDateForLookback(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function getAnnouncementTimeoutMs(): number {
  return Math.min(getRequestTimeoutMs(10_000), DEFAULT_ANNOUNCEMENT_TIMEOUT_MS);
}

function isAxiosTimeout(error: unknown): boolean {
  return axios.isAxiosError(error) && error.code === "ECONNABORTED";
}

function formatAxiosError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status) return `status ${status}`;
    if (error.code === "ECONNABORTED") {
      return `timeout after ${error.config?.timeout ?? getRequestTimeoutMs(10_000)}ms`;
    }
    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

function getFallbackOpenDates(initialOpenDate: string): string[] {
  const configuredLookbackDays = getLookbackDays();
  const candidates = [
    initialOpenDate,
    getOpenDateForLookback(Math.min(configuredLookbackDays, 30)),
    getOpenDateForLookback(Math.min(configuredLookbackDays, 14)),
    getOpenDateForLookback(Math.min(configuredLookbackDays, 7)),
  ];

  return Array.from(new Set(candidates));
}

function getContinuationToken<T>(response: UsaJobsResponse<T>): string | undefined {
  const nextUrl = response.paging?.next;
  if (nextUrl) {
    const query = nextUrl.split("?")[1];
    const token = query ? new URLSearchParams(query).get("continuationtoken") : null;
    if (token) return token;
  }

  const token = response.paging?.metadata?.continuationToken;
  return token ? decodeURIComponent(token) : undefined;
}

function isStillOpen(job: UsaJobsHistoricJob): boolean {
  if (job.disableAppyOnline === "Y") return false;

  if (job.positionOpeningStatus?.toLowerCase().includes("closed")) {
    return false;
  }

  if (!job.positionCloseDate) return true;

  const closeDate = new Date(job.positionCloseDate);
  if (Number.isNaN(closeDate.getTime())) return false;

  closeDate.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return closeDate >= today;
}

function resolveLocation(locations: UsaJobsLocation[] | undefined): string | undefined {
  const parts = Array.from(
    new Set(
      (locations ?? [])
        .map((location) =>
          [
            location.positionLocationCity,
            location.positionLocationState,
            location.positionLocationCountry,
          ]
            .filter(Boolean)
            .join(", "),
        )
        .filter(Boolean),
    ),
  );

  if (parts.length === 0) return undefined;
  return parts.join(" | ");
}

function buildDescription(
  job: UsaJobsHistoricJob,
  text: UsaJobsAnnouncementText | undefined,
): string {
  const parts = [
    text?.summary,
    text?.duties,
    text?.requirementsQualifications,
    text?.requirementsEducation,
    text?.requirementsConditionsOfEmployment,
    text?.requiredDocuments,
    text?.howToApply,
    text?.benefits,
    text?.otherInformation,
  ].filter((value): value is string => Boolean(value?.trim()));

  if (parts.length > 0) return parts.join("\n\n");
  return job.positionTitle ?? "";
}

function buildJobType(job: UsaJobsHistoricJob): string | undefined {
  const parts = [job.workSchedule, job.appointmentType].filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join(" / ");
}

function mapToNormalizedJob(
  job: UsaJobsHistoricJob,
  text: UsaJobsAnnouncementText | undefined,
): NormalizedJob {
  const description = buildDescription(job, text);
  const location = resolveLocation(job.positionlocations);
  const workMode =
    inferWorkMode(location, description) ??
    (job.teleworkEligible === "Y" ? "HYBRID" : undefined);
  const jobUrl = `https://www.usajobs.gov/job/${job.usajobsControlNumber}`;

  return {
    externalId: String(job.usajobsControlNumber),
    source: "USAJOBS",
    title: job.positionTitle ?? "",
    company: job.hiringAgencyName ?? job.hiringDepartmentName ?? "USAJOBS",
    location,
    workMode,
    salaryMin: job.minimumSalary,
    salaryMax: job.maximumSalary,
    salaryCurrency: job.salaryType?.toLowerCase().includes("year") ? "USD" : undefined,
    description,
    summary: summarizeText(text?.summary ?? description),
    url: jobUrl,
    applyUrl: jobUrl,
    postedAt: job.positionOpenDate ? new Date(job.positionOpenDate) : undefined,
    skills: extractSkills(description),
    jobType: buildJobType(job),
  };
}

export const usaJobsAdapter: JobSourceAdapter = {
  source: "USAJOBS",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    if (isLikelyCanadianLocation(params.location)) {
      return [];
    }

    const headers = {
      Accept: "application/json",
      "User-Agent": getUserAgent(),
    };

    const baseParams = {
      StartPositionOpenDate: getRecentOpenDate(),
    };

    const jobs: NormalizedJob[] = [];
    let continuationToken: string | undefined;
    let announcementWarningShown = false;
    let historicWarningShown = false;
    let announcementTextEnabled = true;

    for (let pageIndex = 0; pageIndex < getMaxPages(); pageIndex++) {
      const requestParams = continuationToken
        ? { continuationtoken: continuationToken }
        : baseParams;

      try {
        const paramVariants = continuationToken
          ? [requestParams]
          : getFallbackOpenDates(baseParams.StartPositionOpenDate).map((openDate) => ({
              StartPositionOpenDate: openDate,
            }));

        let historicResponse: Awaited<
          ReturnType<typeof axios.get<UsaJobsResponse<UsaJobsHistoricJob>>>
        > | null = null;

        for (let variantIndex = 0; variantIndex < paramVariants.length; variantIndex++) {
          const requestVariant = paramVariants[variantIndex];

          const [historicResult, textResult] = await Promise.allSettled([
            axios.get<UsaJobsResponse<UsaJobsHistoricJob>>(USAJOBS_API_BASE, {
              headers,
              params: requestVariant,
              timeout: getRequestTimeoutMs(10_000),
            }),
            announcementTextEnabled
              ? axios.get<UsaJobsResponse<UsaJobsAnnouncementText>>(
                  `${USAJOBS_API_BASE}/announcementtext`,
                  {
                    headers,
                    params: requestVariant,
                    timeout: getAnnouncementTimeoutMs(),
                  },
                )
              : Promise.resolve({ data: { data: [] } }),
          ]);

          if (historicResult.status === "fulfilled") {
            historicResponse = historicResult.value;

            const textResponse =
              textResult.status === "fulfilled" ? textResult.value : null;
            if (textResult.status === "rejected" && !announcementWarningShown) {
              announcementTextEnabled = false;
              announcementWarningShown = true;
              console.warn(
                `[USAJOBS] announcement text unavailable; continuing without it (${formatAxiosError(textResult.reason)})`,
              );
            }

            const historicJobs = historicResponse.data.data ?? [];
            const announcementTextById = new Map(
              (textResponse?.data.data ?? []).map((item) => [
                String(item.usajobsControlNumber),
                item,
              ]),
            );

            jobs.push(
              ...historicJobs
                .filter((job) => isStillOpen(job))
                .map((job) =>
                  mapToNormalizedJob(
                    job,
                    announcementTextById.get(String(job.usajobsControlNumber)),
                  ),
                ),
            );

            continuationToken = getContinuationToken(historicResponse.data);

            if (
              !continuationToken &&
              "StartPositionOpenDate" in requestVariant &&
              requestVariant.StartPositionOpenDate !== baseParams.StartPositionOpenDate
            ) {
              console.warn(
                `[USAJOBS] fell back to narrower open-date window ${requestVariant.StartPositionOpenDate} after upstream timeout`,
              );
            }

            break;
          }

          if (
            textResult.status === "rejected" &&
            !announcementWarningShown &&
            historicResult.status === "rejected"
          ) {
            announcementTextEnabled = false;
            announcementWarningShown = true;
            console.warn(
              `[USAJOBS] announcement text unavailable (${formatAxiosError(textResult.reason)})`,
            );
          }

          const shouldRetryWithNarrowerWindow =
            !continuationToken &&
            "StartPositionOpenDate" in requestVariant &&
            isAxiosTimeout(historicResult.reason) &&
            variantIndex < paramVariants.length - 1;

          if (shouldRetryWithNarrowerWindow) {
            continue;
          }

          throw historicResult.reason;
        }

        if (!historicResponse) {
          break;
        }

        if (!continuationToken) {
          break;
        }
      } catch (error) {
        if (!historicWarningShown) {
          historicWarningShown = true;
          console.warn(`[USAJOBS] skipping source for this refresh (${formatAxiosError(error)})`);
        }
        break;
      }
    }

    return jobs.filter((job) => matchesJobSearch(job, params));
  },
};
