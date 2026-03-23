import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";
import {
  extractSkills,
  htmlToPlainText,
  inferWorkMode,
  matchesJobSearch,
  summarizeText,
} from "./utils";

const REED_SEARCH_API = "https://www.reed.co.uk/api/1.0/search";
const DEFAULT_RESULTS_PER_PAGE = 100;
const HARD_MAX_RESULTS = 100;

interface ReedJob {
  jobId?: number;
  employerName?: string;
  jobTitle?: string;
  locationName?: string;
  minimumSalary?: number;
  maximumSalary?: number;
  currency?: string;
  jobDescription?: string;
  jobUrl?: string;
  contractType?: string;
  fullTime?: boolean;
  partTime?: boolean;
  date?: string;
}

interface ReedSearchResponse {
  results?: ReedJob[];
}

function getResultsPerPage(limit: number | undefined): number {
  const configured = Number.parseInt(process.env.REED_RESULTS_PER_PAGE ?? "", 10);
  const fallback = Number.isNaN(configured) ? DEFAULT_RESULTS_PER_PAGE : configured;
  const requested = limit ?? fallback;
  return Math.min(Math.max(requested, 10), HARD_MAX_RESULTS);
}

function buildJobType(job: ReedJob): string | undefined {
  const flags: string[] = [];
  if (job.contractType) flags.push(job.contractType);
  if (job.fullTime) flags.push("Full-time");
  if (job.partTime) flags.push("Part-time");
  return flags.length > 0 ? flags.join(" / ") : undefined;
}

export const reedAdapter: JobSourceAdapter = {
  source: "REED",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const apiKey = process.env.REED_API_KEY?.trim();
    if (!apiKey) return [];

    const response = await axios.get<ReedSearchResponse>(REED_SEARCH_API, {
      auth: {
        username: apiKey,
        password: "",
      },
      params: {
        keywords: params.query,
        locationName: params.location ?? undefined,
        page: params.page ?? 1,
        resultsToTake: getResultsPerPage(params.limit),
      },
    });

    return (response.data.results ?? [])
      .map((job): NormalizedJob => {
        const description = htmlToPlainText(job.jobDescription ?? "");

        return {
          externalId: String(job.jobId ?? ""),
          source: "REED",
          title: job.jobTitle ?? "",
          company: job.employerName ?? "Reed",
          location: job.locationName ?? undefined,
          workMode: inferWorkMode(job.locationName, description),
          salaryMin: job.minimumSalary,
          salaryMax: job.maximumSalary,
          salaryCurrency: job.currency ?? "GBP",
          description,
          summary: summarizeText(job.jobDescription ?? description),
          url: job.jobUrl ?? "",
          applyUrl: job.jobUrl ?? undefined,
          postedAt: job.date ? new Date(job.date) : undefined,
          skills: extractSkills(description),
          jobType: buildJobType(job),
        };
      })
      .filter((job) => matchesJobSearch(job, params));
  },
};
