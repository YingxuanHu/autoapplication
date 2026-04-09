import type { Prisma } from "@/generated/prisma/client";
import type { ConnectorFreshnessMode } from "@/lib/ingestion/types";

const DIRECT_COMPANY_PREFIXES = new Set([
  "Ashby",
  "Greenhouse",
  "Lever",
  "Recruitee",
  "Rippling",
  "SmartRecruiters",
  "SuccessFactors",
  "Taleo",
  "Workable",
  "Workday",
  "iCIMS",
]);

const STRUCTURED_BOARD_PREFIXES = new Set([
  "Himalayas",
  "JobBank",
  "TheMuse",
  "USAJobs",
]);

const AGGREGATOR_PREFIXES = new Set([
  "Adzuna",
  "Jobicy",
  "RemoteOK",
  "Remotive",
]);

const DIRECT_HOST_HINTS = [
  "ashbyhq.com",
  "greenhouse.io",
  "lever.co",
  "recruitee.com",
  "ats.rippling.com",
  "smartrecruiters.com",
  "successfactors.com",
  "successfactors.eu",
  "taleo.net",
  "apply.workable.com",
  "myworkdayjobs.com",
  "icims.com",
];

const STRUCTURED_BOARD_HOST_HINTS = [
  "himalayas.app",
  "jobbank.gc.ca",
  "themuse.com",
  "usajobs.gov",
];

const AGGREGATOR_HOST_HINTS = [
  "adzuna.com",
  "jobicy.com",
  "remoteok.com",
  "remotive.com",
  "lensa.com",
];

const STABLE_QUERY_PARAMS = [
  "gh_jid",
  "job",
  "jobid",
  "job_id",
  "jobreqid",
  "requisitionid",
  "requisition_id",
  "reqid",
  "req_id",
  "posting",
  "postingid",
  "posting_id",
];

export type SourceQualityKind =
  | "DIRECT_COMPANY"
  | "STRUCTURED_BOARD"
  | "AGGREGATOR_REDIRECT"
  | "WEAK_SCRAPED_COPY";

export type SourceQualitySnapshot = {
  kind: SourceQualityKind;
  rank: number;
};

export type SourceIdentitySnapshot = {
  sourceFamily: string;
  sourceQualityKind: SourceQualityKind;
  sourceQualityRank: number;
  applyUrlKey: string | null;
  sourceUrlKey: string | null;
  postingIdKey: string | null;
};

export type SourceLifecycleType =
  | "ATS"
  | "BOARD"
  | "AGGREGATOR"
  | "COMPANY_HTML"
  | "COMPANY_JSON";

export type SourceLifecycleSnapshot = {
  sourceType: SourceLifecycleType;
  sourceReliability: number;
  isFullSnapshot: boolean;
  pollPattern: ConnectorFreshnessMode;
};

export function deriveSourceIdentitySnapshot(input: {
  sourceName: string;
  sourceId: string;
  sourceUrl: string | null;
  applyUrl: string | null;
  metadata: Prisma.InputJsonValue;
}) {
  const sourceFamily = getSourceFamily(input.sourceName);
  const sourceQuality = getSourceQualitySnapshot({
    sourceName: input.sourceName,
    sourceUrl: input.sourceUrl,
    applyUrl: input.applyUrl,
  });
  const applyUrlKey = normalizeUrlIdentityKey(input.applyUrl);
  const sourceUrlKey = normalizeUrlIdentityKey(input.sourceUrl);
  const postingIdKey = derivePostingIdKey({
    sourceFamily,
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl,
    applyUrl: input.applyUrl,
    metadata: input.metadata,
  });

  return {
    sourceFamily,
    sourceQualityKind: sourceQuality.kind,
    sourceQualityRank: sourceQuality.rank,
    applyUrlKey,
    sourceUrlKey,
    postingIdKey,
  } satisfies SourceIdentitySnapshot;
}

