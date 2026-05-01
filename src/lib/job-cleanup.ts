import {
  decodeHtmlEntitiesFull,
  trimDescriptionPollution,
} from "@/lib/ingestion/html-description";

const TITLE_ROLE_HINT_RE =
  /\b(engineer|developer|manager|analyst|scientist|designer|architect|consultant|specialist|coordinator|director|lead|intern|administrator|technician|officer|developer relations|researcher)\b/i;

const TITLE_BAD_MARKER_RE =
  /\b(work at|careers?\b|career page|find real[- ]time|parking|join (?:our )?team|we make work|intelligent parking|close search|skip to main content|about us|our current job openings|what do we offer)\b/i;

const COMPANY_BAD_MARKER_RE =
  /\b(jobs?|careers?|career page|work at|hiring|logo|intelligent parking|using ai|find real[- ]time|close search|skip to main content)\b/i;

const COMMON_SECOND_LEVEL_TLDS = new Set([
  "co",
  "com",
  "org",
  "net",
  "gov",
  "ac",
]);

const CHROME_LINE_PATTERNS = [
  /^skip to main content$/i,
  /^close search$/i,
  /^open search$/i,
  /^close menu$/i,
  /^main navigation$/i,
  /^careers blog$/i,
  /^in-page topics$/i,
  /^(facebook|instagram|twitter|linkedin|youtube|vimeo)$/i,
  /^•\s*(facebook|instagram|twitter|linkedin|youtube|vimeo)$/i,
  /^(login|sign up)$/i,
  /^learn more$/i,
  /^apply for the job$/i,
  /^location$/i,
] satisfies RegExp[];

const FOOTER_START_PATTERNS = [
  /^©\s*20\d{2}\b/i,
  /^body::?-webkit-scrollbar/i,
  /^off-street parking solutions$/i,
  /^turn-by-turn parking navigation$/i,
  /^parking analytics and other services$/i,
  /^resources$/i,
  /^industries$/i,
  /^company$/i,
  /^pricing$/i,
  /^contact us$/i,
  /^investors$/i,
] satisfies RegExp[];

