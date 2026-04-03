import { prisma } from "@/lib/db";
import {
  ENTERPRISE_DISCOVERY_COMPANIES,
  type EnterpriseAtsHint,
  type EnterpriseCompanyRecord,
} from "@/lib/ingestion/discovery/enterprise-catalog";

export type CompanyDiscoveryCorpusEntry = {
  companyKey: string;
  displayName: string;
  aliases: string[];
  totalLiveCount: number;
  canadaRelevantCount: number;
  canadaRemoteCount: number;
  score: number;
  matchedCatalogName: string | null;
  record: EnterpriseCompanyRecord;
};

type RawCompanyCounts = {
  totalLiveCount: number;
  canadaRelevantCount: number;
  canadaRemoteCount: number;
};

const COMPANY_SKIP_RE = new RegExp(
  [
    "\\brecruit(?:er|ers|ing|ment)\\b",
    "\\bstaff(?:ing)?\\b",
    "\\bheadhunt(?:er|ing)?\\b",
    "\\bagency\\b",
    "\\bjobgether\\b",
    "\\bmercor\\b",
    "\\bactalent\\b",
    "\\bnearsource\\b",
    "\\bmaarut\\b",
    "\\bemergitel\\b",
    "\\btalentsphere\\b",
    "\\bflexstaf\\b",
    "\\binner circle agency\\b",
    "\\bnewfound recruiting\\b",
    "\\bswim recruiting\\b",
    "\\bstarboard recruitment\\b",
    "\\btechbiz global\\b",
    "\\bwelcome to the jungle\\b",
  ].join("|"),
  "i"
);

const CORPORATE_SUFFIX_RE =
  /\b(?:incorporated|inc|corporation|corp|company|co|limited|ltd|llc|ulc|llp|lp|plc|gmbh|ulc|holdings?)\.?$/i;

const PREFIX_NOISE_RE =
  /^(?:company\s+\d+\s*-\s*|[a-z]{1,3}\d{2,}\s+|\d{4,}\s+|canada:\s*)/i;

type CatalogAliasEntry = {
  aliasKey: string;
  record: EnterpriseCompanyRecord;
};

const catalogAliases = buildCatalogAliasEntries();

export async function buildCompanyDiscoveryCorpus(options?: {
  limit?: number;
  minCanadaRelevantCount?: number;
  minTotalLiveCount?: number;
}) {
  const minCanadaRelevantCount = options?.minCanadaRelevantCount ?? 1;
  const minTotalLiveCount = options?.minTotalLiveCount ?? 1;

  const [liveRows, canadaRows, canadaRemoteRows] = await Promise.all([
    prisma.jobCanonical.groupBy({
      by: ["company"],
      where: { status: "LIVE" },
      _count: { _all: true },
    }),
    prisma.jobCanonical.groupBy({
      by: ["company"],
      where: {
        status: "LIVE",
        OR: [{ region: "CA" }, { region: "CA", workMode: "REMOTE" }],
      },
      _count: { _all: true },
    }),
    prisma.jobCanonical.groupBy({
      by: ["company"],
      where: {
        status: "LIVE",
        region: "CA",
        workMode: "REMOTE",
      },
      _count: { _all: true },
    }),
  ]);

  const countsByName = new Map<string, RawCompanyCounts>();

  for (const row of liveRows) {
    countsByName.set(row.company, {
      totalLiveCount: row._count._all,
      canadaRelevantCount: 0,
      canadaRemoteCount: 0,
    });
  }

  for (const row of canadaRows) {
    const existing = countsByName.get(row.company) ?? {
      totalLiveCount: 0,
      canadaRelevantCount: 0,
      canadaRemoteCount: 0,
    };
    existing.canadaRelevantCount = row._count._all;
    countsByName.set(row.company, existing);
  }

  for (const row of canadaRemoteRows) {
    const existing = countsByName.get(row.company) ?? {
      totalLiveCount: 0,
      canadaRelevantCount: 0,
      canadaRemoteCount: 0,
    };
    existing.canadaRemoteCount = row._count._all;
    countsByName.set(row.company, existing);
  }

  const merged = new Map<
    string,
    {
      aliases: Set<string>;
      counts: RawCompanyCounts;
      matchedCatalog: EnterpriseCompanyRecord | null;
      displayName: string;
    }
  >();

  for (const [companyName, counts] of countsByName.entries()) {
    if (
      counts.totalLiveCount < minTotalLiveCount ||
      counts.canadaRelevantCount < minCanadaRelevantCount
    ) {
      continue;
    }

    const cleaned = cleanCompanyName(companyName);
    if (!cleaned || COMPANY_SKIP_RE.test(cleaned)) {
      continue;
    }

    const companyKey = buildCompanyKey(cleaned);
    if (!companyKey) continue;

    const matchedCatalog = matchEnterpriseCatalogEntry(cleaned);
    const entry = merged.get(companyKey) ?? {
      aliases: new Set<string>(),
      counts: {
        totalLiveCount: 0,
        canadaRelevantCount: 0,
        canadaRemoteCount: 0,
      },
      matchedCatalog,
      displayName: matchedCatalog?.name ?? cleaned,
    };

    entry.aliases.add(cleaned);
    entry.aliases.add(companyName.trim());
    entry.counts.totalLiveCount += counts.totalLiveCount;
    entry.counts.canadaRelevantCount += counts.canadaRelevantCount;
    entry.counts.canadaRemoteCount += counts.canadaRemoteCount;
    if (!entry.matchedCatalog && matchedCatalog) {
      entry.matchedCatalog = matchedCatalog;
      entry.displayName = matchedCatalog.name;
    }
    if (!entry.matchedCatalog) {
      entry.displayName = chooseBetterDisplayName(entry.displayName, cleaned);
    }

    merged.set(companyKey, entry);
  }

  const corpus = [...merged.entries()]
    .map(([companyKey, value]) => {
      const record = value.matchedCatalog
        ? mergeCatalogRecord(value.matchedCatalog, value.aliases)
        : buildGeneratedRecord(value.displayName, value.aliases, value.counts);
      const score = buildCorpusScore(record, value.counts);

      return {
        companyKey,
        displayName: value.displayName,
        aliases: [...value.aliases].sort(),
        totalLiveCount: value.counts.totalLiveCount,
        canadaRelevantCount: value.counts.canadaRelevantCount,
        canadaRemoteCount: value.counts.canadaRemoteCount,
        score,
        matchedCatalogName: value.matchedCatalog?.name ?? null,
        record,
      } satisfies CompanyDiscoveryCorpusEntry;
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.canadaRelevantCount !== left.canadaRelevantCount) {
        return right.canadaRelevantCount - left.canadaRelevantCount;
      }
      if (right.totalLiveCount !== left.totalLiveCount) {
        return right.totalLiveCount - left.totalLiveCount;
      }
      return left.displayName.localeCompare(right.displayName);
    });

  return typeof options?.limit === "number" ? corpus.slice(0, options.limit) : corpus;
}

