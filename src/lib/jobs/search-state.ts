export const JOBS_SEARCH_STATE_STORAGE_KEY = "autoapplication.jobs.filters";

const TEXT_PARAM_MAX_LENGTH = 120;
const LIST_PARAM_MAX_LENGTH = 240;

export const JOBS_STATE_PARAM_KEYS = [
  "q",
  "field",
  "search",
  "searchScope",
  "titleSearch",
  "companySearch",
  "locationSearch",
  "location",
  "source",
  "region",
  "workMode",
  "employmentType",
  "industry",
  "function",
  "jobFunction",
  "roleCategory",
  "roleFamily",
  "salaryMin",
  "salaryMax",
  "salaryCurrency",
  "includeUnknownSalary",
  "hideApplied",
  "careerStage",
  "experienceLevel",
  "expiry",
  "datePosted",
  "posted",
  "status",
  "sortBy",
  "sort",
  "page",
] as const;

// Saved filters intentionally exclude one-off title and company queries. A
// returning user should get their preferred job pool, not an old ad-hoc search.
export const JOBS_SAVED_FILTER_PARAM_KEYS = [
  "locationSearch",
  "location",
  "source",
  "region",
  "workMode",
  "employmentType",
  "industry",
  "function",
  "jobFunction",
  "roleCategory",
  "roleFamily",
  "salaryMin",
  "salaryMax",
  "salaryCurrency",
  "includeUnknownSalary",
  "hideApplied",
  "careerStage",
  "experienceLevel",
  "expiry",
  "datePosted",
  "posted",
  "status",
  "sortBy",
  "sort",
] as const;

const DEFAULT_KEYWORD_SEARCH_FIELD = "title" as const;
const JOBS_STATE_PARAM_KEY_SET = new Set<string>(JOBS_STATE_PARAM_KEYS);

const MULTI_VALUE_KEYS = new Set([
  "locationSearch",
  "region",
  "workMode",
  "employmentType",
  "industry",
  "jobFunction",
  "roleCategory",
  "roleFamily",
  "careerStage",
  "experienceLevel",
]);

const TEXT_VALUE_KEYS = new Set([
  "search",
  "titleSearch",
  "companySearch",
  "locationSearch",
  "location",
  "source",
  "roleFamily",
]);

const ORDERED_JOBS_STATE_KEYS = [
  "search",
  "searchScope",
  "titleSearch",
  "companySearch",
  "locationSearch",
  "location",
  "source",
  "region",
  "workMode",
  "employmentType",
  "industry",
  "jobFunction",
  "roleCategory",
  "roleFamily",
  "salaryMin",
  "salaryMax",
  "salaryCurrency",
  "includeUnknownSalary",
  "hideApplied",
  "careerStage",
  "experienceLevel",
  "expiry",
  "posted",
  "status",
  "sortBy",
  "page",
] as const;

export function hasJobsStateParamsRecord(
  searchParams: Record<string, string | string[] | undefined>
) {
  const hasSearchText = Boolean(
    normalizeTextValue(firstParamValue(searchParams.q)) ||
      normalizeTextValue(firstParamValue(searchParams.search)) ||
      normalizeTextValue(firstParamValue(searchParams.titleSearch)) ||
      normalizeTextValue(firstParamValue(searchParams.companySearch)) ||
      normalizeTextValue(firstParamValue(searchParams.locationSearch))
  );

  return Object.entries(searchParams).some(([key, value]) => {
    if (!JOBS_STATE_PARAM_KEY_SET.has(key)) return false;
    if ((key === "field" || key === "searchScope") && !hasSearchText) return false;
    const normalizedValue = Array.isArray(value) ? value.filter(Boolean).join(",") : value;
    return normalizeParamValue(key, normalizedValue) !== undefined;
  });
}

export function hasJobsStateParams(searchParams: URLSearchParams) {
  const hasSearchText = Boolean(
    normalizeTextValue(searchParams.get("q") ?? undefined) ||
      normalizeTextValue(searchParams.get("search") ?? undefined) ||
      normalizeTextValue(searchParams.get("titleSearch") ?? undefined) ||
      normalizeTextValue(searchParams.get("companySearch") ?? undefined) ||
      normalizeTextValue(searchParams.get("locationSearch") ?? undefined)
  );

  for (const key of JOBS_STATE_PARAM_KEYS) {
    if ((key === "field" || key === "searchScope") && !hasSearchText) continue;
    if (normalizeParamValue(key, searchParams.get(key) ?? undefined)) return true;
  }
  return false;
}

