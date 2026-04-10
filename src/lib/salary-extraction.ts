import type { Region } from "@/generated/prisma/client";

export type ResolvedSalaryRange = {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
};

type ExtractedSalaryRange = {
  min: number | null;
  max: number | null;
  currency: string | null;
};

const SALARY_KEYWORD_RE =
  /\b(salary|compensation|pay(?:\s+range|\s+details|\s+rate)?|base pay|base salary|hourly rate|hourly wage|rate of pay|annual salary|annualized|ote|on-target earnings?)\b/i;
const MONEY_HINT_RE =
  /(?:[$€£]|(?:USD|CAD|EUR|GBP|AUD|NZD|US\$|CA\$|C\$)\b)/i;
const RANGE_HINT_RE =
  /(?:[$€£]|\b(?:USD|CAD|EUR|GBP|AUD|NZD|US\$|CA\$|C\$)\b)?\s*\d[\d,]*(?:\.\d+)?\s*[kKmM]?\s*(?:-|–|—|to)\s*(?:[$€£]|\b(?:USD|CAD|EUR|GBP|AUD|NZD|US\$|CA\$|C\$)\b)?\s*\d[\d,]*(?:\.\d+)?\s*[kKmM]?/i;
const BAD_CONTEXT_RE =
  /\b(assets under management|aum|market cap|valuation|funding|runway|revenue|arr|users|ideas saved|billion in assets|million users)\b/i;
const PERIOD_HINTS = [
  { pattern: /\b(per\s+hour|\/\s*hour|hourly|per\s+hr|\/\s*hr)\b/i, multiplier: 2080 },
  { pattern: /\b(per\s+day|\/\s*day|daily)\b/i, multiplier: 260 },
  { pattern: /\b(per\s+week|\/\s*week|weekly)\b/i, multiplier: 52 },
  { pattern: /\b(per\s+month|\/\s*month|monthly)\b/i, multiplier: 12 },
  { pattern: /\b(per\s+year|\/\s*year|annually|annual|yearly|base salary range)\b/i, multiplier: 1 },
];

export function resolveJobSalaryRange(input: {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  description?: string | null;
  regionHint?: Region | null;
}): ResolvedSalaryRange {
  const { salaryMin, salaryMax, salaryCurrency, description, regionHint } = input;

  if (salaryMin != null || salaryMax != null) {
    return {
      salaryMin,
      salaryMax,
      salaryCurrency: salaryCurrency ?? inferDefaultCurrency(regionHint),
    };
  }

  const extracted = extractSalaryRangeFromText(description, {
    currencyHint: salaryCurrency,
    regionHint,
  });

  return {
    salaryMin: extracted?.min ?? null,
    salaryMax: extracted?.max ?? null,
    salaryCurrency: extracted?.currency ?? salaryCurrency ?? inferDefaultCurrency(regionHint),
  };
}

function extractSalaryRangeFromText(
  raw: string | null | undefined,
  options: {
    currencyHint?: string | null;
    regionHint?: Region | null;
  } = {}
) {
  if (!raw?.trim()) {
    return null;
  }

  const candidates = collectCandidateSnippets(raw);
  let best: { score: number; result: ExtractedSalaryRange } | null = null;

  for (const candidate of candidates) {
    const parsed = parseCandidateSalary(candidate, options);
    if (!parsed) continue;

    if (!best || parsed.score > best.score) {
      best = parsed;
    }
  }

  return best?.result ?? null;
}

