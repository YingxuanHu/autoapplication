import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { CompanyDiscoveryStatus, CrawlStatus } from "@/generated/prisma/client";

const THIRD_PARTY_JOB_HOST_HINTS = [
  "ashbyhq.com",
  "greenhouse.io",
  "lever.co",
  "recruitee.com",
  "rippling.com",
  "smartrecruiters.com",
  "successfactors.com",
  "successfactors.eu",
  "taleo.net",
  "workable.com",
  "myworkdayjobs.com",
  "wd1.myworkdaysite.com",
  "icims.com",
  "adzuna.com",
  "adzuna.ca",
  "jobicy.com",
  "remoteok.com",
  "remotive.com",
  "themuse.com",
  "himalayas.app",
  "jobbank.gc.ca",
  "lensa.com",
];

function normalizeHost(url: string | null | undefined) {
  if (!url) return null;

  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function isThirdPartyJobHost(host: string | null) {
  if (!host) return false;
  return THIRD_PARTY_JOB_HOST_HINTS.some(
    (hint) => host === hint || host.endsWith(`.${hint}`)
  );
}

export function inferCompanyDomainFromUrls(urls: Array<string | null | undefined>) {
  for (const url of urls) {
    const host = normalizeHost(url);
    if (!host || isThirdPartyJobHost(host)) continue;
    return host;
  }

  return null;
}

export async function ensureCompanyRecord(input: {
  companyName: string;
  companyKey: string;
  urls?: Array<string | null | undefined>;
  careersUrl?: string | null;
  detectedAts?: string | null;
  discoveryStatus?: CompanyDiscoveryStatus;
  crawlStatus?: CrawlStatus;
  discoveryConfidence?: number;
  metadataJson?: Record<string, unknown> | null;
}) {
  const domain =
    inferCompanyDomainFromUrls(input.urls ?? []) ??
    inferCompanyDomainFromUrls([input.careersUrl]) ??
    null;

  const existing = await prisma.company.findUnique({
    where: { companyKey: input.companyKey },
    select: {
      id: true,
      name: true,
      domain: true,
      careersUrl: true,
      detectedAts: true,
      discoveryStatus: true,
      crawlStatus: true,
      discoveryConfidence: true,
      metadataJson: true,
    },
  });

  if (existing) {
    return prisma.company.update({
      where: { companyKey: input.companyKey },
      data: {
        name: chooseBetterCompanyName(existing.name, input.companyName),
        domain: existing.domain ?? domain,
        careersUrl: existing.careersUrl ?? input.careersUrl ?? null,
        detectedAts: existing.detectedAts ?? input.detectedAts ?? null,
        discoveryStatus: input.discoveryStatus ?? existing.discoveryStatus,
        crawlStatus: input.crawlStatus ?? existing.crawlStatus,
        discoveryConfidence: Math.max(
          existing.discoveryConfidence,
          input.discoveryConfidence ?? 0
        ),
        metadataJson:
          ((mergeMetadataJson(
            existing.metadataJson as Record<string, unknown> | null,
            input.metadataJson
          ) as Prisma.InputJsonValue | null) ?? Prisma.DbNull),
      },
    });
  }

  return prisma.company.create({
    data: {
      name: input.companyName,
      companyKey: input.companyKey,
      domain,
      careersUrl: input.careersUrl ?? null,
      detectedAts: input.detectedAts ?? null,
      discoveryStatus: input.discoveryStatus ?? "PENDING",
      crawlStatus: input.crawlStatus ?? "IDLE",
      discoveryConfidence: input.discoveryConfidence ?? 0,
      metadataJson:
        input.metadataJson != null
          ? (input.metadataJson as Prisma.InputJsonValue)
          : Prisma.DbNull,
    },
  });
}

export async function assignCanonicalJobsToCompany(companyId: string, companyKey: string) {
  return prisma.jobCanonical.updateMany({
    where: {
      companyKey,
      OR: [{ companyId: null }, { companyId: { not: companyId } }],
    },
    data: { companyId },
  });
}

function chooseBetterCompanyName(currentValue: string, nextValue: string) {
  const currentLength = currentValue.trim().length;
  const nextLength = nextValue.trim().length;
  if (nextLength === 0) return currentValue;
  if (currentLength === 0) return nextValue;
  return nextLength > currentLength ? nextValue : currentValue;
}

function mergeMetadataJson(
  currentValue: Record<string, unknown> | null,
  nextValue: Record<string, unknown> | null | undefined
) {
  if (!currentValue && !nextValue) return null;
  if (!currentValue) return nextValue ?? null;
  if (!nextValue) return currentValue;

  const merged: Record<string, unknown> = { ...currentValue };

  for (const [key, value] of Object.entries(nextValue)) {
    const existing = merged[key];

    if (Array.isArray(existing) && Array.isArray(value)) {
      merged[key] = [...new Set([...existing, ...value])];
      continue;
    }

    if (
      existing &&
      value &&
      typeof existing === "object" &&
      typeof value === "object" &&
      !Array.isArray(existing) &&
      !Array.isArray(value)
    ) {
      merged[key] = {
        ...(existing as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
      continue;
    }

    if (value != null) {
      merged[key] = value;
    }
  }

  return merged;
}
