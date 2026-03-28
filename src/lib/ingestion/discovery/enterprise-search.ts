import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildSuccessFactorsBoardUrl,
} from "@/lib/ingestion/connectors";
import {
  discoverSourceCandidatesFromPageUrls,
  discoverSourceCandidatesFromUrls,
  fetchBingRssLinks,
  type DiscoveredSourceCandidate,
} from "@/lib/ingestion/discovery/sources";
import {
  selectEnterpriseCompanies,
  type EnterpriseCompanyRecord,
} from "@/lib/ingestion/discovery/enterprise-catalog";

export type EnterpriseSearchFamily = "workday" | "successfactors";

export type EnterpriseSearchQuery = {
  companyName: string;
  family: EnterpriseSearchFamily;
  query: string;
  reason: string;
  priority: number;
};

type EnterpriseSearchTerm = {
  value: string;
  reason: string;
  priorityDelta: number;
  canadaCityEligible: boolean;
};

type EnterpriseSearchCacheEntry = {
  query: string;
  fetchedAt: string;
  resultUrls: string[];
  errors: string[];
};

type EnterpriseSearchCache = {
  updatedAt: string;
  entries: EnterpriseSearchCacheEntry[];
};

type KnownSourceStatus = "pending" | "rejected" | "promoted";

export type EnterpriseSearchCandidateRecord = {
  url: string;
  boardUrl: string;
  sourceKey: string;
  connectorName: EnterpriseSearchFamily;
  token: string;
  companyNames: string[];
  discoveredFromQueries: string[];
  searchResultUrls: string[];
  matchedReasons: string[];
  knownStatus: KnownSourceStatus | null;
};

export type EnterpriseDiscoverySummary = {
  companiesSelected: string[];
  queryCount: number;
  cacheHits: number;
  cacheMisses: number;
  resultUrlsFetched: number;
  uniqueResultUrls: number;
  pageUrlsScanned: number;
  directSeedUrls: number;
  candidatesDiscovered: number;
  newCandidates: number;
  skippedKnownCandidates: number;
  candidatesByFamily: Record<string, number>;
  queryReports: Array<{
    companyName: string;
    family: EnterpriseSearchFamily;
    query: string;
    reason: string;
    fromCache: boolean;
    resultUrlsFetched: number;
    errors: string[];
  }>;
};

const DEFAULT_CACHE_PATH = "data/discovery/seeds/enterprise-search-cache.json";
const DEFAULT_STORE_PATH = "data/discovery/source-candidates.json";
const SEARCH_QUERY_CONCURRENCY = 6;

