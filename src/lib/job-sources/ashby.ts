import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";
import {
  extractSkills,
  htmlToPlainText,
  matchesJobSearch,
  parseBoardConfigs,
  resolveCompanyName,
  summarizeText,
} from "./utils";

interface AshbyCompensationSummary {
  compensationType?: string;
  interval?: string | null;
  currencyCode?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
}

interface AshbyJob {
  title?: string;
  location?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  publishedAt?: string;
  employmentType?: string;
  workplaceType?: "OnSite" | "Remote" | "Hybrid";
  jobUrl?: string;
  applyUrl?: string;
  isListed?: boolean;
  compensation?: {
    summaryComponents?: AshbyCompensationSummary[];
  };
}

interface AshbyJobsResponse {
  jobs?: AshbyJob[];
}

function mapAshbyWorkplaceType(
  workplaceType: AshbyJob["workplaceType"],
): NormalizedJob["workMode"] {
  switch (workplaceType) {
    case "Remote":
      return "REMOTE";
    case "Hybrid":
      return "HYBRID";
    case "OnSite":
      return "ONSITE";
    default:
      return undefined;
  }
}

function getAshbySalary(job: AshbyJob) {
  const salary = job.compensation?.summaryComponents?.find(
    (component) => component.compensationType === "Salary",
  );

  return {
    salaryMin: salary?.minValue ?? undefined,
    salaryMax: salary?.maxValue ?? undefined,
    salaryCurrency: salary?.currencyCode ?? undefined,
  };
}

export const ashbyAdapter: JobSourceAdapter = {
  source: "ASHBY",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const boards = parseBoardConfigs(process.env.ASHBY_JOB_BOARDS);
    if (boards.length === 0) return [];

    const results = await Promise.allSettled(
      boards.map(async (board) => {
        const response = await axios.get<AshbyJobsResponse>(
          `https://api.ashbyhq.com/posting-api/job-board/${board.token}`,
          {
            params: { includeCompensation: true },
          },
        );

        const company = resolveCompanyName(board);
        const jobs = response.data.jobs ?? [];

        return jobs
          .filter((job) => job.isListed !== false)
          .map((job): NormalizedJob => {
            const description = htmlToPlainText(
              job.descriptionPlain || job.descriptionHtml || "",
            );
            const salary = getAshbySalary(job);

            return {
              externalId: `${board.token}:${job.jobUrl ?? job.applyUrl ?? job.title ?? ""}`,
              source: "ASHBY",
              title: job.title ?? "",
              company,
              location: job.location ?? undefined,
              workMode: mapAshbyWorkplaceType(job.workplaceType),
              salaryMin: salary.salaryMin,
              salaryMax: salary.salaryMax,
              salaryCurrency: salary.salaryCurrency,
              description,
              summary: summarizeText(job.descriptionPlain || job.descriptionHtml || ""),
              url: job.jobUrl ?? job.applyUrl ?? "",
              applyUrl: job.applyUrl ?? undefined,
              postedAt: job.publishedAt ? new Date(job.publishedAt) : undefined,
              skills: extractSkills(description),
              jobType: job.employmentType ?? undefined,
            };
          });
      }),
    );

    return results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .filter((job) => matchesJobSearch(job, params));
  },
};
