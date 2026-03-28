/**
 * discover-enterprise-batch.ts
 *
 * Comprehensive enterprise source discovery with three strategies:
 * 1. Career page scanning — generate likely URLs, fetch, extract ATS links
 * 2. Direct Workday API probing — try common tenant/wdN/site combos
 * 3. SuccessFactors board validation — validate SF hosts from catalog
 *
 * Usage:
 *   npx tsx scripts/discover-enterprise-batch.ts
 *   npx tsx scripts/discover-enterprise-batch.ts --canada-only
 *   npx tsx scripts/discover-enterprise-batch.ts --family=workday
 *   npx tsx scripts/discover-enterprise-batch.ts --family=successfactors
 *   npx tsx scripts/discover-enterprise-batch.ts --companies=telus,rogers
 *   npx tsx scripts/discover-enterprise-batch.ts --skip-probe  # skip direct API probing
 *   npx tsx scripts/discover-enterprise-batch.ts --skip-pages   # skip career page scanning
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  ENTERPRISE_DISCOVERY_COMPANIES,
  type EnterpriseCompanyRecord,
} from "../src/lib/ingestion/discovery/enterprise-catalog";
import {
  buildWorkdayApiUrl,
  buildWorkdaySourceToken,
  buildSuccessFactorsBoardUrl,
  buildSuccessFactorsSourceToken,
  validateSuccessFactorsBoard,
} from "../src/lib/ingestion/connectors";
import {
  discoverSourceCandidatesFromPageUrls,
  type DiscoveredSourceCandidate,
} from "../src/lib/ingestion/discovery/sources";

// ─── Types ──────────────────────────────────────────────────────────────────────

type ProbeResult = {
  companyName: string;
  tenant: string;
  wdVariant: string;
  site: string;
  token: string;
  apiUrl: string;
  total: number;
  firstTitle: string | null;
};

type CareerPageResult = {
  companyName: string;
  pageUrl: string;
  status: number | null;
  discovered: DiscoveredSourceCandidate[];
  error?: string;
};

type SfValidationResult = {
  companyName: string;
  host: string;
  pathPrefix: string | null;
  token: string;
  boardUrl: string;
  valid: boolean;
  reason?: string;
  pageTitle?: string | null;
};

type BatchDiscoveryResult = {
  workdayProbes: ProbeResult[];
  careerPageResults: CareerPageResult[];
  sfValidations: SfValidationResult[];
  allDiscovered: Map<string, {
    token: string;
    connectorName: string;
    sourceKey: string;
    boardUrl: string;
    companyName: string;
    discoveryMethod: string;
    total?: number;
  }>;
};

// ─── Constants ──────────────────────────────────────────────────────────────────

const STORE_PATH = path.resolve("data/discovery/source-candidates.json");
const OUTPUT_DIR = path.resolve("data/discovery/seeds");

// Common Workday wdN variants, ordered by frequency for Canadian companies
const WD_VARIANTS = ["wd3", "wd5", "wd1", "wd10", "wd12"] as const;

// Common Workday site names, ordered by frequency
const BASE_SITE_NAMES = ["external", "careers", "jobs"] as const;

const PROBE_TIMEOUT_MS = 8000;
const CONCURRENCY = 10;

type DiscoveryStoreEntry = {
  connectorName: string;
  token: string;
  sourceKey: string;
  sourceName?: string;
  boardUrl?: string;
  status?: string;
  firstDiscoveredAt?: string;
  lastDiscoveredAt?: string;
  discoveredFrom?: Array<{
    type: string;
    value: string;
    discoveredAt: string;
  }>;
  decisionReason?: string;
};

type DiscoveryStore = {
  updatedAt?: string;
  entries?: DiscoveryStoreEntry[];
};

// ─── CLI ────────────────────────────────────────────────────────────────────────

type CliFlags = {
  canadaOnly: boolean;
  family: "workday" | "successfactors" | "all";
  companies: string[];
  skipProbe: boolean;
  skipPages: boolean;
};

function parseCliFlags(): CliFlags {
  const args = process.argv.slice(2);
  const flags: CliFlags = {
    canadaOnly: false,
    family: "all",
    companies: [],
    skipProbe: false,
    skipPages: false,
  };
  for (const arg of args) {
    if (arg === "--canada-only") flags.canadaOnly = true;
    if (arg === "--skip-probe") flags.skipProbe = true;
    if (arg === "--skip-pages") flags.skipPages = true;
    if (arg.startsWith("--family=")) flags.family = arg.split("=")[1] as CliFlags["family"];
    if (arg.startsWith("--companies=")) flags.companies = arg.split("=")[1]!.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  }
  return flags;
}

// ─── Load existing promoted sources ─────────────────────────────────────────────

function loadPromotedTokens(): { workday: Set<string>; successfactors: Set<string> } {
  const store = JSON.parse(readFileSync(STORE_PATH, "utf8")) as DiscoveryStore;
  const promoted = (store.entries ?? []).filter((entry) => entry.status === "promoted");

  const workdayTenants = new Set<string>();
  const sfTokens = new Set<string>();

  for (const entry of promoted) {
    if (entry.connectorName === "workday") {
      const parts = entry.token.split("|");
      if (parts[1]) workdayTenants.add(parts[1].toLowerCase());
      // Also track full token
      workdayTenants.add(entry.token.toLowerCase());
    }
    if (entry.connectorName === "successfactors") {
      sfTokens.add(entry.token.toLowerCase());
    }
  }

  return { workday: workdayTenants, successfactors: sfTokens };
}

// ─── Company selection ──────────────────────────────────────────────────────────

function selectCompanies(flags: CliFlags, promoted: ReturnType<typeof loadPromotedTokens>) {
  let companies = ENTERPRISE_DISCOVERY_COMPANIES;

  if (flags.companies.length > 0) {
    const filter = new Set(flags.companies);
    companies = companies.filter(c =>
      filter.has(c.name.toLowerCase()) ||
      c.tenants.some(t => filter.has(t.toLowerCase()))
    );
  }

  if (flags.canadaOnly) {
    companies = companies.filter(c => c.canadaHq || (c.canadaCities?.length ?? 0) > 0);
  }

  // Filter by family
  if (flags.family === "workday") {
    companies = companies.filter(c => c.ats === "workday" || c.ats === "both" || c.ats === "unknown");
  } else if (flags.family === "successfactors") {
    companies = companies.filter(c => c.ats === "successfactors" || c.ats === "both");
  }

  // Filter out companies that already have promoted sources
  const missingWd = companies.filter(c => {
    if (c.ats !== "workday" && c.ats !== "both") return false;
    return !c.tenants.some(t => promoted.workday.has(t.toLowerCase()));
  });

  const missingSf = companies.filter(c => {
    if (c.ats !== "successfactors" && c.ats !== "both") return false;
    return !(c.sfHosts ?? []).some(h => promoted.successfactors.has(h.toLowerCase()));
  });

  const unknowns = companies.filter(c => c.ats === "unknown");

  return { missingWd, missingSf, unknowns, all: companies };
}

// ─── Phase 1: Career page scanning ─────────────────────────────────────────────

function generateCareerPageUrls(company: EnterpriseCompanyRecord): string[] {
  const urls: string[] = [];

  // Use existing seedPageUrls first
  for (const url of company.seedPageUrls ?? []) {
    if (url.trim()) urls.push(url.trim());
  }

  // Generate likely URLs from tenants
  for (const tenant of company.tenants) {
    const slug = tenant.toLowerCase().replace(/[^a-z0-9-]/g, "");
    urls.push(`https://careers.${slug}.com/`);
    urls.push(`https://www.${slug}.com/careers`);
    urls.push(`https://jobs.${slug}.com/`);
    urls.push(`https://${slug}.com/careers`);
  }

  // Deduplicate
  return [...new Set(urls)];
}

async function scanCareerPages(
  companies: EnterpriseCompanyRecord[],
): Promise<CareerPageResult[]> {
  const allUrls = new Map<string, string>(); // url -> companyName
  for (const company of companies) {
    const urls = generateCareerPageUrls(company);
    for (const url of urls) {
      if (!allUrls.has(url)) allUrls.set(url, company.name);
    }
  }

  console.log(`[career-pages] Scanning ${allUrls.size} career page URLs for ${companies.length} companies...`);

  const urlList = [...allUrls.keys()];
  const pageDiscovery = await discoverSourceCandidatesFromPageUrls(urlList, {
    concurrency: CONCURRENCY,
  });

  // Map results back to companies
  const results: CareerPageResult[] = [];
  for (const [url, companyName] of allUrls) {
    const discovered = pageDiscovery.candidates.filter(c => {
      const sources = pageDiscovery.sourceMap.get(c.sourceKey) ?? [];
      return sources.some((source) => source.pageUrl === url);
    });

    results.push({
      companyName,
      pageUrl: url,
      status: null,
      discovered,
    });
  }

  const totalDiscovered = new Set(pageDiscovery.candidates.map(c => c.sourceKey));
  console.log(`[career-pages] Found ${totalDiscovered.size} unique ATS sources from career page scanning`);

  return results;
}

// ─── Phase 2: Direct Workday API probing ────────────────────────────────────────

async function probeWorkdayEndpoint(
  tenant: string,
  wdVariant: string,
  site: string,
): Promise<{ total: number; firstTitle: string | null } | null> {
  const host = `${tenant}.${wdVariant}.myworkdayjobs.com`;
  const token = buildWorkdaySourceToken({ host, tenant, site });
  const apiUrl = buildWorkdayApiUrl(token);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; autoapplication-workday-probe/1.0)",
      },
      body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = (await response.json()) as {
      total?: number;
      jobPostings?: Array<{ title?: string }>;
    };
    const total = typeof data.total === "number" ? data.total : 0;
    const firstTitle = data.jobPostings?.[0]?.title?.trim() || null;

    if (total === 0 && !firstTitle) return null;

    return { total, firstTitle };
  } catch {
    return null;
  }
}

async function probeWorkdayCompanies(
  companies: EnterpriseCompanyRecord[],
  existingTokens: Set<string>,
): Promise<ProbeResult[]> {
  console.log(`[workday-probe] Probing ${companies.length} companies across WD variants and site names...`);

  const results: ProbeResult[] = [];
  const foundTenants = new Set<string>();
  let probeCount = 0;
  let hitCount = 0;

  // Build probe queue: priority-ordered list of (company, tenant, wdVariant, site)
  type ProbeTask = {
    companyName: string;
    tenant: string;
    wdVariant: string;
    site: string;
  };

  const tasks: ProbeTask[] = [];
  for (const company of companies) {
    for (const tenant of company.tenants) {
      const siteNames = [
        ...BASE_SITE_NAMES,
        tenant.toLowerCase(), // Try tenant as site name
        `${tenant.toLowerCase()}_careers`,
      ];
      const uniqueSites = [...new Set(siteNames)];

      for (const wdVariant of WD_VARIANTS) {
        for (const site of uniqueSites) {
          tasks.push({ companyName: company.name, tenant, wdVariant, site });
        }
      }
    }
  }

  console.log(`[workday-probe] ${tasks.length} total probe tasks queued`);

  // Process with concurrency, short-circuiting per tenant
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const idx = cursor;
      cursor += 1;
      const task = tasks[idx]!;

      // Skip if we already found this tenant or it's already promoted
      const tenantKey = task.tenant.toLowerCase();
      if (foundTenants.has(tenantKey)) continue;

      const token = buildWorkdaySourceToken({
        host: `${task.tenant}.${task.wdVariant}.myworkdayjobs.com`,
        tenant: task.tenant,
        site: task.site,
      });

      if (existingTokens.has(token.toLowerCase())) continue;

      probeCount += 1;
      const result = await probeWorkdayEndpoint(task.tenant, task.wdVariant, task.site);
      if (result && result.total > 0) {
        hitCount += 1;
        foundTenants.add(tenantKey);
        const host = `${task.tenant}.${task.wdVariant}.myworkdayjobs.com`;
        results.push({
          companyName: task.companyName,
          tenant: task.tenant,
          wdVariant: task.wdVariant,
          site: task.site,
          token,
          apiUrl: buildWorkdayApiUrl(token),
          total: result.total,
          firstTitle: result.firstTitle,
        });
        console.log(
          `  ✓ ${task.companyName}: ${host}/${task.site} → ${result.total} jobs (${result.firstTitle ?? "no title"})`
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker())
  );

  console.log(`[workday-probe] ${probeCount} probes executed, ${hitCount} hits found`);
  return results;
}

// ─── Phase 3: SuccessFactors board validation ───────────────────────────────────

async function validateSfBoards(
  companies: EnterpriseCompanyRecord[],
  existingTokens: Set<string>,
): Promise<SfValidationResult[]> {
  console.log(`[sf-validate] Validating ${companies.length} SuccessFactors boards...`);

  const results: SfValidationResult[] = [];

  for (const company of companies) {
    for (const host of company.sfHosts ?? []) {
      const pathPrefixes = company.sfPaths?.length ? company.sfPaths : [null];
      for (const pathPrefix of pathPrefixes) {
        const token = pathPrefix
          ? buildSuccessFactorsSourceToken({ host, pathPrefix })
          : buildSuccessFactorsSourceToken(host);

        if (existingTokens.has(token.toLowerCase())) {
          console.log(`  ○ ${company.name} (${host}): already promoted, skipping`);
          continue;
        }

        try {
          const boardUrl = buildSuccessFactorsBoardUrl(token);
          const validation = await validateSuccessFactorsBoard(token);

          results.push({
            companyName: company.name,
            host,
            pathPrefix,
            token,
            boardUrl,
            valid: validation.valid,
            reason: validation.valid ? undefined : validation.reason,
            pageTitle: validation.pageTitle,
          });

          if (validation.valid) {
            console.log(`  ✓ ${company.name} (${host}): VALID — "${validation.pageTitle ?? "no title"}"`);
          } else {
            console.log(
              `  ✗ ${company.name} (${host}): ${validation.reason}`
            );
          }
        } catch (error) {
          results.push({
            companyName: company.name,
            host,
            pathPrefix,
            token,
            boardUrl: buildSuccessFactorsBoardUrl(token),
            valid: false,
            reason: `error: ${error instanceof Error ? error.message : String(error)}`,
          });
          console.log(`  ✗ ${company.name} (${host}): ERROR — ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  const validCount = results.filter(r => r.valid).length;
  console.log(`[sf-validate] ${validCount}/${results.length} boards valid`);
  return results;
}

// ─── Merge & deduplicate results ────────────────────────────────────────────────

function mergeResults(
  probeResults: ProbeResult[],
  careerPageResults: CareerPageResult[],
  sfValidations: SfValidationResult[],
  existingTokens: ReturnType<typeof loadPromotedTokens>,
): BatchDiscoveryResult["allDiscovered"] {
  const discovered = new Map<string, {
    token: string;
    connectorName: string;
    sourceKey: string;
    boardUrl: string;
    companyName: string;
    discoveryMethod: string;
    total?: number;
  }>();

  // Add Workday probe results
  for (const probe of probeResults) {
    const sourceKey = `workday:${probe.token}`;
    if (!discovered.has(sourceKey)) {
      discovered.set(sourceKey, {
        token: probe.token,
        connectorName: "workday",
        sourceKey,
        boardUrl: `https://${probe.tenant}.${probe.wdVariant}.myworkdayjobs.com/${probe.site}`,
        companyName: probe.companyName,
        discoveryMethod: "direct_api_probe",
        total: probe.total,
      });
    }
  }

  // Add career page discoveries (Workday + SF)
  for (const result of careerPageResults) {
    for (const candidate of result.discovered) {
      if (candidate.connectorName !== "workday" && candidate.connectorName !== "successfactors") continue;
      if (!discovered.has(candidate.sourceKey)) {
        discovered.set(candidate.sourceKey, {
          token: candidate.token,
          connectorName: candidate.connectorName,
          sourceKey: candidate.sourceKey,
          boardUrl: candidate.boardUrl,
          companyName: result.companyName,
          discoveryMethod: "career_page_scan",
        });
      }
    }
  }

  // Add valid SF boards
  for (const sf of sfValidations) {
    if (!sf.valid) continue;
    const sourceKey = `successfactors:${sf.token}`;
    if (!discovered.has(sourceKey)) {
      discovered.set(sourceKey, {
        token: sf.token,
        connectorName: "successfactors",
        sourceKey,
        boardUrl: sf.boardUrl,
        companyName: sf.companyName,
        discoveryMethod: "sf_board_validation",
      });
    }
  }

  // Filter out already-promoted
  for (const [key, entry] of discovered) {
    const isPromoted = entry.connectorName === "workday"
      ? existingTokens.workday.has(entry.token.toLowerCase())
      : existingTokens.successfactors.has(entry.token.toLowerCase());
    if (isPromoted) {
      discovered.delete(key);
    }
  }

  return discovered;
}

// ─── Promote to discovery store ─────────────────────────────────────────────────

function promoteToStore(
  discovered: BatchDiscoveryResult["allDiscovered"],
) {
  const store = JSON.parse(readFileSync(STORE_PATH, "utf8")) as DiscoveryStore;
  store.entries ??= [];
  const existingKeys = new Set(store.entries.map((entry) => entry.sourceKey));
  const now = new Date().toISOString();
  let added = 0;

  for (const [sourceKey, entry] of discovered) {
    if (existingKeys.has(sourceKey)) continue;

    store.entries.push({
      connectorName: entry.connectorName,
      token: entry.token,
      sourceKey: entry.sourceKey,
      sourceName: entry.connectorName === "workday"
        ? `Workday:${entry.token}`
        : `SuccessFactors:${entry.token}`,
      boardUrl: entry.boardUrl,
      status: "promoted",
      firstDiscoveredAt: now,
      lastDiscoveredAt: now,
      discoveredFrom: [{
        type: "batch_discovery",
        value: `discover-enterprise-batch:${entry.discoveryMethod}`,
        discoveredAt: now,
      }],
      decisionReason: entry.discoveryMethod,
    });
    added += 1;
  }

  store.updatedAt = now;
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2) + "\n", "utf8");
  console.log(`[promote] Added ${added} new promoted entries to discovery store`);
  return added;
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseCliFlags();
  const promoted = loadPromotedTokens();
  const { missingWd, missingSf, unknowns } = selectCompanies(flags, promoted);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Enterprise Batch Discovery");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`Companies in catalog: ${ENTERPRISE_DISCOVERY_COMPANIES.length}`);
  console.log(`Missing Workday sources: ${missingWd.length}`);
  console.log(`Missing SF sources: ${missingSf.length}`);
  console.log(`Unknown ATS companies: ${unknowns.length}`);
  console.log(`Flags: ${JSON.stringify(flags)}`);
  console.log("───────────────────────────────────────────────────────────────");

  // Phase 1: Career page scanning
  let careerPageResults: CareerPageResult[] = [];
  if (!flags.skipPages) {
    console.log("\n▸ Phase 1: Career Page Scanning");
    // Scan both missing WD companies and unknowns (they might be on WD/SF)
    const companiesWithPages = [...missingWd, ...missingSf, ...unknowns].filter(
      (c, i, arr) => arr.findIndex(x => x.name === c.name) === i // dedupe
    );
    careerPageResults = await scanCareerPages(companiesWithPages);
  } else {
    console.log("\n▸ Phase 1: SKIPPED (--skip-pages)");
  }

  // Phase 2: Direct Workday API probing
  let probeResults: ProbeResult[] = [];
  if (!flags.skipProbe && (flags.family === "all" || flags.family === "workday")) {
    console.log("\n▸ Phase 2: Direct Workday API Probing");
    // Sort by Canada HQ first, then multi-city Canada, then others
    const sortedWd = [...missingWd].sort((a, b) => {
      const aScore = (a.canadaHq ? 10 : 0) + (a.canadaCities?.length ?? 0);
      const bScore = (b.canadaHq ? 10 : 0) + (b.canadaCities?.length ?? 0);
      return bScore - aScore;
    });
    probeResults = await probeWorkdayCompanies(sortedWd, promoted.workday);
  } else {
    console.log("\n▸ Phase 2: SKIPPED");
  }

  // Phase 3: SF board validation
  let sfResults: SfValidationResult[] = [];
  if (flags.family === "all" || flags.family === "successfactors") {
    console.log("\n▸ Phase 3: SuccessFactors Board Validation");
    sfResults = await validateSfBoards(missingSf, promoted.successfactors);
  } else {
    console.log("\n▸ Phase 3: SKIPPED");
  }

  // Merge results
  console.log("\n▸ Merging Discovery Results");
  const allDiscovered = mergeResults(probeResults, careerPageResults, sfResults, promoted);
  console.log(`Total new sources discovered: ${allDiscovered.size}`);

  for (const [, entry] of allDiscovered) {
    console.log(`  ${entry.connectorName}: ${entry.companyName} → ${entry.token} (${entry.discoveryMethod}${entry.total ? `, ~${entry.total} jobs` : ""})`);
  }

  // Write results
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, "enterprise-batch-discovery.json");
  writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    flags,
    probeResults,
    sfValidations: sfResults,
    careerPageDiscoveries: careerPageResults.filter(r => r.discovered.length > 0).map(r => ({
      companyName: r.companyName,
      pageUrl: r.pageUrl,
      discovered: r.discovered.map(d => ({ sourceKey: d.sourceKey, connectorName: d.connectorName, token: d.token })),
    })),
    allDiscovered: [...allDiscovered.values()],
  }, null, 2) + "\n", "utf8");
  console.log(`\nResults written to: ${outputPath}`);

  // Promote
  if (allDiscovered.size > 0) {
    console.log("\n▸ Promoting to Discovery Store");
    const added = promoteToStore(allDiscovered);
    console.log(`Promoted ${added} new sources`);
  } else {
    console.log("\nNo new sources to promote.");
  }

  // Summary
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`Workday probes executed: ${probeResults.length > 0 ? "yes" : "skipped"}`);
  console.log(`  Hits: ${probeResults.length}`);
  console.log(`Career pages scanned: ${careerPageResults.length}`);
  console.log(`  Pages with discoveries: ${careerPageResults.filter(r => r.discovered.length > 0).length}`);
  console.log(`SF boards validated: ${sfResults.length}`);
  console.log(`  Valid: ${sfResults.filter(r => r.valid).length}`);
  console.log(`  Invalid: ${sfResults.filter(r => !r.valid).length}`);
  console.log(`Total new sources promoted: ${allDiscovered.size}`);

  const wdNew = [...allDiscovered.values()].filter(d => d.connectorName === "workday");
  const sfNew = [...allDiscovered.values()].filter(d => d.connectorName === "successfactors");
  console.log(`  New Workday: ${wdNew.length}`);
  console.log(`  New SuccessFactors: ${sfNew.length}`);
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((error) => {
  console.error("Enterprise batch discovery failed:", error);
  process.exit(1);
});