export async function discoverEnterpriseSearchCandidates(options?: {
  companies?: string[];
  families?: EnterpriseSearchFamily[];
  limitCompanies?: number;
  maxSearchResults?: number;
  cachePath?: string;
  storePath?: string;
  canadaWeighted?: boolean;
  includeKnown?: boolean;
  retestSearch?: boolean;
}) {
  const companies = selectDiscoveryCompanies({
    companies: options?.companies,
    families: options?.families,
    limitCompanies: options?.limitCompanies,
    canadaWeighted: options?.canadaWeighted ?? true,
  });
  const queries = buildEnterpriseSearchQueries(companies, {
    families: options?.families,
    canadaWeighted: options?.canadaWeighted ?? true,
  });
  const cachePath = path.resolve(options?.cachePath ?? DEFAULT_CACHE_PATH);
  const cache = await loadSearchCache(cachePath);
  const knownStatuses = await loadKnownSourceStatuses(
    path.resolve(options?.storePath ?? DEFAULT_STORE_PATH)
  );

  const searchReports: EnterpriseDiscoverySummary["queryReports"] = [];
  const allResultUrls = new Set<string>();
  let cacheHits = 0;
  let cacheMisses = 0;
  const queryReports = new Array<EnterpriseDiscoverySummary["queryReports"][number]>(
    queries.length
  );
  let queryCursor = 0;

  async function queryWorker() {
    while (queryCursor < queries.length) {
      const index = queryCursor;
      queryCursor += 1;
      const queryPlan = queries[index]!;
      const cacheEntry = !options?.retestSearch
        ? cache.entries.find((entry) => entry.query === queryPlan.query)
        : null;
      let resultUrls: string[] = [];
      let errors: string[] = [];
      let fromCache = false;

      if (cacheEntry) {
        resultUrls = cacheEntry.resultUrls;
        errors = cacheEntry.errors;
        fromCache = true;
        cacheHits += 1;
      } else {
        cacheMisses += 1;
        try {
          resultUrls = await fetchBingRssLinks(
            queryPlan.query,
            options?.maxSearchResults ?? 5
          );
        } catch (error) {
          errors = [error instanceof Error ? error.message : String(error)];
        }

        upsertCacheEntry(cache, {
          query: queryPlan.query,
          fetchedAt: new Date().toISOString(),
          resultUrls,
          errors,
        });
      }

      queryReports[index] = {
        companyName: queryPlan.companyName,
        family: queryPlan.family,
        query: queryPlan.query,
        reason: queryPlan.reason,
        fromCache,
        resultUrlsFetched: resultUrls.length,
        errors,
      };

      for (const resultUrl of resultUrls) {
        allResultUrls.add(resultUrl);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(SEARCH_QUERY_CONCURRENCY, queries.length) },
      () => queryWorker()
    )
  );
  searchReports.push(...queryReports.filter(Boolean));

  await saveSearchCache(cachePath, cache);

  const directSeedUrls = buildDirectSeedUrls(companies, options?.families);
  const resultUrls = [...allResultUrls];
  const pageScanUrls = [
    ...new Set([
      ...resultUrls.filter((url) => shouldScanEnterprisePageUrl(url)),
      ...directSeedUrls.map((item) => item.url),
    ]),
  ];
  const candidateUrls = [...new Set([...resultUrls, ...directSeedUrls.map((item) => item.url)])];
  const [urlDiscovery, pageDiscovery] = await Promise.all([
    discoverSourceCandidatesFromUrls(candidateUrls),
    discoverSourceCandidatesFromPageUrls(pageScanUrls, { concurrency: 10 }),
  ]);

  const mergedCandidates = new Map<string, DiscoveredSourceCandidate>();
  for (const candidate of [...urlDiscovery.candidates, ...pageDiscovery.candidates]) {
    if (!isEnterpriseFamily(candidate.connectorName, options?.families)) continue;
    mergedCandidates.set(candidate.sourceKey, candidate);
  }

  const queryMap = buildQueryMap(queries, companies);
  const pageResultMap = buildResultUrlMap(searchReports, cache, directSeedUrls);
  const candidateSourceMap = buildCandidateSourceMap(
    urlDiscovery.sourceMap,
    pageDiscovery.sourceMap,
    pageResultMap,
    queryMap
  );
  const candidateRecords = [...mergedCandidates.values()]
    .map((candidate) => {
      const metadata = candidateSourceMap.get(candidate.sourceKey) ?? {
        companyNames: [],
        queries: [],
        reasons: [],
        resultUrls: [],
      };
      const knownStatus = knownStatuses.get(candidate.sourceKey) ?? null;
      return {
        url: candidate.boardUrl,
        boardUrl: candidate.boardUrl,
        sourceKey: candidate.sourceKey,
        connectorName: candidate.connectorName as EnterpriseSearchFamily,
        token: candidate.token,
        companyNames: metadata.companyNames,
        discoveredFromQueries: metadata.queries,
        searchResultUrls: metadata.resultUrls,
        matchedReasons: metadata.reasons,
        knownStatus,
      } satisfies EnterpriseSearchCandidateRecord;
    })
    .filter((candidate) => {
      if (options?.includeKnown) return true;
      return candidate.knownStatus === null;
    })
    .sort((left, right) => {
      const leftPriority = Math.max(left.companyNames.length, left.discoveredFromQueries.length);
      const rightPriority = Math.max(right.companyNames.length, right.discoveredFromQueries.length);
      if (rightPriority !== leftPriority) return rightPriority - leftPriority;
      return left.sourceKey.localeCompare(right.sourceKey);
    });

  const candidatesByFamily = candidateRecords.reduce<Record<string, number>>(
    (counts, candidate) => {
      counts[candidate.connectorName] = (counts[candidate.connectorName] ?? 0) + 1;
      return counts;
    },
    {}
  );
  const skippedKnownCandidates = [...mergedCandidates.values()].length - candidateRecords.length;

  return {
    records: candidateRecords,
    summary: {
      companiesSelected: companies.map((company) => company.name),
      queryCount: queries.length,
      cacheHits,
      cacheMisses,
      resultUrlsFetched: resultUrls.length,
      uniqueResultUrls: candidateUrls.length,
      pageUrlsScanned: pageScanUrls.length,
      directSeedUrls: directSeedUrls.length,
      candidatesDiscovered: mergedCandidates.size,
      newCandidates: candidateRecords.length,
      skippedKnownCandidates,
      candidatesByFamily,
      queryReports: searchReports,
    } satisfies EnterpriseDiscoverySummary,
  };
}

