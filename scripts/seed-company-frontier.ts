import "dotenv/config";

import { prisma } from "../src/lib/db";
import {
  type CompanyFrontierSeed,
  processCompanyFrontierSeeds,
} from "../src/lib/ingestion/frontier-expansion";
import { buildCompanyDiscoveryCorpus } from "../src/lib/ingestion/discovery/company-corpus";

type ProviderName =
  | "internal-corpus"
  | "sec-edgar"
  | "github-org"
  | "companies-house"
  | "opencorporates";

type CliArgs = {
  providers: ProviderName[];
  limit: number;
  queryLimit: number;
  pageScanLimit: number;
  githubSinceId: number;
  dryRun: boolean;
};

type SecTickersExchangePayload = {
  fields?: string[];
  data?: Array<Array<string | number | null>>;
};

type GitHubOrgSummary = {
  login?: string;
  id?: number;
};

type GitHubOrgDetail = {
  login?: string;
  id?: number;
  name?: string | null;
  company?: string | null;
  blog?: string | null;
  location?: string | null;
  email?: string | null;
  description?: string | null;
  public_repos?: number;
  followers?: number;
  is_verified?: boolean;
  html_url?: string | null;
};

type CompaniesHouseSearchResponse = {
  items?: Array<{
    company_name?: string;
    company_number?: string;
    company_status?: string;
    company_type?: string;
    description?: string;
    address?: {
      country?: string;
      region?: string;
      locality?: string;
      postal_code?: string;
    };
    links?: {
      self?: string;
      company_profile?: string;
    };
  }>;
};

type OpenCorporatesSearchResponse = {
  results?: {
    companies?: Array<{
      company?: {
        company_number?: string;
        name?: string;
        jurisdiction_code?: string;
        current_status?: string;
        company_type?: string | null;
        incorporation_date?: string | null;
        registered_address_in_full?: string | null;
        registry_url?: string | null;
        branch_status?: string | null;
        opencorporates_url?: string | null;
      };
    }>;
  };
};

function parseArgs(argv: string[]): CliArgs {
  const providersRaw = readArg(argv, "--providers");
  const providers = providersRaw
    ? providersRaw.split(",").map((value) => value.trim()).filter(Boolean) as ProviderName[]
    : resolveDefaultProviders();

  return {
    providers,
    limit: readIntArg(argv, "--limit", 1_000),
    queryLimit: readIntArg(argv, "--query-limit", 250),
    pageScanLimit: readIntArg(argv, "--page-scan-limit", 300),
    githubSinceId: readIntArg(argv, "--github-since-id", 0),
    dryRun: argv.includes("--dry-run"),
  };
}

function readArg(argv: string[], name: string) {
  const exact = argv.find((arg) => arg.startsWith(`${name}=`));
  return exact ? exact.slice(name.length + 1) : null;
}

