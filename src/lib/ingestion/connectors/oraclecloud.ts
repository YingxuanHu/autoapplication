/**
 * Oracle Cloud HCM (Fusion / OCS) candidate-facing recruiting connector.
 *
 * Why this connector exists:
 *   HiringCafe revealed Oracle Cloud HCM as the single biggest ATS in our
 *   data that we did NOT poll directly. ~35% of HiringCafe's surfaced
 *   non-overlapping ATS volume comes from this family. Major North American
 *   employers on Oracle Cloud HCM include retailers, healthcare systems,
 *   universities, public-sector agencies, manufacturers, and some banks.
 *
 * URL pattern (candidate-facing job board):
 *   https://{tenant}.fa.{region}.oraclecloud.com/hcmUI/CandidateExperience/en/sites/{site}/requisitions
 *
 * REST endpoint (public — no auth for the candidate search API):
 *   GET https://{tenant}.fa.{region}.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *
 * Tenant identifiers from production data:
 *   - `ejov.fa.ca2` (Toronto-based Canadian tenant)
 *   - `emgi.fa.ca3`
 *   - `hcrw.fa.us2`
 *   - `fa-exhh-saasfaprod1.fa.ocs` (OCS region, multi-tenant)
 *   - `fa-evcg-saasfaprod1.fa.ocs`
 *
 * The connector takes a `tenant` host (e.g. "ejov.fa.ca2.oraclecloud.com")
 * and a `site` identifier (defaults to "CX" — the most common candidate
 * experience site). The REST API supports pagination via offset/limit.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { EmploymentType, WorkMode } from "@/generated/prisma/client";

import { throwIfAborted } from "@/lib/ingestion/runtime-control";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";

// Defaults conservatively sized; adaptive runtime budget upstairs handles the
// real envelope per cycle.
const ORACLE_CLOUD_DEFAULT_RATE_DELAY_MS = 500;
const ORACLE_CLOUD_DEFAULT_LIMIT_PER_PAGE = 50;
const ORACLE_CLOUD_DEFAULT_MAX_PAGES = 20;
const ORACLE_CLOUD_USER_AGENT =
  "Mozilla/5.0 (compatible; applyoverflow-oraclecloud/1.0)";

type OracleCloudJob = {
  Id?: string;
  Title?: string;
  // Live response uses "PostedDate" (NOT "PostingDate"). Keep both for
  // forward compatibility — the first non-empty wins.
  PostedDate?: string;
  PostingDate?: string;
  PostingEndDate?: string;
  PrimaryLocation?: string;
  PrimaryLocationCountry?: string;
  GeographyId?: number | string;
  // Live response uses "JobFamily" / "JobFunction" (NOT *Name). Same
  // dual-name strategy for forward compat.
  JobFamily?: string;
  JobFunction?: string;
  JobFamilyName?: string;
  JobFunctionName?: string;
  ShortDescriptionStr?: string;
  ExternalDescriptionStr?: string;
  ExternalQualificationsStr?: string;
  ExternalResponsibilitiesStr?: string;
  WorkplaceTypeCode?: string | null;
  WorkerType?: string | null;
  ContractType?: string | null;
  StudyLevel?: string;
  MediaLink?: string;
  ExternalUrl?: string;
};

// Oracle Cloud HCM nests the actual job entries under `items[0].requisitionList`,
// NOT under `items[0].items`. Earlier guess was wrong — verified against
// live response from ejov.fa.ca2.oraclecloud.com on 2026-05-26.
type OracleCloudListResponse = {
  items?: Array<{
    requisitionList?: OracleCloudJob[];
    TotalJobsCount?: number;
    Limit?: number;
    Offset?: number;
  }>;
  count?: number;
  hasMore?: boolean;
  limit?: number;
  offset?: number;
  links?: unknown[];
};

type OracleCloudConnectorOptions = {
  /**
   * The OCS tenant host. Examples:
   *   "ejov.fa.ca2.oraclecloud.com"
   *   "fa-exhh-saasfaprod1.fa.ocs.oraclecloud.com"
   */
  tenant: string;
  /**
   * The candidate-experience site identifier (CX is the most common public
   * site). Some tenants expose CX_2, CX_3 — pass the relevant one.
   */
  site?: string;
  companyName?: string;
  limitPerPage?: number;
  maxPages?: number;
};