export function getSourceQualitySnapshot(input: {
  sourceName: string;
  sourceUrl: string | null;
  applyUrl: string | null;
}) {
  const prefix = input.sourceName.split(":")[0] ?? input.sourceName;
  const sourceHost = getHost(input.sourceUrl);
  const applyHost = getHost(input.applyUrl);

  let base: SourceQualitySnapshot;

  if (
    DIRECT_COMPANY_PREFIXES.has(prefix) ||
    hasHostSuffix(sourceHost, DIRECT_HOST_HINTS) ||
    hasHostSuffix(applyHost, DIRECT_HOST_HINTS)
  ) {
    base = {
      kind: "DIRECT_COMPANY",
      rank: 400,
    };
  } else if (
    STRUCTURED_BOARD_PREFIXES.has(prefix) ||
    hasHostSuffix(sourceHost, STRUCTURED_BOARD_HOST_HINTS) ||
    hasHostSuffix(applyHost, STRUCTURED_BOARD_HOST_HINTS)
  ) {
    base = {
      kind: "STRUCTURED_BOARD",
      rank: 300,
    };
  } else if (
    AGGREGATOR_PREFIXES.has(prefix) ||
    hasHostSuffix(sourceHost, AGGREGATOR_HOST_HINTS) ||
    hasHostSuffix(applyHost, AGGREGATOR_HOST_HINTS)
  ) {
    base = {
      kind: "AGGREGATOR_REDIRECT",
      rank: 200,
    };
  } else {
    base = {
      kind: "WEAK_SCRAPED_COPY",
      rank: 100,
    };
  }

  return {
    kind: base.kind,
    rank:
      base.rank +
      scoreApplyUrlQuality(input.applyUrl) +
      (normalizeUrlIdentityKey(input.sourceUrl) ? 5 : 0),
  } satisfies SourceQualitySnapshot;
}

export function scoreApplyUrlQuality(url: string | null) {
  const host = getHost(url);

  if (!host) return 0;
  if (hasHostSuffix(host, DIRECT_HOST_HINTS)) return 40;
  if (hasHostSuffix(host, STRUCTURED_BOARD_HOST_HINTS)) return 20;
  if (hasHostSuffix(host, AGGREGATOR_HOST_HINTS)) return 0;
  return 10;
}

export function deriveSourceLifecycleSnapshot(input: {
  sourceName: string;
  sourceUrl: string | null;
  applyUrl: string | null;
  freshnessMode: ConnectorFreshnessMode;
}) {
  const sourceFamily = getSourceFamily(input.sourceName);
  const sourceHost = getHost(input.sourceUrl);
  const applyHost = getHost(input.applyUrl);
  const normalizedPollPattern = input.freshnessMode;

  let sourceType: SourceLifecycleType = "COMPANY_HTML";
  let sourceReliability = 0.7;

  if (
    DIRECT_COMPANY_PREFIXES.has(input.sourceName.split(":")[0] ?? input.sourceName) ||
    hasHostSuffix(sourceHost, DIRECT_HOST_HINTS) ||
    hasHostSuffix(applyHost, DIRECT_HOST_HINTS)
  ) {
    sourceType = "ATS";
    sourceReliability = 0.95;
  } else if (
    STRUCTURED_BOARD_PREFIXES.has(input.sourceName.split(":")[0] ?? input.sourceName) ||
    hasHostSuffix(sourceHost, STRUCTURED_BOARD_HOST_HINTS) ||
    hasHostSuffix(applyHost, STRUCTURED_BOARD_HOST_HINTS)
  ) {
    sourceType = "BOARD";
    sourceReliability = 0.82;
  } else if (
    AGGREGATOR_PREFIXES.has(input.sourceName.split(":")[0] ?? input.sourceName) ||
    hasHostSuffix(sourceHost, AGGREGATOR_HOST_HINTS) ||
    hasHostSuffix(applyHost, AGGREGATOR_HOST_HINTS)
  ) {
    sourceType = "AGGREGATOR";
    sourceReliability = 0.55;
  } else if (sourceFamily.includes("json")) {
    sourceType = "COMPANY_JSON";
    sourceReliability = 0.85;
  }

  if (normalizedPollPattern === "FULL_SNAPSHOT") {
    sourceReliability += 0.05;
  }

  return {
    sourceType,
    sourceReliability: Math.min(0.99, sourceReliability),
    isFullSnapshot: normalizedPollPattern === "FULL_SNAPSHOT",
    pollPattern: normalizedPollPattern,
  } satisfies SourceLifecycleSnapshot;
}