function readIntArg(argv: string[], name: string, fallback: number) {
  const raw = readArg(argv, name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveDefaultProviders(): ProviderName[] {
  const providers: ProviderName[] = [
    "internal-corpus",
    "sec-edgar",
    "github-org",
  ];

  if ((process.env.COMPANIES_HOUSE_API_KEY ?? "").trim()) {
    providers.push("companies-house");
  }
  if ((process.env.OPENCORPORATES_API_TOKEN ?? "").trim()) {
    providers.push("opencorporates");
  }

  return providers;
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function normalizeUrl(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeDomainFromUrlOrEmail(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.includes("@") && !trimmed.includes("://")) {
    const domain = trimmed.split("@")[1]?.trim().toLowerCase() ?? "";
    return domain || null;
  }

  try {
    return new URL(trimmed).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function buildGitHubHeaders() {
  const token = process.env.GITHUB_FRONTIER_TOKEN?.trim();
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "autoapplication/1.0 frontier-seed",
    "X-GitHub-Api-Version": process.env.GITHUB_FRONTIER_API_VERSION?.trim() || "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function buildSecHeaders() {
  return {
    Accept: "application/json",
    "User-Agent":
      process.env.SEC_FRONTIER_USER_AGENT?.trim() ||
      "autoapplication/1.0 frontier-seed",
  };
}

function buildCompaniesHouseHeaders() {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("COMPANIES_HOUSE_API_KEY is required for Companies House seeding.");
  }

  return {
    Accept: "application/json",
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    "User-Agent": "autoapplication/1.0 frontier-seed",
  };
}

async function loadFrontierQueries(limit: number) {
  const corpus = await buildCompanyDiscoveryCorpus({ limit });
  if (corpus.length > 0) {
    return corpus.map((entry) => entry.displayName);
  }

  const companies = await prisma.company.findMany({
    where: {
      OR: [{ sources: { none: {} } }, { domain: null }],
    },
    orderBy: [{ discoveryConfidence: "desc" }, { updatedAt: "desc" }],
    take: limit,
    select: {
      name: true,
    },
  });

  return companies.map((company) => company.name);
}

async function loadInternalCorpusSeeds(limit: number) {
  const corpus = await buildCompanyDiscoveryCorpus({ limit });
  return corpus.map((entry) => {
    const record = entry.record;
    const directAtsUrls = (record.seedPageUrls ?? []).filter((url) => {
      const normalized = normalizeUrl(url);
      return Boolean(normalized) && /(?:ashbyhq|greenhouse|lever|smartrecruiters|workable|myworkdayjobs|myworkdaysite|icims|teamtailor|jobvite|recruitee|rippling|taleo|successfactors)/i.test(normalized!);
    });

    return {
      family: "internal-corpus",
      providerId: entry.companyKey,
      companyName: entry.displayName,
      aliases: entry.aliases,
      searchTerms: record.searchTerms ?? [],
      domain: record.domains?.[0] ?? null,
      seedPageUrls: record.seedPageUrls ?? [],
      directAtsUrls,
      sectors: record.sectors ?? [],
      detectedAts:
        record.ats && record.ats !== "unknown" ? record.ats : null,
      discoveryConfidence: Math.min(0.98, 0.62 + entry.score / 200),
      metadataJson: {
        seedSource: "internal-corpus",
        canadaRelevantCount: entry.canadaRelevantCount,
        canadaRemoteCount: entry.canadaRemoteCount,
        liveCount: entry.totalLiveCount,
        matchedCatalogName: entry.matchedCatalogName,
        tenants: record.tenants ?? [],
      },
    } satisfies CompanyFrontierSeed;
  });
}

async function loadSecEdgarSeeds(limit: number) {
  const response = await fetch(
    "https://www.sec.gov/files/company_tickers_exchange.json",
    { headers: buildSecHeaders() }
  );

  if (!response.ok) {
    throw new Error(
      `SEC company tickers fetch failed: ${response.status} ${response.statusText}`
    );
  }

  const payload = (await response.json()) as SecTickersExchangePayload;
  const fields = payload.fields ?? [];
  const fieldIndex = new Map(fields.map((field, index) => [field, index] as const));
  const allowedExchangesRaw = (process.env.SEC_EDGAR_EXCHANGES ?? "").trim();
  const allowedExchanges = new Set(
    allowedExchangesRaw
      ? allowedExchangesRaw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
      : []
  );

  return (payload.data ?? [])
    .filter((row) => {
      if (allowedExchanges.size === 0) return true;
      const exchange = String(row[fieldIndex.get("exchange") ?? -1] ?? "")
        .trim()
        .toLowerCase();
      return exchange.length > 0 && allowedExchanges.has(exchange);
    })
    .slice(0, limit)
    .map((row) => {
      const cik = String(row[fieldIndex.get("cik") ?? -1] ?? "").trim();
      const name = String(row[fieldIndex.get("name") ?? -1] ?? "").trim();
      const ticker = String(row[fieldIndex.get("ticker") ?? -1] ?? "").trim();
      const exchange = String(row[fieldIndex.get("exchange") ?? -1] ?? "").trim();

      return {
        family: "sec-edgar",
        providerId: cik,
        companyName: name,
        searchTerms: [name, ticker].filter(Boolean),
        tickers: ticker ? [ticker] : [],
        jurisdictionCodes: ["us"],
        discoveryConfidence: 0.76,
        metadataJson: {
          seedSource: "sec-edgar",
          cik,
          ticker,
          exchange,
        },
      } satisfies CompanyFrontierSeed;
    });
}

async function loadGitHubOrgSeeds(limit: number, sinceId: number) {
  const headers = buildGitHubHeaders();
  const perPage = Math.min(100, Math.max(20, limit));
  const listResponse = await fetch(
    `https://api.github.com/organizations?per_page=${perPage}${sinceId > 0 ? `&since=${sinceId}` : ""}`,
    { headers }
  );

  if (!listResponse.ok) {
    throw new Error(
      `GitHub organizations fetch failed: ${listResponse.status} ${listResponse.statusText}`
    );
  }

  const summaries = (await listResponse.json()) as GitHubOrgSummary[];
  const detailSeeds: CompanyFrontierSeed[] = [];

  for (const summaryChunk of chunk(summaries.slice(0, limit), 10)) {
    const details = await Promise.all(
      summaryChunk.map(async (summary) => {
        if (!summary.login) return null;
        const detailResponse = await fetch(
          `https://api.github.com/orgs/${encodeURIComponent(summary.login)}`,
          { headers }
        );
        if (!detailResponse.ok) return null;
        return (await detailResponse.json()) as GitHubOrgDetail;
      })
    );

    for (const detail of details) {
      if (!detail) continue;
      const companyName = detail.name?.trim() || detail.login?.trim() || "";
      if (!companyName) continue;
      if ((detail.public_repos ?? 0) < 2 && !(detail.is_verified ?? false)) {
        continue;
      }

      const domain =
        normalizeDomainFromUrlOrEmail(detail.blog) ??
        normalizeDomainFromUrlOrEmail(detail.email) ??
        null;
      const websiteUrl = normalizeUrl(detail.blog) ?? null;

      detailSeeds.push({
        family: "github-org",
        providerId: detail.id != null ? String(detail.id) : detail.login ?? null,
        companyName,
        aliases: [detail.login ?? "", detail.company ?? ""].filter(Boolean),
        searchTerms: [
          detail.login ?? "",
          detail.name ?? "",
          detail.company ?? "",
        ].filter(Boolean),
        domain,
        websiteUrl,
        seedPageUrls: websiteUrl ? [`${websiteUrl.replace(/\/+$/, "")}/careers`] : [],
        discoveryConfidence: detail.is_verified ? 0.82 : 0.66,
        metadataJson: {
          seedSource: "github-org",
          githubLogin: detail.login ?? null,
          githubUrl: detail.html_url ?? null,
          githubLocation: detail.location ?? null,
          githubDescription: detail.description ?? null,
          githubFollowers: detail.followers ?? null,
          githubPublicRepos: detail.public_repos ?? null,
          githubVerified: detail.is_verified ?? false,
        },
      });
    }
  }

  return detailSeeds.slice(0, limit);
}

async function loadCompaniesHouseSeeds(limit: number, queries: string[]) {
  const headers = buildCompaniesHouseHeaders();
  const seeds: CompanyFrontierSeed[] = [];

  for (const query of queries) {
    if (seeds.length >= limit) break;

    const url =
      `https://api.company-information.service.gov.uk/search/companies` +
      `?q=${encodeURIComponent(query)}&items_per_page=5`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      if (response.status === 429) break;
      continue;
    }

    const payload = (await response.json()) as CompaniesHouseSearchResponse;
    for (const item of payload.items ?? []) {
      const name = item.company_name?.trim();
      const companyNumber = item.company_number?.trim();
      if (!name || !companyNumber) continue;
      seeds.push({
        family: "companies-house",
        providerId: companyNumber,
        companyName: name,
        searchTerms: [name, query],
        jurisdictionCodes: ["gb"],
        discoveryConfidence:
          item.company_status?.toLowerCase() === "active" ? 0.62 : 0.52,
        metadataJson: {
          seedSource: "companies-house",
          companyNumber,
          companyStatus: item.company_status ?? null,
          companyType: item.company_type ?? null,
          description: item.description ?? null,
          addressCountry: item.address?.country ?? null,
          addressRegion: item.address?.region ?? null,
          addressLocality: item.address?.locality ?? null,
          companyProfilePath: item.links?.company_profile ?? null,
        },
      });

      if (seeds.length >= limit) break;
    }
  }

  return seeds;
}

async function loadOpenCorporatesSeeds(limit: number, queries: string[]) {
  const apiToken = process.env.OPENCORPORATES_API_TOKEN?.trim();
  if (!apiToken) {
    throw new Error("OPENCORPORATES_API_TOKEN is required for OpenCorporates seeding.");
  }

  const seeds: CompanyFrontierSeed[] = [];

  for (const query of queries) {
    if (seeds.length >= limit) break;

    const response = await fetch(
      `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(query)}&order=score&per_page=5&api_token=${encodeURIComponent(apiToken)}`
    );
    if (!response.ok) {
      if (response.status === 429) break;
      continue;
    }

    const payload = (await response.json()) as OpenCorporatesSearchResponse;
    for (const wrapper of payload.results?.companies ?? []) {
      const company = wrapper.company;
      if (!company) continue;
      const name = company?.name?.trim();
      const companyNumber = company?.company_number?.trim();
      if (!name || !companyNumber) continue;

      seeds.push({
        family: "opencorporates",
        providerId: `${company.jurisdiction_code ?? "unknown"}:${companyNumber}`,
        companyName: name,
        searchTerms: [name, query],
        jurisdictionCodes: company.jurisdiction_code ? [company.jurisdiction_code] : [],
        websiteUrl: normalizeUrl(company.registry_url ?? null),
        discoveryConfidence:
          company.current_status?.toLowerCase() === "active" ? 0.66 : 0.54,
        metadataJson: {
          seedSource: "opencorporates",
          companyNumber,
          jurisdictionCode: company.jurisdiction_code ?? null,
          currentStatus: company.current_status ?? null,
          companyType: company.company_type ?? null,
          incorporationDate: company.incorporation_date ?? null,
          registeredAddress: company.registered_address_in_full ?? null,
          registryUrl: company.registry_url ?? null,
          opencorporatesUrl: company.opencorporates_url ?? null,
          branchStatus: company.branch_status ?? null,
        },
      });

      if (seeds.length >= limit) break;
    }
  }

  return seeds;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const queries = await loadFrontierQueries(args.queryLimit);
  const providerCounts: Record<string, number> = {};
  const seeds: CompanyFrontierSeed[] = [];
  const skippedProviders: Array<{ provider: ProviderName; reason: string }> = [];

  for (const provider of args.providers) {
    try {
      let nextSeeds: CompanyFrontierSeed[] = [];
      if (provider === "internal-corpus") {
        nextSeeds = await loadInternalCorpusSeeds(args.limit);
      } else if (provider === "sec-edgar") {
        nextSeeds = await loadSecEdgarSeeds(args.limit);
      } else if (provider === "github-org") {
        nextSeeds = await loadGitHubOrgSeeds(args.limit, args.githubSinceId);
      } else if (provider === "companies-house") {
        nextSeeds = await loadCompaniesHouseSeeds(args.limit, queries);
      } else if (provider === "opencorporates") {
        nextSeeds = await loadOpenCorporatesSeeds(args.limit, queries);
      }

      providerCounts[provider] = nextSeeds.length;
      seeds.push(...nextSeeds);
    } catch (error) {
      skippedProviders.push({
        provider,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const result = await processCompanyFrontierSeeds(seeds, {
    pageDiscoveryLimit: args.pageScanLimit,
    dryRun: args.dryRun,
  });

  console.log(
    JSON.stringify(
      {
        providers: args.providers,
        providerCounts,
        skippedProviders,
        queryCount: queries.length,
        seedCount: seeds.length,
        ...result,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(
      "[company:seed-frontier] failed:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