export async function writeEnterpriseDiscoveryDataset(options: {
  outputPath: string;
  records: EnterpriseSearchCandidateRecord[];
  summary: EnterpriseDiscoverySummary;
}) {
  const outputPath = path.resolve(options.outputPath);
  const reportPath = outputPath.replace(/\.json$/i, ".report.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(options.records, null, 2)}\n`, "utf8");
  await writeFile(reportPath, `${JSON.stringify(options.summary, null, 2)}\n`, "utf8");
  return { outputPath, reportPath };
}

function buildEnterpriseSearchQueries(
  companies: EnterpriseCompanyRecord[],
  options?: {
    families?: EnterpriseSearchFamily[];
    canadaWeighted?: boolean;
  }
) {
  const families = options?.families ?? ["workday", "successfactors"];
  const queries: EnterpriseSearchQuery[] = [];

  for (const company of companies) {
    if (families.includes("workday") && supportsFamily(company, "workday")) {
      const firstCanadaCity = company.canadaCities?.[0];
      const searchTerms = buildEnterpriseSearchTerms(company);
      for (const term of searchTerms) {
        const priorityBase = 10 + term.priorityDelta;
        queries.push({
          companyName: company.name,
          family: "workday",
          query: `site:myworkdayjobs.com "${term.value}" careers`,
          reason: `workday_${term.reason}_direct`,
          priority: priorityBase,
        });
        queries.push({
          companyName: company.name,
          family: "workday",
          query: `site:myworkdayjobs.com "${term.value}" jobs`,
          reason: `workday_${term.reason}_jobs`,
          priority: priorityBase - 1,
        });
        queries.push({
          companyName: company.name,
          family: "workday",
          query: `"${term.value}" "myworkdayjobs.com"`,
          reason: `workday_${term.reason}_host_hint`,
          priority: priorityBase - 2,
        });
        queries.push({
          companyName: company.name,
          family: "workday",
          query: `"${term.value}" careers workday`,
          reason: `workday_${term.reason}_careers_page`,
          priority: priorityBase - 1,
        });
        if (
          options?.canadaWeighted !== false &&
          firstCanadaCity &&
          term.canadaCityEligible
        ) {
          queries.push({
            companyName: company.name,
            family: "workday",
            query: `site:myworkdayjobs.com "${term.value}" "${firstCanadaCity}" careers`,
            reason: `workday_${term.reason}_canada_city`,
            priority: priorityBase + 1,
          });
        }
      }
      if (company.tenants[0]) {
        queries.push({
          companyName: company.name,
          family: "workday",
          query: `site:myworkdayjobs.com "${company.tenants[0]}" careers`,
          reason: "tenant_direct",
          priority: 8,
        });
      }
      if (options?.canadaWeighted !== false && firstCanadaCity) {
        queries.push({
          companyName: company.name,
          family: "workday",
          query: `site:myworkdayjobs.com "${company.name}" "${firstCanadaCity}" careers`,
          reason: "canada_city_direct",
          priority: 11,
        });
      }
    }

    if (
      families.includes("successfactors") &&
      supportsFamily(company, "successfactors")
    ) {
      const searchTerms = buildEnterpriseSearchTerms(company).slice(0, 3);
      for (const term of searchTerms) {
        const priorityBase = 8 + term.priorityDelta;
        queries.push({
          companyName: company.name,
          family: "successfactors",
          query: `"${term.value}" careers`,
          reason: `successfactors_${term.reason}_careers_page`,
          priority: priorityBase - 2,
        });
        queries.push({
          companyName: company.name,
          family: "successfactors",
          query: `"${term.value}" "createNewAlert=false"`,
          reason: `successfactors_${term.reason}_listing_hint`,
          priority: priorityBase,
        });
        queries.push({
          companyName: company.name,
          family: "successfactors",
          query: `"${term.value}" "talentcommunity/apply"`,
          reason: `successfactors_${term.reason}_apply_hint`,
          priority: priorityBase - 1,
        });
      }
      for (const host of company.sfHosts ?? []) {
        queries.push({
          companyName: company.name,
          family: "successfactors",
          query: `site:${host} "${company.name}" jobs`,
          reason: "known_sf_host",
          priority: 10,
        });
      }
    }
  }

  queries.push(...buildSupplementalQueries(families));

  return dedupeQueries(queries).sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    return left.query.localeCompare(right.query);
  });
}

