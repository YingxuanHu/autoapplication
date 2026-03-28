import type {
  EmploymentType,
  WorkMode,
} from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
} from "@/lib/ingestion/types";

type WorkableConnectorOptions = {
  accountToken: string;
  companyName?: string;
};

type WorkableLocation = {
  city?: string | null;
  region?: string | null;
  country?: string | null;
  country_code?: string | null;
  location_str?: string | null;
};

type WorkablePublicJob = {
  title: string;
  shortcode?: string | null;
  code?: string | null;
  url?: string | null;
  application_url?: string | null;
  employment_type?: string | null;
  work_place?: string | null;
  remote?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
  published?: string | null;
  description?: string | null;
  short_description?: string | null;
  department?: string | null;
  location?: WorkableLocation | null;
  state?: string | null;
};

type WorkablePublicAccountResponse = {
  name?: string | null;
  description?: string | null;
  jobs?: WorkablePublicJob[] | null;
};

export function createWorkableConnector({
  accountToken,
  companyName,
}: WorkableConnectorOptions): SourceConnector {
  return {
    key: `workable:${accountToken}`,
    sourceName: `Workable:${accountToken}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const response = await fetch(
        `https://www.workable.com/api/accounts/${accountToken}`
      );

      if (!response.ok) {
        throw new Error(
          `Workable fetch failed for ${accountToken}: ${response.status} ${response.statusText}`
        );
      }

      const text = await response.text();
      const payload = parseWorkableAccountResponse(accountToken, text);
      const resolvedCompanyName =
        companyName ??
        payload.name?.trim() ??
        buildCompanyName(accountToken);
      const publishedJobs = (payload.jobs ?? []).filter((job) => Boolean(job.title?.trim()));
      const selectedJobs =
        typeof options.limit === "number"
          ? publishedJobs.slice(0, options.limit)
          : publishedJobs;

      return {
        jobs: selectedJobs.map((job) =>
          buildSourceJob({
            accountToken,
            fallbackCompanyName: resolvedCompanyName,
            accountDescription: payload.description ?? null,
            job,
          })
        ),
        metadata: {
          accountToken,
          companyName: resolvedCompanyName,
          fetchedAt: options.now.toISOString(),
          publicJobCount: publishedJobs.length,
        },
      };
    },
  };
}

function parseWorkableAccountResponse(accountToken: string, rawText: string) {
  try {
    return JSON.parse(rawText) as WorkablePublicAccountResponse;
  } catch {
    throw new Error(
      `Workable public account returned non-JSON for ${accountToken}; likely a security challenge or temporary block`
    );
  }
}

function buildSourceJob({
  accountToken,
  fallbackCompanyName,
  accountDescription,
  job,
}: {
  accountToken: string;
  fallbackCompanyName: string;
  accountDescription: string | null;
  job: WorkablePublicJob;
}) {
  const sourceId = String(job.shortcode ?? job.code ?? job.title);
  const postingUrl =
    job.url ??
    buildPostingUrl(accountToken, job.shortcode ?? job.code ?? null);

  return {
    sourceId,
    sourceUrl: postingUrl,
    title: job.title,
    company: fallbackCompanyName,
    location: buildLocation(job),
    description: buildDescription(job, accountDescription),
    applyUrl: job.application_url ?? postingUrl,
    postedAt: parseDateValue(job.published ?? job.created_at ?? job.updated_at),
    deadline: null,
    employmentType: inferEmploymentType(job.employment_type),
    workMode: inferWorkMode(job),
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    metadata: job,
  };
}

function buildPostingUrl(accountToken: string, shortcode: string | null) {
  if (!shortcode) return `https://apply.workable.com/${accountToken}/`;
  return `https://apply.workable.com/${accountToken}/j/${shortcode}/`;
}

function buildLocation(job: WorkablePublicJob) {
  if (job.location?.location_str?.trim()) {
    return job.location.location_str.trim();
  }

  const parts = [
    job.location?.city?.trim(),
    job.location?.region?.trim(),
    job.location?.country?.trim() ?? job.state?.trim(),
  ].filter(Boolean);

  if (parts.length > 0) return parts.join(", ");
  if (job.remote) return "Remote";
  return "Unknown";
}

function buildDescription(job: WorkablePublicJob, accountDescription: string | null) {
  const sections = [
    job.short_description?.trim(),
    job.description?.trim(),
    job.department?.trim(),
    accountDescription?.trim(),
  ].filter(Boolean);

  return sections.join("\n\n");
}

function inferEmploymentType(
  value: string | null | undefined
): EmploymentType | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized.includes("intern")) return "INTERNSHIP";
  if (normalized.includes("contract") || normalized.includes("temporary")) {
    return "CONTRACT";
  }
  if (normalized.includes("part")) return "PART_TIME";
  if (normalized.includes("full")) return "FULL_TIME";
  return null;
}

function inferWorkMode(job: WorkablePublicJob): WorkMode | null {
  if (job.remote) return "REMOTE";

  const normalized = [
    job.work_place,
    job.location?.location_str,
    job.state,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (normalized.includes("remote")) return "REMOTE";
  if (normalized.includes("hybrid")) return "HYBRID";
  if (normalized.includes("on-site") || normalized.includes("onsite")) {
    return "ONSITE";
  }

  return null;
}

function parseDateValue(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function buildCompanyName(accountToken: string) {
  return accountToken
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}
