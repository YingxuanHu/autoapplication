import {
  buildWorkdayApiUrl,
  buildWorkdaySourceToken,
} from "@/lib/ingestion/connectors";

export type WorkdayDiscoverySeed = {
  name: string;
  tenants: string[];
  wdVariants?: string[];
  siteHints?: string[];
  sectors: string[];
  canadaCities?: string[];
  remoteCanadaLikely?: boolean;
  canadaHeadquartered?: boolean;
  priority: "high" | "medium";
  notes?: string;
};

export type WorkdaySeedCandidate = {
  companyName: string;
  tenant: string;
  wdVariant: string;
  site: string;
  sourceToken: string;
  url: string;
  score: number;
  scoreReasons: string[];
  sectors: string[];
  notes?: string;
};

export type WorkdayPreflightCandidate = WorkdaySeedCandidate & {
  valid: boolean;
  fetchedCount: number;
  totalCount: number | null;
  previewLimitHint: number;
  firstTitle: string | null;
  error?: string;
};

const DEFAULT_WD_VARIANTS = ["wd1", "wd5", "wd3"] as const;
const DEFAULT_SITE_HINTS = ["external", "jobs", "careers"] as const;
const WD_VARIANT_SCORES: Record<string, number> = {
  wd1: 1.2,
  wd5: 1.0,
  wd3: 0.8,
};
const SITE_SCORES: Record<string, number> = {
  external: 1.6,
  jobs: 1.4,
  careers: 0.8,
};

