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
import { throwIfAborted } from "@/lib/ingestion/runtime-control";

const WORKDAY_PAGE_SIZE = 20;
const WORKDAY_DETAIL_CONCURRENCY = 6;
const WORKDAY_SOURCE_TOKEN_SEPARATOR = "|";

type WorkdayConnectorOptions = {
  sourceToken?: string;
  host?: string;
  tenant?: string;
  site?: string;
  companyName?: string;
};

type WorkdaySourceTarget = {
  host: string;
  tenant: string;
  site: string;
};

type WorkdayListJob = {
  title: string;
  externalPath: string;
  locationsText?: string | null;
  postedOn?: string | null;
  remoteType?: string | null;
  bulletFields?: string[] | null;
};

type WorkdayListResponse = {
  total?: number | null;
  jobPostings?: WorkdayListJob[] | null;
};

type WorkdayJobPostingIdentifier = {
  name?: string | null;
  value?: string | null;
};

type WorkdayPostalAddress = {
  addressCountry?: string | null;
  addressLocality?: string | null;
  addressRegion?: string | null;
  streetAddress?: string | null;
};

type WorkdayPlace = {
  "@type"?: string | string[] | null;
  address?: WorkdayPostalAddress | null;
  name?: string | null;
};

type WorkdayQuantitativeValue = {
  minValue?: number | string | null;
  maxValue?: number | string | null;
  value?: number | string | null;
  unitText?: string | null;
};

type WorkdayMonetaryAmount = {
  currency?: string | null;
  value?: WorkdayQuantitativeValue | number | string | null;
};

type WorkdayHiringOrganization = {
  name?: string | null;
};

type WorkdayJobPostingLd = {
  "@type"?: string | string[] | null;
  title?: string | null;
  description?: string | null;
  datePosted?: string | null;
  validThrough?: string | null;
  employmentType?: string | string[] | null;
  identifier?: WorkdayJobPostingIdentifier | null;
  hiringOrganization?: WorkdayHiringOrganization | null;
  jobLocation?: WorkdayPlace | WorkdayPlace[] | null;
  applicantLocationRequirements?: WorkdayPlace | WorkdayPlace[] | null;
  jobLocationType?: string | null;
  url?: string | null;
  baseSalary?: WorkdayMonetaryAmount | null;
};

type WorkdayRuntimeConfig = {
  locale?: string | null;
  requestLocale?: string | null;
  siteId?: string | null;
  tenant?: string | null;
};

type WorkdayJobDetail = {
  pageUrl: string;
  detailUrl: string;
  jsonLd: WorkdayJobPostingLd | null;
  runtimeConfig: WorkdayRuntimeConfig | null;
};

type WorkdayCheckpoint = {
  offset: number;
};

export function buildWorkdaySourceToken({
  host,
  tenant,
  site,
}: WorkdaySourceTarget) {
  return [host, tenant, site]
    .map((segment) => segment.trim().toLowerCase())
    .join(WORKDAY_SOURCE_TOKEN_SEPARATOR);
}

export function parseWorkdaySourceToken(token: string): WorkdaySourceTarget {
  const [host, tenant, site] = token
    .split(WORKDAY_SOURCE_TOKEN_SEPARATOR)
    .map((segment) => segment.trim().toLowerCase());

  if (!host || !tenant || !site) {
    throw new Error(
      `Invalid Workday source token "${token}". Expected host|tenant|site.`
    );
  }

  return { host, tenant, site };
}

export function buildWorkdayBoardUrl(tokenOrTarget: string | WorkdaySourceTarget) {
  const target =
    typeof tokenOrTarget === "string"
      ? parseWorkdaySourceToken(tokenOrTarget)
      : tokenOrTarget;
  return `https://${target.host}/${target.site}`;
}

export function buildWorkdayApiUrl(tokenOrTarget: string | WorkdaySourceTarget) {
  const target =
    typeof tokenOrTarget === "string"
      ? parseWorkdaySourceToken(tokenOrTarget)
      : tokenOrTarget;
  return `https://${target.host}/wday/cxs/${target.tenant}/${target.site}/jobs`;
}

