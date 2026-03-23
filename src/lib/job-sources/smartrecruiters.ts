import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";
import {
  extractSkills,
  htmlToPlainText,
  inferWorkMode,
  matchesJobSearch,
  normalizeText,
  parseBoardConfigs,
  resolveCompanyName,
  summarizeText,
} from "./utils";

interface SmartRecruitersLocation {
  city?: string;
  region?: string;
  country?: string;
  remote?: boolean;
}

interface SmartRecruitersPostingSummary {
  id: string;
  name?: string;
  company?: {
    name?: string;
  };
  releasedDate?: string;
  location?: SmartRecruitersLocation;
  typeOfEmployment?: {
    label?: string;
  };
}

interface SmartRecruitersPostingDetail extends SmartRecruitersPostingSummary {
  applyUrl?: string;
  jobAd?: {
    sections?: Record<string, { title?: string; text?: string }>;
  };
}

interface SmartRecruitersListResponse {
  content?: SmartRecruitersPostingSummary[];
}

function formatLocation(location: SmartRecruitersLocation | undefined): string | undefined {
  if (!location) return undefined;

  const values = [location.city, location.region, location.country]
    .map((value) => value?.trim())
    .filter(Boolean);

  if (values.length === 0) {
    return location.remote ? "Remote" : undefined;
  }

  return values.join(", ");
}

function matchesSmartRecruitersSummary(
  posting: SmartRecruitersPostingSummary,
  params: JobSearchParams,
): boolean {
  const location = formatLocation(posting.location);

  if (params.location) {
    if (!normalizeText(location ?? "").includes(normalizeText(params.location))) {
      return false;
    }
  }

  if (params.workMode === "REMOTE" && posting.location?.remote !== true) {
    return false;
  }

  return true;
}

function buildSmartRecruitersDescription(
  posting: SmartRecruitersPostingDetail,
): string {
  const sections = posting.jobAd?.sections;
  if (!sections) return "";

  return htmlToPlainText(
    Object.values(sections)
      .map((section) => section.text ?? "")
      .filter(Boolean)
      .join("\n\n"),
  );
}

export const smartRecruitersAdapter: JobSourceAdapter = {
  source: "SMARTRECRUITERS",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const companies = parseBoardConfigs(process.env.SMARTRECRUITERS_COMPANIES);
    if (companies.length === 0) return [];

    const results = await Promise.allSettled(
      companies.map(async (company) => {
        const listResponse = await axios.get<SmartRecruitersListResponse>(
          `https://api.smartrecruiters.com/v1/companies/${company.token}/postings`,
          {
            params: {
              q: params.query,
              limit: Math.max(params.limit ?? 20, 25),
              offset: 0,
            },
          },
        );

        const summaries = (listResponse.data.content ?? []).filter((posting) =>
          matchesSmartRecruitersSummary(posting, params),
        );

        const detailResults = await Promise.allSettled(
          summaries.map((posting) =>
            axios.get<SmartRecruitersPostingDetail>(
              `https://api.smartrecruiters.com/v1/companies/${company.token}/postings/${posting.id}`,
            ),
          ),
        );

        return detailResults.flatMap((detailResult, index) => {
          if (detailResult.status !== "fulfilled") return [];

          const detail = detailResult.value.data;
          const summary = summaries[index];
          const resolvedCompany =
            detail.company?.name ||
            summary.company?.name ||
            resolveCompanyName(company);
          const location = formatLocation(detail.location || summary.location);
          const description = buildSmartRecruitersDescription(detail);

          const job: NormalizedJob = {
            externalId: `${company.token}:${detail.id}`,
            source: "SMARTRECRUITERS",
            title: detail.name ?? summary.name ?? "",
            company: resolvedCompany,
            location,
            workMode:
              detail.location?.remote === true
                ? "REMOTE"
                : inferWorkMode(location, description),
            description,
            summary: summarizeText(description),
            url: detail.applyUrl ?? "",
            applyUrl: detail.applyUrl ?? undefined,
            postedAt: detail.releasedDate
              ? new Date(detail.releasedDate)
              : summary.releasedDate
                ? new Date(summary.releasedDate)
                : undefined,
            skills: extractSkills(description),
            jobType:
              detail.typeOfEmployment?.label ??
              summary.typeOfEmployment?.label ??
              undefined,
          };

          return matchesJobSearch(job, params) ? [job] : [];
        });
      }),
    );

    return results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
  },
};