export function normalizeUrlIdentityKey(url: string | null) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname
      .toLowerCase()
      .replace(/\/+$/, "")
      .replace(/\/{2,}/g, "/");
    const queryParts = [...parsed.searchParams.entries()]
      .filter(([key, value]) => {
        const normalizedKey = key.toLowerCase();
        return STABLE_QUERY_PARAMS.includes(normalizedKey) && Boolean(value.trim());
      })
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, value]) => `${key.toLowerCase()}=${value.trim().toLowerCase()}`);

    return `${parsed.hostname.toLowerCase()}${pathname}${queryParts.length > 0 ? `?${queryParts.join("&")}` : ""}`;
  } catch {
    return null;
  }
}

function derivePostingIdKey(input: {
  sourceFamily: string;
  sourceId: string;
  sourceUrl: string | null;
  applyUrl: string | null;
  metadata: Prisma.InputJsonValue;
}) {
  const urlDerived =
    extractPostingIdFromUrl(input.applyUrl) ??
    extractPostingIdFromUrl(input.sourceUrl);
  if (urlDerived) return urlDerived;

  const sourceScope = deriveSourceScope(
    input.sourceFamily,
    input.sourceUrl,
    input.applyUrl,
    null
  );
  const metadataDerived = extractPostingIdFromMetadata(
    input.metadata,
    input.sourceFamily,
    sourceScope
  );
  if (metadataDerived) return metadataDerived;

  const normalizedSourceId = normalizeStableIdentifier(input.sourceId);
  if (normalizedSourceId) {
    return buildScopedPostingId(input.sourceFamily, sourceScope, normalizedSourceId);
  }

  return null;
}

function extractPostingIdFromMetadata(
  metadata: Prisma.InputJsonValue,
  sourceFamily: string,
  sourceScope: string | null
) {
  const candidates = collectMetadataIdentifierCandidates(metadata);
  for (const candidate of candidates) {
    const normalized = normalizeStableIdentifier(candidate);
    if (normalized) {
      return buildScopedPostingId(sourceFamily, sourceScope, normalized);
    }
  }

  return null;
}

function collectMetadataIdentifierCandidates(value: Prisma.InputJsonValue): string[] {
  const found = new Set<string>();
  const queue: Prisma.InputJsonValue[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    if (typeof current === "string") {
      if (looksLikeStableIdentifier(current)) {
        found.add(current);
      }
      continue;
    }

    if (typeof current !== "object") continue;

    if (Array.isArray(current)) {
      for (const entry of current) queue.push(entry);
      continue;
    }

    for (const [key, entry] of Object.entries(current)) {
      if (entry == null) continue;

      if (
        /(?:^|_)(id|jobid|job_id|postingid|posting_id|requisitionid|requisition_id|reqid|req_id|contestno|externalpath|guid|uuid|slug|token)$/i.test(
          key
        ) &&
        typeof entry === "string"
      ) {
        found.add(entry);
      }

      if (typeof entry === "object") {
        queue.push(entry as Prisma.InputJsonValue);
      }
    }
  }

  return [...found];
}

