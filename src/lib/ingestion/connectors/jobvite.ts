import type {
  EmploymentType,
  WorkMode,
} from "@/generated/prisma/client";
import { throwIfAborted } from "@/lib/ingestion/runtime-control";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";

const DETAIL_BATCH_SIZE = 6;
const JOBVITE_HEADERS = {
  Accept: "text/html,application/xhtml+xml",
  "User-Agent": "Mozilla/5.0 (compatible; autoapplication-jobvite/1.0)",
} satisfies Record<string, string>;
const STRIP_TAGS_RE = /<[^>]+>/g;

type JobviteConnectorOptions = {
  companyToken: string;
  companyName?: string;
};

type JobviteListing = {
  jobId: string;
  detailUrl: string;
  title: string;
  location: string | null;
};

type JobvitePostalAddress = {
  addressLocality?: string | null;
  addressRegion?: string | null;
  addressCountry?: string | null;
  streetAddress?: string | null;
};

type JobvitePlace = {
  address?: JobvitePostalAddress | null;
  name?: string | null;
};

type JobviteSalary = {
  currency?: string | null;
  value?: {
    minValue?: number | string | null;
    maxValue?: number | string | null;
  } | null;
};

type JobviteJobPostingLd = {
  "@type"?: string | string[];
  title?: string | null;
  description?: string | null;
  datePosted?: string | null;
  validThrough?: string | null;
  employmentType?: string | string[] | null;
  jobLocationType?: string | null;
  url?: string | null;
  identifier?: string | { value?: string | null } | null;
  hiringOrganization?: {
    name?: string | null;
  } | null;
  jobLocation?: JobvitePlace | JobvitePlace[] | null;
  baseSalary?: JobviteSalary | null;
};

export function buildJobviteSourceToken(companyToken: string) {
  return companyToken.trim().toLowerCase();
}

export function buildJobviteBoardUrl(companyToken: string) {
  return `https://jobs.jobvite.com/${buildJobviteSourceToken(companyToken)}/jobs`;
}

export function createJobviteConnector({
  companyToken,
  companyName,
}: JobviteConnectorOptions): SourceConnector {
  const normalizedToken = buildJobviteSourceToken(companyToken);

  return {
    key: `jobvite:${normalizedToken}`,
    sourceName: `Jobvite:${normalizedToken}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const boardUrl = buildJobviteBoardUrl(normalizedToken);
      const boardHtml = await fetchText(boardUrl, options.signal);
      const listings = parseJobviteListings(boardHtml, normalizedToken);
      const selectedListings =
        typeof options.limit === "number"
          ? listings.slice(0, options.limit)
          : listings;
      const resolvedCompanyName =
        companyName ??
        extractBoardCompanyName(boardHtml) ??
        buildCompanyName(normalizedToken);
      const log = options.log ?? (() => {});

      const jobs = await mapInBatches(selectedListings, DETAIL_BATCH_SIZE, async (listing) => {
        try {
          return await fetchAndBuildJob({
            listing,
            fallbackCompanyName: resolvedCompanyName,
            signal: options.signal,
          });
        } catch (error) {
          log(
            `[jobvite:${normalizedToken}] Detail fetch failed for ${listing.jobId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          return null;
        }
      });

      return {
        jobs: jobs.filter((job): job is SourceConnectorJob => Boolean(job)),
        metadata: {
          companyToken: normalizedToken,
          companyName: resolvedCompanyName,
          fetchedAt: options.now.toISOString(),
          listingCount: listings.length,
          detailSuccessCount: jobs.filter(Boolean).length,
        },
      };
    },
  };
}