function buildEnterpriseSearchTerms(company: EnterpriseCompanyRecord) {
  const terms: EnterpriseSearchTerm[] = [];
  const seen = new Set<string>();
  const normalizedCompanyName = normalizeSearchTerm(company.name);

  function addTerm(
    value: string,
    reason: string,
    priorityDelta: number,
    canadaCityEligible = true
  ) {
    const normalized = normalizeSearchTerm(value);
    if (!normalized || normalized.length < 2 || seen.has(normalized)) return;
    seen.add(normalized);
    terms.push({
      value: value.trim(),
      reason,
      priorityDelta,
      canadaCityEligible,
    });
  }

  addTerm(company.name, "company_name", 0);

  for (const term of company.searchTerms ?? []) {
    addTerm(term, "search_term", -1);
  }

  for (const segment of deriveCompanyNameSegments(company.name)) {
    addTerm(segment, "name_segment", -2, false);
  }

  for (const tenant of company.tenants) {
    if (!isSearchableTenant(tenant, normalizedCompanyName)) continue;
    addTerm(formatTenantSearchTerm(tenant), "tenant_term", -2, false);
  }

  return terms.slice(0, 4);
}

function deriveCompanyNameSegments(name: string) {
  const segments = new Set<string>();

  for (const segment of name.split(/\s*\/\s*/)) {
    const trimmed = segment.trim();
    if (trimmed) segments.add(trimmed);
  }

  const withoutParens = name.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (withoutParens && withoutParens !== name) {
    segments.add(withoutParens);
  }

  for (const match of name.matchAll(/\(([^)]+)\)/g)) {
    const inner = match[1]?.trim();
    if (inner) segments.add(inner);
  }

  const stripped = name
    .replace(/\s+(financial group|group|corp(?:oration)?|inc\.?|ltd\.?|limited|holdings?)$/i, "")
    .trim();
  if (stripped && stripped !== name) {
    segments.add(stripped);
  }

  return [...segments];
}

function isSearchableTenant(tenant: string, normalizedCompanyName: string) {
  const normalizedTenant = normalizeSearchTerm(tenant);
  if (!normalizedTenant || normalizedTenant.length < 4) return false;
  return !normalizedCompanyName.includes(normalizedTenant);
}

function formatTenantSearchTerm(tenant: string) {
  if (/^[a-z]{2,8}$/i.test(tenant)) {
    return tenant.toUpperCase();
  }
  return tenant.replace(/[-_]+/g, " ").trim();
}