export function normalizeJobsStateQuery(
  input: string | URLSearchParams | Record<string, string | string[] | undefined>,
  options: { includePage?: boolean } = {}
) {
  const includePage = options.includePage ?? true;
  const source = toURLSearchParams(input);
  applyAliasParams(source);
  moveBroadSearchToScopedSearch(source);
  if (!source.has("searchScope") && hasSearchValue(source)) {
    const inferredScope = inferSearchScope(source);
    if (inferredScope !== "all") source.set("searchScope", inferredScope);
  }

  const output = new URLSearchParams();
  for (const key of ORDERED_JOBS_STATE_KEYS) {
    if (key === "page" && !includePage) continue;
    const rawValue = source.get(key) ?? undefined;
    const normalizedValue = normalizeParamValue(key, rawValue);
    if (!normalizedValue) continue;
    if (key === "searchScope" && !hasSearchValue(source)) continue;
    if (key === "sortBy" && normalizedValue === "relevance") continue;
    if (key === "page" && normalizedValue === "1" && !source.has("page")) continue;
    output.set(key, normalizedValue);
  }

  if (!output.get("salaryMin") && !output.get("salaryMax")) {
    output.delete("salaryCurrency");
    output.delete("includeUnknownSalary");
  }

  if (!hasSearchValue(output)) {
    output.delete("searchScope");
  }

  return output.toString();
}

export function mergeNaturalLanguageJobsSearch(
  currentSearch: string | URLSearchParams,
  interpretedParams: Record<string, string | undefined>
) {
  const current = toURLSearchParams(currentSearch);
  const interpreted = cleanInterpretedParams(interpretedParams);
  const clearedConflictGroups = new Set<string>();

  for (const [key, value] of Object.entries(interpreted)) {
    if (!value || key === "searchScope") continue;
    const conflictingKeys = getConflictingJobsStateKeys(key);
    const conflictGroup = conflictingKeys.join(":");
    if (!clearedConflictGroups.has(conflictGroup)) {
      for (const conflictingKey of conflictingKeys) {
        current.delete(conflictingKey);
      }
      clearedConflictGroups.add(conflictGroup);
    }
    current.set(key, value);
  }

  // Scope is presentation state for the keyword control. Apply it after the
  // parsed title/company search has replaced the previous search state.
  if (
    interpreted.searchScope &&
    (interpreted.titleSearch || interpreted.companySearch || interpreted.locationSearch)
  ) {
    current.set("searchScope", interpreted.searchScope);
  }

  current.delete("page");
  const normalized = normalizeJobsStateQuery(current, { includePage: false });
  return normalized ? `/jobs?${normalized}` : "/jobs";
}

function cleanInterpretedParams(input: Record<string, string | undefined>) {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!JOBS_STATE_PARAM_KEY_SET.has(key)) continue;
    const normalized = normalizeParamValue(key, value);
    if (normalized) params[key] = normalized;
  }
  return params;
}

function getConflictingJobsStateKeys(key: string) {
  switch (key) {
    case "titleSearch":
      return ["q", "field", "search", "searchScope", "titleSearch"];
    case "companySearch":
      return ["q", "field", "search", "searchScope", "companySearch"];
    case "locationSearch":
      return ["locationSearch"];
    case "jobFunction":
      return ["function", "jobFunction", "roleCategory"];
    case "careerStage":
      return ["careerStage", "experienceLevel"];
    case "posted":
      return ["datePosted", "posted"];
    case "sortBy":
      return ["sort", "sortBy"];
    case "salaryMin":
    case "salaryMax":
    case "salaryCurrency":
      return ["salaryMin", "salaryMax", "salaryCurrency", "includeUnknownSalary"];
    default:
      return [key];
  }
}

function toURLSearchParams(
  input: string | URLSearchParams | Record<string, string | string[] | undefined>
) {
  if (input instanceof URLSearchParams) return new URLSearchParams(input);
  if (typeof input === "string") return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      const joined = value.filter(Boolean).join(",");
      if (joined) params.set(key, joined);
    } else if (value) {
      params.set(key, value);
    }
  }
  return params;
}