async function fetchAndBuildJob({
  listing,
  fallbackCompanyName,
  signal,
}: {
  listing: JobviteListing;
  fallbackCompanyName: string;
  signal?: AbortSignal;
}): Promise<SourceConnectorJob | null> {
  throwIfAborted(signal);

  const detailHtml = await fetchText(listing.detailUrl, signal);
  const jsonLd = extractJobPostingJsonLd(detailHtml);
  const description = buildDescription(jsonLd?.description, detailHtml);

  if (!description) {
    return null;
  }

  const sourceUrl = readText(jsonLd?.url) ?? listing.detailUrl;
  const applyUrl = extractApplyUrl(detailHtml, listing.detailUrl) ?? sourceUrl;
  const employmentType = inferEmploymentType(jsonLd?.employmentType);
  const workMode = inferWorkMode({
    jobLocationType: jsonLd?.jobLocationType,
    description,
    listingLocation: listing.location,
  });
  const salary = extractSalary(jsonLd?.baseSalary);
  const sourceId = extractIdentifier(jsonLd?.identifier) ?? listing.jobId;

  return {
    sourceId,
    sourceUrl,
    title: readText(jsonLd?.title) ?? listing.title,
    company:
      readText(jsonLd?.hiringOrganization?.name) ?? fallbackCompanyName,
    location:
      buildLocation(jsonLd?.jobLocation, workMode) ??
      listing.location ??
      (workMode === "REMOTE" ? "Remote" : "Unknown"),
    description,
    applyUrl,
    postedAt: parseDateValue(jsonLd?.datePosted),
    deadline: parseDateValue(jsonLd?.validThrough),
    employmentType,
    workMode,
    salaryMin: salary.salaryMin,
    salaryMax: salary.salaryMax,
    salaryCurrency: salary.salaryCurrency,
    metadata: {
      listing,
      detailFetched: true,
      jsonLd,
    },
  } satisfies SourceConnectorJob;
}

async function fetchText(url: string, signal?: AbortSignal) {
  throwIfAborted(signal);

  const response = await fetch(url, {
    signal,
    redirect: "follow",
    headers: JOBVITE_HEADERS,
  });

  if (!response.ok) {
    throw new Error(
      `Jobvite fetch failed: ${response.status} ${response.statusText}`
    );
  }

  return response.text();
}

function parseJobviteListings(html: string, companyToken: string) {
  const matches = html.matchAll(
    /<tr>\s*<td[^>]*class=["'][^"']*jv-job-list-name[^"']*["'][^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td[^>]*class=["'][^"']*jv-job-list-location[^"']*["'][^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi
  );
  const listings: JobviteListing[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const rawHref = decodeHtmlEntities(match[1] ?? "").trim();
    const title = stripHtml(match[2] ?? "");
    const location = normalizeLocation(stripHtml(match[3] ?? ""));

    if (!rawHref || !title) continue;

    let detailUrl: string;
    try {
      detailUrl = new URL(rawHref, buildJobviteBoardUrl(companyToken)).toString();
    } catch {
      continue;
    }

    const jobId = extractJobId(detailUrl);
    if (!jobId || seen.has(jobId)) continue;
    seen.add(jobId);

    listings.push({
      jobId,
      detailUrl,
      title,
      location,
    });
  }

  return listings;
}

function extractJobPostingJsonLd(html: string): JobviteJobPostingLd | null {
  const matches = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const match of matches) {
    const raw = match[1]?.trim();
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw) as unknown;
      const posting = findJobPosting(parsed);
      if (posting) return posting;
    } catch {
      continue;
    }
  }

  return null;
}

function findJobPosting(value: unknown): JobviteJobPostingLd | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }

  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const typeValue = record["@type"];
  const types = Array.isArray(typeValue)
    ? typeValue
    : typeof typeValue === "string"
      ? [typeValue]
      : [];

  if (types.some((type) => String(type).toLowerCase() === "jobposting")) {
    return record as JobviteJobPostingLd;
  }

  if (record["@graph"]) {
    return findJobPosting(record["@graph"]);
  }

  return null;
}

