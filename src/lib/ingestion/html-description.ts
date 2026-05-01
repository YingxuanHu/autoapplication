/**
 * Shared helpers for extracting clean job-description text from HTML pages
 * and decoding HTML entities consistently across connectors.
 *
 * Consumers:
 * - connectors/company-site.ts — full-page HTML scrape fallback
 * - connectors/workday.ts — JSON-LD-less detail page fallback
 * - normalize.ts — final sanitize pass
 * - scripts/cleanup-polluted-descriptions.ts — retroactive cleanup
 */

// Named HTML entity map — covers what actually appears in scraped job pages.
// (Exhaustive HTML5 tables are overkill; this list hits the common cases.)
/** Regex to strip all HTML tags. Shared by description extractors and connectors. */
export const STRIP_TAGS_RE = /<[^>]+>/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  divide: "÷",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  laquo: "«",
  raquo: "»",
  hearts: "♥",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  iexcl: "¡",
  iquest: "¿",
  szlig: "ß",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  atilde: "ã",
  otilde: "õ",
  ccedil: "ç",
  aring: "å",
  oslash: "ø",
  AElig: "Æ",
  aelig: "æ",
  OElig: "Œ",
  oelig: "œ",
  thinsp: " ",
  ensp: " ",
  emsp: " ",
  zwnj: "",
  zwj: "",
  lrm: "",
  rlm: "",
  shy: "",
};

/**
 * Decode all HTML entity forms: named (`&amp;`), numeric decimal (`&#34;`),
 * and numeric hex (`&#x2F;` / `&#X2F;`). Unknown named entities pass through
 * verbatim rather than being dropped.
 */
export function decodeHtmlEntitiesFull(input: string): string {
  if (!input) return "";
  return input.replace(
    /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]+));/g,
    (match, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (dec !== undefined) {
        const code = Number.parseInt(dec, 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      if (named !== undefined) {
        const hit = NAMED_ENTITIES[named] ?? NAMED_ENTITIES[named.toLowerCase()];
        return hit ?? match;
      }
      return match;
    }
  );
}

// -- DOM-aware content extraction (regex-based; no parser dependency) -------

// Selector-like patterns for known job-description container nodes, in
// priority order. Each entry is a regex that captures the inner HTML of a
// matching element on first successful match. These regexes do not enforce
// proper nesting — they look for <tag ... attr=value ...> ... </tag>.
type ContainerMatcher = {
  label: string;
  pattern: RegExp;
};

