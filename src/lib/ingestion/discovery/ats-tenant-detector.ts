import type { AtsPlatform } from "@/generated/prisma/client";
import {
  buildJobviteBoardUrl,
  buildJobviteSourceToken,
  buildTaleoBoardUrl,
  buildTaleoSourceToken,
  buildWorkdayBoardUrl,
  buildWorkdaySourceToken,
} from "@/lib/ingestion/connectors";

export type DetectedAtsTenant = {
  platform: AtsPlatform;
  tenantKey: string;
  normalizedBoardUrl: string;
  rootHost: string;
};

function safeUrl(input: string) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function normalizePathSegments(url: URL) {
  return url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

const GENERIC_JOBVITE_TOKENS = new Set([
  "about",
  "career",
  "careers",
  "company",
  "job",
  "jobs",
  "join",
  "join-us",
  "openings",
  "search",
]);

function buildDetected(platform: AtsPlatform, tenantKey: string, boardUrl: string) {
  const url = safeUrl(boardUrl);
  if (!url) return null;

  return {
    platform,
    tenantKey: tenantKey.trim().toLowerCase(),
    normalizedBoardUrl: url.toString(),
    rootHost: url.hostname.replace(/^www\./i, "").toLowerCase(),
  } satisfies DetectedAtsTenant;
}

export function detectAtsTenantFromUrl(input: string): DetectedAtsTenant | null {
  const url = safeUrl(input);
  if (!url) return null;

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  const path = normalizePathSegments(url);

  if (host === "jobs.ashbyhq.com" && path[0]) {
    return buildDetected("ASHBY", path[0], `https://jobs.ashbyhq.com/${path[0]}`);
  }

  if ((host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") && path[0]) {
    return buildDetected("GREENHOUSE", path[0], `https://job-boards.greenhouse.io/${path[0]}`);
  }

  if (host === "jobs.lever.co" && path[0]) {
    return buildDetected("LEVER", path[0], `https://jobs.lever.co/${path[0]}`);
  }

  if (host.endsWith(".recruitee.com")) {
    const subdomain = host.split(".")[0];
    return buildDetected("RECRUITEE", subdomain, `https://${subdomain}.recruitee.com/`);
  }

  if (host === "ats.rippling.com" && path[0]) {
    return buildDetected("RIPPLING", path[0], `https://ats.rippling.com/${path[0]}/jobs`);
  }

  if (
    (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") &&
    path[0]
  ) {
    return buildDetected("SMARTRECRUITERS", path[0], `https://jobs.smartrecruiters.com/${path[0]}`);
  }

  if ((host.endsWith(".successfactors.com") || host.endsWith(".successfactors.eu")) && path.length > 0) {
    const tenantKey = [host.split(".")[0], ...path.slice(0, 2)].join("|");
    return buildDetected("SUCCESSFACTORS", tenantKey, `${url.origin}/${path.slice(0, 2).join("/")}`);
  }

  if (host.endsWith(".taleo.net") && path[0]) {
    const tenant = host.split(".")[0];
    if (path[0] === "careersection" && path[1] && path[1] !== "sitemap.jss" && path[1] !== "rest") {
      const tenantKey = buildTaleoSourceToken({
        tenant,
        careerSection: path[1],
      });
      return buildDetected("TALEO", tenantKey, buildTaleoBoardUrl(tenantKey));
    }
  }

  if (host === "apply.workable.com" && path[0]) {
    return buildDetected("WORKABLE", path[0], `https://apply.workable.com/${path[0]}/`);
  }

  if (host.includes("myworkdayjobs.com") || host.includes("myworkdaysite.com")) {
    const hostTenant = host.split(".")[0] ?? host;

    if (
      path[0] === "wday" &&
      path[1] === "cxs" &&
      path[2] &&
      path[3]
    ) {
      const tenantKey = buildWorkdaySourceToken({
        host,
        tenant: path[2],
        site: path[3],
      });
      return buildDetected("WORKDAY", tenantKey, buildWorkdayBoardUrl(tenantKey));
    }

    const localeOffset =
      path[0]?.match(/^[a-z]{2}(?:-[a-z]{2})?$/i) ? 1 : 0;
    const site = path[localeOffset];
    if (site) {
      const tenantKey = buildWorkdaySourceToken({
        host,
        tenant: hostTenant,
        site,
      });
      return buildDetected("WORKDAY", tenantKey, buildWorkdayBoardUrl(tenantKey));
    }
  }

  if (host.endsWith(".icims.com")) {
    const tenantKey = host.split(".")[0];
    return buildDetected("ICIMS", tenantKey, url.origin);
  }

  if (host === "jobs.jobvite.com" && path[0]) {
    const companyToken = buildJobviteSourceToken(path[0]);
    if (!GENERIC_JOBVITE_TOKENS.has(companyToken)) {
      return buildDetected("JOBVITE", companyToken, buildJobviteBoardUrl(companyToken));
    }
  }

  if (host.endsWith(".teamtailor.com") && path[0] === "jobs") {
    const tenantKey = host.split(".")[0];
    return buildDetected("TEAMTAILOR", tenantKey, `${url.origin}/jobs`);
  }

  return null;
}
