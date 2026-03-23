import axios from "axios";
import { ATSType } from "@/generated/prisma";
import { rateLimiter } from "./rate-limiter";

const USER_AGENT = "AutoApplicationBot/1.0";
const REQUEST_TIMEOUT = 10_000;

export interface ATSDetectionResult {
  atsType: ATSType | null;
  confidence: number;
  boardToken?: string;
  evidence: string[];
}

interface HostnamePattern {
  test: (hostname: string, pathname: string) => boolean;
  atsType: ATSType;
  extractToken?: (hostname: string, pathname: string) => string | undefined;
}

const HOSTNAME_PATTERNS: HostnamePattern[] = [
  {
    test: (h) =>
      h === "boards.greenhouse.io" || h === "job-boards.greenhouse.io",
    atsType: ATSType.GREENHOUSE,
    extractToken: (_h, p) => {
      const segments = p.split("/").filter(Boolean);
      return segments[0] || undefined;
    },
  },
  {
    test: (h) => h === "jobs.lever.co",
    atsType: ATSType.LEVER,
    extractToken: (_h, p) => {
      const segments = p.split("/").filter(Boolean);
      return segments[0] || undefined;
    },
  },
  {
    test: (h) => h === "jobs.ashbyhq.com",
    atsType: ATSType.ASHBY,
    extractToken: (_h, p) => {
      const segments = p.split("/").filter(Boolean);
      return segments[0] || undefined;
    },
  },
  {
    test: (h) => h === "jobs.smartrecruiters.com",
    atsType: ATSType.SMARTRECRUITERS,
    extractToken: (_h, p) => {
      const segments = p.split("/").filter(Boolean);
      return segments[0] || undefined;
    },
  },
  {
    test: (h, p) =>
      (h.endsWith(".workable.com") && p.includes("/j/")) ||
      h === "apply.workable.com",
    atsType: ATSType.WORKABLE,
    extractToken: (h) => {
      const parts = h.split(".");
      return parts[0] !== "apply" ? parts[0] : undefined;
    },
  },
  {
    test: (h) =>
      h.endsWith(".myworkdayjobs.com"),
    atsType: ATSType.WORKDAY,
    extractToken: (h) => {
      const parts = h.split(".");
      return parts[0] || undefined;
    },
  },
  {
    test: (h) =>
      h === "career.teamtailor.com" || h.endsWith(".teamtailor.com"),
    atsType: ATSType.TEAMTAILOR,
    extractToken: (h) => {
      const parts = h.split(".");
      return parts[0] !== "career" ? parts[0] : undefined;
    },
  },
  {
    test: (h) => h.endsWith(".recruitee.com"),
    atsType: ATSType.RECRUITEE,
    extractToken: (h) => {
      const parts = h.split(".");
      return parts[0] || undefined;
    },
  },
];

interface HTMLPattern {
  atsType: ATSType;
  patterns: RegExp[];
  tokenExtractor?: (html: string) => string | undefined;
}

