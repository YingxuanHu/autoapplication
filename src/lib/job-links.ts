export const DEMO_SOURCE_NAMES = [
  "BoardAggregator-X",
  "CompanyCareer-Direct",
  "PartnerAPI-Alpha",
] as const;

const DEMO_SOURCE_NAME_SET = new Set<string>(DEMO_SOURCE_NAMES);
const TRUSTED_SOURCE_PREFIXES = [
  "Ashby:",
  "Greenhouse:",
  "iCIMS:",
  "Lever:",
  "Recruitee:",
  "Rippling:",
  "SuccessFactors:",
  "SmartRecruiters:",
  "Taleo:",
  "Workday:",
];
const TRUSTED_HOST_SUFFIXES = [
  "icims.com",
  "jobs.ashbyhq.com",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "recruitee.com",
  "ats.rippling.com",
  "successfactors.com",
  "successfactors.eu",
  "jobs.smartrecruiters.com",
  "myworkdayjobs.com",
  "taleo.net",
];
const BLOCKED_HOST_SUFFIXES = [
  "boardaggregator-x.com",
  "companycareer-direct.com",
  "partnerapi-alpha.com",
];

export type JobLinkTrustLevel = "TRUSTED" | "CAUTION" | "UNAVAILABLE";

export type JobResolvedLink = {
  href: string;
  label: string;
  kind: "APPLY" | "SOURCE";
  sourceName: string | null;
};

export type JobLinkTrust = {
  level: JobLinkTrustLevel;
  label: string;
  summary: string;
};

export type JobSourceTrust = JobLinkTrust;

export function isDemoSourceName(sourceName: string) {
  return DEMO_SOURCE_NAME_SET.has(sourceName);
}

export function getSourceTrust(
  sourceName: string,
  sourceUrl: string | null
): JobSourceTrust {
  const parsedUrl = normalizeExternalUrl(sourceUrl);

  if (isDemoSourceName(sourceName)) {
    return {
      level: "UNAVAILABLE",
      label: "Demo source",
      summary:
        "This mapping comes from seeded demo data. External links are withheld until a live source confirms the job.",
    };
  }

  if (!parsedUrl) {
    return {
      level: "CAUTION",
      label: "Missing source link",
      summary:
        "The connector produced a canonical job, but there is no captured source posting URL for this mapping.",
    };
  }

  if (hasBlockedHost(parsedUrl)) {
    return {
      level: "UNAVAILABLE",
      label: "Untrusted source",
      summary:
        "This source host matches an internal/demo domain and should not be shown as a live external posting.",
    };
  }

  if (isTrustedConnectorSourceName(sourceName) || hasTrustedHost(parsedUrl)) {
    return {
      level: "TRUSTED",
      label: "Trusted source",
      summary:
        "This posting comes from a live structured connector with a known ATS source URL.",
    };
  }

  return {
    level: "CAUTION",
    label: "Live source",
    summary:
      "The job came from a non-demo source, but the host is not yet in the verified ATS list.",
  };
}