function normalizeSearchTerm(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDirectSeedUrls(
  companies: EnterpriseCompanyRecord[],
  families?: EnterpriseSearchFamily[]
) {
  const urls = new Map<string, string>();
  const familiesSet = new Set(families ?? ["workday", "successfactors"]);

  for (const company of companies) {
    const supportsRequestedFamily =
      (familiesSet.has("workday") && supportsFamily(company, "workday")) ||
      (familiesSet.has("successfactors") && supportsFamily(company, "successfactors"));

    if (supportsRequestedFamily) {
      for (const seedPageUrl of company.seedPageUrls ?? []) {
        if (!seedPageUrl.trim()) continue;
        urls.set(seedPageUrl, company.name);
      }
    }

    if (
      familiesSet.has("successfactors") &&
      supportsFamily(company, "successfactors")
    ) {
      for (const host of company.sfHosts ?? []) {
        const pathPrefixes = company.sfPaths?.length ? company.sfPaths : [null];
        for (const pathPrefix of pathPrefixes) {
          const token = pathPrefix ? `${host}|${pathPrefix}` : host;
          urls.set(buildSuccessFactorsBoardUrl(token), company.name);
        }
      }
    }
  }

  return [...urls.entries()].map(([url, companyName]) => ({ url, companyName }));
}

function shouldScanEnterprisePageUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const combined = `${hostname}${path}`;

    if (hostname.includes("myworkdayjobs.com")) return true;
    if (hostname.startsWith("careers.") || hostname.startsWith("jobs.")) return true;
    if (
      /(careers?|jobs?|jobsearch|employment|opportunit|join-us|work-with-us|talentcommunity|createNewAlert=false|search)/i.test(
        combined
      )
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function buildQueryMap(
  queries: EnterpriseSearchQuery[],
  companies: EnterpriseCompanyRecord[]
) {
  const companyMap = new Map(
    companies.map((company) => [company.name, company])
  );
  return new Map(
    queries.map((query) => [
      query.query,
      {
        company: companyMap.get(query.companyName),
        reason: query.reason,
      },
    ])
  );
}

function buildResultUrlMap(
  queryReports: EnterpriseDiscoverySummary["queryReports"],
  cache: EnterpriseSearchCache,
  directSeedUrls: Array<{ url: string; companyName: string }>
) {
  const resultMap = new Map<
    string,
    Array<{ query: string; companyName: string; reason: string }>
  >();

  for (const report of queryReports) {
    const cacheEntry = cache.entries.find((entry) => entry.query === report.query);
    for (const resultUrl of cacheEntry?.resultUrls ?? []) {
      const existing = resultMap.get(resultUrl) ?? [];
      existing.push({
        query: report.query,
        companyName: report.companyName,
        reason: report.reason,
      });
      resultMap.set(resultUrl, existing);
    }
  }

  for (const directSeedUrl of directSeedUrls) {
    const existing = resultMap.get(directSeedUrl.url) ?? [];
    existing.push({
      query: directSeedUrl.url,
      companyName: directSeedUrl.companyName,
      reason: "direct_seed_url",
    });
    resultMap.set(directSeedUrl.url, existing);
  }

  return resultMap;
}

function buildCandidateSourceMap(
  urlSourceMap: Map<
    string,
    Array<{ type: "url"; value: string; inputUrl: string }>
  >,
  pageSourceMap: Map<
    string,
    Array<{ type: "page"; value: string; pageUrl: string }>
  >,
  resultUrlMap: Map<
    string,
    Array<{ query: string; companyName: string; reason: string }>
  >,
  queryMap: Map<string, { company?: EnterpriseCompanyRecord; reason: string }>
) {
  const metadataBySourceKey = new Map<
    string,
    {
      companyNames: string[];
      queries: string[];
      reasons: string[];
      resultUrls: string[];
    }
  >();

  const allSourceMaps = new Map<
    string,
    Array<{ value: string; sourcePageUrl: string }>
  >();

  for (const [sourceKey, entries] of urlSourceMap.entries()) {
    allSourceMaps.set(
      sourceKey,
      (allSourceMaps.get(sourceKey) ?? []).concat(
        entries.map((entry) => ({
          value: entry.value,
          sourcePageUrl: entry.inputUrl,
        }))
      )
    );
  }

  for (const [sourceKey, entries] of pageSourceMap.entries()) {
    allSourceMaps.set(
      sourceKey,
      (allSourceMaps.get(sourceKey) ?? []).concat(
        entries.map((entry) => ({
          value: entry.value,
          sourcePageUrl: entry.pageUrl,
        }))
      )
    );
  }

  for (const [sourceKey, entries] of allSourceMaps.entries()) {
    const companyNames = new Set<string>();
    const queries = new Set<string>();
    const reasons = new Set<string>();
    const resultUrls = new Set<string>();

    for (const entry of entries) {
      const metadata = resultUrlMap.get(entry.sourcePageUrl) ?? [];
      resultUrls.add(entry.sourcePageUrl);
      for (const item of metadata) {
        queries.add(item.query);
        reasons.add(item.reason);
        const queryEntry = queryMap.get(item.query);
        if (queryEntry?.company) companyNames.add(queryEntry.company.name);
        else companyNames.add(item.companyName);
      }
    }

    metadataBySourceKey.set(sourceKey, {
      companyNames: [...companyNames].sort(),
      queries: [...queries].sort(),
      reasons: [...reasons].sort(),
      resultUrls: [...resultUrls].sort(),
    });
  }

  return metadataBySourceKey;
}

async function loadSearchCache(cachePath: string): Promise<EnterpriseSearchCache> {
  try {
    return JSON.parse(await readFile(cachePath, "utf8")) as EnterpriseSearchCache;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { updatedAt: new Date(0).toISOString(), entries: [] };
    }
    throw error;
  }
}

async function saveSearchCache(cachePath: string, cache: EnterpriseSearchCache) {
  cache.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function loadKnownSourceStatuses(storePath: string) {
  try {
    const store = JSON.parse(await readFile(storePath, "utf8")) as {
      entries?: Array<{ sourceKey: string; status: KnownSourceStatus }>;
    };
    return new Map(
      (store.entries ?? []).map((entry) => [entry.sourceKey, entry.status])
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map<string, KnownSourceStatus>();
    }
    throw error;
  }
}

function upsertCacheEntry(
  cache: EnterpriseSearchCache,
  entry: EnterpriseSearchCacheEntry
) {
  const existingIndex = cache.entries.findIndex(
    (candidate) => candidate.query === entry.query
  );
  if (existingIndex === -1) {
    cache.entries.push(entry);
    return;
  }
  cache.entries[existingIndex] = entry;
}

function dedupeQueries(queries: EnterpriseSearchQuery[]) {
  const seen = new Set<string>();
  return queries.filter((query) => {
    const key = `${query.family}:${query.query.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectDiscoveryCompanies(options: {
  companies?: string[];
  families?: EnterpriseSearchFamily[];
  limitCompanies?: number;
  canadaWeighted: boolean;
}) {
  const families = options.families ?? ["workday", "successfactors"];
  if (
    families.length !== 2 ||
    !families.includes("workday") ||
    !families.includes("successfactors") ||
    !options.limitCompanies
  ) {
    return selectEnterpriseCompanies({
      companies: options.companies,
      families,
      limit: options.limitCompanies,
      canadaWeighted: options.canadaWeighted,
    });
  }

  const successFactorsQuota = Math.min(
    15,
    Math.max(10, Math.floor(options.limitCompanies * 0.25))
  );
  const workdayQuota = Math.max(options.limitCompanies - successFactorsQuota, 0);
  const workdayCompanies = selectEnterpriseCompanies({
    companies: options.companies,
    families: ["workday"],
    limit: workdayQuota,
    canadaWeighted: options.canadaWeighted,
  });
  const successFactorsCompanies = selectEnterpriseCompanies({
    companies: options.companies,
    families: ["successfactors"],
    limit: successFactorsQuota,
    canadaWeighted: options.canadaWeighted,
  });

  const merged = new Map<string, EnterpriseCompanyRecord>();
  for (const company of [...workdayCompanies, ...successFactorsCompanies]) {
    merged.set(company.name, company);
  }
  return [...merged.values()];
}

function buildSupplementalQueries(families: EnterpriseSearchFamily[]) {
  const queries: EnterpriseSearchQuery[] = [];

  if (families.includes("workday")) {
    for (const city of ["Toronto", "Vancouver", "Montreal", "Ottawa", "Calgary", "Waterloo"]) {
      queries.push({
        companyName: `Canada:${city}`,
        family: "workday",
        query: `site:myworkdayjobs.com "${city}" Canada careers`,
        reason: "generic_canada_city",
        priority: 5,
      });
    }
    for (const sector of ["fintech", "enterprise software", "cloud", "telecom", "healthcare"]) {
      queries.push({
        companyName: `Canada:${sector}`,
        family: "workday",
        query: `site:myworkdayjobs.com Canada "${sector}" careers`,
        reason: "generic_canada_sector",
        priority: 4,
      });
    }
  }

  if (families.includes("successfactors")) {
    for (const city of ["Toronto", "Vancouver", "Montreal", "Ottawa", "Calgary"]) {
      queries.push({
        companyName: `Canada:${city}`,
        family: "successfactors",
        query: `"createNewAlert=false" "${city}" careers`,
        reason: "generic_sf_city",
        priority: 5,
      });
      queries.push({
        companyName: `Canada:${city}`,
        family: "successfactors",
        query: `"talentcommunity/apply" "${city}"`,
        reason: "generic_sf_apply_city",
        priority: 4,
      });
    }
    for (const sector of ["fintech", "telecom", "enterprise software", "healthcare"]) {
      queries.push({
        companyName: `Canada:${sector}`,
        family: "successfactors",
        query: `"createNewAlert=false" Canada "${sector}"`,
        reason: "generic_sf_sector",
        priority: 4,
      });
    }
  }

  return queries;
}

function supportsFamily(
  company: EnterpriseCompanyRecord,
  family: EnterpriseSearchFamily
) {
  if (family === "workday") {
    return company.ats === "workday" || company.ats === "both" || company.ats === "unknown";
  }
  return company.ats === "successfactors" || company.ats === "both";
}

function isEnterpriseFamily(
  connectorName: string,
  families?: EnterpriseSearchFamily[]
) {
  const familySet = new Set(families ?? ["workday", "successfactors"]);
  return familySet.has(connectorName as EnterpriseSearchFamily);
}