const HTML_PATTERNS: HTMLPattern[] = [
  {
    atsType: ATSType.GREENHOUSE,
    patterns: [
      /greenhouse\.io/i,
      /boards\.greenhouse\.io/i,
      /grnh\.se/i,
    ],
    tokenExtractor: (html) => {
      const match = html.match(/boards\.greenhouse\.io\/([a-zA-Z0-9_-]+)/);
      return match?.[1];
    },
  },
  {
    atsType: ATSType.LEVER,
    patterns: [
      /lever\.co/i,
      /jobs\.lever\.co/i,
    ],
    tokenExtractor: (html) => {
      const match = html.match(/jobs\.lever\.co\/([a-zA-Z0-9_-]+)/);
      return match?.[1];
    },
  },
  {
    atsType: ATSType.ASHBY,
    patterns: [
      /ashbyhq\.com/i,
      /jobs\.ashbyhq\.com/i,
    ],
    tokenExtractor: (html) => {
      const match = html.match(/jobs\.ashbyhq\.com\/([a-zA-Z0-9_-]+)/);
      return match?.[1];
    },
  },
  {
    atsType: ATSType.SMARTRECRUITERS,
    patterns: [
      /smartrecruiters\.com/i,
      /jobs\.smartrecruiters\.com/i,
    ],
    tokenExtractor: (html) => {
      const match = html.match(/jobs\.smartrecruiters\.com\/([a-zA-Z0-9_-]+)/);
      return match?.[1];
    },
  },
  {
    atsType: ATSType.WORKABLE,
    patterns: [
      /workable\.com/i,
      /apply\.workable\.com/i,
      /whr-[a-zA-Z0-9]/i,
      /workable-widget/i,
      /workable\.com\/api\/v[0-9]/i,
    ],
    tokenExtractor: (html) => {
      const match =
        html.match(/apply\.workable\.com\/([a-zA-Z0-9_-]+)/) ||
        html.match(/([a-zA-Z0-9_-]+)\.workable\.com/);
      return match?.[1];
    },
  },
  {
    atsType: ATSType.WORKDAY,
    patterns: [
      /myworkdayjobs\.com/i,
      /\.wd\d+\.myworkdayjobs\.com/i,
      /workday\.com\/[a-zA-Z0-9_-]+\/d\/jobs/i,
      /workdaycdn\.com/i,
    ],
    tokenExtractor: (html) => {
      const match = html.match(
        /([a-zA-Z0-9_-]+)\.wd\d+\.myworkdayjobs\.com/,
      );
      return match?.[1];
    },
  },
  {
    atsType: ATSType.TEAMTAILOR,
    patterns: [
      /teamtailor\.com/i,
      /career\.teamtailor\.com/i,
      /teamtailor-widget/i,
      /cdn\.teamtailor\.com/i,
    ],
    tokenExtractor: (html) => {
      const match =
        html.match(/([a-zA-Z0-9_-]+)\.teamtailor\.com/) ||
        html.match(/career\.([a-zA-Z0-9_-]+)\.com/);
      return match?.[1];
    },
  },
  {
    atsType: ATSType.RECRUITEE,
    patterns: [
      /recruitee\.com/i,
      /recruitee-widget/i,
      /d\.recruitee\.com/i,
      /recruitee\.com\/api\/offers/i,
    ],
    tokenExtractor: (html) => {
      const match = html.match(/([a-zA-Z0-9_-]+)\.recruitee\.com/);
      return match?.[1];
    },
  },
];

/**
 * Detect the Applicant Tracking System (ATS) used by a career page.
 * Checks hostname patterns first (high confidence), then page HTML content.
 */
export async function detectATS(url: string): Promise<ATSDetectionResult> {
  const evidence: string[] = [];
  let detectedType: ATSType | null = null;
  let confidence = 0;
  let boardToken: string | undefined;

  // Phase 1: Check hostname patterns
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    for (const pattern of HOSTNAME_PATTERNS) {
      if (pattern.test(hostname, pathname)) {
        detectedType = pattern.atsType;
        confidence = 0.95;
        boardToken = pattern.extractToken?.(hostname, pathname);
        evidence.push(`Hostname match: ${hostname} -> ${pattern.atsType}`);
        break;
      }
    }
  } catch {
    // Invalid URL, continue to HTML check
  }

  // If hostname gave a strong match, return early
  if (confidence >= 0.9) {
    return { atsType: detectedType, confidence, boardToken, evidence };
  }

  // Phase 2: Fetch page and check HTML content
  try {
    const domain = new URL(url).hostname;
    await rateLimiter.waitForSlot(domain);

    const response = await axios.get<string>(url, {
      timeout: REQUEST_TIMEOUT,
      headers: { "User-Agent": USER_AGENT },
      responseType: "text",
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
    });

    if (response.status !== 200) {
      return { atsType: detectedType, confidence, boardToken, evidence };
    }

    const html = typeof response.data === "string" ? response.data : "";

    // Check for meta tags indicating ATS
    const metaEvidence = checkMetaTags(html);
    if (metaEvidence) {
      evidence.push(`Meta tag: ${metaEvidence.evidence}`);
      if (!detectedType || metaEvidence.confidence > confidence) {
        detectedType = metaEvidence.atsType;
        confidence = metaEvidence.confidence;
        boardToken = metaEvidence.boardToken || boardToken;
      }
    }

    // Check for JSON-LD data attributes
    const jsonLdEvidence = checkJsonLD(html);
    if (jsonLdEvidence) {
      evidence.push(`JSON-LD: ${jsonLdEvidence.evidence}`);
      if (!detectedType || jsonLdEvidence.confidence > confidence) {
        detectedType = jsonLdEvidence.atsType;
        confidence = jsonLdEvidence.confidence;
      }
    }

    // Check for data attributes
    const dataAttrEvidence = checkDataAttributes(html);
    if (dataAttrEvidence) {
      evidence.push(`Data attribute: ${dataAttrEvidence.evidence}`);
      if (!detectedType || dataAttrEvidence.confidence > confidence) {
        detectedType = dataAttrEvidence.atsType;
        confidence = dataAttrEvidence.confidence;
      }
    }

    // Check scripts, iframes, and links
    for (const htmlPattern of HTML_PATTERNS) {
      const matchedPatterns = htmlPattern.patterns.filter((p) => p.test(html));
      if (matchedPatterns.length > 0) {
        const patternConfidence = matchedPatterns.length > 1 ? 0.85 : 0.7;
        evidence.push(
          `HTML content match: ${htmlPattern.atsType} (${matchedPatterns.length} patterns)`,
        );

        if (!detectedType || patternConfidence > confidence) {
          detectedType = htmlPattern.atsType;
          confidence = patternConfidence;
          boardToken = htmlPattern.tokenExtractor?.(html) || boardToken;
        }
      }
    }
  } catch {
    // Page fetch failed, return what we have
  }

  return { atsType: detectedType, confidence, boardToken, evidence };
}