function buildDescription(jsonLdDescription: string | null | undefined, html: string) {
  const fromJsonLd = buildReadableText(jsonLdDescription ?? "");
  if (fromJsonLd.length >= 80) return fromJsonLd;

  const detailMatch =
    html.match(
      /<div[^>]*class=["'][^"']*jv-job-detail-description[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<)/i
    ) ??
    html.match(
      /<section[^>]*class=["'][^"']*jv-job-detail-description[^"']*["'][^>]*>([\s\S]*?)<\/section>/i
    );

  const fromHtml = buildReadableText(detailMatch?.[1] ?? "");
  return fromHtml.length > fromJsonLd.length ? fromHtml : fromJsonLd;
}

function buildLocation(
  rawLocation: JobvitePlace | JobvitePlace[] | null | undefined,
  workMode: WorkMode | null
) {
  const places = Array.isArray(rawLocation)
    ? rawLocation
    : rawLocation
      ? [rawLocation]
      : [];

  const formatted = places
    .map((place) => formatPlace(place))
    .filter((value): value is string => Boolean(value));

  if (formatted.length > 0) {
    return [...new Set(formatted)].join(" | ");
  }

  if (workMode === "REMOTE") {
    return "Remote";
  }

  return null;
}

function formatPlace(place: JobvitePlace) {
  const name = readText(place.name);
  if (name) return name;

  const address = place.address;
  if (!address) return null;

  const parts = [
    readText(address.addressLocality),
    readText(address.addressRegion),
    readText(address.addressCountry),
  ].filter(Boolean);

  if (parts.length > 0) {
    return parts.join(", ");
  }

  return readText(address.streetAddress);
}

function extractApplyUrl(html: string, pageUrl: string) {
  const applyMatch = html.match(
    /<a[^>]*href=["']([^"']+\/apply(?:\?[^"']*)?)["'][^>]*>\s*(?:Apply|Apply Now|Apply for this Job)[\s\S]*?<\/a>/i
  );

  if (!applyMatch?.[1]) return null;

  try {
    return new URL(decodeHtmlEntities(applyMatch[1]), pageUrl).toString();
  } catch {
    return null;
  }
}

function inferEmploymentType(value: string | string[] | null | undefined): EmploymentType | null {
  const normalized = Array.isArray(value)
    ? value.join(" ").toLowerCase()
    : readText(value)?.toLowerCase() ?? "";

  if (!normalized) return null;
  if (normalized.includes("intern")) return "INTERNSHIP";
  if (normalized.includes("contract") || normalized.includes("temporary")) {
    return "CONTRACT";
  }
  if (normalized.includes("part")) return "PART_TIME";
  if (normalized.includes("full")) return "FULL_TIME";
  return null;
}

function inferWorkMode({
  jobLocationType,
  description,
  listingLocation,
}: {
  jobLocationType: string | null | undefined;
  description: string;
  listingLocation: string | null;
}): WorkMode | null {
  const normalized = [
    readText(jobLocationType),
    listingLocation,
    description.slice(0, 2000),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (normalized.includes("telecommute") || normalized.includes("remote")) {
    return "REMOTE";
  }
  if (normalized.includes("hybrid")) {
    return "HYBRID";
  }
  if (normalized.includes("on-site") || normalized.includes("onsite") || normalized.includes("in office")) {
    return "ONSITE";
  }

  return null;
}

function extractSalary(baseSalary: JobviteSalary | null | undefined) {
  const salaryCurrency = readText(baseSalary?.currency) ?? null;
  const salaryMin = parseNumber(baseSalary?.value?.minValue);
  const salaryMax = parseNumber(baseSalary?.value?.maxValue);

  return {
    salaryMin,
    salaryMax,
    salaryCurrency,
  };
}

function extractIdentifier(identifier: JobviteJobPostingLd["identifier"]) {
  if (typeof identifier === "string") {
    return readText(identifier);
  }

  if (identifier && typeof identifier === "object") {
    return readText(identifier.value);
  }

  return null;
}

function extractJobId(detailUrl: string) {
  try {
    const parsed = new URL(detailUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[1] !== "job" || !segments[2]) return null;
    return segments[2];
  } catch {
    return null;
  }
}

function extractBoardCompanyName(html: string) {
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = stripHtml(titleMatch?.[1] ?? "");
  if (!title) return null;

  return title.replace(/\s+careers?$/i, "").trim() || null;
}

function normalizeLocation(location: string | null) {
  if (!location) return null;
  const normalized = location.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function buildReadableText(input: string) {
  return decodeHtmlEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/ul|\/ol|\/section|\/article|\/h[1-6])[^>]*>/gi, "\n")
      .replace(STRIP_TAGS_RE, " ")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  ).slice(0, 24_000);
}

function stripHtml(value: string) {
  return decodeHtmlEntities(value.replace(STRIP_TAGS_RE, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function readText(value: unknown) {
  return typeof value === "string" && value.trim()
    ? decodeHtmlEntities(value).trim()
    : null;
}

function parseDateValue(value: string | null | undefined) {
  const normalized = readText(value);
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseNumber(value: number | string | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function mapInBatches<T, R>(
  items: T[],
  batchSize: number,
  mapper: (item: T) => Promise<R>
) {
  const results: R[] = [];

  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const mapped = await Promise.all(batch.map((item) => mapper(item)));
    results.push(...mapped);
  }

  return results;
}

function buildCompanyName(companyToken: string) {
  return companyToken
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function decodeHtmlEntities(input: string) {
  return input
    .replace(/&#x2013;/gi, "–")
    .replace(/&#x2014;/gi, "—")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x2B;/gi, "+")
    .replace(/&#xE3;/gi, "ã")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&nbsp;/gi, " ");
}
