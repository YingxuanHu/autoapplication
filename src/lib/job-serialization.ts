import { resolveJobLinks, getSourceTrust } from "@/lib/job-links";
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
  roleFamily: string;
  experienceLevel: JobCardData["experienceLevel"];
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  shortSummary: string;
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
  const sourceMappings = serializeJobSourceMappings(job.sourceMappings);
  const { linkTrust, primaryExternalLink, sourcePostingLink } = resolveJobLinks({
    applyUrl: job.applyUrl,
    sourceMappings: job.sourceMappings,
  });

  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    workMode: job.workMode,
    industry: job.industry,
    status: job.status,
    roleFamily: job.roleFamily,
    experienceLevel: job.experienceLevel,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    shortSummary: job.shortSummary,
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
    description: string;
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
