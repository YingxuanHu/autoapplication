import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";
import {
  extractSkills,
  getRequestTimeoutMs,
  htmlToPlainText,
  matchesJobSearch,
  summarizeText,
} from "./utils";

const REMOTEOK_API_BASE = "https://remoteok.com/api";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1_500;

interface RemoteOKJob {
  id?: string | number;
  epoch?: number;
  date?: string;
  company?: string;
  company_logo?: string;
  position?: string;
  tags?: string[];
  description?: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
  url?: string;
  apply_url?: string;
  original?: boolean;
}

function isNorthAmericaFriendly(location: string | undefined): boolean {
  if (!location) return true; // Remote jobs without location restriction are fine
  const lower = location.toLowerCase();
  return (
    /north america|usa|united states|u\.s\.|canada|us timezones|americas|worldwide|anywhere|global/i.test(
      lower,
    ) || !lower.trim()
  );
}

async function fetchWithRetry(): Promise<RemoteOKJob[]> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<RemoteOKJob[]>(REMOTEOK_API_BASE, {
        timeout: getRequestTimeoutMs(15_000),
        headers: {
          Accept: "application/json",
          "User-Agent": "AutoApplicationBot/1.0",
        },
      });

      // RemoteOK returns an array where the first element is metadata (a "legal" notice)
      const data = response.data;
      if (!Array.isArray(data)) return [];
      // Filter out non-job entries (first item is usually a legal/metadata object)
      return data.filter(
        (item) => item.position || item.company || item.id,
      );
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[RemoteOK] Attempt ${attempt + 1} failed, retrying in ${RETRY_DELAY_MS}ms...`,
          error instanceof Error ? error.message : error,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  }
  return [];
}

export const remoteOKAdapter: JobSourceAdapter = {
  source: "REMOTEOK",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    try {
      const jobs = await fetchWithRetry();

      return jobs
        .filter((job) => isNorthAmericaFriendly(job.location))
        .map((job): NormalizedJob => {
          const rawDescription = htmlToPlainText(job.description ?? "");
          const tags = job.tags ?? [];

          return {
            externalId: `remoteok-${String(job.id ?? job.epoch ?? "")}`,
            source: "REMOTEOK",
            title: job.position ?? "",
            company: job.company ?? "Unknown Company",
            companyLogo: job.company_logo ?? undefined,
            location: job.location || "Remote",
            workMode: "REMOTE",
            salaryMin: job.salary_min ?? undefined,
            salaryMax: job.salary_max ?? undefined,
            salaryCurrency: job.salary_min || job.salary_max ? "USD" : undefined,
            description: rawDescription,
            summary: summarizeText(rawDescription),
            url: job.url ?? `https://remoteok.com/remote-jobs/${job.id ?? ""}`,
            applyUrl: job.apply_url ?? job.url ?? undefined,
            postedAt: job.date
              ? new Date(job.date)
              : job.epoch
                ? new Date(job.epoch * 1000)
                : undefined,
            skills: [
              ...new Set([
                ...tags.map((t) => t.toLowerCase()),
                ...extractSkills(rawDescription),
              ]),
            ],
            jobType: undefined,
          };
        })
        .filter((job) => job.externalId && job.title)
        .filter((job) => matchesJobSearch(job, params));
    } catch (error) {
      console.error(
        "[RemoteOK] API error:",
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  },
};
