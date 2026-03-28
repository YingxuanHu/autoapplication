export const GREENHOUSE_CORE_BOARD_TOKENS = [
  "vercel",
  "stripe",
  "coinbase",
  "figma",
  "robinhood",
  "lyft",
  "anthropic",
  "databricks",
  "scaleai",
] as const;

export const GREENHOUSE_EXPANSION_BOARD_TOKENS = [
  "affirm",
  "asana",
  "brex",
  "chime",
  "datadog",
  "dropbox",
  "instacart",
] as const;

export const GREENHOUSE_PRIORITY_BOARD_TOKENS = [
  // Finance / fintech
  "sofi",
  "gusto",
  // High-signal tech companies with healthy NA acceptance in sample ingests
  "reddit",
  "airbnb",
  "discord",
] as const;

export const GREENHOUSE_GROWTH_BOARD_TOKENS = [
  // Strong sample-ingest yield with healthy North America acceptance
  "airtable",
  "everlaw",
  "seatgeek",
  "webflow",
  "checkr",
] as const;

export const GREENHOUSE_DEFAULT_BOARD_TOKENS = [
  ...GREENHOUSE_CORE_BOARD_TOKENS,
  ...GREENHOUSE_EXPANSION_BOARD_TOKENS,
  ...GREENHOUSE_PRIORITY_BOARD_TOKENS,
  ...GREENHOUSE_GROWTH_BOARD_TOKENS,
] as const;

export const RIPPLING_DEFAULT_BOARD_TOKENS = [
  "rippling",   // Rippling itself — 700+ jobs, high NA volume
  "anaconda",   // Anaconda — verified 20 jobs, US remote-first
  "tixr", // Events/tickets platform — strong NA technical yield in discovery dry-run
  "n3xt-jobs", // Digital assets / infra — strong NA SWE + DevOps + compliance blend
  "exacare-inc", // Health-tech AI — ML, product, and SWE roles across US/Canada
  "inrule", // US rules-engine vendor — product + IT + analytics roles with clean NA fit
  "patientnow", // US healthcare software — product, design, SWE, and security with clean NA preview yield
  "vouch-inc", // US insurtech — analytics, platform product, and SWE roles with clean Rippling preview yield
  "heads-up-technologies", // US aviation systems vendor — strong embedded/software/devops/systems engineering yield
] as const;

export const RIPPLING_GROWTH_BOARD_TOKENS = [
  "tixr",
  "n3xt-jobs",
  "exacare-inc",
  "inrule",
  "patientnow",
  "vouch-inc",
  "heads-up-technologies",
] as const;

export const LEVER_DEFAULT_SITE_TOKENS = [
  "plaid",
  "anyscale",
] as const;

export const RECRUITEE_DEFAULT_COMPANY_TOKENS = [
  "innodatainc",
  "deephealth",
  "huaweicanada",
  "1x",
  "basispathinc",
] as const;

export const RECRUITEE_GROWTH_COMPANY_TOKENS = [
  // Batch 2: direct NA tech companies promoted after dry-run validation (2026-03-26)
  "s2corporation", // Defense/engineering, Bozeman MT — 6 accepted (SWE, algorithms, RF)
  "emergentsoftware", // Software consultancy, Minneapolis MN — 6 accepted (data eng, infra)
  "greatminds", // EdTech, Washington DC area — 9 accepted (staff SWE, eng mgr, web dev)
] as const;

export const ASHBY_DEFAULT_ORG_TOKENS = [
  "openai",
  "perplexity",
  "cohere",
  "harvey",
  "supabase",
  "modal",
  "baseten",
  "neon",
  "workos",
  "vanta",
  "drata",
  "notion",
  "linear",
  "runway-ml",
  "ramp",
  "nerdwallet",
  "pinecone",
  "vapi",
  "sierra",
  "persona",
  "synthesia",
  "alchemy",
  "suno",
  "patreon",
  "browserbase",
  "orb",
  "mercor",
  "cognition",
  "tavus",
  "factory",
  "numeral",
  "unify",
  "exa",
  "method",
  "substack",
  "parafin",
  "traba",
  "sardine",
] as const;

export const ASHBY_MARGINAL_YIELD_ORG_TOKENS = [
  "mercor",
  "cognition",
  "tavus",
  "factory",
  "numeral",
] as const;

export const ASHBY_NEXT_YIELD_ORG_TOKENS = [
  "unify",
  "exa",
  "method",
  "substack",
] as const;

