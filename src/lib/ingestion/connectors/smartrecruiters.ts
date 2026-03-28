import type {
  EmploymentType,
  WorkMode,
} from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
} from "@/lib/ingestion/types";

const SMARTRECRUITERS_PAGE_SIZE = 100;
const DETAIL_BATCH_SIZE = 8;

type SmartRecruitersConnectorOptions = {
  companyIdentifier: string;
  companyName?: string;
};

type SmartRecruitersListingResponse = {
  offset: number;
  limit: number;
  totalFound: number;
  content: SmartRecruitersListing[];
};

type SmartRecruitersLocation = {
  city?: string | null;
  region?: string | null;
  country?: string | null;
  remote?: boolean | null;
  hybrid?: boolean | null;
  fullLocation?: string | null;
};

type SmartRecruitersValueLabel = {
  id?: string | null;
  label?: string | null;
};

type SmartRecruitersCompany = {
  identifier?: string | null;
  name?: string | null;
};

type SmartRecruitersListing = {
  id: string;
  name: string;
  refNumber?: string | null;
  releasedDate?: string | null;
  postingUrl?: string | null;
  applyUrl?: string | null;
  location?: SmartRecruitersLocation | null;
  company?: SmartRecruitersCompany | null;
  department?: SmartRecruitersValueLabel | null;
  function?: SmartRecruitersValueLabel | null;
  industry?: SmartRecruitersValueLabel | null;
  typeOfEmployment?: SmartRecruitersValueLabel | null;
  experienceLevel?: SmartRecruitersValueLabel | null;
};

type SmartRecruitersDetailSection = {
  title?: string | null;
  text?: string | null;
};

type SmartRecruitersDetail = SmartRecruitersListing & {
  jobAd?: {
    sections?: Record<string, SmartRecruitersDetailSection> | null;
  } | null;
};

export function createSmartRecruitersConnector({
  companyIdentifier,
  companyName,
}: SmartRecruitersConnectorOptions): SourceConnector {
  const resolvedCompanyName =
    companyName ?? buildCompanyName(companyIdentifier);

  return {
    key: `smartrecruiters:${companyIdentifier}`,
    sourceName: `SmartRecruiters:${companyIdentifier}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const listings = await fetchAllListings({
        companyIdentifier,
        limit: options.limit,
      });

      const jobs = await mapInBatches(
        listings,
        DETAIL_BATCH_SIZE,
        async (listing) => buildSourceJob({
          companyIdentifier,
          fallbackCompanyName: resolvedCompanyName,
          listing,
        })
      );

      return {
        jobs,
        metadata: {
          companyIdentifier,
          companyName: resolvedCompanyName,
          fetchedAt: options.now.toISOString(),
          pageSize: SMARTRECRUITERS_PAGE_SIZE,
        },
      };
    },
  };
}

async function fetchAllListings({
  companyIdentifier,
  limit,
}: {
  companyIdentifier: string;
  limit?: number;
}) {
  const listings: SmartRecruitersListing[] = [];
  let offset = 0;

  while (true) {
    const response = await fetch(
      `https://api.smartrecruiters.com/v1/companies/${companyIdentifier}/postings?limit=${SMARTRECRUITERS_PAGE_SIZE}&offset=${offset}`,
      {
        headers: {
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `SmartRecruiters fetch failed for ${companyIdentifier}: ${response.status} ${response.statusText}`
      );
    }

    const payload = (await response.json()) as SmartRecruitersListingResponse;
    if (payload.content.length === 0) break;

    listings.push(...payload.content);
    offset += payload.content.length;

    if (typeof limit === "number" && listings.length >= limit) {
      return listings.slice(0, limit);
    }

    if (offset >= payload.totalFound) break;
  }

  return listings;
}

