import type {
  EmploymentType,
  Prisma,
  WorkMode,
} from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
} from "@/lib/ingestion/types";

type LeverConnectorOptions = {
  siteToken: string;
  companyName?: string;
};

type LeverPostingCategory = {
  commitment?: string | null;
  department?: string | null;
  location?: string | null;
  team?: string | null;
  allLocations?: string[] | null;
};

type LeverSalaryRange = {
  min?: number | null;
  max?: number | null;
  currency?: string | null;
  interval?: string | null;
};

type LeverPosting = {
  id: string;
  text: string;
  descriptionPlain?: string | null;
  openingPlain?: string | null;
  additionalPlain?: string | null;
  salaryDescriptionPlain?: string | null;
  applyUrl?: string | null;
  hostedUrl?: string | null;
  createdAt?: number | null;
  categories?: LeverPostingCategory | null;
  workplaceType?: string | null;
  country?: string | null;
  salaryRange?: LeverSalaryRange | null;
};

export function createLeverConnector({
  siteToken,
  companyName,
}: LeverConnectorOptions): SourceConnector {
  const resolvedCompanyName = companyName ?? buildCompanyName(siteToken);

  return {
    key: `lever:${siteToken}`,
    sourceName: `Lever:${siteToken}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const response = await fetch(
        `https://api.lever.co/v0/postings/${siteToken}?mode=json`,
        {
          headers: {
            Accept: "application/json",
          },
        }
      );

      if (!response.ok) {
        console.error(
          `[lever:${siteToken}] Fetch failed: ${response.status} ${response.statusText}`
        );
        return {
          jobs: [],
          metadata: {
            siteToken,
            error: `${response.status} ${response.statusText}`,
            fetchedAt: options.now.toISOString(),
          } as Prisma.InputJsonValue,
        };
      }

      const payload = (await response.json()) as LeverPosting[];
      const jobs = typeof options.limit === "number"
        ? payload.slice(0, options.limit)
        : payload;

      return {
        jobs: jobs.map((job) => ({
          sourceId: job.id,
          sourceUrl: job.hostedUrl ?? job.applyUrl ?? null,
          title: job.text,
          company: resolvedCompanyName,
          location: buildLocation(job),
          description: buildDescription(job),
          applyUrl: job.applyUrl ?? job.hostedUrl ?? "",
          postedAt: parseTimestamp(job.createdAt),
          deadline: null,
          employmentType: inferEmploymentType(job.categories?.commitment),
          workMode: inferWorkMode(job.workplaceType),
          salaryMin: job.salaryRange?.min ?? null,
          salaryMax: job.salaryRange?.max ?? null,
          salaryCurrency: job.salaryRange?.currency ?? null,
          metadata: job,
        })),
        metadata: {
          siteToken,
          fetchedAt: options.now.toISOString(),
          companyName: resolvedCompanyName,
        },
      };
    },
  };
}

function buildLocation(job: LeverPosting) {
  const allLocations = job.categories?.allLocations?.map((value) => value.trim()).filter(Boolean);
  if (allLocations && allLocations.length > 0) {
    return [...new Set(allLocations)].join(", ");
  }

  const directLocation = job.categories?.location?.trim();
  if (directLocation) return directLocation;

  const country = job.country?.trim();
  return country || "Unknown";
}

function buildDescription(job: LeverPosting) {
  const sections = [
    job.descriptionPlain,
    job.openingPlain,
    job.additionalPlain,
    job.salaryDescriptionPlain,
  ]
    .map((value) => value?.trim())
    .filter(Boolean);

  return sections.join("\n\n");
}

function parseTimestamp(value: number | null | undefined) {
  if (typeof value !== "number") return null;

  const parsedValue = new Date(value);
  if (Number.isNaN(parsedValue.getTime())) return null;
  return parsedValue;
}

function inferEmploymentType(value: string | null | undefined): EmploymentType | null {
  if (!value) return null;

  const normalizedValue = value.toLowerCase();
  if (normalizedValue.includes("intern")) return "INTERNSHIP";
  if (normalizedValue.includes("contract") || normalizedValue.includes("temporary")) {
    return "CONTRACT";
  }
  if (normalizedValue.includes("part")) return "PART_TIME";
  if (normalizedValue.includes("full")) return "FULL_TIME";
  return null;
}

function inferWorkMode(value: string | null | undefined): WorkMode | null {
  if (!value) return null;

  const normalizedValue = value.toLowerCase();
  if (normalizedValue.includes("remote")) return "REMOTE";
  if (normalizedValue.includes("hybrid")) return "HYBRID";
  if (normalizedValue.includes("on-site") || normalizedValue.includes("onsite")) {
    return "ONSITE";
  }
  if (normalizedValue.includes("flex")) return "FLEXIBLE";
  return null;
}

function buildCompanyName(siteToken: string) {
  return siteToken
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}