export const ASHBY_STRICT_YIELD_ORG_TOKENS = [
  "parafin",
  "traba",
  "sardine",
] as const;

// ─── Taleo ──────────────────────────────────────────────────────────────────
// Source token format: tenant/careerSection
// Validated via sitemap + headless ingestion (2026-03-27)

export const TALEO_DEFAULT_SOURCE_TOKENS = [
  "aircanada/2",   // Air Canada external — 63 entries, ~24% NA tech/finance acceptance
  "axp/rp",        // American Express (recruiter portal) — 110 entries, ~35% acceptance, US-heavy
  "axp/2",         // American Express (section 2) — 470 entries, ~18% acceptance, global with NA slice
] as const;

export const TALEO_EXPANSION_SOURCE_TOKENS = [
  "axp/1",         // American Express (section 1) — 685 entries, large global pool
  "axp/6",         // American Express (section 6) — 85 entries
  "aa270/ex",      // Unknown enterprise — 127 entries, needs NA validation
] as const;

export type IngestionExpansionProfile =
  | "greenhouse_trusted_batch"
  | "greenhouse_priority_batch"
  | "greenhouse_growth_batch"
  | "rippling_growth_batch"
  | "recruitee_growth_batch"
  | "ashby_growth_batch"
  | "ashby_yield_batch"
  | "ashby_marginal_yield_batch"
  | "ashby_next_yield_batch"
  | "ashby_strict_yield_batch";

export function getExpansionProfileTargets(profile: IngestionExpansionProfile) {
  switch (profile) {
    case "greenhouse_trusted_batch":
      return {
        connector: "greenhouse" as const,
        tokens: [...GREENHOUSE_EXPANSION_BOARD_TOKENS],
        description:
          "Verified Greenhouse expansion batch for North America tech and finance coverage.",
      };
    case "greenhouse_priority_batch":
      return {
        connector: "greenhouse" as const,
        tokens: [...GREENHOUSE_PRIORITY_BOARD_TOKENS],
        description:
          "Second Greenhouse priority batch chosen from probe and sample-ingest results.",
      };
    case "greenhouse_growth_batch":
      return {
        connector: "greenhouse" as const,
        tokens: [...GREENHOUSE_GROWTH_BOARD_TOKENS],
        description:
          "Next curated Greenhouse growth batch selected for canonical growth, NA fit, and healthy dedupe behavior.",
      };
    case "rippling_growth_batch":
      return {
        connector: "rippling" as const,
        tokens: [...RIPPLING_GROWTH_BOARD_TOKENS],
        description:
          "High-confidence Rippling growth batch promoted only after slug discovery, board validation, and dry-run-created yield screening.",
      };
    case "recruitee_growth_batch":
      return {
        connector: "recruitee" as const,
        tokens: [...RECRUITEE_GROWTH_COMPANY_TOKENS],
        description:
          "Curated direct-company Recruitee batch selected for North America fit, trusted board ownership, and healthy net-new canonical yield.",
      };
    case "ashby_growth_batch":
      return {
        connector: "ashby" as const,
        tokens: ["vapi", "sierra", "persona", "synthesia"],
        description:
          "Curated Ashby growth batch selected for stronger net-new canonical yield than the next Greenhouse cohort.",
      };
    case "ashby_yield_batch":
      return {
        connector: "ashby" as const,
        tokens: ["alchemy", "suno", "patreon", "browserbase", "orb"],
        description:
          "Next Ashby yield-first batch selected for stronger marginal canonical creation than the remaining curated Greenhouse cohort.",
      };
    case "ashby_marginal_yield_batch":
      return {
        connector: "ashby" as const,
        tokens: [...ASHBY_MARGINAL_YIELD_ORG_TOKENS],
        description:
          "Dry-run-gated Ashby batch promoted only after clearing a preview threshold for net-new canonical creation.",
      };
    case "ashby_next_yield_batch":
      return {
        connector: "ashby" as const,
        tokens: [...ASHBY_NEXT_YIELD_ORG_TOKENS],
        description:
          "Next dry-run-gated Ashby batch promoted after strong preview-created yield on fresh candidates.",
      };
    case "ashby_strict_yield_batch":
      return {
        connector: "ashby" as const,
        tokens: [...ASHBY_STRICT_YIELD_ORG_TOKENS],
        description:
          "Strict Ashby batch promoted only after clearing a higher dry-run-created threshold and post-preview role-family QA.",
      };
  }
}
