import {
  decodeHtmlEntitiesFull,
  extractDescriptionFromHtml,
  hasDescriptionPollution,
} from "@/lib/ingestion/html-description";
import {
  fetchGuarded,
  type FetchGuardDeps,
} from "@/lib/ingestion/net/ssrf-guard";

export type DescriptionBlock =
  | { kind: "header"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

type DescriptionSourceLinks = {
  applyUrl?: string | null;
  primaryExternalLink?: { href: string } | null;
  sourcePostingLink?: { href: string } | null;
  sourceMappings?: Array<{
    sourceUrl: string | null;
    isPrimary?: boolean;
  }>;
};

const SECTION_HEADINGS = [
  "about the job",
  "about the role",
  "about this role",
  "role overview",
  "position overview",
  "job description",
  "job summary",
  "responsibilities",
  "key responsibilities",
  "what you'll do",
  "what youll do",
  "what you will do",
  "what you'll bring",
  "what youll bring",
  "what you will bring",
  "what we're looking for",
  "what were looking for",
  "required qualifications",
  "minimum qualifications",
  "preferred qualifications",
  "qualifications",
  "requirements",
  "nice to have",
  "benefits",
  "compensation",
  "salary",
  "industry",
  "domain",
  "department",
  "details",
  "about us",
  "about the team",
  "experience",
  "skills",
  "soft skills",
  "work location",
  "hours",
  "line of business",
  "pay details",
  "who we are",
  "our total rewards package",
  "additional information",
  "colleague development",
  "training & onboarding",
  "interview process",
  "accommodation",
  "language requirement",
  "work authorization",
];

const LIST_LIKE_HEADINGS = new Set([
  "responsibilities",
  "key responsibilities",
  "what you'll do",
  "what youll do",
  "what you will do",
  "required qualifications",
  "minimum qualifications",
  "preferred qualifications",
  "qualifications",
  "requirements",
  "what you'll bring",
  "what youll bring",
  "what you will bring",
  "what we're looking for",
  "what were looking for",
  "benefits",
  "skills",
  "soft skills",
  "nice to have",
]);

const COUNTRY_PICKER_VALUES = new Set([
  "united kingdom",
  "australia",
  "österreich",
  "belgië",
  "brasil",
  "canada",
  "france",
  "deutschland",
  "india",
  "italia",
  "méxico",
  "nederland",
  "new zealand",
  "polska",
  "singapore",
  "south africa",
  "españa",
  "schweiz",
  "united states",
  "usa",
]);

const START_MARKERS = [
  "job description",
  "job summary",
  "about the job",
  "about the role",
  "what does a successful",
  "what you'll do",
  "what we're looking for",
  "what you will do",
];

const END_MARKERS = [
  "similar jobs",
  "receive similar jobs by email",
  "create alert",
  "popular jobs",
  "top job titles",
  "top job types",
  "top companies",
  "top locations",
  "jobseekers",
  "recruiters",
  "country selection",
  "back to last search",
  "show full description",
  'window["az_details"]',
  "job_desc_modal_details",
  "var path =",
  "var lang =",
  "var frontend =",
];

const WRONG_PAGE_TEXT_SIGNALS = [
  "roles we fill",
  "apply as a freelancer",
  "hire now",
  "shortcuts open positions",
  "trusted by",
  "featured in",
  "you are now being redirected",
  "view ad here",
  "adzuna jobs search",
  "this blog will help you",
  "watch this video",
  "announcing the general availability",
  "work from anywhere",
];

// Phrasing that is near-universal in real job postings and near-absent in
// marketing/About prose. Used to keep a substantial single-paragraph blob from
// passing the quality gate unless it actually reads like a posting.
const JOB_CONTENT_SIGNAL_RE =
  /\b(responsibilit|qualification|requirement|what you(?:['’]ll| will)|you(?:['’]ll| will) (?:be|have|work|help|own|build|lead|design|develop|manage|collaborat)|we(?:['’]re| are) (?:looking|hiring|seeking)|years? of experience|about (?:the|this) (?:role|job|position)|the ideal candidate|preferred qualification|nice to have|who you are|what we offer)\b/i;

// Only genuine redirect-stub markers belong here. Ambient analytics and SSR
// hydration scripts (Google Tag Manager, sendBeacon, __NEXT_DATA__,
// __INITIAL_STATE__) appear on a huge fraction of legitimate job pages — keeping
// them caused complete, correctly-extracted postings to be discarded as "wrong
// page" purely because the source page loaded analytics or was server-rendered.
const WRONG_PAGE_HTML_SIGNALS = ["setTimeout(redirect"];

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHeadingText(text: string) {
  return text
    .replace(/^#+\s*/, "")
    .replace(/:$/, "")
    .trim();
}

function normalizeHeadingKey(text: string) {
  return normalizeHeadingText(text)
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[^\w\s&/+()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCommonMojibake(text: string) {
  return text
    .replace(/â¦/g, "…")
    .replace(/â/g, "–")
    .replace(/â/g, "—")
    .replace(/â/g, "'")
    .replace(/â|â/g, '"')
    .replace(/Â&nbsp;/g, " ")
    .replace(/Â\s/g, " ");
}

function looksLikeIncompleteDescriptionSnippet(text: string) {
  const normalized = normalizeCommonMojibake(text).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return true;
  }

  const lower = normalized.toLowerCase();
  const hasRoleContent =
    /\b(responsibilities|requirements|qualifications|you will|you'll|what you|this role|the role|candidate|as a|as an)\b/i.test(
      normalized
    );

  if (
    normalized.length < 360 &&
    (/(\.\.\.|…)/.test(normalized) ||
      /\b(?:see this and similar jobs|similar jobs on linkedin)\b/i.test(normalized) ||
      /\b(?:at|to|and|with|for|of|in|the|a|an|our|their)$/i.test(normalized))
  ) {
    return true;
  }

  if (
    normalized.length < 360 &&
    /^(company description|who are we|who we are|about [a-z0-9& .'-]+)\b/.test(lower) &&
    !hasRoleContent
  ) {
    return true;
  }

  if (
    normalized.length < 240 &&
    !hasRoleContent &&
    /(work authorization|autorisation de travail|on-site expectation|onsite expectation)/i.test(
      normalized
    )
  ) {
    return true;
  }

  return false;
}

function decodeEmbeddedJsonString(value: string) {
  try {
    return JSON.parse(`"${value.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`) as string;
  } catch {
    return value;
  }
}

function scanJsonObjectAt(text: string, startIndex: number) {
  if (text[startIndex] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function findJsonObjectStartsNearJobPosting(raw: string) {
  const starts = new Set<number>();
  const markers = ['"@context"', '"@type"', "JobPosting", "schema.org"];

  for (const marker of markers) {
    let index = raw.indexOf(marker);
    while (index !== -1) {
      const start = raw.lastIndexOf("{", index);
      if (start !== -1) {
        starts.add(start);
      }
      index = raw.indexOf(marker, index + marker.length);
    }
  }

  return [...starts].sort((left, right) => left - right);
}

// Returns the FIRST JobPosting.description in document order. A page's primary
// posting is emitted before any "similar jobs" siblings, so first-wins reliably
// targets the real job — preferring the longest instead can surface a longer
// similar-jobs entry.
function extractJobPostingDescriptionFromValue(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const description = extractJobPostingDescriptionFromValue(entry);
      if (description) return description;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  const typeValue = record["@type"];
  const types = Array.isArray(typeValue) ? typeValue : [typeValue];
  const isJobPosting = types.some(
    (entry) => typeof entry === "string" && entry.toLowerCase() === "jobposting"
  );
  const description = record.description;

  if (isJobPosting && typeof description === "string" && description.trim().length >= 80) {
    return description.trim();
  }

  for (const key of ["@graph", "mainEntity", "itemListElement"]) {
    const nested = extractJobPostingDescriptionFromValue(record[key]);
    if (nested) return nested;
  }

  return null;
}

function extractStructuredJobPostingDescription(raw: string) {
  const candidates = [raw, decodeHtmlEntitiesFull(raw)];

  for (const candidate of candidates) {
    for (const start of findJsonObjectStartsNearJobPosting(candidate)) {
      const objectText = scanJsonObjectAt(candidate, start);
      if (!objectText) continue;

      try {
        const parsed = JSON.parse(objectText) as unknown;
        const description = extractJobPostingDescriptionFromValue(parsed);
        if (description) return description;
      } catch {
        // Fall through to the string-regex fallback below. Some sites emit
        // nearly-JSON script data with unescaped line breaks in description.
      }
    }
  }

  return null;
}

function extractEmbeddedDescription(raw: string) {
  const structured = extractStructuredJobPostingDescription(raw);
  if (structured) {
    return structured;
  }

  const anchors = ['window["az_details"]', "window['az_details']", '"az_details"'];

  for (const anchor of anchors) {
    const anchorIndex = raw.indexOf(anchor);
    if (anchorIndex === -1) continue;

    const slice = raw.slice(anchorIndex, anchorIndex + 60000);
    const match = slice.match(/"description"\s*:\s*"((?:\\.|[\s\S])*?)"/);
    if (!match?.[1]) continue;

    const decoded = decodeEmbeddedJsonString(match[1]).trim();
    if (decoded.length >= 120) {
      return decoded;
    }
  }

  const fallbackMatches = [
    ...raw.matchAll(/"description"\s*:\s*"((?:\\.|[\s\S])*?)"/g),
  ];
  const bestFallback = fallbackMatches
    .map((match) => decodeEmbeddedJsonString(match[1] ?? "").trim())
    .filter((value) => value.length >= 120)
    .sort((left, right) => right.length - left.length)[0];

  if (bestFallback) {
    return bestFallback;
  }

  return null;
}

function stripLeadingTitleBullets(raw: string) {
  const lines = raw.replace(/\r/g, "").split("\n");
  let index = 0;
  let removed = 0;

  while (index < lines.length && removed < 4) {
    const line = lines[index]?.trim() ?? "";
    const normalized = line.replace(/^[•*–·-]\s*/, "").trim();
    const looksLikeEmptyBullet = /^[•*–·-]\s*$/.test(line);
    const looksLikeTitleByCompany =
      /^[A-Z0-9][^.!?]{2,90}\s+@\s+[A-Z0-9][^.!?]{1,80}$/i.test(normalized);

    if (!line || looksLikeEmptyBullet || looksLikeTitleByCompany) {
      index += 1;
      removed += 1;
      continue;
    }

    break;
  }

  return lines.slice(index).join("\n");
}

function stripNoiseLines(raw: string) {
  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim());

  const kept: string[] = [];

  for (const line of lines) {
    if (!line) {
      if (kept[kept.length - 1] !== "") {
        kept.push("");
      }
      continue;
    }

    const lower = line.toLowerCase();
    const punctuationHeavy =
      (line.match(/[{}[\];]/g)?.length ?? 0) >= 3 ||
      /^(var |window\.|window\[|function\(|new date\(|https:\/\/www\.googletagmanager)/i.test(line);
    const looksLikeJson =
      /^["[{]/.test(line) ||
      /"@type"|itemlistelement|ga4_event_options|query_info|currency_iso|privacy notice/i.test(
        lower
      );
    const isChromeCopy =
      COUNTRY_PICKER_VALUES.has(lower) ||
      [
        "continue",
        "what?",
        "where?",
        "search",
        "advanced",
        "sorry, this job is not available in your region",
        "search for similar jobs in your region",
        "receive similar jobs by email",
        "create alert",
        "show full description",
        "similar jobs",
        "popular jobs",
        "top job titles",
        "top job types",
        "top companies",
        "top locations",
        "jobseekers",
        "recruiters",
        "privacy",
        "terms & conditions",
        "country selection",
        "change",
        "select your country to see jobs specific to your location.",
        "advanced",
        "create email alert",
        "no thanks, take me to the job",
      ].includes(lower);

    if (punctuationHeavy || looksLikeJson || isChromeCopy) {
      continue;
    }

    kept.push(line);
  }

  while (kept[0] === "") kept.shift();
  while (kept[kept.length - 1] === "") kept.pop();
  return kept.join("\n");
}

function countSubstring(text: string, needle: string) {
  if (!text || !needle) return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const index = text.indexOf(needle, start);
    if (index === -1) return count;
    count += 1;
    start = index + needle.length;
  }
}

function looksLikeRedirectOrTrackerPage(
  text: string,
  html?: string | null
) {
  const lower = text.toLowerCase();
  const htmlLower = html?.toLowerCase() ?? "";

  if (
    lower.includes("you are now being redirected") ||
    lower.includes("view ad here") ||
    lower.includes("adzuna jobs search")
  ) {
    return true;
  }

  return WRONG_PAGE_HTML_SIGNALS.some((signal) => htmlLower.includes(signal.toLowerCase()));
}

function looksLikeGenericCareerLandingPage(text: string) {
  const lower = text.toLowerCase();
  const signalHits = WRONG_PAGE_TEXT_SIGNALS.filter((signal) => lower.includes(signal)).length;
  const openPositionCount = countSubstring(lower, "open position");
  const learnMoreCount = countSubstring(lower, "learn more");

  return (
    signalHits >= 3 ||
    openPositionCount >= 2 ||
    learnMoreCount >= 3 ||
    (lower.includes("faqs") && lower.includes("benefits") && lower.includes("trusted by"))
  );
}

function looksLikeBlogOrArticlePage(text: string) {
  const trimmed = text.trim();
  const firstChunk = trimmed.slice(0, 800);
  const lower = firstChunk.toLowerCase();
  const hasByline = /\bby\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\b/.test(firstChunk);
  const hasPublishDate =
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},\s+\d{4}\b/i.test(
      firstChunk
    ) || /\b\d{4}\b/.test(firstChunk.slice(0, 160));
  const articleSignals = [
    "this blog",
    "watch this video",
    "the wait is over",
    "general availability",
  ].filter((signal) => lower.includes(signal)).length;

  return articleSignals >= 2 || (hasByline && hasPublishDate && articleSignals >= 1);
}

function looksLikeWrongPageDescription(text: string, html?: string | null) {
  if (!text.trim()) {
    return false;
  }

  return (
    looksLikeRedirectOrTrackerPage(text, html) ||
    looksLikeGenericCareerLandingPage(text) ||
    looksLikeBlogOrArticlePage(text)
  );
}

function extractPrimaryDescription(raw: string) {
  const embedded = extractEmbeddedDescription(raw);
  const source = embedded ?? raw;
  const normalized = source.replace(/\r/g, "");
  const lower = normalized.toLowerCase();

  let startIndex = -1;
  for (const marker of START_MARKERS) {
    const index = lower.indexOf(marker);
    if (index !== -1 && (startIndex === -1 || index < startIndex)) {
      startIndex = index;
    }
  }

  const standaloneDescriptionIndex = normalized.search(/(?:^|\n)\s*description\s*(?:\n|$)/i);
  if (
    standaloneDescriptionIndex !== -1 &&
    (startIndex === -1 || standaloneDescriptionIndex < startIndex)
  ) {
    startIndex = standaloneDescriptionIndex;
  }

  const sliced = startIndex >= 0 ? normalized.slice(startIndex) : normalized;
  const slicedLower = sliced.toLowerCase();

  let endIndex = sliced.length;
  for (const marker of END_MARKERS) {
    const index = slicedLower.indexOf(marker);
    if (index > 120 && index < endIndex) {
      endIndex = index;
    }
  }

  return stripNoiseLines(sliced.slice(0, endIndex));
}

function looksLikeStructuredDescription(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }

  const noisySignals = [
    "window[",
    "function(",
    "googletagmanager",
    "country selection",
    "similar jobs",
    "join our talent community",
    "manage preferences",
    "accept all",
    "top job titles",
    "top companies",
  ];

  if (noisySignals.some((signal) => trimmed.toLowerCase().includes(signal))) {
    return false;
  }

  const hasMultipleLines = trimmed.includes("\n");
  const hasStructuredMarkers =
    /^([A-Z][^.!?]{0,60}:|\*\*.+\*\*|[-•*–·]\s+)/m.test(trimmed) ||
    /\n\n[A-Z][^.!?]{0,60}:/.test(trimmed);

  return hasMultipleLines && hasStructuredMarkers;
}

function splitInlineHeadingValues(raw: string) {
  return raw.replace(
    /^([A-Z][A-Za-z0-9/&+,'’() -]{1,48}):\s+(.+)$/gm,
    (_match, label: string, value: string) => {
      const normalizedLabel = normalizeHeadingKey(label);
      const trimmedValue = value.trim();

      if (!trimmedValue || trimmedValue.length > 220) {
        return `${label}: ${trimmedValue}`;
      }

      if (
        SECTION_HEADINGS.includes(normalizedLabel) ||
        /^[A-Z][a-z]+\s+[A-Z]/.test(label) ||
        normalizedLabel.includes("location") ||
        normalizedLabel.includes("salary") ||
        normalizedLabel.includes("compensation") ||
        normalizedLabel.includes("business")
      ) {
        return `${label}:\n${trimmedValue}`;
      }

      return `${label}: ${trimmedValue}`;
    }
  );
}

function cleanupJobDescription(raw: string) {
  const embeddedDescription = extractEmbeddedDescription(raw);
  let cleaned = (embeddedDescription ?? (looksLikeStructuredDescription(raw) ? raw : extractPrimaryDescription(raw)))
    .replace(/\r/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|ul|ol|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\b(click here to apply|apply now!?|submit your application today)\b[.!]*/gi, "")
    .replace(/^[=\-*_]{3,}\s*$/gm, "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ");

  cleaned = normalizeCommonMojibake(cleaned);
  cleaned = decodeHtmlEntitiesFull(cleaned);
  cleaned = stripLeadingTitleBullets(cleaned);

  cleaned = splitInlineHeadingValues(cleaned);

  for (const heading of SECTION_HEADINGS) {
    const regex = new RegExp(`\\s*(${escapeRegex(heading)})\\s*:`, "gi");
    cleaned = cleaned.replace(regex, (_match, matchedHeading) => `\n\n${matchedHeading}:\n`);
  }

  cleaned = cleaned
    .replace(/^description\s*\n+/i, "")
    .replace(/\n+\s*:\s*\n+/g, ":\n")
    .replace(/\s+[•·▪◦]\s+/g, "\n• ")
    .replace(/\s+[-–—]\s+(?=[A-Z0-9])/g, "\n- ")
    .replace(/\s+(\d{1,2}\.\s+)/g, "\n$1")
    .replace(/\b(What Youll Do|What Youll Bring|Who We Are|Job Summary|Key Responsibilities|Required Qualifications|Preferred Qualifications|Additional Information|Interview Process|Work Authorization)\b(?!\s*:)/g, "\n\n$1\n")
    .replace(/^About the job\s+.+$/gim, "About the job")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
}

export function formatJobDescriptionText(raw: string) {
  return cleanupJobDescription(raw);
}

export function parseJobDescriptionBlocks(raw: string): DescriptionBlock[] {
  if (!raw.trim()) return [];

  const cleaned = cleanupJobDescription(raw);
  const hasStructure = /\n/.test(cleaned) && cleaned.split(/\n/).filter(Boolean).length > 2;

  const normalized = hasStructure
    ? cleaned
    : cleaned.replace(
        /(?<![A-Z])\s+(?=[A-Z][A-Z\s&'/()-]{4,}(?:\s|$|:))/g,
        "\n\n"
      );

  const lines = normalized
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const allCapsHeader = /^[A-Z][A-Z\s&'/():-]{3,}$/;
  const titleHeader = /^[A-Z][^.!?]{0,55}:$/;
  const markdownHeader = /^#{1,3}\s+\S/;
  const boldHeader = /^\*\*([^*]+)\*\*:?$/;
  const bullet = /^[-•*–·]\s+(.+)$/;
  const numberedItem = /^\d{1,2}\.\s+(.+)$/;
  const aboutEntityHeader = /^About [A-Z][A-Za-z0-9&'’().,/-]{1,40}:$/;

  const blocks: DescriptionBlock[] = [];
  let pendingBullets: string[] = [];
  let listMode = false;

  const flushBullets = () => {
    if (pendingBullets.length > 0) {
      blocks.push({ kind: "list", items: [...pendingBullets] });
      pendingBullets = [];
    }
  };

  for (const line of lines) {
    if (line === ":") {
      continue;
    }

    const bulletMatch = line.match(bullet);
    const numberedMatch = !bulletMatch ? line.match(numberedItem) : null;
    const boldMatch = !bulletMatch && !numberedMatch ? line.match(boldHeader) : null;
    const headerSource = boldMatch?.[1] ?? line;
    const normalizedHeading = normalizeHeadingKey(headerSource);
    const aboutJobHeading = /^about the job\b/i.test(line);

    const isKnownHeading =
      (SECTION_HEADINGS.includes(normalizedHeading) || aboutJobHeading) &&
      !bulletMatch &&
      !numberedMatch;

    const isHeader =
      isKnownHeading ||
      (!bulletMatch && !numberedMatch && aboutEntityHeader.test(line)) ||
      (!bulletMatch && !numberedMatch && allCapsHeader.test(line) && !/[a-z]/.test(line)) ||
      (!bulletMatch && !numberedMatch && titleHeader.test(line)) ||
      (!bulletMatch && !numberedMatch && markdownHeader.test(line)) ||
      Boolean(boldMatch);

    if (isHeader) {
      flushBullets();
      const headerText = aboutJobHeading ? "About the job" : normalizeHeadingText(headerSource);
      const previous = blocks[blocks.length - 1];
      if (
        previous?.kind === "header" &&
        previous.text.toLowerCase() === headerText.toLowerCase()
      ) {
        continue;
      }
      blocks.push({ kind: "header", text: headerText });
      listMode = LIST_LIKE_HEADINGS.has(normalizedHeading);
      continue;
    }

    if (bulletMatch) {
      pendingBullets.push(bulletMatch[1].trim());
      listMode = true;
      continue;
    }

    if (numberedMatch) {
      pendingBullets.push(numberedMatch[1].trim());
      listMode = true;
      continue;
    }

    if (
      listMode &&
      line.length <= 180 &&
      !/:$/.test(line) &&
      !/^[A-Z][A-Z\s&'/():-]{3,}$/.test(line)
    ) {
      pendingBullets.push(line);
      continue;
    }

    flushBullets();
    listMode = false;
    blocks.push({ kind: "paragraph", text: line });
  }

  flushBullets();
  return blocks;
}

function trimSummaryText(text: string, maxLength: number) {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  const sentenceMatch = trimmed
    .slice(0, maxLength + 1)
    .match(/^([\s\S]{0,220}[.!?])(?:\s|$)/);
  if (sentenceMatch?.[1] && sentenceMatch[1].length >= Math.min(120, maxLength * 0.55)) {
    return sentenceMatch[1].trim();
  }

  return `${trimmed.slice(0, maxLength).trimEnd()}…`;
}

function isDescriptionNoiseText(text: string) {
  const lower = text.toLowerCase().trim();
  if (!lower) {
    return true;
  }

  if (
    [
      "description",
      "saved",
      "apply now",
      "search",
      "share",
      "skip to main content",
      "[open search bar]",
    ].includes(lower)
  ) {
    return true;
  }

  return [
    "skip to main content",
    "open search bar",
    "search",
    "saved",
    "join our talent community",
    "back to top",
    "manage preferences",
    "accept all",
    "similar jobs",
    "careers",
  ].some((signal) => lower.includes(signal));
}

type DescriptionSection = {
  header: string | null;
  blocks: DescriptionBlock[];
};

const METADATA_HEADING_KEYS = new Set([
  "department",
  "work location",
  "location",
  "hours",
  "line of business",
  "pay details",
  "salary",
  "compensation",
  "industry",
  "domain",
]);

const ROLE_OVERVIEW_HEADING_KEYS = new Set([
  "about the job",
  "about the role",
  "about this role",
  "role overview",
  "position overview",
  "job description",
  "job summary",
]);

const RESPONSIBILITY_HEADING_KEYS = new Set([
  "responsibilities",
  "key responsibilities",
  "what youll do",
  "what you will do",
]);

const REQUIRED_QUALIFICATION_HEADING_KEYS = new Set([
  "required qualifications",
  "minimum qualifications",
  "qualifications",
  "requirements",
  "what youll bring",
  "what you will bring",
  "what were looking for",
]);

const PREFERRED_QUALIFICATION_HEADING_KEYS = new Set([
  "preferred qualifications",
  "nice to have",
  "skills",
  "soft skills",
]);

function buildDescriptionSections(blocks: DescriptionBlock[]) {
  const sections: DescriptionSection[] = [];
  let current: DescriptionSection = { header: null, blocks: [] };

  for (const block of blocks) {
    if (block.kind === "header") {
      if (current.header || current.blocks.length > 0) {
        sections.push(current);
      }
      current = { header: block.text, blocks: [] };
      continue;
    }

    current.blocks.push(block);
  }

  if (current.header || current.blocks.length > 0) {
    sections.push(current);
  }

  return sections.filter((section) => section.header || section.blocks.length > 0);
}

type SummarySection = {
  index: number;
  section: DescriptionSection;
  normalizedHeader: string;
  paragraphBlocks: Array<Extract<DescriptionBlock, { kind: "paragraph" }>>;
  listItems: string[];
};

function getSummarySectionPriority(normalizedHeader: string) {
  if (RESPONSIBILITY_HEADING_KEYS.has(normalizedHeader)) return 0;
  if (REQUIRED_QUALIFICATION_HEADING_KEYS.has(normalizedHeader)) return 1;
  if (ROLE_OVERVIEW_HEADING_KEYS.has(normalizedHeader)) return 2;
  if (PREFERRED_QUALIFICATION_HEADING_KEYS.has(normalizedHeader)) return 3;
  if (normalizedHeader === "about the team" || normalizedHeader === "about us") return 6;
  if (normalizedHeader === "benefits" || normalizedHeader === "our total rewards package") return 7;
  return 4;
}

function getSummaryListItemLimit(normalizedHeader: string) {
  if (
    RESPONSIBILITY_HEADING_KEYS.has(normalizedHeader) ||
    REQUIRED_QUALIFICATION_HEADING_KEYS.has(normalizedHeader)
  ) {
    return 6;
  }

  if (PREFERRED_QUALIFICATION_HEADING_KEYS.has(normalizedHeader)) {
    return 5;
  }

  return 4;
}

function getSummaryParagraphLimit(normalizedHeader: string) {
  return ROLE_OVERVIEW_HEADING_KEYS.has(normalizedHeader) || normalizedHeader === "" ? 2 : 1;
}

function getSummaryParagraphLength(normalizedHeader: string) {
  return ROLE_OVERVIEW_HEADING_KEYS.has(normalizedHeader) ||
    RESPONSIBILITY_HEADING_KEYS.has(normalizedHeader) ||
    REQUIRED_QUALIFICATION_HEADING_KEYS.has(normalizedHeader)
    ? 320
    : 260;
}

export function getJobDescriptionSummaryBlocks(raw: string, maxSections = 6) {
  const blocks = parseJobDescriptionBlocks(raw);
  if (blocks.length === 0) {
    return [];
  }

  const sections = buildDescriptionSections(blocks);
  const summarySections: SummarySection[] = [];

  for (const [index, section] of sections.entries()) {
    const normalizedHeader = section.header ? normalizeHeadingKey(section.header) : "";
    if (METADATA_HEADING_KEYS.has(normalizedHeader)) {
      continue;
    }

    const listBlock = section.blocks.find((block) => block.kind === "list");
    const paragraphBlocks = section.blocks.filter(
      (block): block is Extract<DescriptionBlock, { kind: "paragraph" }> => block.kind === "paragraph"
    ).filter((block) => !isDescriptionNoiseText(block.text));
    const listItems = listBlock?.items.filter((item) => !isDescriptionNoiseText(item)) ?? [];

    if (!section.header && paragraphBlocks.length === 0 && listItems.length === 0) {
      continue;
    }

    if (
      !section.header &&
      index === 0 &&
      paragraphBlocks.length === 1 &&
      listItems.length === 0 &&
      sections.slice(1).some((candidate) => candidate.header) &&
      paragraphBlocks[0].text.length <= 80 &&
      !/[.!?]$/.test(paragraphBlocks[0].text)
    ) {
      continue;
    }

    summarySections.push({
      index,
      section,
      normalizedHeader,
      paragraphBlocks,
      listItems,
    });
  }

  // Source pages often start with employer marketing or location metadata. Pick the
  // sections a candidate needs first, then render them in their natural source order.
  const selectedSections = summarySections
    .sort(
      (left, right) =>
        getSummarySectionPriority(left.normalizedHeader) -
          getSummarySectionPriority(right.normalizedHeader) ||
        left.index - right.index
    )
    .slice(0, Math.max(1, maxSections))
    .sort((left, right) => left.index - right.index);
  const summary: DescriptionBlock[] = [];

  for (const summarySection of selectedSections) {
    const { normalizedHeader, paragraphBlocks, listItems, section } = summarySection;

    if (section.header && (paragraphBlocks.length > 0 || listItems.length > 0)) {
      summary.push({ kind: "header", text: section.header });
    }

    if (listItems.length > 0) {
      summary.push({
        kind: "list",
        items: listItems.slice(0, getSummaryListItemLimit(normalizedHeader)),
      });
      continue;
    }

    if (paragraphBlocks.length === 0) {
      continue;
    }

    for (const paragraph of paragraphBlocks.slice(0, getSummaryParagraphLimit(normalizedHeader))) {
      summary.push({
        kind: "paragraph",
        text: trimSummaryText(paragraph.text, getSummaryParagraphLength(normalizedHeader)),
      });
    }
  }

  return summary;
}

export function getCleanJobDescriptionDisplayBlocks(raw: string, maxSections = 8) {
  if (!raw.trim()) {
    return [];
  }

  const summaryBlocks = getJobDescriptionSummaryBlocks(raw, maxSections);
  const sourceBlocks =
    summaryBlocks.length > 0 ? summaryBlocks : parseJobDescriptionBlocks(raw);

  return compactDescriptionBlocks(sourceBlocks);
}

function compactDescriptionBlocks(blocks: DescriptionBlock[]) {
  const compacted: DescriptionBlock[] = [];
  const seenContent = new Set<string>();
  let pendingHeader: string | null = null;

  const pushHeader = () => {
    if (!pendingHeader) return;
    const previous = compacted[compacted.length - 1];
    if (
      previous?.kind !== "header" ||
      normalizeHeadingKey(previous.text) !== normalizeHeadingKey(pendingHeader)
    ) {
      compacted.push({ kind: "header", text: pendingHeader });
    }
    pendingHeader = null;
  };

  for (const block of blocks) {
    if (block.kind === "header") {
      const header = normalizeHeadingText(block.text);
      if (!header || isDescriptionNoiseText(header)) {
        continue;
      }
      pendingHeader = header;
      continue;
    }

    if (block.kind === "paragraph") {
      const text = cleanDescriptionContentText(block.text);
      const key = normalizeDescriptionContentKey(text);
      if (!text || text.length < 35 || seenContent.has(key)) {
        continue;
      }

      pushHeader();
      seenContent.add(key);
      compacted.push({
        kind: "paragraph",
        text: trimSummaryText(text, 420),
      });
      continue;
    }

    const items = block.items
      .map(cleanDescriptionContentText)
      .filter((item) => item.length >= 18 && !isDescriptionNoiseText(item))
      .filter((item) => {
        const key = normalizeDescriptionContentKey(item);
        if (seenContent.has(key)) {
          return false;
        }
        seenContent.add(key);
        return true;
      })
      .map((item) => trimSummaryText(item, 260))
      .slice(0, 6);

    if (items.length === 0) {
      continue;
    }

    pushHeader();
    compacted.push({ kind: "list", items });
  }

  return compacted;
}

function cleanDescriptionContentText(text: string) {
  return text
    .replace(/^[•*–·-]\s+/, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function normalizeDescriptionContentKey(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export function isJobDescriptionSummaryUsable(raw: string | null | undefined) {
  if (!raw?.trim()) {
    return false;
  }

  const cleaned = cleanupJobDescription(raw);
  if (
    !cleaned ||
    looksLikeIncompleteDescriptionSnippet(cleaned) ||
    looksLikeWrongPageDescription(cleaned, raw) ||
    hasDescriptionPollution(cleaned)
  ) {
    return false;
  }

  const blocks = getJobDescriptionSummaryBlocks(cleaned, 8);
  if (blocks.length === 0) {
    return false;
  }

  const headers = blocks
    .filter((block): block is Extract<DescriptionBlock, { kind: "header" }> => block.kind === "header")
    .map((block) => normalizeHeadingKey(block.text));
  const contentParagraphs = blocks.filter(
    (block): block is Extract<DescriptionBlock, { kind: "paragraph" }> => block.kind === "paragraph"
  );
  const listBlocks = blocks.filter(
    (block): block is Extract<DescriptionBlock, { kind: "list" }> => block.kind === "list"
  );

  const totalParagraphLength = contentParagraphs.reduce(
    (sum, block) => sum + block.text.trim().length,
    0
  );
  const totalListItemCount = listBlocks.reduce((sum, block) => sum + block.items.length, 0);
  const hasContentHeading = headers.some((header) => !METADATA_HEADING_KEYS.has(header));
  const onlyMetadataHeadings = headers.length > 0 && headers.every((header) => METADATA_HEADING_KEYS.has(header));
  const hasLongParagraph = contentParagraphs.some((block) => block.text.trim().length >= 120);
  const hasSubstantialList = listBlocks.some(
    (block) =>
      block.items.length >= 2 &&
      block.items.join(" ").trim().length >= 80
  );

  if (hasSubstantialList || hasLongParagraph) {
    return true;
  }

  if (hasContentHeading && (totalParagraphLength >= 160 || totalListItemCount >= 3)) {
    return true;
  }

  if (onlyMetadataHeadings && totalParagraphLength < 160 && totalListItemCount < 3) {
    return false;
  }

  return totalParagraphLength >= 220 || totalListItemCount >= 4;
}

export function getJobDescriptionPreviewBlocks(raw: string, maxBlocks = 3) {
  if (!raw.trim()) {
    return [];
  }

  const blocks = parseJobDescriptionBlocks(raw).filter((block) => {
    if (block.kind !== "paragraph") return true;
    return block.text.length > 20;
  });

  if (blocks.length === 0) {
    return [];
  }

  const preview: DescriptionBlock[] = [];
  for (const block of blocks) {
    if (block.kind === "list") {
      preview.push({
        kind: "list",
        items: block.items.slice(0, Math.min(2, Math.max(1, 4 - preview.length))),
      });
    } else {
      preview.push(block);
    }

    if (preview.length >= maxBlocks) {
      break;
    }
  }

  return preview;
}

function getDescriptionNoisePenalty(text: string) {
  const lower = text.toLowerCase();
  const signals = [
    "skip to main content",
    "open search bar",
    "saved",
    "apply now",
    "similar jobs",
    "join our talent community",
    "manage preferences",
    "accept all",
    "search",
    "locations",
  ];

  return signals.reduce(
    (penalty, signal) => penalty + (lower.includes(signal) ? 140 : 0),
    0
  );
}

function scoreDescriptionQuality(text: string) {
  const blocks = parseJobDescriptionBlocks(text);
  const headers = blocks.filter((block) => block.kind === "header").length;
  const lists = blocks.filter((block) => block.kind === "list").length;
  const paragraphs = blocks.filter((block) => block.kind === "paragraph").length;
  const wrongPagePenalty = looksLikeWrongPageDescription(text) ? 2_000 : 0;
  const pollutionPenalty = hasDescriptionPollution(text) ? 700 : 0;

  return (
    headers * 45 +
    lists * 30 +
    paragraphs * 8 +
    Math.min(text.length, 2400) / 12 -
    getDescriptionNoisePenalty(text) -
    wrongPagePenalty -
    pollutionPenalty
  );
}

export function pickBestFormattedJobDescription(candidates: Array<string | null | undefined>) {
  const usable = Array.from(
    new Set(
      candidates
        .map((candidate) => candidate?.trim() ?? "")
        .filter(Boolean)
    )
  ).filter((candidate) => !isLowQualityJobDescription(candidate));

  if (usable.length === 0) {
    return null;
  }

  usable.sort((left, right) => scoreDescriptionQuality(right) - scoreDescriptionQuality(left));
  return usable[0] ?? null;
}

function isCandidateDescriptionUrl(value: string | null | undefined): value is string {
  if (!value) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function scoreDescriptionCandidateUrl(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const query = parsed.search.toLowerCase();
    const value = `${parsed.hostname}${path}${query}`.toLowerCase();
    let score = 0;

    if (/(?:^|\/)(job|jobs|position|positions|opening|openings|vacancy|vacancies)(?:\/|$)/.test(path)) {
      score += 50;
    }
    if (/(gh_jid|jobid|job_id|reqid|requisition|opening|position|vacancy)/.test(query)) {
      score += 35;
    }
    if (/apply|viewjob|jobdetails|job-detail|job\/|jobs\//.test(value)) {
      score += 25;
    }

    if (/(?:^|\/)(blog|blogs|article|articles|news|press|insights|faq|faqs)(?:\/|$)/.test(path)) {
      score -= 90;
    }
    if (/redirect|land=|utm_|gclid=|fbclid=|sendbeacon/.test(value)) {
      score -= 80;
    }
    if (/adzuna\./.test(parsed.hostname)) {
      score -= 40;
    }

    return score;
  } catch {
    return 0;
  }
}

export function getJobDescriptionCandidateUrls(links: DescriptionSourceLinks) {
  const primarySourceUrls =
    links.sourceMappings
      ?.filter((mapping) => mapping.isPrimary)
      .map((mapping) => mapping.sourceUrl)
      .filter(isCandidateDescriptionUrl) ?? [];
  const secondarySourceUrls =
    links.sourceMappings
      ?.filter((mapping) => !mapping.isPrimary)
      .map((mapping) => mapping.sourceUrl)
      .filter(isCandidateDescriptionUrl) ?? [];

  return Array.from(
    new Map(
      [
        links.sourcePostingLink?.href,
        links.primaryExternalLink?.href,
        ...primarySourceUrls,
        links.applyUrl,
        ...secondarySourceUrls,
      ]
        .filter(isCandidateDescriptionUrl)
        .map((url, index) => ({ url: url.trim(), index }))
        .sort((left, right) => {
          const scoreDelta =
            scoreDescriptionCandidateUrl(right.url) - scoreDescriptionCandidateUrl(left.url);
          if (scoreDelta !== 0) {
            return scoreDelta;
          }

          return left.index - right.index;
        })
        .map((candidate) => [candidate.url, candidate.url])
    ).values()
  );
}

export function isRenderableJobDescription(raw: string | null | undefined) {
  if (!raw?.trim()) {
    return false;
  }

  const cleaned = cleanupJobDescription(raw);
  if (!cleaned) {
    return false;
  }

  const blocks = parseJobDescriptionBlocks(cleaned);
  if (blocks.length === 0) {
    return false;
  }

  const structuredBlockCount = blocks.filter((block) => block.kind !== "paragraph").length;
  const paragraphLength = blocks.reduce(
    (sum, block) => sum + (block.kind === "paragraph" ? block.text.trim().length : 0),
    0
  );

  return structuredBlockCount > 0 || paragraphLength >= 140;
}

export function isLowQualityJobDescription(raw: string | null | undefined) {
  if (!raw?.trim()) return true;

  const cleaned = cleanupJobDescription(raw);
  if (!cleaned) return true;
  if (looksLikeIncompleteDescriptionSnippet(cleaned)) {
    return true;
  }
  if (looksLikeWrongPageDescription(cleaned, raw)) {
    return true;
  }
  if (hasDescriptionPollution(cleaned)) {
    return true;
  }

  const blocks = parseJobDescriptionBlocks(cleaned);
  const hasHeader = blocks.some((block) => block.kind === "header");
  const hasList = blocks.some((block) => block.kind === "list");
  const paragraphCount = blocks.filter((block) => block.kind === "paragraph").length;

  // A trailing ellipsis is a truncation tell. A genuinely complete posting still
  // has structure (headings/bullets) when it ends with "…"; an unstructured blob
  // ending in "…" is a cut-off teaser regardless of length.
  if (/(?:…|\.\.\.)\s*$/.test(cleaned) && !hasHeader && !hasList) {
    return true;
  }

  if ((hasHeader || hasList) && cleaned.length >= 180) {
    return false;
  }

  if (cleaned.length < 260) {
    return true;
  }

  // A complete posting delivered as one flowing prose paragraph (no bullets, no
  // recognized section headings) parses to a single paragraph block. Accept it
  // only when it is clearly substantial AND reads like a job posting — length
  // and sentence count alone would also admit long marketing/About prose. This
  // preserves the "exact original posting, just reorganized" case the user wants
  // while rejecting non-job single-paragraph blobs.
  if (paragraphCount <= 1) {
    const sentenceCount = (cleaned.match(/[.!?](?=\s|$)/g) ?? []).length;
    return !(
      cleaned.length >= 600 &&
      sentenceCount >= 4 &&
      JOB_CONTENT_SIGNAL_RE.test(cleaned)
    );
  }

  return false;
}

const JOB_FETCH_TIMEOUT_MS = 15_000;
const JOB_FETCH_MAX_BYTES = 5_000_000;

// Realistic desktop browser User-Agents. The old "ApplicationTracker/1.0" UA is
// a bot-tell that WAFs (Cloudflare/Akamai on Workday/iCIMS/Greenhouse) block. We
// try Chrome first, then Firefox — a different UA frequently flips a 403 or a
// JS-shell response into a real 200.
const JOB_FETCH_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

// Response content types we cannot parse as an HTML/JSON job posting. (Plain
// application/json is intentionally allowed — some ATS endpoints return the
// posting as JSON and extractEmbeddedDescription can still read it.)
const NON_HTML_CONTENT_TYPE =
  /^(?:image|audio|video)\/|application\/(?:pdf|zip|octet-stream)/i;

// Human-readable copy a genuinely empty JS shell shows when scripting is off. We
// only treat a page as a dead shell when it says one of these AND we extracted
// almost nothing — ambient framework markers (__NEXT_DATA__, application/json,
// noscript) are deliberately NOT used, because they coexist with a complete
// JSON-LD posting on pages we can extract from.
const JS_SHELL_SIGNALS = [
  "you need to enable javascript",
  "please enable javascript",
  "requires javascript",
  "enable javascript to run",
];

function buildJobFetchHeaders(userAgent: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
  };
  if (userAgent.includes("Chrome")) {
    headers["sec-ch-ua"] =
      '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"';
    headers["sec-ch-ua-mobile"] = "?0";
    headers["sec-ch-ua-platform"] = '"Windows"';
  }
  return headers;
}

// Stream the body with a hard byte cap so a huge SPA bundle cannot exhaust
// memory; JSON-LD/description content lives in the first tens of KB.
async function readResponseTextCapped(
  response: Response,
  maxBytes: number
): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        text += decoder.decode(value, { stream: true });
      }
      if (received >= maxBytes) break;
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/**
 * Choose the best raw source string to feed the formatter from a fetched HTML
 * page. Prefers the JSON-LD JobPosting.description (the authoritative full
 * posting, present in the initial HTML even on JS-rendered ATS pages), then the
 * balanced-container extraction, then the raw body. Guards the rare case where
 * the JSON-LD is only a short teaser but the rendered DOM body is substantially
 * fuller. Exported for unit testing without network I/O.
 */
export function selectDescriptionSource(html: string): string {
  const embedded = extractEmbeddedDescription(html);
  if (!embedded) {
    const container = extractDescriptionFromHtml(html);
    return container.length >= 120 ? container : html;
  }

  // Passing raw html lets cleanupJobDescription re-extract the same JSON-LD (the
  // code path the existing tests exercise). Only fall back to a fuller DOM body
  // when the JSON-LD formats to a short teaser.
  const embeddedText = formatJobDescriptionText(html);
  if (embeddedText.length >= 600) {
    return html;
  }
  const container = extractDescriptionFromHtml(html);
  if (container.length >= 120) {
    const containerText = formatJobDescriptionText(container);
    if (
      containerText.length > embeddedText.length * 1.5 &&
      !isLowQualityJobDescription(containerText) &&
      !looksLikeWrongPageDescription(containerText)
    ) {
      return container;
    }
  }
  return html;
}

export async function fetchFormattedJobDescriptionFromUrl(
  url: string,
  deps: FetchGuardDeps = {}
): Promise<string | null> {
  for (const userAgent of JOB_FETCH_USER_AGENTS) {
    let html: string;
    try {
      const response = await fetchGuarded(
        url,
        {
          headers: buildJobFetchHeaders(userAgent),
          signal: AbortSignal.timeout(JOB_FETCH_TIMEOUT_MS),
          cache: "no-store",
        },
        deps
      );

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // A bot wall (403/429/503) often flips with a different UA — retry.
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (NON_HTML_CONTENT_TYPE.test(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        return null; // binary target; a different UA will not help.
      }

      html = await readResponseTextCapped(response, JOB_FETCH_MAX_BYTES);
    } catch {
      // Network error / timeout / SSRF block — try the next UA, then give up.
      continue;
    }

    if (!html) continue;

    const embedded = extractEmbeddedDescription(html);
    const pageText = formatJobDescriptionText(selectDescriptionSource(html));

    // Only treat the page as an empty JS shell when it literally asks the human
    // to enable JavaScript AND we could not extract a structured description.
    const looksLikeDeadJsShell =
      !embedded &&
      pageText.length < 300 &&
      JS_SHELL_SIGNALS.some((signal) => html.toLowerCase().includes(signal));

    if (
      looksLikeDeadJsShell ||
      looksLikeWrongPageDescription(pageText, html) ||
      isLowQualityJobDescription(pageText)
    ) {
      continue; // try the fallback UA before giving up
    }

    return pageText;
  }

  return null;
}

export async function fetchBestFormattedJobDescriptionFromUrls(
  urls: string[],
  maxFetches = 3
) {
  const candidateUrls = Array.from(new Set(urls.filter(isCandidateDescriptionUrl))).slice(
    0,
    Math.max(1, maxFetches)
  );

  if (candidateUrls.length === 0) {
    return null;
  }

  const fetchedDescriptions = await Promise.all(
    candidateUrls.map((url) => fetchFormattedJobDescriptionFromUrl(url))
  );

  return pickBestFormattedJobDescription(fetchedDescriptions);
}
