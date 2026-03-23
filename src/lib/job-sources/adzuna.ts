import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";

const DEFAULT_COUNTRIES = ["us", "ca"];
const DEFAULT_MAX_PAGES = 20;
const RESULTS_PER_PAGE = 50; // Adzuna max is 50
const PAGE_DELAY_MS = 300;

function getAdzunaCountries(): string[] {
  const raw = process.env.ADZUNA_COUNTRIES?.trim();
  if (!raw) return DEFAULT_COUNTRIES;

  const countries = raw
    .split(/[\n,]/)
    .map((country) => country.trim().toLowerCase())
    .filter(Boolean);

  return countries.length > 0 ? Array.from(new Set(countries)) : DEFAULT_COUNTRIES;
}

function getMaxPages(): number {
  const raw = process.env.ADZUNA_MAX_PAGES?.trim();
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return Math.min(parsed, 50);
  }
  return DEFAULT_MAX_PAGES;
}

async function fetchCountryJobs(
  country: string,
  query: string,
  location: string | undefined,
  appId: string,
  appKey: string,
  maxPages: number,
): Promise<NormalizedJob[]> {
  const allJobs: NormalizedJob[] = [];

  for (let page = 1; page <= maxPages; page++) {
    try {
      const response = await axios.get(
        `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`,
        {
          params: {
            app_id: appId,
            app_key: appKey,
            results_per_page: RESULTS_PER_PAGE,
            what: query,
            where: location ?? undefined,
            sort_by: "date",
          },
          timeout: 10000,
        },
      );

      const results = response.data?.results ?? [];
      if (results.length === 0) break;

      for (const item of results) {
        const description = (item.description as string) ?? "";
        const loc =
          (item.location as Record<string, unknown>)?.display_name as string ??
          undefined;
        const salaryMin = (item.salary_min as number) ?? undefined;
        const salaryMax = (item.salary_max as number) ?? undefined;
        const company =
          ((item.company as Record<string, unknown>)?.display_name as string) ??
          "";

        allJobs.push({
          externalId: `${country}:${String(item.id ?? "")}`,
          source: "ADZUNA",
          title: (item.title as string) ?? "",
          company,
          location: loc,
          description,
          summary: description.slice(0, 500) || undefined,
          url: (item.redirect_url as string) ?? "",
          applyUrl: (item.redirect_url as string) ?? undefined,
          postedAt: item.created
            ? new Date(item.created as string)
            : undefined,
          salaryMin,
          salaryMax,
          salaryCurrency:
            (item.salary_currency as string) ??
            (country === "ca" ? "CAD" : "USD"),
          skills: [],
          jobType: (item.contract_type as string) ?? undefined,
        });
      }

      // If we got fewer than requested, no more pages
      if (results.length < RESULTS_PER_PAGE) break;

      // Rate limit between pages
      if (page < maxPages) {
        await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
      }
    } catch (error) {
      console.warn(
        `[Adzuna] ${country} page ${page} failed:`,
        error instanceof Error ? error.message : error,
      );
      break;
    }
  }

  return allJobs;
}

export const adzunaAdapter: JobSourceAdapter = {
  source: "ADZUNA",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const appId = process.env.ADZUNA_APP_ID?.trim();
    const appKey = process.env.ADZUNA_APP_KEY?.trim();
    if (!appId || !appKey) return [];

    try {
      const maxPages = getMaxPages();
      const countries = getAdzunaCountries();

      const responses = await Promise.allSettled(
        countries.map((country) =>
          fetchCountryJobs(
            country,
            params.query,
            params.location,
            appId,
            appKey,
            maxPages,
          ),
        ),
      );

      const allJobs = responses.flatMap((response) =>
        response.status === "fulfilled" ? response.value : [],
      );

      console.log(`[Adzuna] Fetched ${allJobs.length} jobs across ${countries.join(", ")}`);
      return allJobs;
    } catch (error) {
      console.error("Adzuna API error:", error);
      return [];
    }
  },
};