function applyAliasParams(params: URLSearchParams) {
  const q = normalizeTextValue(params.get("q") ?? undefined);
  if (q) {
    const field = normalizeFieldValue(params.get("field") ?? undefined);
    if (
      !params.has("search") &&
      !params.has("titleSearch") &&
      !params.has("companySearch") &&
      !params.has("locationSearch")
    ) {
      if (field === "title") {
        params.set("titleSearch", q);
      } else if (field === "company") {
        params.set("companySearch", q);
      } else if (field === "location") {
        params.set("locationSearch", q);
      } else {
        params.set("titleSearch", q);
      }
      params.set("searchScope", field === "all" ? DEFAULT_KEYWORD_SEARCH_FIELD : field);
    }
  }

  const sort = normalizeSortValue(params.get("sort") ?? undefined);
  if (sort && !params.has("sortBy")) {
    params.set("sortBy", sort);
  }

  const jobFunction = normalizeListValue(params.get("function") ?? undefined);
  if (jobFunction && !params.has("jobFunction") && !params.has("roleCategory")) {
    params.set("jobFunction", jobFunction);
  }

  const datePosted = normalizeTextValue(params.get("datePosted") ?? undefined);
  if (datePosted && !params.has("posted")) {
    params.set("posted", datePosted);
  }
}

function moveBroadSearchToScopedSearch(params: URLSearchParams) {
  const search = normalizeTextValue(params.get("search") ?? undefined);
  if (!search) return;

  const scope = normalizeFieldValue(params.get("searchScope") ?? undefined);
  if (scope === "company") {
    if (!normalizeTextValue(params.get("companySearch") ?? undefined)) {
      params.set("companySearch", search);
    }
  } else if (scope === "location") {
    const locationSearch = normalizeListValue(
      [params.get("locationSearch"), search].filter(Boolean).join(",")
    );
    if (locationSearch) params.set("locationSearch", locationSearch);
  } else {
    if (!normalizeTextValue(params.get("titleSearch") ?? undefined)) {
      params.set("titleSearch", search);
    }
  }

  params.delete("search");
  params.delete("searchScope");
}

function hasSearchValue(params: URLSearchParams) {
  return Boolean(
    normalizeTextValue(params.get("search") ?? undefined) ||
      normalizeTextValue(params.get("titleSearch") ?? undefined) ||
      normalizeTextValue(params.get("companySearch") ?? undefined) ||
      normalizeTextValue(params.get("locationSearch") ?? undefined)
  );
}

function normalizeParamValue(key: string, value?: string) {
  if (!value) return undefined;
  if (key === "status" && value === "LIVE") return undefined;
  if (key === "searchScope") return normalizeFieldValue(value);
  if (key === "field") return normalizeFieldValue(value);
  if (key === "sort") return normalizeSortValue(value);
  if (key === "sortBy") return normalizeSortValue(value);
  if (key === "page") {
    const parsed = parsePositiveInt(value);
    return parsed ? String(parsed) : undefined;
  }
  if (key === "salaryMin" || key === "salaryMax") {
    const parsed = parsePositiveInt(value);
    return parsed ? String(parsed) : undefined;
  }
  if (key === "includeUnknownSalary" || key === "hideApplied") {
    return value === "1" || value === "true" || value === "on" ? "1" : undefined;
  }
  if (MULTI_VALUE_KEYS.has(key)) return normalizeListValue(value);
  if (TEXT_VALUE_KEYS.has(key)) return normalizeTextValue(value);
  return normalizeTextValue(value);
}

function normalizeFieldValue(value?: string) {
  if (value === "title" || value === "company" || value === "location") return value;
  return "all";
}

function normalizeSortValue(value?: string) {
  if (value === "best" || value === "relevance") return "relevance";
  if (value === "newest" || value === "deadline" || value === "company") return value;
  return undefined;
}

function normalizeTextValue(value?: string) {
  const trimmed = String(value ?? "").replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, TEXT_PARAM_MAX_LENGTH) : undefined;
}

function normalizeListValue(value?: string) {
  const values = splitValues(value).map((entry) => entry.slice(0, LIST_PARAM_MAX_LENGTH));
  return values.length > 0 ? values.join(",") : undefined;
}

function splitValues(value?: string | null) {
  if (!value) return [];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const entry of value.split(",")) {
    const normalized = normalizeTextValue(entry);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(normalized);
  }
  return values;
}

function firstParamValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parsePositiveInt(value?: string | null) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function inferSearchScope(params: URLSearchParams) {
  if (normalizeTextValue(params.get("titleSearch") ?? undefined)) return "title";
  if (normalizeTextValue(params.get("companySearch") ?? undefined)) return "company";
  if (normalizeTextValue(params.get("locationSearch") ?? undefined)) return "location";
  return "all";
}
