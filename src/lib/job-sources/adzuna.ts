import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";

export const adzunaAdapter: JobSourceAdapter = {
  source: "ADZUNA",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    try {
      const page = params.page ?? 1;

      const response = await axios.get(
        `https://api.adzuna.com/v1/api/jobs/us/search/${page}`,
        {
          params: {
            app_id: process.env.ADZUNA_APP_ID ?? "",
            app_key: process.env.ADZUNA_APP_KEY ?? "",
            results_per_page: params.limit ?? 20,
            what: params.query,
            where: params.location ?? undefined,
          },
        },
      );

      const results = response.data?.results ?? [];

      return results.map(
        (item: Record<string, unknown>): NormalizedJob => {
          const description = (item.description as string) ?? "";
          const location =
            (item.location as Record<string, unknown>)?.display_name as string ??
            undefined;
          const salary_min =
            (item.salary_min as number) ?? undefined;
          const salary_max =
            (item.salary_max as number) ?? undefined;
          const company =
            ((item.company as Record<string, unknown>)?.display_name as string) ??
            "";

          return {
            externalId: String(item.id ?? ""),
            source: "ADZUNA",
            title: (item.title as string) ?? "",
            company,
            location,
            description,
            summary: description.slice(0, 500) || undefined,
            url: (item.redirect_url as string) ?? "",
            applyUrl: (item.redirect_url as string) ?? undefined,
            postedAt: item.created
              ? new Date(item.created as string)
              : undefined,
            salaryMin: salary_min,
            salaryMax: salary_max,
            skills: [],
            jobType: (item.contract_type as string) ?? undefined,
          };
        },
      );
    } catch (error) {
      console.error("Adzuna API error:", error);
      return [];
    }
  },
};
