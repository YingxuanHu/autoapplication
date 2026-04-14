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
import { sleepWithAbort, throwIfAborted } from "@/lib/ingestion/runtime-control";

const WORKDAY_PAGE_SIZE = 20;
const WORKDAY_DETAIL_CONCURRENCY = 6;
const WORKDAY_SOURCE_TOKEN_SEPARATOR = "|";
const WORKDAY_LIST_TIMEOUT_MS = 25_000;
const WORKDAY_DETAIL_TIMEOUT_MS = 20_000;
const WORKDAY_FETCH_MAX_ATTEMPTS = 3;
const WORKDAY_FETCH_RETRY_DELAY_MS = 1_500;
const WORKDAY_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

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

type WorkdayFetchSession = {
  landingUrl: string;
  refererUrl: string;
  cookieHeader: string | null;
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
      const log = options.log ?? console.error;
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
        log,
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
  log,
  checkpoint,
  onCheckpoint,
}: {
  target: WorkdaySourceTarget;
  fallbackCompanyName: string;
  now: Date;
  limit?: number;
  signal?: AbortSignal;
  log: (message: string) => void;
  checkpoint?: WorkdayCheckpoint | null;
  onCheckpoint?: (checkpoint: Prisma.InputJsonValue | null) => Promise<void> | void;
}): Promise<SourceConnectorFetchResult> {
  const jobs: SourceConnectorJob[] = [];
  let offset = checkpoint?.offset ?? 0;
  let total: number | null = null;
  let exhausted = false;
  const session = await bootstrapWorkdaySession(target, signal);

  while (true) {
    throwIfAborted(signal);
    const remaining =
      typeof limit === "number" ? Math.max(limit - jobs.length, 0) : null;
    if (remaining === 0) break;

    const requestedLimit =
      typeof remaining === "number"
        ? Math.min(WORKDAY_PAGE_SIZE, remaining)
        : WORKDAY_PAGE_SIZE;

    const payload = await fetchListingPage(
      target,
      requestedLimit,
      offset,
      session,
      signal,
      log
    );
    const postings = (payload.jobPostings ?? []).filter(
      (job) => Boolean(readText(job.title) && readText(job.externalPath))
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
          session,
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
  session: WorkdayFetchSession,
  signal?: AbortSignal,
  log: (message: string) => void = console.error
) {
  const sourceToken = buildWorkdaySourceToken(target);
  const requestUrl = buildWorkdayApiUrl(target);

  for (let attempt = 1; attempt <= WORKDAY_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      throwIfAborted(signal);
      const response = await fetch(requestUrl, {
        method: "POST",
        signal: buildTimeoutSignal(signal, WORKDAY_LIST_TIMEOUT_MS),
        headers: buildWorkdayRequestHeaders(target, {
          accept: "application/json, text/plain, */*",
          contentType: "application/json",
          mode: "api",
          refererUrl: session.refererUrl,
          cookieHeader: session.cookieHeader,
        }),
        body: JSON.stringify({
          appliedFacets: {},
          limit: requestedLimit,
          offset,
          searchText: "",
        }),
      });

      if (!response.ok) {
        throw new Error(
          buildWorkdayResponseErrorMessage({
            target,
            mode: "api",
            method: "POST",
            requestUrl,
            response,
            session,
          })
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        const responseSnippet = await readResponseSnippet(response);
        throw new Error(
          buildWorkdayUnexpectedContentTypeMessage({
            target,
            mode: "api",
            requestUrl,
            response,
            contentType,
            responseSnippet,
            session,
          })
        );
      }

      return (await response.json()) as WorkdayListResponse;
    } catch (error) {
      throwIfAborted(signal);

      if (
        isTransientWorkdayError(error) &&
        attempt < WORKDAY_FETCH_MAX_ATTEMPTS
      ) {
        log(
          `[workday:${sourceToken}] Fetch error: ${formatErrorMessage(error)}; retrying (${attempt}/${WORKDAY_FETCH_MAX_ATTEMPTS})`
        );
        await sleepWithAbort(WORKDAY_FETCH_RETRY_DELAY_MS * attempt, signal);
        continue;
      }

      log(
        `[workday:${sourceToken}] Fetch error: ${formatErrorMessage(error)}`
      );
      throw error instanceof Error
        ? error
        : new Error(formatErrorMessage(error));
    }
  }

  throw new Error("Fetch failed after exhausting Workday retries.");
}

async function buildSourceJob({
  target,
  fallbackCompanyName,
  now,
  job,
  session,
  signal,
}: {
  target: WorkdaySourceTarget;
  fallbackCompanyName: string;
  now: Date;
  job: WorkdayListJob;
  session: WorkdayFetchSession;
  signal?: AbortSignal;
}): Promise<SourceConnectorJob> {
  let detail: WorkdayJobDetail;
  try {
    detail = await fetchJobDetail(target, job.externalPath, session, signal);
  } catch {
    detail = {
      pageUrl: buildDetailPageUrl(target, job.externalPath),
      detailUrl: buildDetailPageUrl(target, job.externalPath),
      jsonLd: null,
      runtimeConfig: null,
    };
  }
  const jsonLd = detail.jsonLd;
  const pageUrl = readText(jsonLd?.url) || detail.pageUrl;
  const salary = extractSalary(jsonLd?.baseSalary ?? null);
  const workMode = inferWorkMode({
    jsonLd,
    listJob: job,
  });

  return {
    sourceId:
      readText(jsonLd?.identifier?.value) ||
      findReferenceId(job.bulletFields) ||
      job.externalPath,
    sourceUrl: detail.pageUrl,
    title: readText(jsonLd?.title) || job.title,
    company:
      readText(jsonLd?.hiringOrganization?.name) || fallbackCompanyName,
    location: buildLocation({
      jsonLd,
      listJob: job,
      workMode,
    }),
    description:
      readText(jsonLd?.description) ||
      buildFallbackDescription(job, detail.runtimeConfig),
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
  session: WorkdayFetchSession,
  signal?: AbortSignal
): Promise<WorkdayJobDetail> {
  const detailUrl = buildDetailPageUrl(target, externalPath);
  const localeDetailUrl = buildDetailPageUrl(target, externalPath, "en-US");

  for (const pageUrl of [...new Set([detailUrl, localeDetailUrl])]) {
    throwIfAborted(signal);
    let response: Response;
    try {
      response = await fetch(pageUrl, {
        signal: buildTimeoutSignal(signal, WORKDAY_DETAIL_TIMEOUT_MS),
        headers: buildWorkdayRequestHeaders(target, {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          mode: "detail",
          refererUrl: session.refererUrl,
          cookieHeader: session.cookieHeader,
        }),
      });
    } catch {
      continue;
    }

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

function buildTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;

  const abortSignalAny = (AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;

  return abortSignalAny ? abortSignalAny([signal, timeoutSignal]) : timeoutSignal;
}

function buildWorkdayRequestHeaders(
  target: WorkdaySourceTarget,
  options: {
    accept: string;
    contentType?: string;
    mode: "landing" | "api" | "detail";
    refererUrl?: string;
    cookieHeader?: string | null;
  }
) {
  const origin = `https://${target.host}`;
  const referer = options.refererUrl ?? `${origin}/${target.site}`;

  return {
    Accept: options.accept,
    ...(options.contentType ? { "Content-Type": options.contentType } : {}),
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    ...(options.mode === "api" ? { Origin: origin } : {}),
    Referer: referer,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    ...(options.cookieHeader ? { Cookie: options.cookieHeader } : {}),
    "Sec-Ch-Ua": '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": options.mode === "api" ? "empty" : "document",
    "Sec-Fetch-Mode":
      options.mode === "api"
        ? "cors"
        : options.mode === "detail"
          ? "navigate"
          : "navigate",
    "Sec-Fetch-Site": "same-origin",
    ...(options.mode !== "api" ? { "Sec-Fetch-User": "?1" } : {}),
    "Upgrade-Insecure-Requests": options.mode === "api" ? "0" : "1",
    "User-Agent": WORKDAY_BROWSER_USER_AGENT,
  } satisfies Record<string, string>;
}

async function bootstrapWorkdaySession(
  target: WorkdaySourceTarget,
  signal: AbortSignal | undefined
): Promise<WorkdayFetchSession> {
  const landingUrl = buildWorkdayBoardUrl(target);
  const response = await fetch(landingUrl, {
    method: "GET",
    redirect: "follow",
    signal: buildTimeoutSignal(signal, WORKDAY_LIST_TIMEOUT_MS),
    headers: buildWorkdayRequestHeaders(target, {
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      mode: "landing",
      refererUrl: landingUrl,
    }),
  });

  if (!response.ok) {
    throw new Error(
      buildWorkdayResponseErrorMessage({
        target,
        mode: "landing",
        method: "GET",
        requestUrl: landingUrl,
        response,
        session: {
          landingUrl,
          refererUrl: landingUrl,
          cookieHeader: null,
        },
      })
    );
  }

  const cookieHeader = buildCookieHeader(readSetCookieHeaders(response));
  const refererUrl = response.url || landingUrl;

  return {
    landingUrl,
    refererUrl,
    cookieHeader,
  };
}

function buildWorkdayResponseErrorMessage(input: {
  target: WorkdaySourceTarget;
  mode: "landing" | "api" | "detail";
  method: "GET" | "POST";
  requestUrl: string;
  response: Response;
  session: WorkdayFetchSession;
}) {
  const { response } = input;
  const contentType = response.headers.get("content-type") ?? "unknown";
  const location = response.headers.get("location");
  const cfRay = response.headers.get("cf-ray");
  const server = response.headers.get("server");
  const cookiePresent = input.session.cookieHeader ? "present" : "absent";

  return [
    `Fetch failed: ${response.status} ${response.statusText}`,
    `[workday ${input.mode}]`,
    `${input.method} ${input.requestUrl}`,
    `final=${response.url || input.requestUrl}`,
    `content-type=${contentType}`,
    `referer=${input.session.refererUrl}`,
    `cookies=${cookiePresent}`,
    location ? `location=${location}` : null,
    server ? `server=${server}` : null,
    cfRay ? `cf-ray=${cfRay}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

function buildWorkdayUnexpectedContentTypeMessage(input: {
  target: WorkdaySourceTarget;
  mode: "api" | "detail";
  requestUrl: string;
  response: Response;
  contentType: string;
  responseSnippet: string | null;
  session: WorkdayFetchSession;
}) {
  return [
    `Unexpected content-type: ${input.contentType || "unknown"}`,
    `[workday ${input.mode}]`,
    `request=${input.requestUrl}`,
    `final=${input.response.url || input.requestUrl}`,
    `referer=${input.session.refererUrl}`,
    `cookies=${input.session.cookieHeader ? "present" : "absent"}`,
    input.responseSnippet ? `snippet=${input.responseSnippet}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

async function readResponseSnippet(response: Response) {
  try {
    const text = await response.text();
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length > 160 ? `${collapsed.slice(0, 160)}...` : collapsed;
  } catch {
    return null;
  }
}

function readSetCookieHeaders(response: Response) {
  const headersWithSetCookie = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof headersWithSetCookie.getSetCookie === "function") {
    return headersWithSetCookie.getSetCookie();
  }

  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

function buildCookieHeader(setCookieHeaders: string[]) {
  if (setCookieHeaders.length === 0) return null;

  const cookies = new Map<string, string>();
  for (const header of setCookieHeaders) {
    const pair = header.split(";")[0]?.trim();
    if (!pair) continue;
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) continue;
    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (!name || !value) continue;
    cookies.set(name, value);
  }

  if (cookies.size === 0) return null;
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isTransientWorkdayError(error: unknown) {
  const message = formatErrorMessage(error).toLowerCase();
  const hardStatusMatch = message.match(/\b(401|403|404|410)\b/);
  if (hardStatusMatch) {
    return false;
  }

  return (
    message.includes("fetch failed") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("abort") ||
    message.includes("gateway timeout")
  );
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

  const listLocation = readText(listJob.locationsText);
  if (listLocation) {
    return listLocation;
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
    .filter((location): location is string => Boolean(location))
    .map((location) => location!);

  return [...new Set(formatted)];
}

function formatPlace(place: WorkdayPlace) {
  const placeName = readText(place.name);
  if (placeName) {
    return placeName;
  }

  const address = place.address;
  if (!address) return null;

  const parts = [
    readText(address.addressLocality),
    readText(address.addressRegion),
    readText(address.addressCountry),
  ].filter(Boolean);

  if (parts.length > 0) return parts.join(", ");
  return readText(address.streetAddress);
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
    .map((value) => readText(value))
    .filter((value): value is string => Boolean(value))
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

  if (jsonLd?.jobLocation || readText(listJob.locationsText)) {
    return "ONSITE";
  }

  return null;
}

function inferEmploymentType(
  value: string | string[] | null | undefined
): EmploymentType | null {
  const values = (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => readLowerText(item))
    .filter((item): item is string => Boolean(item));

  for (const item of values) {
    if (item.includes("intern")) return "INTERNSHIP";
    if (item.includes("contract") || item.includes("temporary")) {
      return "CONTRACT";
    }
    if (item.includes("part")) return "PART_TIME";
    if (item.includes("full")) return "FULL_TIME";
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
    currency: readText(baseSalary.currency),
  };
}

function buildFallbackDescription(
  job: WorkdayListJob,
  runtimeConfig: WorkdayRuntimeConfig | null
) {
  const locationsText = readText(job.locationsText);
  const postedOn = readText(job.postedOn);
  const remoteType = readText(job.remoteType);
  return [
    locationsText ? `Locations: ${locationsText}` : null,
    postedOn ? `Posted: ${postedOn}` : null,
    remoteType ? `Remote type: ${remoteType}` : null,
    job.bulletFields?.length ? job.bulletFields.join(" · ") : null,
    runtimeConfig?.siteId ? `Site: ${runtimeConfig.siteId}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function findReferenceId(values: string[] | null | undefined) {
  return (
    values
      ?.map((value) => readText(value))
      .find((value) => value && /[A-Z]{2,}-?\d+/i.test(value)) || null
  );
}

function parseDateValue(value: string | null | undefined) {
  const text = readText(value);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseRelativePostedOn(value: string | null | undefined, now: Date) {
  const normalized = readLowerText(value);
  if (!normalized) return null;

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
      host: normalizeTokenPart(options.host, "host"),
      tenant: normalizeTokenPart(options.tenant, "tenant"),
      site: normalizeTokenPart(options.site, "site"),
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

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readLowerText(value: unknown): string | null {
  const text = readText(value);
  return text ? text.toLowerCase() : null;
}

function normalizeTokenPart(value: string, label: string) {
  const normalized = readLowerText(value);
  if (!normalized) {
    throw new Error(`Workday connector ${label} cannot be empty.`);
  }
  return normalized;
}