type OracleCloudCheckpoint = {
  offset: number;
};

export function createOracleCloudConnector(
  options: OracleCloudConnectorOptions
): SourceConnector {
  const tenant = options.tenant.trim().toLowerCase();
  if (!tenant) {
    throw new Error("Oracle Cloud HCM connector requires a `tenant` host.");
  }
  if (!/^[a-z0-9.-]+\.oraclecloud\.com$/i.test(tenant)) {
    throw new Error(
      `Oracle Cloud HCM connector got an invalid tenant host '${tenant}' — expected '*.oraclecloud.com'.`
    );
  }

  const site = (options.site ?? "CX").trim();
  const companyName = options.companyName?.trim() || inferCompanyFromTenant(tenant);
  const tenantKey = tenant.replace(/\.oraclecloud\.com$/i, "");
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: `oraclecloud:${tenantKey}:${site.toLowerCase()}`,
    sourceName: `OracleCloud:${tenantKey}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      fetchOptions: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const cacheKey = JSON.stringify({
        limit: fetchOptions.limit ?? "all",
        checkpoint: fetchOptions.checkpoint ?? null,
      });
      const existing = fetchCache.get(cacheKey);
      if (existing) return existing;

      const request = fetchOracleCloudJobs({
        tenant,
        site,
        companyName,
        now: fetchOptions.now ?? new Date(),
        limit: fetchOptions.limit,
        signal: fetchOptions.signal,
        checkpoint: parseCheckpoint(fetchOptions.checkpoint),
        onCheckpoint: fetchOptions.onCheckpoint,
        limitPerPage:
          options.limitPerPage ?? ORACLE_CLOUD_DEFAULT_LIMIT_PER_PAGE,
        maxPages: options.maxPages ?? ORACLE_CLOUD_DEFAULT_MAX_PAGES,
      });
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchOracleCloudJobs(input: {
  tenant: string;
  site: string;
  companyName: string;
  now: Date;
  limit: number | undefined;
  signal: AbortSignal | undefined;
  checkpoint: OracleCloudCheckpoint | null;
  onCheckpoint:
    | ((checkpoint: Prisma.InputJsonValue | null) => void | Promise<void>)
    | undefined;
  limitPerPage: number;
  maxPages: number;
}): Promise<SourceConnectorFetchResult> {
  throwIfAborted(input.signal);
  const jobs: SourceConnectorJob[] = [];
  const seenIds = new Set<string>();
  let offset = input.checkpoint?.offset ?? 0;
  let page = 0;
  let totalAvailable: number | null = null;
  let lastPageItemCount = 0;
  let stoppedBeforeCompletion = false;

  while (page < input.maxPages) {
    throwIfAborted(input.signal);
    if (input.limit && jobs.length >= input.limit) {
      stoppedBeforeCompletion = true;
      break;
    }

    const url = buildListUrl({
      tenant: input.tenant,
      site: input.site,
      offset,
      limit: input.limitPerPage,
    });

    let response: Response;
    try {
      response = await fetch(url, {
        signal: input.signal,
        headers: {
          "User-Agent": ORACLE_CLOUD_USER_AGENT,
          // Oracle requires this version header on its REST API
          "REST-Framework-Version": "1",
          Accept: "application/json",
        },
      });
    } catch (error) {
      if (page === 0) throw error;
      // Mid-pagination network failure is an incomplete snapshot. Keep the
      // checkpoint so a later poll can resume, but never remove prior mappings.
      stoppedBeforeCompletion = true;
      break;
    }

    if (!response.ok) {
      if (page === 0) {
        throw new Error(
          `Oracle Cloud HCM fetch failed: ${response.status} ${response.statusText} @ ${url}`
        );
      }
      stoppedBeforeCompletion = true;
      break;
    }

    const payload = (await response.json().catch(() => null)) as
      | OracleCloudListResponse
      | null;
    if (!payload) {
      stoppedBeforeCompletion = true;
      break;
    }

    // Oracle Cloud HCM nests under items[0].requisitionList. The wrapping
    // items[0] also carries TotalJobsCount + Limit + Offset for the entire
    // search context.
    const wrapper = payload.items?.[0];
    const items = wrapper?.requisitionList ?? [];

    if (totalAvailable === null && typeof wrapper?.TotalJobsCount === "number") {
      totalAvailable = wrapper.TotalJobsCount;
    }
    if (items.length === 0) {
      if (totalAvailable !== null && offset < totalAvailable) {
        stoppedBeforeCompletion = true;
      }
      break;
    }
    lastPageItemCount = items.length;

    for (const item of items) {
      const mapped = mapOracleCloudJob(item, {
        tenant: input.tenant,
        site: input.site,
        companyName: input.companyName,
        now: input.now,
      });
      if (!mapped) continue;
      if (mapped.sourceId && seenIds.has(mapped.sourceId)) continue;
      if (mapped.sourceId) seenIds.add(mapped.sourceId);
      jobs.push(mapped);
      if (input.limit && jobs.length >= input.limit) break;
    }

    offset += items.length;
    page += 1;

    if (input.onCheckpoint) {
      await input.onCheckpoint({ offset } satisfies OracleCloudCheckpoint);
    }

    // Stop when we've walked past the total job count
    if (totalAvailable !== null && offset >= totalAvailable) break;

    if (input.limit && jobs.length >= input.limit) {
      stoppedBeforeCompletion = true;
      break;
    }

    // Small delay between pages to be a polite citizen
    await new Promise((resolve) =>
      setTimeout(resolve, ORACLE_CLOUD_DEFAULT_RATE_DELAY_MS)
    );
  }

  const hitPageCapBeforeCompletion =
    page >= input.maxPages &&
    (totalAvailable === null
      ? lastPageItemCount >= input.limitPerPage
      : offset < totalAvailable);
  const exhausted = !stoppedBeforeCompletion && !hitPageCapBeforeCompletion;
  const checkpoint = exhausted ? null : ({ offset } satisfies OracleCloudCheckpoint);

  return {
    jobs,
    metadata: {
      tenant: input.tenant,
      site: input.site,
      pagesFetched: page,
      totalAvailable,
      offsetAfterRun: offset,
      snapshotComplete: exhausted,
    } as Prisma.InputJsonValue,
    checkpoint,
    exhausted,
  };
}

function buildListUrl(args: {
  tenant: string;
  site: string;
  offset: number;
  limit: number;
}): string {
  const params = new URLSearchParams({
    onlyData: "true",
    expand: "requisitionList.secondaryLocations,flexFieldsFacet.values",
    finder: `findReqs;siteNumber=${args.site},sortBy=POSTING_DATES_DESC,facetsList=LOCATIONS;WORK_LOCATIONS;WORKPLACE_TYPES;TITLES;CATEGORIES;ORGANIZATIONS;POSTING_DATES;FLEX_FIELDS,limit=${args.limit},offset=${args.offset}`,
  });
  return `https://${args.tenant}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?${params.toString()}`;
}

