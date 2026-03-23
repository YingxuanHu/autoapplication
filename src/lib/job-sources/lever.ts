import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";
import {
  extractSkills,
  htmlToPlainText,
  inferWorkMode,
  matchesJobSearch,
  parseBoardConfigs,
  resolveCompanyName,
  summarizeText,
} from "./utils";

interface LeverPosting {
  id: string;
  text?: string;
  categories?: {
    location?: string;
    commitment?: string;
    team?: string;
    department?: string;
  };
  description?: string;
  descriptionPlain?: string;
  openingPlain?: string;
  descriptionBodyPlain?: string;
  additionalPlain?: string;
  hostedUrl?: string;
  applyUrl?: string;
  workplaceType?: "unspecified" | "on-site" | "remote" | "hybrid";
  salaryRange?: {
    currency?: string;
    min?: number;
    max?: number;
  };
}

function mapLeverWorkplaceType(
  workplaceType: LeverPosting["workplaceType"],
): NormalizedJob["workMode"] {
  switch (workplaceType) {
    case "remote":
      return "REMOTE";
    case "hybrid":
      return "HYBRID";
    case "on-site":
      return "ONSITE";
    default:
      return undefined;
  }
}

function buildDescription(posting: LeverPosting): string {
  return htmlToPlainText(
    posting.descriptionPlain ||
      [
        posting.openingPlain,
        posting.descriptionBodyPlain,
        posting.additionalPlain,
      ]
        .filter(Boolean)
        .join("\n\n") ||
      posting.description ||
      "",
  );
}

async function fetchLeverJobs(
  baseUrl: string,
  site: string,
): Promise<LeverPosting[]> {
  const response = await axios.get<LeverPosting[]>(
    `${baseUrl}/v0/postings/${site}`,
    {
      params: { mode: "json" },
    },
  );

  return Array.isArray(response.data) ? response.data : [];
}

export const leverAdapter: JobSourceAdapter = {
  source: "LEVER",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const globalSites = parseBoardConfigs(process.env.LEVER_SITES).map(
      (site) => ({
        ...site,
        apiBaseUrl: "https://api.lever.co",
      }),
    );
    const euSites = parseBoardConfigs(process.env.LEVER_EU_SITES).map(
      (site) => ({
        ...site,
        apiBaseUrl: "https://api.eu.lever.co",
      }),
    );
    const sites = [...globalSites, ...euSites];

    if (sites.length === 0) return [];

    const results = await Promise.allSettled(
      sites.map(async (site) => {
        const jobs = await fetchLeverJobs(site.apiBaseUrl, site.token);
        const company = resolveCompanyName(site);

        return jobs.map((job): NormalizedJob => {
          const description = buildDescription(job);
          const location = job.categories?.location ?? undefined;

          return {
            externalId: `${site.token}:${job.id}`,
            source: "LEVER",
            title: job.text ?? "",
            company,
            location,
            workMode:
              mapLeverWorkplaceType(job.workplaceType) ||
              inferWorkMode(location, description),
            salaryMin: job.salaryRange?.min,
            salaryMax: job.salaryRange?.max,
            salaryCurrency: job.salaryRange?.currency,
            description,
            summary: summarizeText(description),
            url: job.hostedUrl ?? job.applyUrl ?? "",
            applyUrl: job.applyUrl ?? undefined,
            skills: extractSkills(description),
            jobType: job.categories?.commitment ?? undefined,
          };
        });
      }),
    );

    return results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .filter((job) => matchesJobSearch(job, params));
  },
};
