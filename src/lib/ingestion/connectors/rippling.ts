import type { WorkMode } from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
} from "@/lib/ingestion/types";

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
      const jobs = await fetchJobs(boardSlug, options.limit);

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

async function fetchJobs(boardSlug: string, limit?: number) {
  const response = await fetch(
    `https://api.rippling.com/platform/api/ats/v1/board/${boardSlug}/jobs`,
    { headers: { Accept: "application/json" } }
  );

  if (!response.ok) {
    throw new Error(
      `Rippling fetch failed for ${boardSlug}: ${response.status} ${response.statusText}`
    );
  }

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
  if (!label) return "Unknown";
  const match = label.match(/\(([^)]+)\)/);
  if (match) return match[1].trim();
  // Fall back to the full label if no parens (shouldn't happen in practice)
  return label.trim();
}

function parseWorkMode(label: string | null | undefined): WorkMode | null {
  if (!label) return null;
  const prefix = label.split("(")[0].trim().toLowerCase();
  if (prefix === "remote") return "REMOTE";
  if (prefix === "hybrid") return "HYBRID";
  if (prefix === "on-site" || prefix === "onsite") return "ONSITE";
  if (prefix === "flexible") return "FLEXIBLE";
  return null;
}

function buildDescription(job: RipplingJob): string {
  const parts: string[] = [];

  if (job.department?.label?.trim()) {
    parts.push(`Department: ${job.department.label.trim()}`);
  }
  if (job.workLocation?.label?.trim()) {
    parts.push(`Work location: ${job.workLocation.label.trim()}`);
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
