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

interface GreenhouseBoard {
  name?: string;
}

interface GreenhouseJob {
  id: number;
  title?: string;
  updated_at?: string;
  location?: {
    name?: string;
  };
  absolute_url?: string;
  content?: string;
  metadata?: Record<string, unknown> | null;
}

interface GreenhouseJobsResponse {
  jobs?: GreenhouseJob[];
}

const GREENHOUSE_API_BASE = "https://boards-api.greenhouse.io/v1";

export const greenhouseAdapter: JobSourceAdapter = {
  source: "GREENHOUSE",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const boards = parseBoardConfigs(process.env.GREENHOUSE_BOARDS);
    if (boards.length === 0) return [];

    const results = await Promise.allSettled(
      boards.map(async (board) => {
        const [boardInfo, jobsResponse] = await Promise.all([
          board.name
            ? Promise.resolve({ data: { name: board.name } })
            : axios.get<GreenhouseBoard>(
                `${GREENHOUSE_API_BASE}/boards/${board.token}`,
              ),
          axios.get<GreenhouseJobsResponse>(
            `${GREENHOUSE_API_BASE}/boards/${board.token}/jobs`,
            {
              params: { content: true },
            },
          ),
        ]);

        const company = boardInfo.data?.name || resolveCompanyName(board);
        const jobs = jobsResponse.data.jobs ?? [];

        return jobs.map((job): NormalizedJob => {
          const descriptionHtml = job.content ?? "";
          const description = htmlToPlainText(descriptionHtml);
          const location = job.location?.name ?? undefined;

          return {
            externalId: `${board.token}:${job.id}`,
            source: "GREENHOUSE",
            title: job.title ?? "",
            company,
            location,
            workMode: inferWorkMode(location, description),
            description,
            summary: summarizeText(descriptionHtml),
            url: job.absolute_url ?? "",
            applyUrl: job.absolute_url ?? undefined,
            postedAt: job.updated_at ? new Date(job.updated_at) : undefined,
            skills: extractSkills(description),
          };
        });
      }),
    );

    return results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .filter((job) => matchesJobSearch(job, params));
  },
};
