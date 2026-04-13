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
const TEAMTAILOR_HEADERS = {
  Accept: "text/html,application/xhtml+xml",
  "User-Agent": "Mozilla/5.0 (compatible; autoapplication-teamtailor/1.0)",
} satisfies Record<string, string>;
const STRIP_TAGS_RE = /<[^>]+>/g;

type TeamtailorConnectorOptions = {
  companyToken: string;
  companyName?: string;
};

type TeamtailorListing = {
  jobId: string;
  detailUrl: string;
  title: string;
  location: string | null;
  remoteStatus: string | null;
  department: string | null;
};

type TeamtailorPostalAddress = {
  addressLocality?: string | null;
  addressRegion?: string | null;
  addressCountry?: string | null;
  streetAddress?: string | null;
};

type TeamtailorPlace = {
  address?: TeamtailorPostalAddress | null;
  name?: string | null;
};

type TeamtailorSalaryValue =
  | {
      minValue?: number | string | null;
      maxValue?: number | string | null;
      value?: number | string | null;
    }
  | number
  | string
  | null;

type TeamtailorSalary = {
  currency?: string | null;
  value?: TeamtailorSalaryValue;
};

type TeamtailorJobPostingLd = {
  "@type"?: string | string[];
  title?: string | null;
  description?: string | null;
  identifier?: string | { value?: string | null } | null;
  datePosted?: string | null;
  validThrough?: string | null;
  employmentType?: string | string[] | null;
  hiringOrganization?: {
    name?: string | null;
  } | null;
  jobLocationType?: string | null;
  jobLocation?: TeamtailorPlace | TeamtailorPlace[] | null;
  baseSalary?: TeamtailorSalary | null;
  url?: string | null;
};

export function buildTeamtailorSourceToken(companyToken: string) {
  return companyToken.trim().toLowerCase();
}

export function buildTeamtailorBoardUrl(companyToken: string) {
  return `https://${buildTeamtailorSourceToken(companyToken)}.teamtailor.com/jobs`;
}

export function createTeamtailorConnector({
  companyToken,
  companyName,
}: TeamtailorConnectorOptions): SourceConnector {
  const normalizedToken = buildTeamtailorSourceToken(companyToken);

  return {
    key: `teamtailor:${normalizedToken}`,
    sourceName: `Teamtailor:${normalizedToken}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const boardUrl = buildTeamtailorBoardUrl(normalizedToken);
      const boardHtml = await fetchText(boardUrl, options.signal);
      const listings = parseTeamtailorListings(boardHtml, normalizedToken);
      const selectedListings =
        typeof options.limit === "number"
          ? listings.slice(0, options.limit)
          : listings;
      const resolvedCompanyName =
        companyName ??
        extractBoardCompanyName(boardHtml) ??
        buildCompanyName(normalizedToken);
      const log = options.log ?? (() => {});

      const jobs = await mapInBatches(
        selectedListings,
        DETAIL_BATCH_SIZE,
        async (listing) => {
          try {
            return await fetchAndBuildJob({
              listing,
              fallbackCompanyName: resolvedCompanyName,
              signal: options.signal,
            });
          } catch (error) {
            log(
              `[teamtailor:${normalizedToken}] Detail fetch failed for ${listing.jobId}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            return null;
          }
        }
      );

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
  listing: TeamtailorListing;
  fallbackCompanyName: string;
  signal?: AbortSignal;
}): Promise<SourceConnectorJob | null> {
  throwIfAborted(signal);

  const detailHtml = await fetchText(listing.detailUrl, signal);
  const jsonLd = extractJobPostingJsonLd(detailHtml);
  const description = buildReadableText(jsonLd?.description ?? "");

  if (!description) {
    return null;
  }

  const remoteStatus = extractLabeledValue(detailHtml, "Remote status");
  const detailLocations = extractLabeledValue(detailHtml, "Locations");
  const sourceUrl = readText(jsonLd?.url) ?? listing.detailUrl;
  const workMode = inferWorkMode({
    jobLocationType: jsonLd?.jobLocationType,
    remoteStatus,
    listingRemoteStatus: listing.remoteStatus,
    description,
  });
  const salary = extractSalary(jsonLd?.baseSalary);
  const sourceId = extractIdentifier(jsonLd?.identifier) ?? listing.jobId;
  const location =
    buildLocation(jsonLd?.jobLocation, detailLocations, listing.location, workMode) ??
    (workMode === "REMOTE" ? "Remote" : "Unknown");

  return {
    sourceId,
    sourceUrl,
    title: readText(jsonLd?.title) ?? listing.title,
    company:
      readText(jsonLd?.hiringOrganization?.name) ?? fallbackCompanyName,
    location,
    description,
    applyUrl: sourceUrl,
    postedAt: parseDateValue(jsonLd?.datePosted),
    deadline: parseDateValue(jsonLd?.validThrough),
    employmentType: inferEmploymentType(jsonLd?.employmentType),
    workMode,
    salaryMin: salary.salaryMin,
    salaryMax: salary.salaryMax,
    salaryCurrency: salary.salaryCurrency,
    metadata: {
      listing,
      remoteStatus,
      detailLocations,
      department:
        extractLabeledValue(detailHtml, "Department") ?? listing.department,
      jsonLd,
    },
  } satisfies SourceConnectorJob;
}

