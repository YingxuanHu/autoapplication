import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
} from "@/lib/ingestion/types";
import {
  buildTimeoutSignal,
  throwIfAborted,
} from "@/lib/ingestion/runtime-control";

type GreenhouseConnectorOptions = {
  boardToken: string;
};

type GreenhouseApiJob = {
  absolute_url: string;
  company_name: string;
  content: string;
  id: number;
  location?: {
    name?: string;
  } | null;
  title: string;
  updated_at?: string | null;
  first_published?: string | null;
};

type GreenhouseApiResponse = {
  jobs: GreenhouseApiJob[];
};

export function createGreenhouseConnector({
  boardToken,
}: GreenhouseConnectorOptions): SourceConnector {
  return {
    key: `greenhouse:${boardToken}`,
    sourceName: `Greenhouse:${boardToken}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      throwIfAborted(options.signal);
      const response = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs?content=true`,
        {
          headers: {
            Accept: "application/json",
          },
          signal: buildTimeoutSignal(options.signal, 30_000),
        }
      );

      const log = options.log ?? console.log;

      if (!response.ok) {
        log(`[greenhouse:${boardToken}] API error ${response.status} ${response.statusText}`);
        return {
          jobs: [],
          metadata: {
            boardToken,
            error: `${response.status} ${response.statusText}`,
            fetchedAt: options.now.toISOString(),
          },
        };
      }

      throwIfAborted(options.signal);
      const payload = (await response.json()) as GreenhouseApiResponse;
      const jobs = typeof options.limit === "number"
        ? payload.jobs.slice(0, options.limit)
        : payload.jobs;

      return {
        jobs: jobs.map((job) => ({
          sourceId: String(job.id),
          sourceUrl: job.absolute_url,
          title: job.title,
          company: job.company_name,
          location: job.location?.name ?? "Unknown",
          description: job.content,
          applyUrl: job.absolute_url,
          postedAt: parseDateValue(job.first_published),
          deadline: null,
          employmentType: null,
          workMode: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          metadata: job,
        })),
        metadata: {
          boardToken,
          fetchedAt: options.now.toISOString(),
        },
      };
    },
  };
}

function parseDateValue(value: string | null | undefined) {
  if (!value) return null;

  const parsedValue = new Date(value);
  if (Number.isNaN(parsedValue.getTime())) return null;
  return parsedValue;
}
