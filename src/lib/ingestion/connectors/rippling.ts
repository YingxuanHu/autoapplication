import type { WorkMode } from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
} from "@/lib/ingestion/types";
import {
  buildTimeoutSignal,
  throwIfAborted,
} from "@/lib/ingestion/runtime-control";

type RipplingConnectorOptions = {
  boardSlug: string;
  companyName?: string;
};

type RipplingDepartment = {
  id?: string | null;
  label?: string | null;
};

type RipplingWorkLocation = {
  id?: string | null;
  label?: string | null;
};

type RipplingJob = {
  uuid: string;
  name: string;
  department?: RipplingDepartment | null;
  url: string;
  workLocation?: RipplingWorkLocation | null;
};

export function createRipplingConnector({
  boardSlug,
  companyName,
}: RipplingConnectorOptions): SourceConnector {
  const resolvedCompanyName = companyName ?? buildCompanyName(boardSlug);

  return {
    key: `rippling:${boardSlug}`,
    sourceName: `Rippling:${boardSlug}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const jobs = await fetchJobs(boardSlug, options.limit, options.signal);

      return {
        jobs: jobs.map((job) => ({
          sourceId: job.uuid,
          sourceUrl: job.url,
          title: job.name,
          company: resolvedCompanyName,
          location: parseLocation(job.workLocation?.label),
          description: buildDescription(job),
          applyUrl: job.url,
          postedAt: null,
          deadline: null,
          employmentType: null,
          workMode: parseWorkMode(job.workLocation?.label),
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          metadata: job,
        })),
        metadata: {
          boardSlug,
          companyName: resolvedCompanyName,
          fetchedAt: options.now.toISOString(),
          totalFetched: jobs.length,
        },
      };
    },
  };
}

async function fetchJobs(boardSlug: string, limit?: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  const response = await fetch(
    `https://api.rippling.com/platform/api/ats/v1/board/${boardSlug}/jobs`,
    {
      headers: { Accept: "application/json" },
      signal: buildTimeoutSignal(signal, 45_000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Rippling fetch failed for ${boardSlug}: ${response.status} ${response.statusText}`
    );
  }

  throwIfAborted(signal);
  const payload = (await response.json()) as RipplingJob[];
  if (!Array.isArray(payload)) {
    throw new Error(
      `Rippling returned unexpected response shape for ${boardSlug}`
    );
  }

  return typeof limit === "number" ? payload.slice(0, limit) : payload;
}

// workLocation.label format: "Remote (United States)" | "Hybrid (Toronto, CA)" | "On-site (New York, NY)"
// Extract the inner parenthesized portion as the location string.
function parseLocation(label: string | null | undefined): string {
  const text = readText(label);
  if (!text) return "Unknown";
  const match = text.match(/\(([^)]+)\)/);
  if (match) return match[1].trim();
  // Fall back to the full label if no parens (shouldn't happen in practice)
  return text;
}

function parseWorkMode(label: string | null | undefined): WorkMode | null {
  const text = readText(label);
  if (!text) return null;
  const prefix = text.split("(")[0]?.trim().toLowerCase();
  if (!prefix) return null;
  if (prefix === "remote") return "REMOTE";
  if (prefix === "hybrid") return "HYBRID";
  if (prefix === "on-site" || prefix === "onsite") return "ONSITE";
  if (prefix === "flexible") return "FLEXIBLE";
  return null;
}

function buildDescription(job: RipplingJob): string {
  const parts: string[] = [];

  const department = readText(job.department?.label);
  if (department) {
    parts.push(`Department: ${department}`);
  }
  const workLocation = readText(job.workLocation?.label);
  if (workLocation) {
    parts.push(`Work location: ${workLocation}`);
  }

  return parts.join("\n");
}

function buildCompanyName(boardSlug: string): string {
  return boardSlug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}
