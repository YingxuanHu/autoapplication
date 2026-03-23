import axios from "axios";
import type { CompanySource } from "@/generated/prisma";
import type { NormalizedJob } from "@/types/index";
import {
  extractSkills,
  htmlToPlainText,
  inferWorkMode,
  summarizeText,
} from "@/lib/job-sources/utils";

const USER_AGENT = "AutoApplicationBot/1.0";
const REQUEST_TIMEOUT = 15_000;

interface RecruiteeOffer {
  id?: number;
  slug?: string;
  title?: string;
  department?: string;
  description?: string;
  requirements?: string;
  location?: string;
  city?: string;
  country?: string;
  region?: string;
  remote?: boolean;
  position?: string;
  employment_type_code?: string;
  careers_url?: string;
  careers_apply_url?: string;
  url?: string;
  created_at?: string;
  published_at?: string;
  min_hours?: number;
  max_hours?: number;
  salary_min?: number;
  salary_max?: number;
  salary_currency?: string;
}

interface RecruiteeResponse {
  offers?: RecruiteeOffer[];
}

/**
 * Fetch jobs from a Recruitee career page.
 *
 * API endpoint:
 *   GET https://{company}.recruitee.com/api/offers/
 *
 * Returns a JSON object with an `offers` array.
 */
export async function fetchRecruiteeJobs(
  source: CompanySource,
  companyName: string,
): Promise<NormalizedJob[]> {
  const token = source.boardToken;
  if (!token) return [];

  try {
    const response = await axios.get<RecruiteeResponse>(
      `https://${token}.recruitee.com/api/offers/`,
      {
        timeout: REQUEST_TIMEOUT,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      },
    );

    const offers = response.data.offers ?? [];
    return offers.map((offer) => mapRecruiteeOffer(offer, token, companyName));
  } catch {
    return [];
  }
}

function mapRecruiteeOffer(
  offer: RecruiteeOffer,
  companySlug: string,
  companyName: string,
): NormalizedJob {
  const descriptionHtml = [offer.description, offer.requirements]
    .filter(Boolean)
    .join("\n\n");
  const description = htmlToPlainText(descriptionHtml);

  const locationParts = [
    offer.city || offer.location,
    offer.region,
    offer.country,
  ].filter(Boolean);
  const location =
    locationParts.length > 0
      ? locationParts.join(", ")
      : offer.remote
        ? "Remote"
        : undefined;

  const workMode = offer.remote
    ? ("REMOTE" as const)
    : inferWorkMode(location, description);

  const offerId = offer.slug || offer.id?.toString() || offer.title || "";
  const applyUrl =
    offer.careers_apply_url ||
    offer.careers_url ||
    offer.url ||
    `https://${companySlug}.recruitee.com/o/${offerId}`;
  const jobUrl =
    offer.careers_url ||
    offer.url ||
    applyUrl;

  return {
    externalId: `${companySlug}:${offerId}`,
    source: "RECRUITEE",
    title: offer.title ?? "",
    company: companyName,
    location,
    workMode,
    salaryMin: offer.salary_min ?? undefined,
    salaryMax: offer.salary_max ?? undefined,
    salaryCurrency: offer.salary_currency ?? undefined,
    description,
    summary: summarizeText(descriptionHtml),
    url: jobUrl,
    applyUrl,
    postedAt: offer.published_at
      ? new Date(offer.published_at)
      : offer.created_at
        ? new Date(offer.created_at)
        : undefined,
    skills: extractSkills(description),
    jobType: offer.employment_type_code ?? offer.position ?? undefined,
  };
}