function collectCandidateSnippets(raw: string) {
  const normalized = decodeEntities(raw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|li|ul|ol|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const lines = normalized
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const snippets = new Set<string>();
  const push = (value: string | null | undefined) => {
    const normalizedValue = value?.replace(/\s+/g, " ").trim();
    if (normalizedValue && normalizedValue.length >= 6) {
      snippets.add(normalizedValue);
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1] ?? "";
    const nextTwo = lines[index + 2] ?? "";
    const combined = [line, next, nextTwo].filter(Boolean).join(" ");

    if (SALARY_KEYWORD_RE.test(line) || RANGE_HINT_RE.test(line)) {
      push(combined);
      continue;
    }

    if (
      /^(salary|compensation|pay details|pay range|base salary|rate of pay)\s*:?\s*$/i.test(line) &&
      next
    ) {
      push(`${line} ${next}`);
    }
  }

  for (const paragraph of normalized.split(/\n\s*\n/)) {
    const compact = paragraph.replace(/\s+/g, " ").trim();
    if (!compact) continue;
    if (SALARY_KEYWORD_RE.test(compact) || RANGE_HINT_RE.test(compact)) {
      push(compact);
    }
  }

  return [...snippets];
}

function parseCandidateSalary(
  snippet: string,
  options: { currencyHint?: string | null; regionHint?: Region | null }
) {
  if (!snippet.trim() || BAD_CONTEXT_RE.test(snippet)) {
    return null;
  }

  const amounts = [...snippet.matchAll(/(?:[$€£]|(?:USD|CAD|EUR|GBP|AUD|NZD|US\$|CA\$|C\$)\s*)?\s*(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?/g)]
    .map((match) => parseAmountToken(match[1] ?? "", match[2] ?? ""))
    .filter((value): value is number => value !== null);

  if (amounts.length === 0) {
    return null;
  }

  const hasSalaryKeyword = SALARY_KEYWORD_RE.test(snippet);
  const hasMoneyHint = MONEY_HINT_RE.test(snippet);
  const hasRangeHint = RANGE_HINT_RE.test(snippet);

  if (!hasSalaryKeyword && !hasRangeHint) {
    return null;
  }

  if (!hasMoneyHint && amounts.every((value) => value < 1000)) {
    return null;
  }

  const multiplier = detectPeriodMultiplier(snippet);
  const converted = amounts.map((value) => Math.round(value * multiplier));
  const plausible = converted.filter((value) => value >= 10_000 && value <= 5_000_000);

  if (plausible.length === 0) {
    return null;
  }

  const min = plausible[0] ?? null;
  const max = plausible[1] ?? plausible[0] ?? null;

  if (!min || !max || max < min) {
    return null;
  }

  const currency =
    inferCurrencyFromText(snippet) ??
    normalizeCurrencyCode(options.currencyHint) ??
    inferDefaultCurrency(options.regionHint);

  let score = 0;
  if (hasSalaryKeyword) score += 4;
  if (hasRangeHint) score += 3;
  if (hasMoneyHint) score += 2;
  if (multiplier !== 1) score += 1;
  if (/\b(CAD|USD|EUR|GBP|AUD|NZD|US\$|CA\$|C\$)\b/i.test(snippet)) score += 1;

  return {
    score,
    result: {
      min,
      max,
      currency,
    },
  };
}

function parseAmountToken(rawValue: string, rawSuffix: string) {
  const value = Number(rawValue.replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  if (/m/i.test(rawSuffix)) {
    return value * 1_000_000;
  }

  if (/k/i.test(rawSuffix)) {
    return value * 1_000;
  }

  return value;
}

function detectPeriodMultiplier(snippet: string) {
  for (const period of PERIOD_HINTS) {
    if (period.pattern.test(snippet)) {
      return period.multiplier;
    }
  }

  return 1;
}

function inferCurrencyFromText(text: string) {
  if (/\bCAD\b|CA\$|C\$/i.test(text)) return "CAD";
  if (/\bUSD\b|US\$/i.test(text)) return "USD";
  if (/\bEUR\b|€/i.test(text)) return "EUR";
  if (/\bGBP\b|£/i.test(text)) return "GBP";
  if (/\bAUD\b/i.test(text)) return "AUD";
  if (/\bNZD\b/i.test(text)) return "NZD";
  if (/\$/i.test(text)) return null;
  return null;
}

function normalizeCurrencyCode(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return normalized || null;
}

function inferDefaultCurrency(region: Region | null | undefined) {
  if (region === "CA") return "CAD";
  if (region === "US") return "USD";
  return "USD";
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x2013;|&#8211;/gi, "–")
    .replace(/&#x2014;|&#8212;/gi, "—")
    .replace(/&#x24;|&#36;/gi, "$");
}