function buildApplyUrl(args: { tenant: string; site: string; jobId: string }) {
  return `https://${args.tenant}/hcmUI/CandidateExperience/en/sites/${args.site}/requisitions/job/${args.jobId}`;
}

function mapOracleCloudJob(
  job: OracleCloudJob,
  ctx: { tenant: string; site: string; companyName: string; now: Date }
): SourceConnectorJob | null {
  const sourceId = sanitizeText(job.Id);
  const title = sanitizeText(job.Title);
  if (!sourceId || !title) return null;

  const applyUrl =
    sanitizeText(job.ExternalUrl) ??
    buildApplyUrl({ tenant: ctx.tenant, site: ctx.site, jobId: sourceId });

  const location = sanitizeText(job.PrimaryLocation) ?? "Unknown";
  const workMode = inferWorkMode(job.WorkplaceTypeCode ?? undefined, location);
  const jobFamily = sanitizeText(job.JobFamily) ?? sanitizeText(job.JobFamilyName);
  const jobFunction =
    sanitizeText(job.JobFunction) ?? sanitizeText(job.JobFunctionName);
  const employmentType = inferEmploymentType(jobFamily, title);
  // Live response uses "PostedDate"; legacy guess used "PostingDate" —
  // accept whichever is present.
  const postedAt =
    parseDate(job.PostedDate) ?? parseDate(job.PostingDate);
  const deadline = parseDate(job.PostingEndDate);
  const description = buildDescription(job);
  const company = ctx.companyName || inferCompanyFromTenant(ctx.tenant);

  return {
    sourceId: `oraclecloud:${ctx.tenant.replace(/\.oraclecloud\.com$/, "")}:${sourceId}`,
    sourceUrl: applyUrl,
    title,
    company,
    location,
    description,
    applyUrl,
    postedAt,
    deadline,
    employmentType,
    workMode,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    metadata: {
      source: "oraclecloud",
      tenant: ctx.tenant,
      site: ctx.site,
      jobFamily: jobFamily ?? null,
      jobFunction: jobFunction ?? null,
      country: sanitizeText(job.PrimaryLocationCountry) ?? null,
    } as Prisma.InputJsonValue,
  };
}

