/**
 * generate-seed.ts
 *
 * Converts a curated company list into ATS board candidate URLs, then writes
 * a seed JSON file that can be fed directly into:
 *
 *   npx tsx scripts/discover-sources.ts --dataset=<output>
 *
 * Each company entry specifies:
 *   - name: display name (used in reports)
 *   - slugs: one or more ATS-board slug guesses to try
 *   - families: which ATS families to probe
 *   - workdaySites / workdayWdVariants / workdayTenants: optional Workday hints
 *
 * Usage:
 *   npx tsx scripts/generate-seed.ts
 *   npx tsx scripts/generate-seed.ts --out=data/discovery/seeds/my-seed.json
 *   npx tsx scripts/generate-seed.ts --filter=greenhouse
 *   npx tsx scripts/generate-seed.ts --families=ashby,greenhouse
 *   npx tsx scripts/generate-seed.ts --families=workday
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, val] = arg.replace(/^--/, "").split("=");
    return [key, val ?? true];
  })
);

const OUTPUT_PATH = typeof args.out === "string"
  ? args.out
  : "data/discovery/seeds/generated-candidates.json";

const FAMILIES_FILTER: Set<string> = typeof args.families === "string"
  ? new Set(args.families.split(",").map((f) => f.trim()))
  : new Set(["ashby", "greenhouse", "lever", "workday"]);

// ─── ATS URL builders ─────────────────────────────────────────────────────────

type CompanyEntry = {
  name: string;
  slugs?: string[];
  families?: string[];
  workdayTenants?: string[];
  workdaySites?: string[];
  workdayWdVariants?: string[];
};

const ATS_BUILDERS: Record<string, (company: CompanyEntry, slug: string) => string[]> = {
  ashby: (_company, slug) => [`https://jobs.ashbyhq.com/${slug}`],
  greenhouse: (_company, slug) => [`https://job-boards.greenhouse.io/${slug}`],
  lever: (_company, slug) => [`https://jobs.lever.co/${slug}`],
  workday: (company, slug) => buildWorkdayCandidateUrls(company, slug),
};

// ─── Company list ─────────────────────────────────────────────────────────────
//
// Format:
//   name      — display name for logging
//   slugs     — ATS slug candidates to try; if omitted, auto-derived from name
//   families  — which ATS families to probe; if omitted, uses FAMILIES_FILTER
//
// Ordering: higher-confidence targets first (established, US-HQ, active hiring)

const COMPANIES: CompanyEntry[] = [
  // ─── Workday validation / scaling cohort ──────────────────────────────────
  { name: "Workday",            slugs: ["workday"],                        families: ["workday"], workdaySites: ["workday", "careers", "external"] },
  { name: "TransUnion",         slugs: ["transunion"],                     families: ["workday"], workdaySites: ["transunion", "external", "careers"] },
  { name: "Visa",               slugs: ["visa"],                           families: ["workday"], workdaySites: ["visa", "external", "careers"] },
  { name: "PayPal",             slugs: ["paypal"],                         families: ["workday"], workdaySites: ["jobs", "paypal", "external"] },
  { name: "Equinix",            slugs: ["equinix"],                        families: ["workday"], workdaySites: ["external", "equinix", "careers"] },
  { name: "Guidewire",          slugs: ["guidewire"],                      families: ["workday"], workdaySites: ["external", "guidewire", "careers"] },
  { name: "Pacific Life",       slugs: ["pacificlife"],                    families: ["workday"], workdaySites: ["pacificlifecareers", "external", "careers"], workdayWdVariants: ["wd1"] },
  { name: "Salesforce",         slugs: ["salesforce"],                     families: ["workday"] },
  { name: "JPMorgan",           slugs: ["jpmorgan"],                       families: ["workday"] },
  { name: "Deloitte",           slugs: ["deloitte"],                       families: ["workday"] },

  // ─── AI / ML ──────────────────────────────────────────────────────────────
  { name: "Hugging Face",       slugs: ["huggingface"],                   families: ["greenhouse", "lever"] },
  { name: "Weights & Biases",   slugs: ["wandb", "weightsandbiases"],      families: ["greenhouse", "lever"] },
  { name: "Deepgram",           slugs: ["deepgram"],                       families: ["greenhouse", "ashby"] },
  { name: "AssemblyAI",         slugs: ["assemblyai"],                     families: ["greenhouse", "lever"] },
  { name: "Groq",               slugs: ["groq"],                           families: ["ashby", "greenhouse"] },
  { name: "Fireworks AI",       slugs: ["fireworks-ai", "fireworksai"],    families: ["ashby"] },
  { name: "Mistral AI",         slugs: ["mistral", "mistralai"],           families: ["ashby", "greenhouse"] },
  { name: "Snorkel AI",         slugs: ["snorkel", "snorkelai"],           families: ["lever", "greenhouse"] },
  { name: "Gretel AI",          slugs: ["gretel", "gretelai"],             families: ["greenhouse", "lever"] },
  { name: "Cleanlab",           slugs: ["cleanlab"],                       families: ["ashby", "greenhouse"] },
  { name: "Pika Labs",          slugs: ["pika", "pika-labs"],              families: ["ashby"] },
  { name: "LlamaIndex",         slugs: ["llamaindex", "run-llama"],        families: ["ashby"] },
  { name: "Anyscale",           slugs: ["anyscale"],                       families: ["lever"] }, // already in system? may dedup
  { name: "Lightning AI",       slugs: ["lightning-ai", "lightningai"],    families: ["greenhouse", "ashby"] },

  // ─── Infra / DevTools ─────────────────────────────────────────────────────
  { name: "HashiCorp",          slugs: ["hashicorp"],                      families: ["greenhouse"] },
  { name: "Pulumi",             slugs: ["pulumi"],                         families: ["greenhouse", "lever"] },
  { name: "Temporal",           slugs: ["temporal", "temporalio"],         families: ["ashby", "lever"] },
  { name: "Tailscale",          slugs: ["tailscale"],                      families: ["ashby"] },
  { name: "Teleport",           slugs: ["goteleport", "teleport"],         families: ["ashby", "greenhouse"] },
  { name: "Render",             slugs: ["render"],                         families: ["ashby", "greenhouse"] },
  { name: "Fly.io",             slugs: ["fly-io", "flyio", "fly"],         families: ["ashby"] },
  { name: "PlanetScale",        slugs: ["planetscale"],                    families: ["lever", "ashby"] },
  { name: "Clerk",              slugs: ["clerk", "clerk-dev"],             families: ["ashby"] },
  { name: "Stytch",             slugs: ["stytch"],                         families: ["ashby"] },
  { name: "Turso",              slugs: ["turso", "chiselstrike"],          families: ["ashby"] },
  { name: "Resend",             slugs: ["resend"],                         families: ["ashby"] },
  { name: "Retool",             slugs: ["retool"],                         families: ["greenhouse", "ashby"] },
  { name: "Deno",               slugs: ["deno", "denoland"],               families: ["ashby"] },
  { name: "Mintlify",           slugs: ["mintlify"],                       families: ["ashby"] },
  { name: "Buf",                slugs: ["buf"],                            families: ["ashby"] },
  { name: "Doppler",            slugs: ["doppler"],                        families: ["ashby"] },
  { name: "Netlify",            slugs: ["netlify"],                        families: ["lever", "greenhouse"] },
  { name: "Sentry",             slugs: ["sentry", "getsentry"],            families: ["lever"] },
  { name: "Grafana Labs",       slugs: ["grafana"],                        families: ["greenhouse", "lever"] },
  { name: "Miro",               slugs: ["miro"],                           families: ["greenhouse"] },
  { name: "Loom",               slugs: ["loom"],                           families: ["greenhouse"] },
  { name: "Notion",             slugs: ["notion"],                         families: ["ashby"] }, // already in system - good dedup test
  { name: "Coda",               slugs: ["coda"],                           families: ["greenhouse", "lever"] },
  { name: "Figma",              slugs: ["figma"],                          families: ["greenhouse"] }, // already in system

  // ─── Cybersecurity ────────────────────────────────────────────────────────
  { name: "Wiz",                slugs: ["wiz", "wizsec"],                  families: ["greenhouse"] },
  { name: "Snyk",               slugs: ["snyk"],                           families: ["greenhouse", "lever"] },
  { name: "1Password",          slugs: ["1password", "agilebits"],         families: ["lever", "greenhouse"] },
  { name: "Lacework",           slugs: ["lacework"],                       families: ["greenhouse"] },
  { name: "Orca Security",      slugs: ["orca-security", "orcasecurity"],  families: ["greenhouse", "lever"] },
  { name: "Semgrep",            slugs: ["semgrep", "r2c"],                 families: ["ashby", "greenhouse"] },
  { name: "Socket",             slugs: ["socket", "socket-security"],      families: ["ashby"] },
  { name: "Tines",              slugs: ["tines"],                          families: ["greenhouse", "ashby"] },
  { name: "Abnormal Security",  slugs: ["abnormal", "abnormalsecurity"],   families: ["greenhouse", "lever"] },
  { name: "Cribl",              slugs: ["cribl"],                          families: ["greenhouse", "lever"] },
  { name: "Cyera",              slugs: ["cyera"],                          families: ["greenhouse", "ashby"] },
  { name: "RunReveal",          slugs: ["runreveal"],                      families: ["ashby"] },

  // ─── Fintech / Finance ────────────────────────────────────────────────────
  { name: "Mercury",            slugs: ["mercury"],                        families: ["ashby", "greenhouse"] },
  { name: "Betterment",         slugs: ["betterment"],                     families: ["greenhouse"] },
  { name: "Marqeta",            slugs: ["marqeta"],                        families: ["greenhouse"] },
  { name: "Dave",               slugs: ["dave"],                           families: ["greenhouse", "lever"] },
  { name: "Acorns",             slugs: ["acorns"],                         families: ["greenhouse", "lever"] },
  { name: "Blend",              slugs: ["blend"],                          families: ["lever", "greenhouse"] },
  { name: "Klarna",             slugs: ["klarna"],                         families: ["greenhouse", "lever"] },
  { name: "Adyen",              slugs: ["adyen"],                          families: ["greenhouse"] },
  { name: "Novo",               slugs: ["novo", "novo-platform"],          families: ["greenhouse", "ashby"] },
  { name: "Arc",                slugs: ["arc", "arc-technologies"],        families: ["ashby"] },
  { name: "Payoneer",           slugs: ["payoneer"],                       families: ["greenhouse"] },
  { name: "Samsara",            slugs: ["samsara"],                        families: ["greenhouse"] },

  // ─── Healthcare / Health Tech ─────────────────────────────────────────────
  { name: "Oscar Health",       slugs: ["oscar", "hioscar"],               families: ["greenhouse", "lever"] },
  { name: "Tempus",             slugs: ["tempus"],                         families: ["greenhouse", "lever"] },
  { name: "Zocdoc",             slugs: ["zocdoc"],                         families: ["greenhouse", "lever"] },
  { name: "Capsule",            slugs: ["capsule"],                        families: ["greenhouse", "lever"] },
  { name: "Ro",                 slugs: ["ro", "rohealthcare"],             families: ["greenhouse", "lever"] },

  // ─── Enterprise / B2B SaaS ────────────────────────────────────────────────
  { name: "Lattice",            slugs: ["lattice"],                        families: ["greenhouse", "lever"] },
  { name: "Rippling",           slugs: ["rippling"],                       families: ["greenhouse"] }, // already Rippling ATS, check GH board
  { name: "Loom",               slugs: ["loom"],                           families: ["greenhouse"] },
  { name: "Salesforce",         slugs: ["salesforce"],                     families: ["greenhouse"] },
  { name: "Duolingo",           slugs: ["duolingo"],                       families: ["greenhouse"] },
  { name: "Iterable",           slugs: ["iterable"],                       families: ["greenhouse", "lever"] },
  { name: "Brainlid",           slugs: ["brainlid"],                       families: ["lever"] },
  { name: "Amplitude",          slugs: ["amplitude"],                      families: ["greenhouse", "lever"] },
  { name: "Heap",               slugs: ["heap", "heap-inc"],               families: ["greenhouse", "lever"] },
  { name: "Mixpanel",           slugs: ["mixpanel"],                       families: ["greenhouse"] }, // already in system
  { name: "Pendo",              slugs: ["pendo"],                          families: ["greenhouse", "lever"] },
  { name: "LaunchDarkly",       slugs: ["launchdarkly"],                   families: ["greenhouse", "lever"] },
  { name: "Contentful",         slugs: ["contentful"],                     families: ["greenhouse"] }, // already in system
  { name: "Calendly",           slugs: ["calendly"],                       families: ["greenhouse", "lever"] },
  { name: "Handshake",          slugs: ["handshake", "joinhandshake"],     families: ["greenhouse", "lever"] },

  // ─── Climate / Energy ─────────────────────────────────────────────────────
  { name: "Arcadia",            slugs: ["arcadia", "arcadiapower"],        families: ["greenhouse", "lever"] },
  { name: "Palmetto",           slugs: ["palmetto"],                       families: ["greenhouse", "lever"] },
  { name: "Swell Energy",       slugs: ["swell", "swellenergy"],           families: ["ashby", "lever"] },
  { name: "Span.IO",            slugs: ["span", "span-io"],                families: ["ashby", "greenhouse"] },
  { name: "Enode",              slugs: ["enode"],                          families: ["ashby"] },
  { name: "Ampere",             slugs: ["ampere"],                         families: ["ashby", "greenhouse"] },
  { name: "Sense",              slugs: ["sense"],                          families: ["greenhouse", "lever"] },
  { name: "Recurve",            slugs: ["recurve"],                        families: ["lever", "greenhouse"] },
];

// ─── Slug auto-derivation ─────────────────────────────────────────────────────

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+(inc|corp|ltd|llc|technologies|technology|tech|labs|ai|io|studio|studios)\.?\s*$/i, "")
    .trim()
    .replace(/[\s.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

// ─── URL generation ───────────────────────────────────────────────────────────

function generateCandidateUrls(company: CompanyEntry): string[] {
  const slugs = company.slugs?.length ? company.slugs : [deriveSlug(company.name)];
  const families = (company.families ?? [...FAMILIES_FILTER.keys()]).filter((f) =>
    FAMILIES_FILTER.has(f)
  );

  const urls: string[] = [];
  for (const family of families) {
    const builder = ATS_BUILDERS[family];
    if (!builder) continue;
    for (const slug of slugs) {
      urls.push(...builder(company, slug));
    }
  }
  return urls;
}

function buildWorkdayCandidateUrls(company: CompanyEntry, slug: string) {
  const tenants = uniqueStrings(company.workdayTenants ?? company.slugs ?? [slug]);
  const siteCandidates = uniqueStrings([
    ...(company.workdaySites ?? []),
    ...(company.slugs ?? [slug]),
    "careers",
    "external",
  ]);
  const wdVariants = uniqueStrings(company.workdayWdVariants ?? ["wd1", "wd3", "wd5"]);
  const urls: string[] = [];

  for (const tenant of tenants) {
    for (const wdVariant of wdVariants) {
      const host = `${tenant}.${wdVariant}.myworkdayjobs.com`;
      for (const site of siteCandidates) {
        urls.push(`https://${host}/wday/cxs/${tenant}/${site}/jobs`);
      }
    }
  }

  return urls;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const urls: string[] = [];

  for (const company of COMPANIES) {
    const candidates = generateCandidateUrls(company);
    urls.push(...candidates);
    if (process.stdout.isTTY) {
      process.stdout.write(`  ${company.name.padEnd(20)} → ${candidates.length} URLs\n`);
    }
  }

  // Deduplicate
  const deduped = [...new Set(urls)];

  // Ensure output dir exists
  await mkdir(path.dirname(path.resolve(OUTPUT_PATH)), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(deduped, null, 2));

  console.log(`\nGenerated ${deduped.length} candidate URLs from ${COMPANIES.length} companies`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log(`\nNext step:`);
  console.log(`  npx tsx scripts/discover-sources.ts --dataset=${OUTPUT_PATH} --limit=5`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
