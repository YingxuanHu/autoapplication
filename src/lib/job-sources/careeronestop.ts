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

const CAREERONESTOP_API_BASE = "https://api.careeronestop.org/v2/jobsearch";
const DEFAULT_PAGE_SIZE = 100;
const HARD_MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const HARD_MAX_PAGES = 20;
const DEFAULT_RADIUS = "25";
const DEFAULT_DAYS = 30;

interface CareerOneStopJob {
  JvId?: string;
  JobTitle?: string;
  Company?: string;
  DescriptionSnippet?: string;
  AcquisitionDate?: string;
  URL?: string;
  Location?: string;
}

interface CareerOneStopResponse {
  Jobs?: CareerOneStopJob[];
}

function getPageSize(): number {
  const raw = Number.parseInt(process.env.CAREERONESTOP_PAGE_SIZE ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(raw, HARD_MAX_PAGE_SIZE);
}

function getMaxPages(): number {
  const raw = Number.parseInt(process.env.CAREERONESTOP_MAX_PAGES ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_MAX_PAGES;
  return Math.min(raw, HARD_MAX_PAGES);
}

function getRadius(): string {
  const value = process.env.CAREERONESTOP_RADIUS?.trim();
  return value || DEFAULT_RADIUS;
}

function getDays(): number {
  const raw = Number.parseInt(process.env.CAREERONESTOP_DAYS ?? "", 10);
  if (Number.isNaN(raw) || raw < 0) return DEFAULT_DAYS;
  return raw;
}

function buildSearchUrl(
  userId: string,
  keyword: string,
  location: string,
  startRecord: number,
  pageSize: number,
): string {
  const safeParts = [
    userId,
    keyword || "0",
    location || "United States",
    getRadius(),
    "0",
    "0",
    String(startRecord),
    String(pageSize),
    String(getDays()),
  ].map((part) => encodeURIComponent(part));

  return `${CAREERONESTOP_API_BASE}/${safeParts.join("/")}`;
}

export const careerOneStopAdapter: JobSourceAdapter = {
  source: "CAREERONESTOP",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const userId = process.env.CAREERONESTOP_USER_ID?.trim();
    const apiToken = process.env.CAREERONESTOP_API_TOKEN?.trim();

    if (!userId || !apiToken) {
      return [];
    }

    const pageSize = getPageSize();
    const location = params.location?.trim() || "United States";
    const startPage = Math.max(1, params.page ?? 1);
    const maxPages = getMaxPages();

    try {
      const results = await Promise.allSettled(
        Array.from({ length: maxPages }, (_, offset) => {
          const pageIndex = startPage + offset - 1;
          const startRecord = pageIndex * pageSize;

          return axios.get<CareerOneStopResponse>(
            buildSearchUrl(userId, params.query, location, startRecord, pageSize),
            {
              headers: {
                Authorization: `Bearer ${apiToken}`,
                Accept: "application/json",
              },
              params: {
                enableJobDescriptionSnippet: true,
                enableMetaData: false,
                showFilters: false,
              },
              timeout: getRequestTimeoutMs(12_000),
            },
          );
        }),
      );

      return results
        .flatMap((result) =>
          result.status === "fulfilled" ? (result.value.data.Jobs ?? []) : [],
        )
        .map((job): NormalizedJob => {
          const description = htmlToPlainText(job.DescriptionSnippet ?? "");
          const locationText = job.Location?.trim() || undefined;
          const url = job.URL?.trim() || "";

          return {
            externalId: job.JvId?.trim() || url,
            source: "CAREERONESTOP",
            title: job.JobTitle?.trim() || "",
            company: job.Company?.trim() || "Unknown Company",
            location: locationText,
            workMode: inferWorkMode(locationText, description),
            description,
            summary: summarizeText(job.DescriptionSnippet ?? description),
            url,
            applyUrl: url || undefined,
            postedAt: job.AcquisitionDate ? new Date(job.AcquisitionDate) : undefined,
            skills: extractSkills(description),
          };
        })
        .filter((job) => job.externalId && job.title && job.url)
        .filter((job) => matchesJobSearch(job, params));
    } catch (error) {
      console.error(
        "CareerOneStop API error:",
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  },
};