function inferCompanyFromTenant(tenant: string): string {
  // Tenant key like "ejov.fa.ca2" or "fa-exhh-saasfaprod1.fa.ocs". We can't
  // reliably derive the company brand name from the tenant ID, so emit
  // "Unknown" and let the canonical company resolver fill it in from
  // metadata + JobCanonical company-name dedupe.
  void tenant;
  return "Unknown";
}

function inferWorkMode(
  workplaceTypeCode: string | undefined,
  location: string
): WorkMode {
  const code = (workplaceTypeCode ?? "").toLowerCase();
  if (code.includes("remote") || code.includes("virtual")) return "REMOTE";
  if (code.includes("hybrid")) return "HYBRID";
  if (code.includes("office") || code.includes("on")) return "ONSITE";
  if (/^remote\b/i.test(location)) return "REMOTE";
  if (/hybrid/i.test(location)) return "HYBRID";
  return "UNKNOWN";
}

function inferEmploymentType(
  jobFamily: string | undefined,
  title: string
): EmploymentType | null {
  const family = (jobFamily ?? "").toLowerCase();
  if (family.includes("intern") || /\bintern(ship)?\b/i.test(title))
    return "INTERNSHIP";
  if (family.includes("contract") || /\bcontract\b/i.test(title)) return "CONTRACT";
  if (family.includes("part-time") || /\bpart[ -]?time\b/i.test(title))
    return "PART_TIME";
  if (family.includes("temporary") || /\btemporary\b/i.test(title))
    return "CONTRACT";
  return null;
}

function buildDescription(job: OracleCloudJob): string {
  const parts: string[] = [];
  const desc = sanitizeText(job.ExternalDescriptionStr);
  const resp = sanitizeText(job.ExternalResponsibilitiesStr);
  const quals = sanitizeText(job.ExternalQualificationsStr);
  const short = sanitizeText(job.ShortDescriptionStr);
  if (desc) parts.push(desc);
  if (resp) parts.push(`Responsibilities: ${resp}`);
  if (quals) parts.push(`Qualifications: ${quals}`);
  if (!parts.length && short) parts.push(short);
  return parts.join("\n\n");
}

function parseCheckpoint(
  value: Prisma.InputJsonValue | null | undefined
): OracleCloudCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawOffset = (value as { offset?: unknown }).offset;
  const offset =
    typeof rawOffset === "number" && Number.isFinite(rawOffset) && rawOffset > 0
      ? Math.floor(rawOffset)
      : 0;
  return { offset };
}

function parseDate(input: string | undefined): Date | null {
  if (!input) return null;
  const parsed = new Date(input);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function sanitizeText<T extends string | undefined>(value: T): T {
  if (typeof value !== "string") return value;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return (trimmed || undefined) as T;
}
