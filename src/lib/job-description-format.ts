import {
  decodeHtmlEntitiesFull,
  extractDescriptionFromHtml,
  hasDescriptionPollution,
} from "@/lib/ingestion/html-description";

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

const WRONG_PAGE_HTML_SIGNALS = [
  "navigator.sendBeacon",
  "googletagmanager.com/gtm.js",
  "setTimeout(redirect",
  "window.__NEXT_DATA__",
  "window.__INITIAL_STATE__",
];

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

function decodeEmbeddedJsonString(value: string) {
  try {
    return JSON.parse(`"${value.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`) as string;
  } catch {
    return value;
  }
}

function extractEmbeddedDescription(raw: string) {
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
  let cleaned = (looksLikeStructuredDescription(raw) ? raw : extractPrimaryDescription(raw))
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

  cleaned = decodeHtmlEntitiesFull(cleaned);

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

export function getJobDescriptionSummaryBlocks(raw: string, maxSections = 6) {
  const blocks = parseJobDescriptionBlocks(raw);
  if (blocks.length === 0) {
    return [];
  }

  const sections = buildDescriptionSections(blocks);
  const summary: DescriptionBlock[] = [];

  for (const [sectionIndex, section] of sections.entries()) {
    if (summary.length >= maxSections * 2) {
      break;
    }

    const normalizedHeader = section.header ? normalizeHeadingKey(section.header) : "";
    const listBlock = section.blocks.find((block) => block.kind === "list");
    const paragraphBlocks = section.blocks.filter(
      (block): block is Extract<DescriptionBlock, { kind: "paragraph" }> => block.kind === "paragraph"
    );
    const filteredParagraphBlocks = paragraphBlocks.filter(
      (block) => !isDescriptionNoiseText(block.text)
    );
    const filteredListItems =
      listBlock?.items.filter((item) => !isDescriptionNoiseText(item)) ?? [];

    if (
      !section.header &&
      filteredParagraphBlocks.length === 0 &&
      filteredListItems.length === 0
    ) {
      continue;
    }

    if (
      !section.header &&
      sectionIndex === 0 &&
      filteredParagraphBlocks.length === 1 &&
      filteredListItems.length === 0 &&
      sections.slice(1).some((candidate) => candidate.header) &&
      filteredParagraphBlocks[0].text.length <= 80 &&
      !/[.!?]$/.test(filteredParagraphBlocks[0].text)
    ) {
      continue;
    }

    if (section.header) {
      summary.push({ kind: "header", text: section.header });
    }

    if (filteredListItems.length > 0) {
      summary.push({
        kind: "list",
        items: filteredListItems.slice(
          0,
          normalizedHeader === "about the job" || normalizedHeader === "about the role" ? 3 : 4
        ),
      });
      continue;
    }

    if (filteredParagraphBlocks.length === 0) {
      continue;
    }

    if (
      normalizedHeader === "about the job" ||
      normalizedHeader === "job summary" ||
      normalizedHeader === "about the role" ||
      normalizedHeader === ""
    ) {
      for (const paragraph of filteredParagraphBlocks.slice(0, 2)) {
        summary.push({
          kind: "paragraph",
          text: trimSummaryText(paragraph.text, 260),
        });
      }
      continue;
    }

    summary.push({
      kind: "paragraph",
      text: trimSummaryText(filteredParagraphBlocks[0].text, 220),
    });
  }

  return summary;
}

export function isJobDescriptionSummaryUsable(raw: string | null | undefined) {
  if (!raw?.trim()) {
    return false;
  }

  const blocks = getJobDescriptionSummaryBlocks(raw, 8);
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
  if (looksLikeWrongPageDescription(cleaned, raw)) {
    return true;
  }
  if (hasDescriptionPollution(cleaned)) {
    return true;
  }

  if (/(?:…|\.\.\.)\s*$/.test(cleaned)) {
    return true;
  }

  const blocks = parseJobDescriptionBlocks(cleaned);
  const hasHeader = blocks.some((block) => block.kind === "header");
  const hasList = blocks.some((block) => block.kind === "list");
  const paragraphCount = blocks.filter((block) => block.kind === "paragraph").length;

  if ((hasHeader || hasList) && cleaned.length >= 180) {
    return false;
  }

  if (cleaned.length < 260) {
    return true;
  }

  return paragraphCount <= 1;
}

export async function fetchFormattedJobDescriptionFromUrl(url: string) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ApplicationTracker/1.0)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const extracted = extractDescriptionFromHtml(html);
    const pageText = formatJobDescriptionText(
      extracted && extracted.length >= 120 ? extracted : html
    );
    const jsPageSignals = [
      "requires javascript",
      "enable javascript",
      "noscript",
      "__next_data__",
      "window.__remixcontext",
      "application/json",
    ];

    const looksLikeJsPage =
      jsPageSignals.some((signal) => html.toLowerCase().includes(signal)) &&
      pageText.length < 500;

    if (
      looksLikeJsPage ||
      looksLikeWrongPageDescription(pageText, html) ||
      isLowQualityJobDescription(pageText)
    ) {
      return null;
    }

    return pageText;
  } catch {
    return null;
  }
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