export function sanitizeJobTitle(value: unknown) {
  const normalized = compactWhitespace(decodeHtmlEntitiesFull(asText(value)).replace(/[®™]/g, ""));
  if (!normalized) return "";

  const candidates = new Set<string>([normalized]);
  const lookingForMatch = normalized.match(
    /\bwe (?:are|'re)\s+looking for (?:an?\s+)?(.+?)(?:\s*(?:[-–—|]|$))/i
  );
  if (lookingForMatch?.[1]) {
    candidates.add(compactWhitespace(lookingForMatch[1]));
  }

  for (const segment of normalized
    .split(/\s+[|–—-]\s+/)
    .map((part) => compactWhitespace(part))
    .filter(Boolean)) {
    candidates.add(segment);
  }

  let best = normalized;
  let bestScore = scoreTitleCandidate(normalized);

  for (const candidate of candidates) {
    const score = scoreTitleCandidate(candidate);
    if (score > bestScore || (score === bestScore && candidate.length < best.length)) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

export function sanitizeCompanyName(
  value: unknown,
  options?: { urls?: Array<string | null | undefined> }
) {
  const normalized = compactWhitespace(
    decodeHtmlEntitiesFull(asText(value)).replace(/[®™]/g, "")
  );
  const hostCandidate = deriveCompanyNameFromUrls(options?.urls ?? []);
  if (!normalized) {
    return hostCandidate ?? "";
  }

  const candidates = new Set<string>([normalized]);
  for (const segment of normalized
    .split(/\s+[|–—-]\s+/)
    .map((part) => compactWhitespace(part))
    .filter(Boolean)) {
    candidates.add(segment);
  }
  if (hostCandidate) {
    candidates.add(hostCandidate);
  }

  let best = normalized;
  let bestScore = scoreCompanyCandidate(normalized, hostCandidate);

  for (const candidate of candidates) {
    const score = scoreCompanyCandidate(candidate, hostCandidate);
    if (score > bestScore || (score === bestScore && candidate.length < best.length)) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

export function sanitizeJobDescriptionText(
  value: unknown,
  context?: { title?: string | null; location?: string | null }
) {
  const raw = asText(value);
  const withoutNoiseElements = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");

  const decoded = decodeHtmlEntitiesFull(withoutNoiseElements);
  const withBreaks = decoded
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/?(p|div|section|article|h[1-6]|li|ul|ol|blockquote|tr|td)[^>]*>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  const joined = stripped
    .split(/\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const dePolluted = trimDescriptionPollution(joined);

  const title = compactWhitespace(context?.title ?? "");
  const location = compactWhitespace(context?.location ?? "");
  const lines = dePolluted.split(/\n+/).map((line) => compactWhitespace(line)).filter(Boolean);
  const kept: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;

    if (index < 4 && title && normalizeComparable(line) === normalizeComparable(title)) {
      continue;
    }

    if (index < 4 && /^location:\s*/i.test(line)) {
      const normalizedLocationLine = normalizeComparable(line.replace(/^location:\s*/i, ""));
      if (!location || normalizedLocationLine === normalizeComparable(location)) {
        continue;
      }
    }

    if (CHROME_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      continue;
    }

    if (
      FOOTER_START_PATTERNS.some((pattern) => pattern.test(line)) &&
      kept.join("\n").length >= 300
    ) {
      break;
    }

    kept.push(line);
  }

  return kept.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function scoreTitleCandidate(candidate: string) {
  let score = 0;
  if (candidate.length >= 4 && candidate.length <= 100) score += 2;
  if (TITLE_ROLE_HINT_RE.test(candidate)) score += 6;
  if (candidate.split(/\s+/).length <= 10) score += 1;
  if (TITLE_BAD_MARKER_RE.test(candidate)) score -= 8;
  if (/\?$/.test(candidate)) score -= 4;
  if (/^[a-z]/.test(candidate)) score -= 1;
  return score;
}

function scoreCompanyCandidate(candidate: string, hostCandidate: string | null) {
  let score = 0;
  if (candidate.length >= 2 && candidate.length <= 80) score += 2;
  if (candidate.split(/\s+/).length <= 4) score += 2;
  if (COMPANY_BAD_MARKER_RE.test(candidate)) score -= 8;
  if (/\?$/.test(candidate)) score -= 4;

  if (hostCandidate) {
    const normalizedCandidate = normalizeComparable(candidate);
    const normalizedHost = normalizeComparable(hostCandidate);
    if (
      normalizedCandidate === normalizedHost ||
      normalizedCandidate.includes(normalizedHost) ||
      normalizedHost.includes(normalizedCandidate)
    ) {
      score += 4;
    } else {
      score -= 3;
    }
  }

  return score;
}

function deriveCompanyNameFromUrls(urls: Array<string | null | undefined>) {
  for (const value of urls) {
    if (!value) continue;
    try {
      const hostname = new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
      const labels = hostname.split(".").filter(Boolean);
      if (labels.length === 0) continue;

      let rootLabel = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
      const tld = labels[labels.length - 1] ?? "";
      if (
        labels.length >= 3 &&
        tld.length === 2 &&
        COMMON_SECOND_LEVEL_TLDS.has(labels[labels.length - 2] ?? "")
      ) {
        rootLabel = labels[labels.length - 3] ?? rootLabel;
      }

      if (!rootLabel || /^(jobs?|careers?|app|apply|business)$/.test(rootLabel)) continue;
      if (rootLabel.length <= 4) return rootLabel.toUpperCase();
      return rootLabel.charAt(0).toUpperCase() + rootLabel.slice(1);
    } catch {
      continue;
    }
  }

  return null;
}

function normalizeComparable(value: string) {
  return value.toLowerCase().replace(/[®™]/g, "").replace(/\s+/g, " ").trim();
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function asText(value: unknown) {
  return typeof value === "string" ? value : "";
}