function extractPostingIdFromUrl(url: string | null) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const segments = pathname.split("/").filter(Boolean);

    if (host.includes("greenhouse.io")) {
      const ghJid = parsed.searchParams.get("gh_jid");
      const scope = deriveSourceScope("greenhouse", url, null, parsed);
      if (ghJid) return buildScopedPostingId("greenhouse", scope, ghJid.trim().toLowerCase());
      const pathId = findLastMatchingSegment(segments, (segment) => /^\d{5,}$/.test(segment));
      if (pathId) return buildScopedPostingId("greenhouse", scope, pathId.toLowerCase());
    }

    if (host.includes("lever.co")) {
      const leverId = getLastSegment(segments);
      if (leverId && looksLikeStableIdentifier(leverId)) {
        return buildScopedPostingId(
          "lever",
          deriveSourceScope("lever", url, null, parsed),
          normalizeStableIdentifier(leverId)
        );
      }
    }

    if (host.includes("ashbyhq.com")) {
      const ashbyId = getLastSegment(segments);
      if (ashbyId && looksLikeStableIdentifier(ashbyId)) {
        return buildScopedPostingId(
          "ashby",
          deriveSourceScope("ashby", url, null, parsed),
          normalizeStableIdentifier(ashbyId)
        );
      }
    }

    if (host.includes("myworkdayjobs.com")) {
      const workdayId =
        extractLastDelimitedToken(getLastSegment(segments)) ??
        normalizeStableIdentifier(parsed.searchParams.get("jobFamilyGroup")) ??
        normalizeStableIdentifier(parsed.searchParams.get("jobFamilyGroupID"));
      if (workdayId) {
        return buildScopedPostingId(
          "workday",
          deriveSourceScope("workday", url, null, parsed),
          workdayId
        );
      }
    }

    if (host.includes("taleo.net")) {
      const taleoJob = parsed.searchParams.get("job");
      if (taleoJob) {
        return buildScopedPostingId(
          "taleo",
          deriveSourceScope("taleo", url, null, parsed),
          normalizeStableIdentifier(taleoJob)
        );
      }
    }

    if (host.includes("smartrecruiters.com")) {
      const smartRecruitersId =
        findLastMatchingSegment(segments, (segment) => looksLikeStableIdentifier(segment)) ?? null;
      if (smartRecruitersId) {
        return buildScopedPostingId(
          "smartrecruiters",
          deriveSourceScope("smartrecruiters", url, null, parsed),
          normalizeStableIdentifier(smartRecruitersId)
        );
      }
    }

    if (host.includes("icims.com")) {
      const jobsIndex = segments.findIndex((segment) => segment.toLowerCase() === "jobs");
      const icimsId = jobsIndex >= 0 ? segments[jobsIndex + 1] : null;
      if (icimsId && looksLikeStableIdentifier(icimsId)) {
        return buildScopedPostingId(
          "icims",
          deriveSourceScope("icims", url, null, parsed),
          normalizeStableIdentifier(icimsId)
        );
      }
    }

    if (host.includes("apply.workable.com") || host.includes("workable.com")) {
      const workableIndex = segments.findIndex((segment) => segment.toLowerCase() === "j");
      const workableId = workableIndex >= 0 ? segments[workableIndex + 1] : getLastSegment(segments);
      if (workableId && looksLikeStableIdentifier(workableId)) {
        return buildScopedPostingId(
          "workable",
          deriveSourceScope("workable", url, null, parsed),
          normalizeStableIdentifier(workableId)
        );
      }
    }

    if (host.includes("recruitee.com")) {
      const recruiteeId = findLastMatchingSegment(
        segments,
        (segment) => looksLikeStableIdentifier(segment)
      );
      if (recruiteeId) {
        return buildScopedPostingId(
          "recruitee",
          deriveSourceScope("recruitee", url, null, parsed),
          normalizeStableIdentifier(recruiteeId)
        );
      }
    }

    const genericQueryId = STABLE_QUERY_PARAMS.map((key) => parsed.searchParams.get(key)).find(
      (value) => Boolean(value?.trim())
    );
    if (genericQueryId) {
      const family = guessFamilyFromHost(host);
      return buildScopedPostingId(
        family,
        deriveSourceScope(family, url, null, parsed),
        normalizeStableIdentifier(genericQueryId)
      );
    }

    return null;
  } catch {
    return null;
  }
}

function extractLastDelimitedToken(value: string | null | undefined) {
  if (!value) return null;

  const pieces = value.split(/[_-]/).filter(Boolean);
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index];
    const normalized = normalizeStableIdentifier(piece);
    if (normalized) return normalized;
  }

  return null;
}

