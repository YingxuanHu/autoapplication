import type { Prisma } from "@/generated/prisma/client";
import type {
  EmploymentType,
  WorkMode,
} from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";
import {
  buildTimeoutSignal,
  throwIfAborted,
} from "@/lib/ingestion/runtime-control";

type RecruiteeConnectorOptions = {
  companyIdentifier: string;
  companyName?: string;
};

type RecruiteeSalary = {
  min?: string | null;
  max?: string | null;
  currency?: string | null;
  period?: string | null;
};

type RecruiteeLocation = {
  id?: number | null;
  name?: string | null;
  state?: string | null;
  country?: string | null;
  city?: string | null;
  country_code?: string | null;
  state_code?: string | null;
  street?: string | null;
  postal_code?: string | null;
  note?: string | null;
};

type RecruiteeOffer = {
  id: number | string;
  guid?: string | null;
  slug?: string | null;
  title: string;
  company_name?: string | null;
  description?: string | null;
  requirements?: string | null;
  careers_url?: string | null;
  careers_apply_url?: string | null;
  city?: string | null;
  country?: string | null;
  state_name?: string | null;
  state_code?: string | null;
  location?: string | null;
  remote?: boolean | null;
  hybrid?: boolean | null;
  on_site?: boolean | null;
  published_at?: string | null;
  updated_at?: string | null;
  close_at?: string | null;
  employment_type_code?: string | null;
  experience_code?: string | null;
  category_code?: string | null;
  department?: string | null;
  status?: string | null;
  salary?: RecruiteeSalary | null;
  locations?: RecruiteeLocation[] | null;
};

type RecruiteeOffersResponse =
  | {
      offers?: RecruiteeOffer[] | null;
    }
  | RecruiteeOffer[];

export function createRecruiteeConnector({
  companyIdentifier,
  companyName,
}: RecruiteeConnectorOptions): SourceConnector {
  const resolvedCompanyName = companyName ?? buildCompanyName(companyIdentifier);

  return {
    key: `recruitee:${companyIdentifier}`,
    sourceName: `Recruitee:${companyIdentifier}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const offers = await fetchOffers(companyIdentifier, options.signal);
      const publishedOffers = offers.filter(
        (offer) => !offer.status || offer.status === "published"
      );
      const selectedOffers =
        typeof options.limit === "number"
          ? publishedOffers.slice(0, options.limit)
          : publishedOffers;

      return {
        jobs: selectedOffers.map((offer) =>
          buildSourceJob({
            companyIdentifier,
            fallbackCompanyName: resolvedCompanyName,
            offer,
          })
        ),
        metadata: {
          companyIdentifier,
          companyName: resolvedCompanyName,
          fetchedAt: options.now.toISOString(),
          publishedOfferCount: publishedOffers.length,
        },
      };
    },
  };
}

async function fetchOffers(companyIdentifier: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const response = await fetch(
    `https://${companyIdentifier}.recruitee.com/api/offers/`,
    {
      headers: {
        Accept: "application/json",
      },
      signal: buildTimeoutSignal(signal, 45_000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Recruitee fetch failed for ${companyIdentifier}: ${response.status} ${response.statusText}`
    );
  }

  throwIfAborted(signal);
  const payload = (await response.json()) as RecruiteeOffersResponse;
  if (Array.isArray(payload)) return payload;
  return payload.offers ?? [];
}

function buildSourceJob({
  companyIdentifier,
  fallbackCompanyName,
  offer,
}: {
  companyIdentifier: string;
  fallbackCompanyName: string;
  offer: RecruiteeOffer;
}): SourceConnectorJob {
  return {
    sourceId: String(offer.guid ?? offer.id),
    sourceUrl: offer.careers_url ?? buildPostingUrl(companyIdentifier, offer.slug),
    title: offer.title,
    company: readText(offer.company_name) || fallbackCompanyName,
    location: buildLocation(offer),
    description: buildDescription(offer),
    applyUrl:
      offer.careers_apply_url ??
      offer.careers_url ??
      buildPostingUrl(companyIdentifier, offer.slug),
    postedAt: parseDateValue(offer.published_at ?? offer.updated_at),
    deadline: parseDateValue(offer.close_at),
    employmentType: inferEmploymentType(offer.employment_type_code),
    workMode: inferWorkMode(offer),
    salaryMin: parseSalaryValue(offer.salary?.min),
    salaryMax: parseSalaryValue(offer.salary?.max),
    salaryCurrency: readText(offer.salary?.currency),
    metadata: {
      offer,
    } as unknown as Prisma.InputJsonValue,
  };
}

function buildPostingUrl(companyIdentifier: string, slug: string | null | undefined) {
  if (!slug) return `https://${companyIdentifier}.recruitee.com/`;
  return `https://${companyIdentifier}.recruitee.com/o/${slug}`;
}

function buildLocation(offer: RecruiteeOffer) {
  const locations = (offer.locations ?? [])
    .map((location) => formatLocation(location))
    .filter(Boolean);

  if (locations.length > 0) {
    return [...new Set(locations)].join(" | ");
  }

  const directLocation = readText(offer.location);
  if (directLocation) return directLocation;

  return [
    readText(offer.city),
    readText(offer.state_name) || readText(offer.state_code),
    readText(offer.country),
  ]
    .filter(Boolean)
    .join(", ") || "Unknown";
}

function formatLocation(location: RecruiteeLocation) {
  const name = readText(location.name);
  if (name) {
    if (/remote/i.test(name)) return name;
  }

  return [
    readText(location.city),
    readText(location.state) || readText(location.state_code),
    readText(location.country),
  ]
    .filter(Boolean)
    .join(", ");
}

function buildDescription(offer: RecruiteeOffer) {
  const description = readText(offer.description);
  const requirements = readText(offer.requirements);
  const sections = [
    description ? `<h2>Role</h2>\n${description}` : null,
    requirements ? `<h2>Requirements</h2>\n${requirements}` : null,
  ].filter(Boolean);

  if (sections.length > 0) return sections.join("\n\n");

  return [
    readText(offer.department),
    readText(offer.category_code),
    readText(offer.experience_code),
  ]
    .filter(Boolean)
    .join(" · ");
}

function inferEmploymentType(
  value: string | null | undefined
): EmploymentType | null {
  const normalized = readLowerText(value);
  if (!normalized) return null;
  if (normalized.includes("intern")) return "INTERNSHIP";
  if (normalized.includes("contract") || normalized.includes("temporary"))
    return "CONTRACT";
  if (normalized.includes("parttime")) return "PART_TIME";
  if (normalized.includes("fulltime")) return "FULL_TIME";
  return null;
}

function inferWorkMode(offer: RecruiteeOffer): WorkMode | null {
  if (offer.hybrid) return "HYBRID";
  if (offer.remote) return "REMOTE";
  if (offer.on_site) return "ONSITE";
  return null;
}

function parseDateValue(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseSalaryValue(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildCompanyName(companyIdentifier: string) {
  return companyIdentifier
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

function readLowerText(value: unknown): string | null {
  const text = readText(value);
  return text ? text.toLowerCase() : null;
}