export function cleanCompanyName(input: string) {
  let cleaned = decodeHtmlEntities(input)
    .replace(/\s+/g, " ")
    .trim();

  while (PREFIX_NOISE_RE.test(cleaned)) {
    cleaned = cleaned.replace(PREFIX_NOISE_RE, "").trim();
  }

  cleaned = cleaned.replace(/\((?:canada|ca)\)/gi, "").trim();

  while (CORPORATE_SUFFIX_RE.test(cleaned)) {
    cleaned = cleaned.replace(CORPORATE_SUFFIX_RE, "").trim();
  }

  cleaned = cleaned
    .replace(/\s+-\s+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return cleaned;
}

export function buildCompanyKey(input: string) {
  return cleanCompanyName(input)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function mergeCatalogRecord(
  record: EnterpriseCompanyRecord,
  aliases: Set<string>
): EnterpriseCompanyRecord {
  const searchTerms = new Set<string>(record.searchTerms ?? []);
  for (const alias of aliases) {
    if (!alias || alias.toLowerCase() === record.name.toLowerCase()) continue;
    searchTerms.add(alias);
  }

  return {
    ...record,
    searchTerms: [...searchTerms].sort(),
  };
}

function buildGeneratedRecord(
  displayName: string,
  aliases: Set<string>,
  counts: RawCompanyCounts
): EnterpriseCompanyRecord {
  const slug = displayName
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return {
    name: displayName,
    searchTerms: [...aliases]
      .filter((alias) => alias.toLowerCase() !== displayName.toLowerCase())
      .sort(),
    tenants: slug ? [slug] : [buildCompanyKey(displayName)],
    ats: "unknown" satisfies EnterpriseAtsHint,
    sectors: [],
    remoteCanadaLikely: counts.canadaRemoteCount > 0,
  };
}

function buildCorpusScore(
  record: EnterpriseCompanyRecord,
  counts: RawCompanyCounts
) {
  let score = 0;
  score += counts.canadaRelevantCount * 8;
  score += counts.canadaRemoteCount * 3;
  score += counts.totalLiveCount * 1.5;

  if ((record.seedPageUrls?.length ?? 0) > 0) score += 24;
  if ((record.domains?.length ?? 0) > 0) score += 18;
  if (record.canadaHq) score += 12;
  if ((record.canadaCities?.length ?? 0) > 0) score += 6;
  if (record.remoteCanadaLikely) score += 5;
  if (record.ats !== "unknown") score += 4;

  return score;
}

function matchEnterpriseCatalogEntry(companyName: string) {
  const companyKey = buildCompanyKey(companyName);
  if (!companyKey) return null;

  const exact = catalogAliases.find((entry) => entry.aliasKey === companyKey);
  if (exact) return exact.record;

  return (
    catalogAliases.find((entry) => {
      if (entry.aliasKey.length < 8 || companyKey.length < 8) return false;
      return (
        companyKey.includes(entry.aliasKey) || entry.aliasKey.includes(companyKey)
      );
    })?.record ?? null
  );
}

function buildCatalogAliasEntries() {
  const entries: CatalogAliasEntry[] = [];

  for (const record of ENTERPRISE_DISCOVERY_COMPANIES) {
    const aliases = new Set<string>([
      record.name,
      ...(record.searchTerms ?? []),
      ...record.tenants.filter((tenant) => tenant.length >= 4),
    ]);

    for (const alias of aliases) {
      const aliasKey = buildCompanyKey(alias);
      if (!aliasKey) continue;
      entries.push({ aliasKey, record });
    }
  }

  return entries;
}

function chooseBetterDisplayName(current: string, candidate: string) {
  if (!current) return candidate;
  if (candidate.length < current.length) return candidate;
  return current;
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