async function buildSourceJob({
  companyIdentifier,
  fallbackCompanyName,
  listing,
}: {
  companyIdentifier: string;
  fallbackCompanyName: string;
  listing: SmartRecruitersListing;
}) {
  const shouldFetchDetail = mayNeedDetailFetch(listing);
  const detail = shouldFetchDetail
    ? await fetchPostingDetail(companyIdentifier, listing.id)
    : null;

  const sourceRecord = detail ?? listing;
  const location = buildLocation(sourceRecord.location);
  const description = detail
    ? buildDetailDescription(detail)
    : buildListingDescription(listing);

  return {
    sourceId: sourceRecord.id,
    sourceUrl: sourceRecord.postingUrl ?? sourceRecord.applyUrl ?? null,
    title: sourceRecord.name,
    company: sourceRecord.company?.name ?? fallbackCompanyName,
    location,
    description,
    applyUrl:
      sourceRecord.applyUrl ?? sourceRecord.postingUrl ?? "",
    postedAt: parseDateValue(sourceRecord.releasedDate),
    deadline: null,
    employmentType: inferEmploymentType(sourceRecord.typeOfEmployment?.label),
    workMode: inferWorkMode(sourceRecord.location),
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    metadata: {
      listing,
      detailFetched: Boolean(detail),
      detail,
    },
  };
}

async function fetchPostingDetail(companyIdentifier: string, postingId: string) {
  const response = await fetch(
    `https://api.smartrecruiters.com/v1/companies/${companyIdentifier}/postings/${postingId}`,
    {
      headers: {
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `SmartRecruiters detail fetch failed for ${companyIdentifier}/${postingId}: ${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as SmartRecruitersDetail;
}

function mayNeedDetailFetch(listing: SmartRecruitersListing) {
  const title = listing.name.toLowerCase();
  const location = buildLocation(listing.location).toLowerCase();

  const isNorthAmerica =
    /\b(united states|usa|canada|remote)\b/.test(location) ||
    /\b(us|ca)\b/.test(listing.location?.country ?? "");
  const isLikelySupportedRole =
    /\b(engineer|developer|frontend|backend|full stack|data|analyst|finance|risk|compliance|security|product|qa|operations)\b/.test(
      title
    );

  return isNorthAmerica && isLikelySupportedRole;
}

function buildLocation(location: SmartRecruitersLocation | null | undefined) {
  if (!location) return "Unknown";
  if (location.fullLocation?.trim()) return location.fullLocation.trim();

  return [location.city, location.region, location.country]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(", ");
}

function buildListingDescription(listing: SmartRecruitersListing) {
  return [
    listing.function?.label,
    listing.department?.label,
    listing.industry?.label,
    listing.experienceLevel?.label,
  ]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(" · ");
}

function buildDetailDescription(detail: SmartRecruitersDetail) {
  const sections = Object.values(detail.jobAd?.sections ?? {})
    .map((section) => {
      const body = stripHtml(section.text ?? "");
      if (!body) return "";
      const title = section.title?.trim();
      return title ? `${title}\n${body}` : body;
    })
    .filter(Boolean);

  if (sections.length > 0) {
    return sections.join("\n\n");
  }

  return buildListingDescription(detail);
}

function stripHtml(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function parseDateValue(value: string | null | undefined) {
  if (!value) return null;

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
  if (normalizedValue.includes("full") || normalizedValue.includes("permanent")) {
    return "FULL_TIME";
  }
  return null;
}

function inferWorkMode(location: SmartRecruitersLocation | null | undefined): WorkMode | null {
  if (!location) return null;
  if (location.remote) return "REMOTE";
  if (location.hybrid) return "HYBRID";
  return null;
}

function buildCompanyName(companyIdentifier: string) {
  return companyIdentifier
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

async function mapInBatches<TInput, TOutput>(
  items: TInput[],
  batchSize: number,
  mapper: (item: TInput) => Promise<TOutput>
) {
  const results: TOutput[] = [];

  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const batchResults = await Promise.all(batch.map((item) => mapper(item)));
    results.push(...batchResults);
  }

  return results;
}
