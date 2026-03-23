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

const THE_MUSE_API_BASE = "https://www.themuse.com/api/public/jobs";
const DEFAULT_MAX_PAGES = 50;
const HARD_MAX_PAGES = 100;

interface MuseLocation {
  name?: string;
}

interface MuseLevel {
  name?: string;
}

interface MuseRefs {
  landing_page?: string;
}

interface MuseCompany {
  name?: string;
}

interface MuseJob {
  id: number;
  name?: string;
  contents?: string;
  publication_date?: string;
  locations?: MuseLocation[];
  levels?: MuseLevel[];
  refs?: MuseRefs;
  company?: MuseCompany;
}

interface MuseJobsResponse {
  page_count?: number;
  results?: MuseJob[];
}

function getMaxPages(): number {
  const raw = Number.parseInt(process.env.THE_MUSE_MAX_PAGES ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_MAX_PAGES;
  return Math.min(raw, HARD_MAX_PAGES);
}

function resolveLocation(locations: MuseLocation[] | undefined): string | undefined {
  const names = Array.from(
    new Set(
      (locations ?? [])
        .map((location) => location.name?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );

  if (names.length === 0) return undefined;
  return names.join(" | ");
}

export const theMuseAdapter: JobSourceAdapter = {
  source: "THE_MUSE",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const startPage = Math.max(1, params.page ?? 1);
    const maxPages = getMaxPages();

    const results = await Promise.allSettled(
      Array.from({ length: maxPages }, (_, offset) =>
        axios.get<MuseJobsResponse>(THE_MUSE_API_BASE, {
          params: {
            page: startPage + offset,
          },
          timeout: getRequestTimeoutMs(),
        }),
      ),
    );

    return results
      .flatMap((result) =>
        result.status === "fulfilled" ? (result.value.data.results ?? []) : [],
      )
      .map((job): NormalizedJob => {
        const description = htmlToPlainText(job.contents ?? "");
        const location = resolveLocation(job.locations);

        return {
          externalId: String(job.id),
          source: "THE_MUSE",
          title: job.name ?? "",
          company: job.company?.name ?? "Unknown Company",
          location,
          workMode: inferWorkMode(location, description),
          description,
          summary: summarizeText(job.contents ?? description),
          url: job.refs?.landing_page ?? "",
          applyUrl: job.refs?.landing_page ?? undefined,
          postedAt: job.publication_date
            ? new Date(job.publication_date)
            : undefined,
          skills: extractSkills(description),
          jobType: job.levels?.map((level) => level.name).filter(Boolean).join(", ") || undefined,
        };
      })
      .filter((job) => matchesJobSearch(job, params));
  },
};