export function createWorkdayConnector(
  options: WorkdayConnectorOptions
): SourceConnector {
  const target = resolveSourceTarget(options);
  const sourceToken = buildWorkdaySourceToken(target);
  const resolvedCompanyName =
    options.companyName ?? buildCompanyName(target.tenant);
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: `workday:${sourceToken}`,
    sourceName: `Workday:${sourceToken}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const cacheKey = JSON.stringify({
        limit: options.limit ?? "all",
        checkpoint: options.checkpoint ?? null,
      });
      const existing = fetchCache.get(cacheKey);
      if (existing) return existing;

      const request = fetchWorkdayJobs({
        target,
        fallbackCompanyName: resolvedCompanyName,
        now: options.now,
        limit: options.limit,
        signal: options.signal,
        checkpoint: parseWorkdayCheckpoint(options.checkpoint),
        onCheckpoint: options.onCheckpoint,
      });
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchWorkdayJobs({
  target,
  fallbackCompanyName,
  now,
  limit,
  signal,
  checkpoint,
  onCheckpoint,
}: {
  target: WorkdaySourceTarget;
  fallbackCompanyName: string;
  now: Date;
  limit?: number;
  signal?: AbortSignal;
  checkpoint?: WorkdayCheckpoint | null;
  onCheckpoint?: (checkpoint: Prisma.InputJsonValue | null) => Promise<void> | void;
}): Promise<SourceConnectorFetchResult> {
  const jobs: SourceConnectorJob[] = [];
  let offset = checkpoint?.offset ?? 0;
  let total: number | null = null;
  let exhausted = false;

  while (true) {
    throwIfAborted(signal);
    const remaining =
      typeof limit === "number" ? Math.max(limit - jobs.length, 0) : null;
    if (remaining === 0) break;

    const requestedLimit =
      typeof remaining === "number"
        ? Math.min(WORKDAY_PAGE_SIZE, remaining)
        : WORKDAY_PAGE_SIZE;

    const payload = await fetchListingPage(target, requestedLimit, offset, signal);
    const postings = (payload.jobPostings ?? []).filter((job) =>
      Boolean(job.title?.trim() && job.externalPath?.trim())
    );

    if (typeof payload.total === "number" && payload.total > 0) {
      total = payload.total;
    }

    if (postings.length === 0) {
      exhausted = true;
      await onCheckpoint?.(null);
      break;
    }

    const pageJobs = await mapWithConcurrency(
      postings,
      WORKDAY_DETAIL_CONCURRENCY,
      async (job) =>
        buildSourceJob({
          target,
          fallbackCompanyName,
          now,
          job,
          signal,
        })
    );
    jobs.push(...pageJobs);
    offset += postings.length;

    const sourceExhausted =
      (typeof total === "number" && offset >= total) ||
      postings.length < requestedLimit;
    if (sourceExhausted) {
      exhausted = true;
      await onCheckpoint?.(null);
      break;
    }

    if (typeof limit === "number" && jobs.length >= limit) {
      await onCheckpoint?.({ offset } satisfies WorkdayCheckpoint);
      break;
    }

    await onCheckpoint?.({ offset } satisfies WorkdayCheckpoint);
  }

  return {
    jobs,
    checkpoint: exhausted ? null : ({ offset } satisfies WorkdayCheckpoint),
    exhausted,
    metadata: {
      host: target.host,
      tenant: target.tenant,
      site: target.site,
      boardUrl: buildWorkdayBoardUrl(target),
      apiUrl: buildWorkdayApiUrl(target),
      fetchedAt: now.toISOString(),
      totalFetched: jobs.length,
      resumedFromCheckpoint: checkpoint ?? null,
    } as Prisma.InputJsonValue,
  };
}

async function fetchListingPage(
  target: WorkdaySourceTarget,
  requestedLimit: number,
  offset: number,
  signal?: AbortSignal
) {
  throwIfAborted(signal);
  const response = await fetch(buildWorkdayApiUrl(target), {
    method: "POST",
    signal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; autoapplication-workday/1.0)",
    },
    body: JSON.stringify({
      appliedFacets: {},
      limit: requestedLimit,
      offset,
      searchText: "",
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Workday fetch failed for ${buildWorkdaySourceToken(target)}: ${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as WorkdayListResponse;
}

async function buildSourceJob({
  target,
  fallbackCompanyName,
  now,
  job,
  signal,
}: {
  target: WorkdaySourceTarget;
  fallbackCompanyName: string;
  now: Date;
  job: WorkdayListJob;
  signal?: AbortSignal;
}): Promise<SourceConnectorJob> {
  const detail = await fetchJobDetail(target, job.externalPath, signal);
  const jsonLd = detail.jsonLd;
  const pageUrl = jsonLd?.url?.trim() || detail.pageUrl;
  const salary = extractSalary(jsonLd?.baseSalary ?? null);
  const workMode = inferWorkMode({
    jsonLd,
    listJob: job,
  });

  return {
    sourceId:
      jsonLd?.identifier?.value?.trim() ||
      findReferenceId(job.bulletFields) ||
      job.externalPath,
    sourceUrl: detail.pageUrl,
    title: jsonLd?.title?.trim() || job.title,
    company:
      jsonLd?.hiringOrganization?.name?.trim() || fallbackCompanyName,
    location: buildLocation({
      jsonLd,
      listJob: job,
      workMode,
    }),
    description:
      jsonLd?.description?.trim() || buildFallbackDescription(job, detail.runtimeConfig),
    applyUrl: pageUrl,
    postedAt:
      parseDateValue(jsonLd?.datePosted) ??
      parseRelativePostedOn(job.postedOn, now),
    deadline: parseDateValue(jsonLd?.validThrough),
    employmentType: inferEmploymentType(jsonLd?.employmentType),
    workMode,
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    metadata: {
      listJob: job,
      detail: {
        pageUrl: detail.pageUrl,
        detailUrl: detail.detailUrl,
        jsonLd,
        runtimeConfig: detail.runtimeConfig,
      },
    } as Prisma.InputJsonValue,
  };
}

function parseWorkdayCheckpoint(value: Prisma.InputJsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const offset = typeof record.offset === "number" ? record.offset : null;
  if (offset == null || !Number.isFinite(offset) || offset < 0) return null;
  return { offset } satisfies WorkdayCheckpoint;
}

async function fetchJobDetail(
  target: WorkdaySourceTarget,
  externalPath: string,
  signal?: AbortSignal
): Promise<WorkdayJobDetail> {
  const detailUrl = buildDetailPageUrl(target, externalPath);
  const localeDetailUrl = buildDetailPageUrl(target, externalPath, "en-US");

  for (const pageUrl of [...new Set([detailUrl, localeDetailUrl])]) {
    throwIfAborted(signal);
    const response = await fetch(pageUrl, {
      signal,
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 (compatible; autoapplication-workday/1.0)",
      },
    });

    if (!response.ok) {
      continue;
    }

    const html = await response.text();
    const jsonLd = extractJobPostingJsonLd(html);
    const runtimeConfig = extractWorkdayRuntimeConfig(html);

    if (jsonLd || runtimeConfig) {
      return {
        pageUrl,
        detailUrl,
        jsonLd,
        runtimeConfig,
      };
    }
  }

  return {
    pageUrl: detailUrl,
    detailUrl,
    jsonLd: null,
    runtimeConfig: null,
  };
}

function extractJobPostingJsonLd(html: string): WorkdayJobPostingLd | null {
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

function extractWorkdayRuntimeConfig(html: string): WorkdayRuntimeConfig | null {
  const match = html.match(/window\.workday\s*=\s*(\{[\s\S]*?\});/i);
  if (!match?.[1]) return null;

  try {
    return JSON.parse(match[1]) as WorkdayRuntimeConfig;
  } catch {
    return null;
  }
}

function findJobPosting(value: unknown): WorkdayJobPostingLd | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }

  if (!value || typeof value !== "object") return null;

  const typedValue = value as Record<string, unknown>;
  const typeValue = typedValue["@type"];
  const types = Array.isArray(typeValue)
    ? typeValue
    : typeof typeValue === "string"
      ? [typeValue]
      : [];

  if (types.some((type) => String(type).toLowerCase() === "jobposting")) {
    return typedValue as WorkdayJobPostingLd;
  }

  if (typedValue["@graph"]) {
    return findJobPosting(typedValue["@graph"]);
  }

  return null;
}

function buildLocation({
  jsonLd,
  listJob,
  workMode,
}: {
  jsonLd: WorkdayJobPostingLd | null;
  listJob: WorkdayListJob;
  workMode: WorkMode | null;
}) {
  const applicantLocations = formatPlaces(jsonLd?.applicantLocationRequirements);
  if (workMode === "REMOTE" && applicantLocations.length > 0) {
    return applicantLocations.join(" | ");
  }

  const locations = formatPlaces(jsonLd?.jobLocation);
  if (locations.length > 0) {
    return locations.join(" | ");
  }

  if (listJob.locationsText?.trim()) {
    return listJob.locationsText.trim();
  }

  if (workMode === "REMOTE") {
    return applicantLocations[0] ?? "Remote";
  }

  return "Unknown";
}

function formatPlaces(value: WorkdayPlace | WorkdayPlace[] | null | undefined) {
  const places = Array.isArray(value) ? value : value ? [value] : [];
  const formatted = places
    .map((place) => formatPlace(place))
    .filter(Boolean)
    .map((location) => location!);

  return [...new Set(formatted)];
}

function formatPlace(place: WorkdayPlace) {
  if (place.name?.trim()) {
    return place.name.trim();
  }

  const address = place.address;
  if (!address) return null;

  const parts = [
    address.addressLocality?.trim(),
    address.addressRegion?.trim(),
    address.addressCountry?.trim(),
  ].filter(Boolean);

  if (parts.length > 0) return parts.join(", ");
  return address.streetAddress?.trim() || null;
}

function inferWorkMode({
  jsonLd,
  listJob,
}: {
  jsonLd: WorkdayJobPostingLd | null;
  listJob: WorkdayListJob;
}): WorkMode | null {
  const combined = [
    jsonLd?.jobLocationType,
    listJob.remoteType,
    listJob.locationsText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    combined.includes("telecommute") ||
    combined.includes("remote")
  ) {
    return "REMOTE";
  }

  if (combined.includes("hybrid")) return "HYBRID";
  if (combined.includes("on-site") || combined.includes("onsite")) {
    return "ONSITE";
  }

  if (jsonLd?.jobLocation || listJob.locationsText?.trim()) {
    return "ONSITE";
  }

  return null;
}

function inferEmploymentType(
  value: string | string[] | null | undefined
): EmploymentType | null {
  const values = Array.isArray(value) ? value : value ? [value] : [];

  for (const item of values) {
    const normalized = item.toLowerCase();
    if (normalized.includes("intern")) return "INTERNSHIP";
    if (normalized.includes("contract") || normalized.includes("temporary")) {
      return "CONTRACT";
    }
    if (normalized.includes("part")) return "PART_TIME";
    if (normalized.includes("full")) return "FULL_TIME";
  }

  return null;
}

function extractSalary(baseSalary: WorkdayMonetaryAmount | null) {
  if (!baseSalary) {
    return {
      min: null,
      max: null,
      currency: null,
    };
  }

  const rawValue = baseSalary.value;
  const value =
    rawValue && typeof rawValue === "object"
      ? (rawValue as WorkdayQuantitativeValue)
      : null;

  return {
    min: parseNumberValue(value?.minValue ?? value?.value ?? null),
    max: parseNumberValue(value?.maxValue ?? value?.value ?? null),
    currency: baseSalary.currency?.trim() || null,
  };
}

function buildFallbackDescription(
  job: WorkdayListJob,
  runtimeConfig: WorkdayRuntimeConfig | null
) {
  return [
    job.locationsText?.trim()
      ? `Locations: ${job.locationsText.trim()}`
      : null,
    job.postedOn?.trim() ? `Posted: ${job.postedOn.trim()}` : null,
    job.remoteType?.trim()
      ? `Remote type: ${job.remoteType.trim()}`
      : null,
    job.bulletFields?.length ? job.bulletFields.join(" · ") : null,
    runtimeConfig?.siteId ? `Site: ${runtimeConfig.siteId}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function findReferenceId(values: string[] | null | undefined) {
  return values?.find((value) => /[A-Z]{2,}-?\d+/i.test(value))?.trim() || null;
}

function parseDateValue(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseRelativePostedOn(value: string | null | undefined, now: Date) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();

  if (normalized.includes("today")) return now;
  if (normalized.includes("yesterday")) {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  const match = normalized.match(/(\d+)\+?\s+(day|week|month|year)s?\s+ago/);
  if (!match) return null;

  const amount = Number.parseInt(match[1] ?? "", 10);
  if (Number.isNaN(amount) || amount <= 0) return null;

  const result = new Date(now);
  const unit = match[2];
  if (unit === "day") result.setDate(result.getDate() - amount);
  if (unit === "week") result.setDate(result.getDate() - amount * 7);
  if (unit === "month") result.setMonth(result.getMonth() - amount);
  if (unit === "year") result.setFullYear(result.getFullYear() - amount);
  return result;
}

function parseNumberValue(value: number | string | null | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildDetailPageUrl(
  target: WorkdaySourceTarget,
  externalPath: string,
  locale?: string
) {
  const normalizedPath = externalPath.startsWith("/")
    ? externalPath
    : `/${externalPath}`;
  const prefix = locale ? `/${locale}/${target.site}` : `/${target.site}`;
  return `https://${target.host}${prefix}${normalizedPath}`;
}

function buildCompanyName(value: string) {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function resolveSourceTarget(options: WorkdayConnectorOptions): WorkdaySourceTarget {
  if (options.sourceToken) {
    return parseWorkdaySourceToken(options.sourceToken);
  }

  if (options.host && options.tenant && options.site) {
    return {
      host: options.host.trim().toLowerCase(),
      tenant: options.tenant.trim().toLowerCase(),
      site: options.site.trim().toLowerCase(),
    };
  }

  throw new Error(
    "Workday connector requires either sourceToken or host+tenant+site."
  );
}

async function mapWithConcurrency<Input, Output>(
  inputs: Input[],
  concurrency: number,
  mapper: (input: Input) => Promise<Output>
) {
  const results = new Array<Output>(inputs.length);
  let cursor = 0;

  async function worker() {
    while (cursor < inputs.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(inputs[index]!);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
