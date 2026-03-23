import axios from "axios";

const USER_AGENT = "AutoApplicationBot/1.0";
const REQUEST_TIMEOUT = 10_000;

export interface RobotsTxt {
  raw: string;
  rules: RobotsRule[];
  sitemaps: string[];
}

interface RobotsRule {
  userAgent: string;
  allow: string[];
  disallow: string[];
  crawlDelay?: number;
}

/**
 * Fetch and parse robots.txt for a domain.
 */
export async function fetchRobotsTxt(domain: string): Promise<RobotsTxt | null> {
  try {
    const url = `https://${domain}/robots.txt`;
    const response = await axios.get<string>(url, {
      timeout: REQUEST_TIMEOUT,
      headers: { "User-Agent": USER_AGENT },
      responseType: "text",
      validateStatus: (status) => status < 500,
    });

    if (response.status === 404 || response.status === 403) {
      return null;
    }

    const raw = typeof response.data === "string" ? response.data : "";
    return parseRobotsTxt(raw);
  } catch {
    return null;
  }
}

/**
 * Parse a robots.txt string into structured rules.
 */
function parseRobotsTxt(raw: string): RobotsTxt {
  const lines = raw.split("\n").map((line) => line.trim());
  const rules: RobotsRule[] = [];
  const sitemaps: string[] = [];

  let currentRule: RobotsRule | null = null;

  for (const line of lines) {
    // Skip comments and empty lines
    const commentIdx = line.indexOf("#");
    const effective = (commentIdx >= 0 ? line.slice(0, commentIdx) : line).trim();
    if (!effective) continue;

    const colonIdx = effective.indexOf(":");
    if (colonIdx < 0) continue;

    const directive = effective.slice(0, colonIdx).trim().toLowerCase();
    const value = effective.slice(colonIdx + 1).trim();

    if (directive === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }

    if (directive === "user-agent") {
      currentRule = { userAgent: value.toLowerCase(), allow: [], disallow: [] };
      rules.push(currentRule);
      continue;
    }

    if (!currentRule) continue;

    switch (directive) {
      case "allow":
        if (value) currentRule.allow.push(value);
        break;
      case "disallow":
        if (value) currentRule.disallow.push(value);
        break;
      case "crawl-delay": {
        const delay = parseFloat(value);
        if (!isNaN(delay) && delay > 0) {
          currentRule.crawlDelay = delay;
        }
        break;
      }
    }
  }

  return { raw, rules, sitemaps };
}

/**
 * Check if a URL path is allowed for our user-agent.
 * Follows standard robots.txt matching: most specific rule wins.
 */
export function isAllowed(url: string, robotsTxt: RobotsTxt): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return true;
  }

  // Find rules that apply to our user-agent, or fall back to wildcard
  const applicableRules = robotsTxt.rules.filter(
    (r) => r.userAgent === "*" || r.userAgent.includes("autoapplication"),
  );

  if (applicableRules.length === 0) return true;

  // Collect all allow/disallow directives
  const directives: { type: "allow" | "disallow"; pattern: string }[] = [];
  for (const rule of applicableRules) {
    for (const p of rule.allow) {
      directives.push({ type: "allow", pattern: p });
    }
    for (const p of rule.disallow) {
      directives.push({ type: "disallow", pattern: p });
    }
  }

  // Find matching directives and pick the most specific (longest match)
  let bestMatch: { type: "allow" | "disallow"; length: number } | null = null;

  for (const directive of directives) {
    if (pathMatches(path, directive.pattern)) {
      const matchLength = directive.pattern.length;
      if (!bestMatch || matchLength > bestMatch.length) {
        bestMatch = { type: directive.type, length: matchLength };
      }
    }
  }

  if (!bestMatch) return true;
  return bestMatch.type === "allow";
}

/**
 * Check if a path matches a robots.txt pattern.
 */
function pathMatches(path: string, pattern: string): boolean {
  // Handle wildcard patterns
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, ".*").replace(/\$/g, "$") + (pattern.endsWith("$") ? "" : ""),
    );
    return regex.test(path);
  }
  // Handle end-of-string anchor
  if (pattern.endsWith("$")) {
    return path === pattern.slice(0, -1);
  }
  // Default: prefix match
  return path.startsWith(pattern);
}

/**
 * Get the crawl delay (in seconds) from robots.txt for our user-agent.
 */
export function getCrawlDelay(robotsTxt: RobotsTxt): number | null {
  // Check for our specific user-agent first, then wildcard
  for (const ua of ["autoapplication", "*"]) {
    const rule = robotsTxt.rules.find((r) => r.userAgent === ua);
    if (rule?.crawlDelay != null) {
      return rule.crawlDelay;
    }
  }
  return null;
}

/**
 * Extract sitemap URLs from robots.txt.
 */
export function getSitemapUrls(robotsTxt: RobotsTxt): string[] {
  return robotsTxt.sitemaps;
}

/**
 * Extract career-related paths mentioned in robots.txt rules.
 */
export function getCareerPaths(robotsTxt: RobotsTxt): string[] {
  const careerPatterns = [
    "career", "jobs", "join", "hiring", "opportunities",
    "vacancies", "work-at", "open-roles", "work-with-us",
  ];

  const paths: string[] = [];

  for (const rule of robotsTxt.rules) {
    const allPaths = [...rule.allow, ...rule.disallow];
    for (const p of allPaths) {
      const lower = p.toLowerCase();
      if (careerPatterns.some((pattern) => lower.includes(pattern))) {
        paths.push(p);
      }
    }
  }

  return paths;
}