export function resolveJobLinks({
  applyUrl,
  sourceMappings,
}: {
  applyUrl: string | null;
  sourceMappings: Array<{
    sourceName: string;
    sourceUrl: string | null;
    isPrimary: boolean;
  }>;
}): {
  primaryExternalLink: JobResolvedLink | null;
  sourcePostingLink: JobResolvedLink | null;
  linkTrust: JobLinkTrust;
} {
  const enrichedSources = sourceMappings.map((sourceMapping) => ({
    ...sourceMapping,
    trust: getSourceTrust(sourceMapping.sourceName, sourceMapping.sourceUrl),
    parsedSourceUrl: normalizeExternalUrl(sourceMapping.sourceUrl),
  }));

  const allSourcesAreDemo =
    enrichedSources.length > 0 &&
    enrichedSources.every((sourceMapping) =>
      isDemoSourceName(sourceMapping.sourceName)
    );
  const trustedSource =
    enrichedSources.find(
      (sourceMapping) =>
        sourceMapping.isPrimary &&
        sourceMapping.trust.level === "TRUSTED" &&
        sourceMapping.parsedSourceUrl !== null
    ) ??
    enrichedSources.find(
      (sourceMapping) =>
        sourceMapping.trust.level === "TRUSTED" &&
        sourceMapping.parsedSourceUrl !== null
    ) ??
    null;
  const liveSource =
    enrichedSources.find(
      (sourceMapping) =>
        sourceMapping.isPrimary &&
        sourceMapping.trust.level !== "UNAVAILABLE" &&
        sourceMapping.parsedSourceUrl !== null
    ) ??
    enrichedSources.find(
      (sourceMapping) =>
        sourceMapping.trust.level !== "UNAVAILABLE" &&
        sourceMapping.parsedSourceUrl !== null
    ) ??
    null;

  const parsedApplyUrl = normalizeExternalUrl(applyUrl);
  const canUseApplyUrl =
    parsedApplyUrl !== null &&
    !allSourcesAreDemo &&
    !hasBlockedHost(parsedApplyUrl) &&
    (trustedSource !== null || liveSource !== null);

  const primaryExternalLink = canUseApplyUrl
    ? {
        href: parsedApplyUrl.toString(),
        label: "Open application",
        kind: "APPLY" as const,
        sourceName: trustedSource?.sourceName ?? liveSource?.sourceName ?? null,
      }
    : trustedSource
      ? {
          href: trustedSource.parsedSourceUrl!.toString(),
          label: "Open source posting",
          kind: "SOURCE" as const,
          sourceName: trustedSource.sourceName,
        }
      : liveSource
        ? {
            href: liveSource.parsedSourceUrl!.toString(),
            label: "Open source posting",
            kind: "SOURCE" as const,
            sourceName: liveSource.sourceName,
          }
        : null;

  const sourcePostingLink =
    liveSource && liveSource.parsedSourceUrl
      ? {
          href: liveSource.parsedSourceUrl.toString(),
          label: "Open source posting",
          kind: "SOURCE" as const,
          sourceName: liveSource.sourceName,
        }
      : null;

  if (allSourcesAreDemo) {
    return {
      primaryExternalLink: null,
      sourcePostingLink: null,
      linkTrust: {
        level: "UNAVAILABLE",
        label: "Demo-only record",
        summary:
          "This job is only backed by seeded/demo sources. It stays in the database for modeling, but its external links are withheld from product surfaces.",
      },
    };
  }

  if (primaryExternalLink && trustedSource) {
    return {
      primaryExternalLink,
      sourcePostingLink:
        sourcePostingLink && sourcePostingLink.href !== primaryExternalLink.href
          ? sourcePostingLink
          : null,
      linkTrust: {
        level: "TRUSTED",
        label: "Trusted outbound link",
        summary:
          "This job has a live external posting from a structured source, so outbound navigation is shown normally.",
      },
    };
  }

  if (primaryExternalLink) {
    return {
      primaryExternalLink,
      sourcePostingLink:
        sourcePostingLink && sourcePostingLink.href !== primaryExternalLink.href
          ? sourcePostingLink
          : null,
      linkTrust: {
        level: "CAUTION",
        label: "Use with caution",
        summary:
          "A live external link is available, but the source is not yet on the verified ATS list. Open it with normal caution.",
      },
    };
  }

  return {
    primaryExternalLink: null,
    sourcePostingLink: null,
    linkTrust: {
      level: "UNAVAILABLE",
      label: "No reliable external link",
      summary:
        "This job exists in the canonical pool, but there is no trustworthy external posting URL captured yet.",
    },
  };
}

function isTrustedConnectorSourceName(sourceName: string) {
  return TRUSTED_SOURCE_PREFIXES.some((prefix) => sourceName.startsWith(prefix));
}

function normalizeExternalUrl(value: string | null | undefined) {
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function hasTrustedHost(url: URL) {
  return TRUSTED_HOST_SUFFIXES.some(
    (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)
  );
}

function hasBlockedHost(url: URL) {
  return BLOCKED_HOST_SUFFIXES.some(
    (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)
  );
}
