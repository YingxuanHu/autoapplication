import { resolveJobLinks, getSourceTrust } from "@/lib/job-links";
import {
  sanitizeCompanyName,
  sanitizeJobDescriptionText,
  sanitizeJobTitle,
} from "@/lib/job-cleanup";
import { resolveJobSalaryRange } from "@/lib/salary-extraction";
import { inferGeoScope } from "@/lib/geo-scope";
import type {
  JobCardData,
  JobCardEligibility,
  JobCardSource,
  JobDetailData,
} from "@/types";

type JobSerializationInput = {
  id: string;
  title: string;
  company: string;
  location: string;
  workMode: JobCardData["workMode"];
  industry: JobCardData["industry"];
  status: JobCardData["status"];
  region?: JobDetailData["region"];
  roleFamily: string;
  experienceLevel: JobCardData["experienceLevel"];
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  shortSummary: string;
  description: string;
  applyUrl: string;
  postedAt: Date;
  deadline: Date | null;
  eligibility: JobCardEligibility;
  sourceMappings: Array<{
    sourceName: string;
    sourceUrl: string | null;
    isPrimary: boolean;
  }>;
  isSaved: boolean;
};

export function serializeJobCardData(job: JobSerializationInput): JobCardData {
  const title = sanitizeJobTitle(job.title);
  const company = sanitizeCompanyName(job.company, {
    urls: [job.applyUrl, ...job.sourceMappings.map((mapping) => mapping.sourceUrl)],
  });
  const description = sanitizeJobDescriptionText(job.description, {
    title,
    location: job.location,
  });
  const shortSummary = job.shortSummary
    ? sanitizeJobDescriptionText(job.shortSummary, {
        title,
        location: job.location,
      })
    : job.shortSummary;
  const sourceMappings = serializeJobSourceMappings(job.sourceMappings);
  const { linkTrust, primaryExternalLink, sourcePostingLink } = resolveJobLinks({
    applyUrl: job.applyUrl,
    sourceMappings: job.sourceMappings,
  });
  const resolvedSalary = resolveJobSalaryRange({
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    description,
    regionHint: job.region ?? null,
  });

  return {
    id: job.id,
    title,
    company,
    location: job.location,
    geoScope: inferGeoScope(job.location, job.region ?? null),
    workMode: job.workMode,
    industry: job.industry,
    status: job.status,
    roleFamily: job.roleFamily,
    experienceLevel: job.experienceLevel,
    salaryMin: resolvedSalary.salaryMin,
    salaryMax: resolvedSalary.salaryMax,
    salaryCurrency: resolvedSalary.salaryCurrency,
    shortSummary,
    description,
    applyUrl: job.applyUrl,
    postedAt: job.postedAt.toISOString(),
    deadline: job.deadline?.toISOString() ?? null,
    isSaved: job.isSaved,
    eligibility: job.eligibility,
    sourceMappings,
    primaryExternalLink,
    sourcePostingLink,
    linkTrust,
  };
}

export function serializeJobDetailData(
  job: JobSerializationInput & {
    region: JobDetailData["region"];
    employmentType: JobDetailData["employmentType"];
  }
): JobDetailData {
  return {
    ...serializeJobCardData(job),
    description: job.description,
    region: job.region,
    employmentType: job.employmentType,
  };
}

function serializeJobSourceMappings(
  sourceMappings: JobSerializationInput["sourceMappings"]
): JobCardSource[] {
  return sourceMappings.map((mapping) => ({
    sourceName: mapping.sourceName,
    sourceUrl: mapping.sourceUrl,
    isPrimary: mapping.isPrimary,
    trust: getSourceTrust(mapping.sourceName, mapping.sourceUrl),
  }));
}
