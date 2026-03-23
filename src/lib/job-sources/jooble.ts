import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";
import {
  extractSkills,
  getRequestTimeoutMs,
  htmlToPlainText,
  inferWorkMode,
  matchesJobSearch,
  summarizeText,
} from "./utils";

const JOOBLE_API_BASE = "https://jooble.org/api";
const DEFAULT_RESULTS_PER_PAGE = 100;
const HARD_MAX_RESULTS_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 10;
const HARD_MAX_PAGES = 20;

interface JoobleJob {
  id?: string | number;
  title?: string;
  location?: string;
  snippet?: string;
  salary?: string;
  source?: string;
  type?: string;
  link?: string;
  company?: string;
  updated?: string;
}

interface JoobleResponse {
  totalCount?: number;
  jobs?: JoobleJob[];
}

function getResultsPerPage(): number {
  const raw = Number.parseInt(process.env.JOOBLE_RESULTS_PER_PAGE ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_RESULTS_PER_PAGE;
  return Math.min(raw, HARD_MAX_RESULTS_PER_PAGE);
}

function getMaxPages(): number {
  const raw = Number.parseInt(process.env.JOOBLE_MAX_PAGES ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_MAX_PAGES;
  return Math.min(raw, HARD_MAX_PAGES);
}

function parseSalaryRange(raw: string | undefined): {
  min?: number;
  max?: number;
  currency?: string;
} {
  if (!raw) return {};

  const matches = [...raw.matchAll(/(\d[\d,]*)/g)]
    .map((match) => Number.parseInt(match[1]!.replace(/,/g, ""), 10))
    .filter((value) => !Number.isNaN(value));

  const currencyMatch = raw.match(/\b(USD|CAD|EUR|GBP)\b/i);

  if (matches.length === 0) {
    return { currency: currencyMatch?.[1]?.toUpperCase() };
  }

  return {
    min: matches[0],
    max: matches.length > 1 ? matches[1] : undefined,
    currency: currencyMatch?.[1]?.toUpperCase(),
  };
}

export const joobleAdapter: JobSourceAdapter = {
  source: "JOOBLE",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const apiKey = process.env.JOOBLE_API_KEY?.trim();
    if (!apiKey) return [];

    const location = params.location?.trim() || "United States";
    const startPage = Math.max(1, params.page ?? 1);
    const maxPages = getMaxPages();
    const resultsPerPage = getResultsPerPage();

    try {
      const results = await Promise.allSettled(
        Array.from({ length: maxPages }, (_, offset) =>
          axios.post<JoobleResponse>(
            `${JOOBLE_API_BASE}/${apiKey}`,
            {
              keywords: params.query,
              location,
              page: String(startPage + offset),
              ResultOnPage: String(resultsPerPage),
              companysearch: "false",
            },
            {
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              timeout: getRequestTimeoutMs(12_000),
            },
          ),
        ),
      );

      return results
        .flatMap((result) =>
          result.status === "fulfilled" ? (result.value.data.jobs ?? []) : [],
        )
        .map((job): NormalizedJob => {
          const description = htmlToPlainText(job.snippet ?? "");
          const salary = parseSalaryRange(job.salary);

          return {
            externalId: String(job.id ?? job.link ?? ""),
            source: "JOOBLE",
            title: job.title?.trim() || "",
            company: job.company?.trim() || "Unknown Company",
            location: job.location?.trim() || undefined,
            workMode: inferWorkMode(job.location, description, job.type),
            salaryMin: salary.min,
            salaryMax: salary.max,
            salaryCurrency: salary.currency,
            description,
            summary: summarizeText(job.snippet ?? description),
            url: job.link?.trim() || "",
            applyUrl: job.link?.trim() || undefined,
            postedAt: job.updated ? new Date(job.updated) : undefined,
            skills: extractSkills(description),
            jobType: job.type?.trim() || undefined,
          };
        })
        .filter((job) => job.externalId && job.title && job.url)
        .filter((job) => matchesJobSearch(job, params));
    } catch (error) {
      console.error(
        "Jooble API error:",
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  },
};