async function fetchText(url: string, signal?: AbortSignal) {
  throwIfAborted(signal);

  const response = await fetch(url, {
    signal,
    redirect: "follow",
    headers: TEAMTAILOR_HEADERS,
  });

  if (!response.ok) {
    throw new Error(
      `Teamtailor fetch failed: ${response.status} ${response.statusText}`
    );
  }

  return response.text();
}

function parseTeamtailorListings(html: string, companyToken: string) {
  const matches = html.matchAll(
    /<div[^>]*class=["'][^"']*hover:bg-gradient-block-base-bg[^"']*["'][^>]*>\s*<a[^>]*href=["']([^"']+\/jobs\/(\d+)-[^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<div[^>]*class=["'][^"']*text-md[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi
  );
  const listings: TeamtailorListing[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const rawHref = decodeHtmlEntities(match[1] ?? "").trim();
    const jobId = readText(match[2]) ?? extractJobId(rawHref);
    const title = stripHtml(match[3] ?? "");
    const metaParts = stripHtml(match[4] ?? "")
      .split(/\s*[·•]\s*/g)
      .map((value) => value.trim())
      .filter(Boolean);

    if (!rawHref || !jobId || !title || seen.has(jobId)) continue;

    let detailUrl: string;
    try {
      detailUrl = new URL(rawHref, buildTeamtailorBoardUrl(companyToken)).toString();
    } catch {
      continue;
    }

    seen.add(jobId);

    listings.push({
      jobId,
      detailUrl,
      title,
      department: metaParts[0] ?? null,
      location: normalizeLocation(metaParts[1] ?? null),
      remoteStatus: normalizeLocation(metaParts[2] ?? null),
    });
  }

  return listings;
}

function extractJobPostingJsonLd(html: string): TeamtailorJobPostingLd | null {
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

function findJobPosting(value: unknown): TeamtailorJobPostingLd | null {
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
    return record as TeamtailorJobPostingLd;
  }

  if (record["@graph"]) {
    return findJobPosting(record["@graph"]);
  }

  return null;
}

function extractLabeledValue(html: string, label: string) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(
      `<dt[^>]*>\\s*${escapedLabel}\\s*<\\/dt>\\s*<dd[^>]*>([\\s\\S]*?)<\\/dd>`,
      "i"
    )
  );

  return normalizeLocation(stripHtml(match?.[1] ?? ""));
}

function buildLocation(
  rawLocation: TeamtailorPlace | TeamtailorPlace[] | null | undefined,
  detailLocations: string | null,
  listingLocation: string | null,
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

  if (detailLocations) return detailLocations;
  if (listingLocation) return listingLocation;
  if (workMode === "REMOTE") return "Remote";
  return null;
}

function formatPlace(place: TeamtailorPlace) {
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

function inferEmploymentType(
  value: string | string[] | null | undefined
): EmploymentType | null {
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
  remoteStatus,
  listingRemoteStatus,
  description,
}: {
  jobLocationType: string | null | undefined;
  remoteStatus: string | null;
  listingRemoteStatus: string | null;
  description: string;
}): WorkMode | null {
  const normalized = [
    readText(jobLocationType),
    remoteStatus,
    listingRemoteStatus,
    description.slice(0, 1500),
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
  if (
    normalized.includes("on-site") ||
    normalized.includes("onsite") ||
    normalized.includes("in office")
  ) {
    return "ONSITE";
  }

  return null;
}

function extractSalary(baseSalary: TeamtailorSalary | null | undefined) {
  const salaryCurrency = readText(baseSalary?.currency) ?? null;
  const salaryValue = baseSalary?.value;

  if (
    typeof salaryValue === "number" ||
    (typeof salaryValue === "string" && salaryValue.trim())
  ) {
    const parsed = parseNumber(salaryValue);
    return {
      salaryMin: parsed,
      salaryMax: parsed,
      salaryCurrency,
    };
  }

  const structuredValue =
    salaryValue && typeof salaryValue === "object" ? salaryValue : null;

  return {
    salaryMin: parseNumber(structuredValue?.minValue ?? structuredValue?.value),
    salaryMax: parseNumber(structuredValue?.maxValue ?? structuredValue?.value),
    salaryCurrency,
  };
}

function extractIdentifier(identifier: TeamtailorJobPostingLd["identifier"]) {
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
    if (segments[0] !== "jobs" || !segments[1]) return null;
    const idMatch = segments[1].match(/^(\d+)/);
    return idMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

function extractBoardCompanyName(html: string) {
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = stripHtml(titleMatch?.[1] ?? "");
  if (!title) return null;

  return (
    title
      .replace(/\s+jobs?$/i, "")
      .replace(/\s+\|\s+teamtailor$/i, "")
      .trim() || null
  );
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
      .replace(
        /<(br|\/p|\/div|\/li|\/ul|\/ol|\/section|\/article|\/h[1-6])[^>]*>/gi,
        "\n"
      )
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
    const cleaned = value.replace(/[^0-9.+-]/g, "");
    const parsed = Number.parseFloat(cleaned);
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
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&middot;/gi, "·")
    .replace(/&nbsp;/gi, " ");
}
