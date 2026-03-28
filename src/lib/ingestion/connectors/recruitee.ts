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
      const offers = await fetchOffers(companyIdentifier);
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

async function fetchOffers(companyIdentifier: string) {
  const response = await fetch(
    `https://${companyIdentifier}.recruitee.com/api/offers/`,
    {
      headers: {
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Recruitee fetch failed for ${companyIdentifier}: ${response.status} ${response.statusText}`
    );
  }

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
    company: offer.company_name?.trim() || fallbackCompanyName,
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
    salaryCurrency: offer.salary?.currency?.trim() || null,
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

  if (offer.location?.trim()) return offer.location.trim();

  return [
    offer.city?.trim(),
    offer.state_name?.trim() || offer.state_code?.trim(),
    offer.country?.trim(),
  ]
    .filter(Boolean)
    .join(", ") || "Unknown";
}

function formatLocation(location: RecruiteeLocation) {
  if (location.name?.trim()) {
    const name = location.name.trim();
    if (/remote/i.test(name)) return name;
  }

  return [
    location.city?.trim(),
    location.state?.trim() || location.state_code?.trim(),
    location.country?.trim(),
  ]
    .filter(Boolean)
    .join(", ");
}

function buildDescription(offer: RecruiteeOffer) {
  const sections = [
    offer.description?.trim()
      ? `<h2>Role</h2>\n${offer.description.trim()}`
      : null,
    offer.requirements?.trim()
      ? `<h2>Requirements</h2>\n${offer.requirements.trim()}`
      : null,
  ].filter(Boolean);

  if (sections.length > 0) return sections.join("\n\n");

  return [
    offer.department?.trim(),
    offer.category_code?.trim(),
    offer.experience_code?.trim(),
  ]
    .filter(Boolean)
    .join(" · ");
}

function inferEmploymentType(
  value: string | null | undefined
): EmploymentType | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
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
