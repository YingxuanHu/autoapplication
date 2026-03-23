import type {
  JobSearchParams,
  NormalizedJob,
  WorkMode,
} from "@/types/index";

const COMMON_TECH_SKILLS = [
  "javascript", "typescript", "python", "java", "c++", "c#", "go", "rust",
  "ruby", "php", "swift", "kotlin", "scala", "r", "sql", "nosql",
  "react", "angular", "vue", "svelte", "next.js", "node.js", "express",
  "django", "flask", "spring", "rails", "laravel", ".net",
  "aws", "azure", "gcp", "docker", "kubernetes", "terraform", "jenkins",
  "git", "ci/cd", "rest", "graphql", "microservices", "serverless",
  "postgresql", "mysql", "mongodb", "redis", "elasticsearch",
  "html", "css", "tailwind", "sass", "webpack", "vite",
  "machine learning", "deep learning", "nlp", "computer vision",
  "agile", "scrum", "jira", "figma", "sketch",
  "linux", "nginx", "apache",
];

export interface BoardConfig {
  token: string;
  name?: string;
}

export function getRequestTimeoutMs(defaultMs = 8000): number {
  const raw = Number.parseInt(process.env.JOB_SOURCE_TIMEOUT_MS ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return defaultMs;
  return raw;
}

export function isLikelyCanadianLocation(location: string | null | undefined): boolean {
  if (!location) return false;

  const normalized = normalizeText(location);
  return [
    "canada",
    "toronto",
    "ontario",
    "vancouver",
    "british columbia",
    "montreal",
    "quebec",
    "calgary",
    "alberta",
    "ottawa",
    "edmonton",
    "winnipeg",
    "manitoba",
    "saskatoon",
    "saskatchewan",
    "halifax",
    "nova scotia",
    "new brunswick",
    "newfoundland",
    "labrador",
    "pei",
    "prince edward island",
  ].some((term) => normalized.includes(term));
}

export function splitSearchQuery(query: string): string[] {
  const variants = query
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);

  return variants.length > 0 ? variants : [query.trim()].filter(Boolean);
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function htmlToPlainText(value: string): string {
  return value
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|section|article)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function inferWorkMode(...values: Array<string | null | undefined>): WorkMode | undefined {
  const lower = normalizeText(values.filter(Boolean).join(" "));
  if (
    lower.includes("on-site") ||
    lower.includes("onsite") ||
    lower.includes("on site")
  ) {
    return "ONSITE";
  }
  if (lower.includes("hybrid")) {
    return "HYBRID";
  }
  if (lower.includes("remote")) {
    return "REMOTE";
  }
  return undefined;
}

export function extractSkills(value: string): string[] {
  const lower = normalizeText(value);
  return COMMON_TECH_SKILLS.filter((skill) => {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(lower);
  });
}

export function summarizeText(value: string, maxLength = 500): string | undefined {
  const text = htmlToPlainText(value);
  if (!text) return undefined;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}

export function matchesJobSearch(
  job: NormalizedJob,
  params: JobSearchParams,
): boolean {
  if (params.query) {
    const haystack = normalizeText([
      job.title,
      job.company,
      job.location ?? "",
      job.summary ?? "",
      job.description,
      job.jobType ?? "",
      job.skills.join(" "),
    ].join(" "));
    const queryVariants = splitSearchQuery(params.query).map(normalizeText);

    const hasQueryMatch = queryVariants.some((query) => {
      if (!query) return false;
      if (haystack.includes(query)) return true;

      const terms = query.split(/\s+/).filter((term) => term.length > 2);
      return terms.length > 0 && terms.every((term) => haystack.includes(term));
    });

    if (!hasQueryMatch) return false;
  }

  const locationFilters =
    params.locations?.filter(Boolean) ??
    (params.location ? [params.location] : []);

  if (locationFilters.length > 0) {
    const location = normalizeText(job.location ?? "");
    const hasLocationMatch = locationFilters.some((entry) =>
      location.includes(normalizeText(entry)),
    );

    if (!hasLocationMatch) {
      return false;
    }
  }

  if (params.workMode) {
    if (job.workMode !== params.workMode) {
      return false;
    }
  }

  return true;
}

export function parseBoardConfigs(raw: string | undefined): BoardConfig[] {
  if (!raw) return [];

  const trimmed = raw.trim();
  if (!trimmed) return [];

  const deduped = new Map<string, BoardConfig>();

  const addEntry = (entry: string | BoardConfig) => {
    const config =
      typeof entry === "string"
        ? parseBoardConfigEntry(entry)
        : {
            token: entry.token.trim(),
            name: entry.name?.trim() || undefined,
          };

    if (!config?.token) return;
    if (!deduped.has(config.token)) {
      deduped.set(config.token, config);
    }
  };

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as Array<string | BoardConfig>;
      parsed.forEach(addEntry);
      return [...deduped.values()];
    } catch {
      // Fall back to line-based parsing below.
    }
  }

  trimmed
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach(addEntry);

  return [...deduped.values()];
}

export function resolveCompanyName(config: BoardConfig): string {
  return config.name || prettifyToken(config.token);
}

function parseBoardConfigEntry(entry: string): BoardConfig | null {
  const [token, name] = entry.split("|").map((part) => part.trim());
  if (!token) return null;
  return { token, name: name || undefined };
}

function prettifyToken(token: string): string {
  return token
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
