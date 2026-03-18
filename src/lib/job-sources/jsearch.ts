import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";

const COMMON_TECH_SKILLS = [
  "javascript", "typescript", "python", "java", "c++", "c#", "go", "rust",
  "ruby", "php", "swift", "kotlin", "scala", "r", "sql", "nosql",
  "react", "angular", "vue", "svelte", "next.js", "node.js", "express",
  "django", "flask", "spring", "rails", "laravel",
  "aws", "azure", "gcp", "docker", "kubernetes", "terraform", "jenkins",
  "git", "ci/cd", "rest", "graphql", "microservices",
  "postgresql", "mysql", "mongodb", "redis", "elasticsearch",
  "html", "css", "tailwind", "sass",
  "machine learning", "deep learning", "nlp", "computer vision",
  "agile", "scrum", "jira", "figma", "sketch",
  "linux", "nginx", "apache",
];

function extractWorkMode(
  description: string,
): "REMOTE" | "HYBRID" | "ONSITE" | undefined {
  const lower = description.toLowerCase();
  if (lower.includes("remote")) return "REMOTE";
  if (lower.includes("hybrid")) return "HYBRID";
  if (lower.includes("onsite") || lower.includes("on-site")) return "ONSITE";
  return undefined;
}

function extractSkills(description: string): string[] {
  const lower = description.toLowerCase();
  return COMMON_TECH_SKILLS.filter((skill) => {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    return regex.test(lower);
  });
}

export const jsearchAdapter: JobSourceAdapter = {
  source: "JSEARCH",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    try {
      const response = await axios.get(
        "https://jsearch.p.rapidapi.com/search",
        {
          headers: {
            "X-RapidAPI-Key": process.env.RAPIDAPI_KEY ?? "",
            "X-RapidAPI-Host": process.env.JSEARCH_HOST ?? "jsearch.p.rapidapi.com",
          },
          params: {
            query: params.location
              ? `${params.query} in ${params.location}`
              : params.query,
            page: params.page ?? 1,
            num_pages: 1,
            date_posted: "all",
          },
        },
      );

      const results = response.data?.data ?? [];

      return results.map(
        (item: Record<string, unknown>): NormalizedJob => {
          const description = (item.job_description as string) ?? "";
          return {
            externalId: item.job_id as string,
            source: "JSEARCH",
            title: (item.job_title as string) ?? "",
            company: (item.employer_name as string) ?? "",
            companyLogo: (item.employer_logo as string) ?? undefined,
            location: [item.job_city, item.job_state, item.job_country]
              .filter(Boolean)
              .join(", ") || undefined,
            workMode:
              item.job_is_remote === true
                ? "REMOTE"
                : extractWorkMode(description),
            salaryMin: (item.job_min_salary as number) ?? undefined,
            salaryMax: (item.job_max_salary as number) ?? undefined,
            salaryCurrency: (item.job_salary_currency as string) ?? undefined,
            description,
            summary: description.slice(0, 500) || undefined,
            url: (item.job_apply_link as string) ??
              (item.job_google_link as string) ?? "",
            applyUrl: (item.job_apply_link as string) ?? undefined,
            postedAt: item.job_posted_at_datetime_utc
              ? new Date(item.job_posted_at_datetime_utc as string)
              : undefined,
            skills: extractSkills(description),
            jobType: (item.job_employment_type as string) ?? undefined,
          };
        },
      );
    } catch (error) {
      console.error("JSearch API error:", error);
      return [];
    }
  },
};