function buildScopedPostingId(
  sourceFamily: string,
  sourceScope: string | null,
  postingId: string | null
) {
  if (!postingId) return null;
  if (sourceScope) return `${sourceFamily}:${sourceScope}:${postingId}`;
  return `${sourceFamily}:${postingId}`;
}

function deriveSourceScope(
  sourceFamily: string,
  sourceUrl: string | null,
  applyUrl: string | null,
  parsedUrl?: URL | null
) {
  const parsed =
    parsedUrl ??
    tryParseUrl(sourceUrl) ??
    tryParseUrl(applyUrl);
  if (!parsed) return null;

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);

  switch (sourceFamily) {
    case "greenhouse":
    case "lever":
    case "ashby":
      return normalizeStableIdentifier(segments[0] ?? host);
    case "workable": {
      const workableIndex = segments.findIndex((segment) => segment.toLowerCase() === "j");
      return normalizeStableIdentifier(
        workableIndex > 0 ? segments[workableIndex - 1] : segments[0] ?? host
      );
    }
    case "recruitee":
      return normalizeStableIdentifier(
        segments.find((segment) => segment.toLowerCase() !== "o") ?? host
      );
    default:
      return normalizeStableIdentifier(host.replace(/\./g, "-"));
  }
}

function getLastSegment(segments: string[]) {
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

function findLastMatchingSegment(
  segments: string[],
  predicate: (segment: string) => boolean
) {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (predicate(segment)) return segment;
  }

  return null;
}

function normalizeStableIdentifier(value: string | null | undefined) {
  if (!value) return null;

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "");
  if (!normalized) return null;
  if (normalized.length < 4) return null;
  return normalized;
}

function looksLikeStableIdentifier(value: string) {
  const normalized = value.trim();
  if (!normalized) return false;
  if (normalized.length < 4) return false;
  if (/^https?:\/\//i.test(normalized)) return false;
  if (/\s/.test(normalized)) return false;
  if (/^[a-z]{1,3}$/i.test(normalized)) return false;
  return /[0-9]/.test(normalized) || /[-_]/.test(normalized);
}

export function getSourceFamily(sourceName: string) {
  return (sourceName.split(":")[0] ?? sourceName).trim().toLowerCase();
}

function guessFamilyFromHost(host: string) {
  if (hasHostSuffix(host, DIRECT_HOST_HINTS)) {
    if (host.includes("greenhouse")) return "greenhouse";
    if (host.includes("lever")) return "lever";
    if (host.includes("ashby")) return "ashby";
    if (host.includes("workday")) return "workday";
    if (host.includes("smartrecruiters")) return "smartrecruiters";
    if (host.includes("icims")) return "icims";
    if (host.includes("workable")) return "workable";
    if (host.includes("taleo")) return "taleo";
    if (host.includes("successfactors")) return "successfactors";
    if (host.includes("recruitee")) return "recruitee";
    if (host.includes("rippling")) return "rippling";
  }

  if (hasHostSuffix(host, STRUCTURED_BOARD_HOST_HINTS)) {
    if (host.includes("jobbank")) return "jobbank";
    if (host.includes("themuse")) return "themuse";
    if (host.includes("usajobs")) return "usajobs";
    if (host.includes("himalayas")) return "himalayas";
  }

  if (hasHostSuffix(host, AGGREGATOR_HOST_HINTS)) {
    if (host.includes("adzuna")) return "adzuna";
    if (host.includes("jobicy")) return "jobicy";
    if (host.includes("remoteok")) return "remoteok";
    if (host.includes("remotive")) return "remotive";
    if (host.includes("lensa")) return "lensa";
  }

  return "unknown";
}

function getHost(url: string | null) {
  if (!url) return null;

  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function tryParseUrl(url: string | null) {
  if (!url) return null;

  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function hasHostSuffix(host: string | null, suffixes: string[]) {
  if (!host) return false;
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}