export const WORKDAY_DISCOVERY_SEEDS: WorkdayDiscoverySeed[] = [
  {
    name: "Equinix",
    tenants: ["equinix"],
    wdVariants: ["wd1"],
    siteHints: ["external", "equinix"],
    sectors: ["cloud", "infra"],
    canadaCities: ["Toronto"],
    remoteCanadaLikely: true,
    priority: "high",
    notes: "Validated board with strong Canada and infra signal.",
  },
  {
    name: "Workday",
    tenants: ["workday"],
    wdVariants: ["wd5"],
    siteHints: ["workday", "external"],
    sectors: ["enterprise software", "data", "product"],
    canadaCities: ["Toronto", "Vancouver"],
    remoteCanadaLikely: true,
    priority: "high",
    notes: "Validated board with Canada-wide roles appearing beyond page 1.",
  },
  {
    name: "PayPal",
    tenants: ["paypal"],
    wdVariants: ["wd1"],
    siteHints: ["jobs", "external"],
    sectors: ["fintech", "payments"],
    canadaCities: ["Toronto"],
    remoteCanadaLikely: false,
    priority: "high",
    notes: "Validated high-volume board; mostly US, but useful scale baseline.",
  },
  {
    name: "Guidewire",
    tenants: ["guidewire"],
    wdVariants: ["wd5"],
    siteHints: ["external", "guidewire"],
    sectors: ["insurance software", "enterprise software"],
    canadaCities: ["Toronto"],
    remoteCanadaLikely: true,
    priority: "high",
  },
  {
    name: "Pacific Life",
    tenants: ["pacificlife"],
    wdVariants: ["wd1"],
    siteHints: ["pacificlifecareers", "external"],
    sectors: ["insurance", "finance"],
    canadaCities: [],
    remoteCanadaLikely: false,
    priority: "medium",
  },
  {
    name: "TransUnion",
    tenants: ["transunion"],
    wdVariants: ["wd5"],
    siteHints: ["transunion", "external"],
    sectors: ["fintech", "credit", "data"],
    canadaCities: ["Toronto"],
    remoteCanadaLikely: false,
    priority: "medium",
  },
  {
    name: "AIG",
    tenants: ["aig"],
    wdVariants: ["wd1"],
    siteHints: ["aig", "external"],
    sectors: ["insurance", "finance"],
    canadaCities: ["Toronto", "Montreal"],
    remoteCanadaLikely: false,
    priority: "medium",
  },
  {
    name: "Intact Financial",
    tenants: ["intact"],
    wdVariants: ["wd3", "wd5", "wd1"],
    siteHints: ["intact", "external", "careers"],
    sectors: ["insurance", "finance"],
    canadaCities: ["Toronto", "Montreal", "Calgary"],
    canadaHeadquartered: true,
    priority: "high",
  },
  {
    name: "Manulife",
    tenants: ["manulife"],
    wdVariants: ["wd3", "wd5", "wd1"],
    siteHints: ["manulife", "external", "careers"],
    sectors: ["insurance", "finance"],
    canadaCities: ["Toronto", "Montreal", "Waterloo"],
    canadaHeadquartered: true,
    priority: "high",
  },
  {
    name: "Sun Life",
    tenants: ["sunlife"],
    wdVariants: ["wd3", "wd5", "wd1"],
    siteHints: ["sunlife", "external", "careers"],
    sectors: ["insurance", "finance"],
    canadaCities: ["Toronto", "Waterloo", "Montreal"],
    canadaHeadquartered: true,
    priority: "high",
  },
  {
    name: "Thomson Reuters",
    tenants: ["thomsonreuters"],
    wdVariants: ["wd5", "wd1"],
    siteHints: ["thomsonreuters", "external", "careers"],
    sectors: ["data", "legal tech", "finance"],
    canadaCities: ["Toronto"],
    canadaHeadquartered: true,
    priority: "high",
  },
  {
    name: "Autodesk",
    tenants: ["autodesk"],
    wdVariants: ["wd1", "wd5"],
    siteHints: ["autodesk", "external", "careers"],
    sectors: ["design software", "enterprise software"],
    canadaCities: ["Toronto", "Montreal"],
    remoteCanadaLikely: true,
    priority: "high",
  },
  {
    name: "PointClickCare",
    tenants: ["pointclickcare"],
    wdVariants: ["wd3", "wd5", "wd1"],
    siteHints: ["pointclickcare", "external", "careers"],
    sectors: ["healthcare tech", "enterprise software"],
    canadaCities: ["Toronto", "Waterloo"],
    canadaHeadquartered: true,
    priority: "high",
  },
  {
    name: "Dayforce",
    tenants: ["dayforce", "ceridian"],
    wdVariants: ["wd3", "wd5", "wd1"],
    siteHints: ["dayforce", "ceridian", "external", "careers"],
    sectors: ["hr tech", "enterprise software", "finance"],
    canadaCities: ["Toronto", "Calgary"],
    canadaHeadquartered: true,
    priority: "high",
  },
  {
    name: "Kinaxis",
    tenants: ["kinaxis"],
    wdVariants: ["wd3", "wd5", "wd1"],
    siteHints: ["kinaxis", "external", "careers"],
    sectors: ["supply chain", "enterprise software"],
    canadaCities: ["Ottawa", "Toronto"],
    canadaHeadquartered: true,
    priority: "high",
  },
  {
    name: "Cisco",
    tenants: ["cisco"],
    wdVariants: ["wd1", "wd5"],
    siteHints: ["cisco", "external", "careers"],
    sectors: ["networking", "infra", "security"],
    canadaCities: ["Toronto"],
    remoteCanadaLikely: true,
    priority: "medium",
  },
  {
    name: "ADP",
    tenants: ["adp"],
    wdVariants: ["wd5", "wd1"],
    siteHints: ["adp", "external", "careers"],
    sectors: ["hr tech", "finance software"],
    canadaCities: ["Toronto"],
    priority: "medium",
  },
  {
    name: "Bank of Canada",
    tenants: ["bankofcanada"],
    wdVariants: ["wd3", "wd5", "wd1"],
    siteHints: ["bankofcanada", "external", "careers"],
    sectors: ["finance", "economics", "research"],
    canadaCities: ["Ottawa"],
    canadaHeadquartered: true,
    priority: "high",
  },
];

export function buildWorkdaySeedCandidates(options?: {
  companies?: string[];
  canadaWeighted?: boolean;
}) {
  const companyFilter = new Set(
    (options?.companies ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean)
  );
  const candidates = new Map<string, WorkdaySeedCandidate>();

  for (const seed of WORKDAY_DISCOVERY_SEEDS) {
    if (companyFilter.size > 0) {
      const normalizedName = seed.name.trim().toLowerCase();
      const normalizedTenants = seed.tenants.map((tenant) => tenant.toLowerCase());
      if (
        !companyFilter.has(normalizedName) &&
        !normalizedTenants.some((tenant) => companyFilter.has(tenant))
      ) {
        continue;
      }
    }

    const wdVariants = uniqueStrings(seed.wdVariants ?? [...DEFAULT_WD_VARIANTS]);
    const siteHints = uniqueStrings([...seed.siteHints ?? [], ...DEFAULT_SITE_HINTS]);

    for (const tenant of uniqueStrings(seed.tenants)) {
      for (const wdVariant of wdVariants) {
        for (const site of siteHints) {
          const candidate = buildCandidate({
            seed,
            tenant,
            wdVariant,
            site,
            canadaWeighted: options?.canadaWeighted ?? true,
          });
          if (!candidates.has(candidate.sourceToken)) {
            candidates.set(candidate.sourceToken, candidate);
          }
        }
      }
    }
  }

  return [...candidates.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.sourceToken.localeCompare(right.sourceToken);
  });
}