const CONTAINER_MATCHERS: ContainerMatcher[] = [
  // Workday
  {
    label: "workday-jobPostingDescription",
    pattern:
      /<div[^>]*data-automation-id=["']jobPostingDescription["'][^>]*>([\s\S]*?)<\/div>/i,
  },
  // iCIMS
  {
    label: "icims-job-details",
    pattern: /<div[^>]*(?:id|class)=["'][^"']*(?:iCIMS_JobContent|job-description|iCIMS_InfoMsg_Posted)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  },
  // Lever
  {
    label: "lever-opening-description",
    pattern:
      /<div[^>]*class=["'][^"']*(?:opening-content|posting-description|content-wrapper)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  },
  // Greenhouse-embedded
  {
    label: "greenhouse-job-description",
    pattern:
      /<div[^>]*(?:id|class)=["'][^"']*(?:content|job-post|app_body|job_description)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  },
  // SuccessFactors
  {
    label: "successfactors-jobdescription",
    pattern:
      /<div[^>]*(?:id|class)=["'][^"']*(?:jobdescription|job-description|jobDetail)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  },
  // Taleo
  {
    label: "taleo-description",
    pattern:
      /<span[^>]*(?:id|class)=["'][^"']*(?:requisitionDescriptionInterface|jobDescription)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
  },
  // Generic semantic
  {
    label: "main",
    pattern: /<main\b[^>]*>([\s\S]*?)<\/main>/i,
  },
  {
    label: "article",
    pattern: /<article\b[^>]*>([\s\S]*?)<\/article>/i,
  },
  // Generic class fallbacks — catch attributes like class="job-description",
  // class="posting-description", class="position-description", etc.
  {
    label: "generic-job-description",
    pattern:
      /<(?:div|section)[^>]*class=["'][^"']*(?:job[-_]description|posting[-_]description|position[-_]description|role[-_]description|job[-_]details|posting[-_]details|description[-_]content|description[-_]body|job[-_]body|description[-_]text)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i,
  },
  {
    label: "generic-id-description",
    pattern:
      /<(?:div|section)[^>]*id=["'][^"']*(?:job[-_]description|posting[-_]description|job[-_]details|description[-_]content)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i,
  },
];

// Tag + attribute patterns whose content is pure noise — stripped before any
// further processing.
const NOISE_ELEMENT_PATTERNS: RegExp[] = [
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style>/gi,
  /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
  /<nav\b[^>]*>[\s\S]*?<\/nav>/gi,
  /<header\b[^>]*>[\s\S]*?<\/header>/gi,
  /<footer\b[^>]*>[\s\S]*?<\/footer>/gi,
  /<aside\b[^>]*>[\s\S]*?<\/aside>/gi,
  /<form\b[^>]*>[\s\S]*?<\/form>/gi,
  /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi,
  /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
  // Class-based noise: cookie banners, breadcrumbs, similar-jobs, related,
  // social-share, site header/footer blocks.
  /<(div|section|aside)[^>]*class=["'][^"']*(?:cookie|consent|breadcrumb|similar[-_]?jobs?|related[-_]?(?:jobs?|posts?|positions?)|site[-_](?:header|footer|nav)|social[-_]share|share[-_]buttons|back[-_]to[-_]top|page[-_]header|page[-_]footer|masthead|subscribe|newsletter|apply[-_]bar|talent[-_]community|recommended)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
  /<(div|section|aside)[^>]*id=["'][^"']*(?:cookie|consent|breadcrumb|similar[-_]?jobs?|related|header|footer|nav|sidebar)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
];

function stripNoiseElements(html: string): string {
  let out = html;
  for (const pattern of NOISE_ELEMENT_PATTERNS) {
    out = out.replace(pattern, " ");
  }
  return out;
}

// Convert block-level tag boundaries to newlines, drop remaining inline tags.
function htmlFragmentToText(fragment: string): string {
  const withLists = fragment
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|section|article|li|ul|ol|h[1-6]|blockquote|tr|td)[^>]*>/gi,
      "\n"
    );
  const stripped = withLists.replace(STRIP_TAGS_RE, " ");
  return decodeHtmlEntitiesFull(stripped)
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Pollution patterns that indicate text accidentally captured from the page
 * chrome (nav, footer, theme config, etc.) rather than the job description.
 * Returns true if the text looks like it has non-description content mixed in.
 */
export function hasDescriptionPollution(text: string): boolean {
  if (!text) return false;
  // Inline JS/JSON blob leakage
  if (/^\s*\{\s*["&][a-zA-Z#]+["&]?\s*:\s*\{/.test(text)) return true;
  if (/(?:window\.|window\[)/.test(text.slice(0, 2000))) return true;
  if (/var\s+\w+\s*=\s*/.test(text.slice(0, 2000)) && /=\s*[{[]/.test(text.slice(0, 2000))) return true;
  // Theme/feature-flag config JSON that some career sites inline (Phenom, Eightfold).
  if (/["&#]+themeOptions["&#]*/i.test(text.slice(0, 5000))) return true;
  if (/["&#]+customTheme["&#]*/i.test(text.slice(0, 5000))) return true;
  // Site chrome phrases frequently captured as description bodies
  const chromeHits = [
    "similar jobs",
    "related jobs",
    "related openings",
    "join our talent community",
    "join talent network",
    "back to top",
    "cookie preferences",
    "manage preferences",
    "accept all cookies",
    "skip to main content",
  ].filter((phrase) => text.toLowerCase().includes(phrase));
  return chromeHits.length >= 1 && text.length > 4000;
}

const POLLUTION_END_MARKERS = [
  "similar jobs",
  "related jobs",
  "related openings",
  "related positions",
  "recommended jobs",
  "recommended for you",
  "recently viewed jobs",
  "you may also like",
  "people also viewed",
  "join our talent community",
  "join talent network",
  "back to top",
  "share this job",
  "share this position",
  "manage preferences",
  "cookie preferences",
  "accept all cookies",
  "privacy notice",
];

/**
 * Trim trailing pollution by cutting at the first END_MARKER that appears
 * after the first 200 chars. Also strips leading site-chrome markers.
 */
// JSON/JS config keys that, when encountered mid-text, mark the start of a
// page-chrome config blob (Phenom, Eightfold, Workday theme configs, etc.).
// If any of these appear after meaningful body text (>50 chars in), we cut
// there — everything after is site chrome, not description.
const CONFIG_BLOB_MARKERS = [
  '"themeOptions"',
  '"customTheme"',
  '"varTheme"',
  '"isUiRefreshGateEnabled"',
  '"isEmailWizardV2Enabled"',
  '"isNavbarImproveSearchResultsEnabled"',
  '"siteMetadata"',
  '"featureFlags"',
  '"inject_in_html_template"',
  '"stylesheets"',
  '"pcsx-theme-',
  "var __NEXT_DATA__",
  "window.__NEXT_DATA__",
  "window.__INITIAL_STATE__",
  "window.__APOLLO_STATE__",
  "window.dataLayer",
  // CSS leaks — the only legitimate reason description text would contain
  // `!important;` or `border-radius:` is a bug, so treat them as cutoffs.
  "!important;",
  "!important }",
  "border-radius:",
  "background-color:",
  "font-family:",
  "@media only screen",
  "@keyframes",
  ".perk-icon",
  "perk-icon",
];

// A line that looks predominantly like CSS (e.g. ".foo{prop:val}.bar{...}")
// or JSON fragments. Used as a line-level filter.
function looksLikeCssOrJsonFragment(line: string): boolean {
  const t = line.trim();
  if (!t || t.length < 40) return false;
  // CSS rule density: count `{prop:...}` patterns per 100 chars.
  const cssRules = (t.match(/[.#]?[\w-]+\s*\{[^{}]{1,200}\}/g) || []).length;
  if (cssRules >= 2 && cssRules * 40 > t.length * 0.5) return true;
  // JSON fragment density: lots of `"key":` patterns.
  const jsonPairs = (t.match(/"[a-zA-Z_][\w-]*"\s*:/g) || []).length;
  if (jsonPairs >= 3 && jsonPairs * 10 > t.length * 0.15) return true;
  // Inline !important blocks (stylesheet leak).
  if (/!important[;}]/.test(t) && /[{}]/.test(t)) {
    const punct = (t.match(/[{}:;]/g) || []).length;
    if (punct > t.length * 0.08) return true;
  }
  return false;
}

export function trimDescriptionPollution(text: string): string {
  if (!text) return text;
  let trimmed = text;

  // Strip embedded JSON/JS blobs at the start.
  trimmed = trimmed.replace(
    /^[\s\u00a0]*(?:\{[\s\S]+?\}\s*\n{2,}|var\s+[\w$]+\s*=\s*[\s\S]+?;\s*\n{1,}|window(?:\[[^\]]+\]|\.\w+)\s*=\s*[\s\S]+?;\s*\n{1,})/,
    ""
  );
  // Drop lines that are JSON/CSS fragments left over by upstream dumps.
  trimmed = trimmed
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^\{[\s"&#]/.test(t) && t.length > 80) return false;
      if (/^"[a-zA-Z#]+"\s*:\s*[{[]/.test(t)) return false;
      if (looksLikeCssOrJsonFragment(t)) return false;
      return true;
    })
    .join("\n");

  // Cut at the earliest config-blob marker past the first 50 chars.
  let cutIndex = trimmed.length;
  for (const marker of CONFIG_BLOB_MARKERS) {
    const idx = trimmed.indexOf(marker);
    if (idx > 50 && idx < cutIndex) {
      cutIndex = idx;
    }
  }

  // Cut at the earliest END_MARKER past meaningful body text (>200 chars).
  const lower = trimmed.toLowerCase();
  for (const marker of POLLUTION_END_MARKERS) {
    const idx = lower.indexOf(marker);
    if (idx > 200 && idx < cutIndex) {
      cutIndex = idx;
    }
  }
  trimmed = trimmed.slice(0, cutIndex);

  return trimmed.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Extract the job-description text from a full HTML page. Tries known
 * container selectors in priority order; each candidate is scored and the
 * highest-scoring plausible extract is returned. Falls back to a
 * noise-stripped whole-body text if no container yields a usable result.
 *
 * Returns a plain-text description with paragraph breaks preserved as `\n`.
 * Never returns the full raw body without noise stripping.
 */
export function extractDescriptionFromHtml(html: string): string {
  if (!html) return "";

  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch?.[1] ?? html;
  const cleanedBody = stripNoiseElements(bodyHtml);

  // Try each container matcher against the cleaned body.
  type Candidate = { label: string; text: string; score: number };
  const candidates: Candidate[] = [];
  for (const matcher of CONTAINER_MATCHERS) {
    const match = cleanedBody.match(matcher.pattern);
    if (!match?.[1]) continue;
    const text = htmlFragmentToText(match[1]);
    if (text.length < 120) continue;
    candidates.push({ label: matcher.label, text, score: scoreCandidate(text) });
  }

  // Always evaluate the full-body fallback as a safety net.
  const bodyText = htmlFragmentToText(cleanedBody);
  if (bodyText.length >= 120) {
    // Heavily penalize the full-body candidate so a container match wins when present.
    candidates.push({ label: "body-fallback", text: bodyText, score: scoreCandidate(bodyText) - 200 });
  }

  if (candidates.length === 0) return "";

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return trimDescriptionPollution(best.text).slice(0, 18_000);
}

function scoreCandidate(text: string): number {
  const length = Math.min(text.length, 8000);
  const lengthScore = length / 20; // up to 400 pts
  const paragraphCount = (text.match(/\n\n/g) ?? []).length;
  const bulletCount = (text.match(/(?:^|\n)\s*[•\-\*]\s+/g) ?? []).length;
  const headingHits = (text.match(
    /\b(responsibilit|qualification|requirement|what you|about (?:the|this) (?:role|job|team|company)|we'?re looking|you(?:'|)?ll do|benefit|compensation)\b/gi
  ) ?? []).length;

  const noisePenalty = (text.match(
    /\b(cookie|consent|similar jobs|related jobs|join our talent community|skip to main|manage preferences|apply now|back to top|subscribe|newsletter)\b/gi
  ) ?? []).length * 30;

  const configPenalty =
    /["&#]+themeOptions|customTheme|window\.__|window\[|var\s+\w+\s*=/.test(text) ? 400 : 0;

  return (
    lengthScore +
    paragraphCount * 8 +
    bulletCount * 5 +
    headingHits * 15 -
    noisePenalty -
    configPenalty
  );
}