/**
 * Check meta tags for ATS indicators.
 */
function checkMetaTags(
  html: string,
): { atsType: ATSType; confidence: number; evidence: string; boardToken?: string } | null {
  // Greenhouse meta tags
  if (/name\s*=\s*["']greenhouse["']/i.test(html) || /content\s*=\s*["'][^"']*greenhouse[^"']*["']/i.test(html)) {
    const tokenMatch = html.match(/boards\.greenhouse\.io\/([a-zA-Z0-9_-]+)/);
    return {
      atsType: ATSType.GREENHOUSE,
      confidence: 0.85,
      evidence: "Greenhouse meta tag found",
      boardToken: tokenMatch?.[1],
    };
  }

  // Teamtailor meta tags
  if (/name\s*=\s*["']teamtailor["']/i.test(html) || /generator.*teamtailor/i.test(html)) {
    return {
      atsType: ATSType.TEAMTAILOR,
      confidence: 0.9,
      evidence: "Teamtailor meta/generator tag found",
    };
  }

  return null;
}

/**
 * Check JSON-LD structured data for ATS references.
 */
function checkJsonLD(
  html: string,
): { atsType: ATSType; confidence: number; evidence: string } | null {
  const jsonLdRegex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = jsonLdRegex.exec(html)) !== null) {
    const content = match[1] || "";
    const lower = content.toLowerCase();

    for (const pattern of HTML_PATTERNS) {
      if (pattern.patterns.some((p) => p.test(lower))) {
        return {
          atsType: pattern.atsType,
          confidence: 0.75,
          evidence: `${pattern.atsType} reference in JSON-LD`,
        };
      }
    }
  }

  return null;
}

/**
 * Check for data attributes indicating ATS.
 */
function checkDataAttributes(
  html: string,
): { atsType: ATSType; confidence: number; evidence: string } | null {
  if (/data-greenhouse/i.test(html)) {
    return {
      atsType: ATSType.GREENHOUSE,
      confidence: 0.8,
      evidence: "data-greenhouse attribute found",
    };
  }

  if (/data-lever/i.test(html)) {
    return {
      atsType: ATSType.LEVER,
      confidence: 0.8,
      evidence: "data-lever attribute found",
    };
  }

  if (/data-ashby/i.test(html)) {
    return {
      atsType: ATSType.ASHBY,
      confidence: 0.8,
      evidence: "data-ashby attribute found",
    };
  }

  if (/id\s*=\s*["']grnhse_app["']/i.test(html)) {
    return {
      atsType: ATSType.GREENHOUSE,
      confidence: 0.9,
      evidence: "Greenhouse embed container (grnhse_app) found",
    };
  }

  if (/data-workable/i.test(html) || /id\s*=\s*["']whr-[a-zA-Z0-9]+["']/i.test(html)) {
    return {
      atsType: ATSType.WORKABLE,
      confidence: 0.8,
      evidence: "Workable data attribute or widget element found",
    };
  }

  if (/data-workday/i.test(html) || /myworkdayjobs\.com/i.test(html)) {
    return {
      atsType: ATSType.WORKDAY,
      confidence: 0.8,
      evidence: "Workday data attribute or domain reference found",
    };
  }

  if (/data-teamtailor/i.test(html)) {
    return {
      atsType: ATSType.TEAMTAILOR,
      confidence: 0.8,
      evidence: "Teamtailor data attribute found",
    };
  }

  if (/data-recruitee/i.test(html) || /recruitee-widget/i.test(html)) {
    return {
      atsType: ATSType.RECRUITEE,
      confidence: 0.8,
      evidence: "Recruitee data attribute or widget found",
    };
  }

  return null;
}