export async function preflightWorkdaySeedCandidates(
  candidates: WorkdaySeedCandidate[],
  options?: { limit?: number; concurrency?: number }
) {
  const concurrency = Math.max(1, options?.concurrency ?? 8);
  const limit = Math.max(1, options?.limit ?? candidates.length);
  const selected = candidates.slice(0, limit);
  const results: WorkdayPreflightCandidate[] = new Array(selected.length);
  let cursor = 0;

  async function worker() {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await preflightCandidate(selected[index]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, selected.length) }, () => worker())
  );

  return results.sort((left, right) => {
    if (Number(right.valid) !== Number(left.valid)) {
      return Number(right.valid) - Number(left.valid);
    }
    if ((right.totalCount ?? 0) !== (left.totalCount ?? 0)) {
      return (right.totalCount ?? 0) - (left.totalCount ?? 0);
    }
    return right.score - left.score;
  });
}

async function preflightCandidate(candidate: WorkdaySeedCandidate) {
  try {
    const response = await fetch(buildWorkdayApiUrl(candidate.sourceToken), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; autoapplication-workday-scout/1.0)",
      },
      body: JSON.stringify({
        appliedFacets: {},
        limit: 1,
        offset: 0,
        searchText: "",
      }),
    });

    if (!response.ok) {
      return {
        ...candidate,
        valid: false,
        fetchedCount: 0,
        totalCount: null,
        previewLimitHint: 20,
        firstTitle: null,
        error: `${response.status} ${response.statusText}`,
      };
    }

    const payload = (await response.json()) as {
      total?: number | null;
      jobPostings?: Array<{ title?: string | null }> | null;
    };
    const fetchedCount = payload.jobPostings?.length ?? 0;
    const totalCount =
      typeof payload.total === "number" && payload.total >= 0
        ? payload.total
        : null;

    return {
      ...candidate,
      valid: fetchedCount > 0 || (totalCount ?? 0) > 0,
      fetchedCount,
      totalCount,
      previewLimitHint:
        typeof totalCount === "number" && totalCount >= 100 ? 100 : 20,
      firstTitle: payload.jobPostings?.[0]?.title?.trim() || null,
    };
  } catch (error) {
    return {
      ...candidate,
      valid: false,
      fetchedCount: 0,
      totalCount: null,
      previewLimitHint: 20,
      firstTitle: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildCandidate({
  seed,
  tenant,
  wdVariant,
  site,
  canadaWeighted,
}: {
  seed: WorkdayDiscoverySeed;
  tenant: string;
  wdVariant: string;
  site: string;
  canadaWeighted: boolean;
}): WorkdaySeedCandidate {
  const host = `${tenant}.${wdVariant}.myworkdayjobs.com`;
  const sourceToken = buildWorkdaySourceToken({
    host,
    tenant,
    site,
  });
  const reasons: string[] = [];
  let score = seed.priority === "high" ? 6 : 3;

  if (canadaWeighted) {
    if (seed.canadaHeadquartered) {
      score += 5;
      reasons.push("canada_hq");
    }
    if ((seed.canadaCities?.length ?? 0) >= 2) {
      score += 3;
      reasons.push("multi_city_canada");
    } else if ((seed.canadaCities?.length ?? 0) === 1) {
      score += 1.5;
      reasons.push("single_city_canada");
    }
    if (seed.remoteCanadaLikely) {
      score += 2;
      reasons.push("remote_canada_likely");
    }
  }

  if (
    seed.sectors.some((sector) =>
      /(fin|insurance|payments|infra|cloud|health|data|research|security|enterprise)/i.test(
        sector
      )
    )
  ) {
    score += 2;
    reasons.push("target_sector");
  }

  score += WD_VARIANT_SCORES[wdVariant] ?? 0.5;
  score += SITE_SCORES[site] ?? (site === tenant ? 1 : 0.6);

  if (seed.siteHints?.includes(site)) {
    score += 1.5;
    reasons.push("explicit_site_hint");
  }

  return {
    companyName: seed.name,
    tenant,
    wdVariant,
    site,
    sourceToken,
    url: buildWorkdayApiUrl(sourceToken),
    score: Number(score.toFixed(2)),
    scoreReasons: reasons,
    sectors: seed.sectors,
    notes: seed.notes,
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}
