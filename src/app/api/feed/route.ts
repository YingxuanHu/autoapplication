import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensureDiscoveryWorkerStarted } from "@/lib/discovery/bootstrap";
import { scoreJobs } from "@/lib/scoring/job-scorer";
import type { Job, UserProfile } from "@/types/index";
import type { SourceType } from "@/generated/prisma";

const EMPTY_PROFILE_CREATE = {
  jobTitles: [] as string[],
  jobAreas: [] as string[],
  locations: [] as string[],
  workModes: [] as Array<"REMOTE" | "HYBRID" | "ONSITE">,
  excludeCompanies: [] as string[],
  excludeKeywords: [] as string[],
  skills: [] as string[],
};

function hasPersonalization(profile: UserProfile): boolean {
  return (
    profile.jobTitles.length > 0 ||
    profile.jobAreas.length > 0 ||
    profile.locations.length > 0 ||
    profile.workModes.length > 0 ||
    profile.skills.length > 0 ||
    Boolean(profile.experienceLevel) ||
    Boolean(profile.salaryMin) ||
    Boolean(profile.salaryMax) ||
    profile.excludeCompanies.length > 0 ||
    profile.excludeKeywords.length > 0
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function containsAny(text: string, terms: string[]): boolean {
  const normalizedText = normalize(text);
  return terms.some((term) => normalizedText.includes(normalize(term)));
}

function matchesWorkMode(job: Job, profile: UserProfile): boolean {
  if (profile.workModes.length === 0) return true;
  return job.workMode ? profile.workModes.includes(job.workMode) : false;
}

function matchesLocation(job: Job, profile: UserProfile): boolean {
  if (profile.locations.length === 0) return true;
  if (!job.location) return false;
  return containsAny(job.location, profile.locations);
}

function matchesSalary(job: Job, profile: UserProfile): boolean {
  if (!profile.salaryMin && !profile.salaryMax) return true;
  if (!job.salaryMin && !job.salaryMax) return false;

  const jobMin = job.salaryMin ?? 0;
  const jobMax = job.salaryMax ?? Infinity;
  const profileMin = profile.salaryMin ?? 0;
  const profileMax = profile.salaryMax ?? Infinity;

  return jobMax >= profileMin && jobMin <= profileMax;
}

function matchesJobArea(job: Job, profile: UserProfile): boolean {
  if (profile.jobAreas.length === 0) return true;

  const haystack = [
    job.title,
    job.jobType ?? "",
    job.summary ?? "",
    job.description,
    job.skills.join(" "),
  ].join(" ");

  return containsAny(haystack, profile.jobAreas);
}

function hasExcludedKeyword(job: Job, profile: UserProfile): boolean {
  if (profile.excludeKeywords.length === 0) return false;

  const haystack = [
    job.title,
    job.company,
    job.location ?? "",
    job.jobType ?? "",
    job.summary ?? "",
    job.description,
    job.skills.join(" "),
  ].join(" ");

  return containsAny(haystack, profile.excludeKeywords);
}

function passesHardFilters(job: Job, profile: UserProfile): boolean {
  return (
    matchesWorkMode(job, profile) &&
    matchesLocation(job, profile) &&
    matchesSalary(job, profile) &&
    matchesJobArea(job, profile) &&
    !hasExcludedKeyword(job, profile)
  );
}

function computeMatchReasons(job: Job, profile: UserProfile): string[] {
  const reasons: string[] = [];

  // Title match
  const jobTitleLower = job.title.toLowerCase();
  for (const title of profile.jobTitles) {
    if (jobTitleLower.includes(title.toLowerCase())) {
      reasons.push(`Matches your target role: ${title}`);
      break;
    }
  }

  // Location / work mode match
  if (job.workMode && profile.workModes.includes(job.workMode)) {
    const modeLabel = job.workMode === "REMOTE" ? "Remote" : job.workMode === "HYBRID" ? "Hybrid" : "Onsite";
    reasons.push(`${modeLabel} \u2014 matches your preference`);
  } else if (job.location && profile.locations.length > 0) {
    const locLower = job.location.toLowerCase();
    for (const loc of profile.locations) {
      if (locLower.includes(loc.toLowerCase())) {
        reasons.push(`Location matches: ${loc}`);
        break;
      }
    }
  }

  // Salary match
  if (
    (profile.salaryMin || profile.salaryMax) &&
    (job.salaryMin || job.salaryMax)
  ) {
    const jobMin = job.salaryMin ?? 0;
    const jobMax = job.salaryMax ?? Infinity;
    const profMin = profile.salaryMin ?? 0;
    const profMax = profile.salaryMax ?? Infinity;
    if (jobMax >= profMin && jobMin <= profMax) {
      reasons.push("Salary range matches your target");
    }
  }

  // Skills match
  if (profile.skills.length > 0 && job.skills.length > 0) {
    const jobSkillsLower = job.skills.map((s) => s.toLowerCase());
    const matched = profile.skills.filter((s) =>
      jobSkillsLower.includes(s.toLowerCase())
    );
    if (matched.length > 0) {
      const display = matched.slice(0, 4).join(", ");
      reasons.push(
        `${matched.length} of your skills match: ${display}${matched.length > 4 ? "..." : ""}`
      );
    }
  }

  return reasons;
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    ensureDiscoveryWorkerStarted();

    const searchParams = request.nextUrl.searchParams;
    const limit = Math.min(
      50,
      Math.max(1, parseInt(searchParams.get("limit") || "10", 10))
    );
    const directOnly = searchParams.get("directOnly") === "true";

    const profile = await prisma.userProfile.upsert({
      where: { userId: session.user.id },
      update: {},
      create: {
        userId: session.user.id,
        ...EMPTY_PROFILE_CREATE,
      },
    });

    // Get job IDs the user has already acted on
    const actedJobIds = await prisma.feedAction.findMany({
      where: { userId: session.user.id },
      select: { jobId: true },
    });
    const actedIds = actedJobIds.map((a) => a.jobId);

    // Build where clause
    const fetchWindow = Math.min(500, Math.max(200, limit * 15));
    const jobs = await prisma.job.findMany({
      where: {
        isActive: true,
        id: actedIds.length > 0 ? { notIn: actedIds } : undefined,
        company:
          profile.excludeCompanies.length > 0
            ? { notIn: profile.excludeCompanies }
            : undefined,
        ...(directOnly ? { isDirectApply: true } : {}),
      },
      take: fetchWindow,
      orderBy: { createdAt: "desc" },
    });

    const shouldPersonalize = hasPersonalization(profile);
    const eligibleJobs = shouldPersonalize
      ? jobs.filter((job) => passesHardFilters(job, profile))
      : jobs;
    const scored = scoreJobs(eligibleJobs, profile);

    // Boost score based on sourceTrust and directApply for better ordering
    const boosted = scored.map((job) => {
      const trustBoost = (job.sourceTrust ?? 0.5) * 10; // 0-10 point boost
      const directBoost = job.isDirectApply ? 5 : 0; // 5 point boost for direct apply
      const stemBoost = (job.stemScore ?? 0) * 8;
      const northAmericaBoost =
        job.regionScope === "US" ||
        job.regionScope === "CA" ||
        job.regionScope === "NA"
          ? 3
          : 0;
      const enrichedMatchReasons = computeMatchReasons(job, profile);

      return {
        ...job,
        score: Math.round(
          job.score + trustBoost + directBoost + stemBoost + northAmericaBoost,
        ),
        sourceLabel: getSourceLabel(job.sourceType, job.source),
        sourceType: job.sourceType,
        sourceTrust: job.sourceTrust,
        isDirectApply: job.isDirectApply,
        matchReasons:
          enrichedMatchReasons.length > 0
            ? enrichedMatchReasons
            : job.matchReasons,
      };
    });

    // Re-sort after applying trust boost
    boosted.sort((a, b) => b.score - a.score);

    const topJobs = boosted.slice(0, limit);

    return NextResponse.json(topJobs);
  } catch (error) {
    console.error("Failed to get feed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

function getSourceLabel(
  sourceType: SourceType | null | undefined,
  source: string,
): string {
  if (sourceType === "ATS_BOARD") {
    const atsNames: Record<string, string> = {
      GREENHOUSE: "Greenhouse",
      LEVER: "Lever",
      ASHBY: "Ashby",
      SMARTRECRUITERS: "SmartRecruiters",
      WORKABLE: "Workable",
      WORKDAY: "Workday",
      TEAMTAILOR: "Teamtailor",
      RECRUITEE: "Recruitee",
    };
    return atsNames[source] ?? source;
  }
  if (sourceType === "CAREER_PAGE") return "Company Site";
  if (sourceType === "STRUCTURED_DATA") return "Structured Data";
  if (sourceType === "AGGREGATOR") return "Job Board";

  // Fallback based on source
  const sourceNames: Record<string, string> = {
    JSEARCH: "JSearch",
    ADZUNA: "Adzuna",
    THE_MUSE: "The Muse",
    USAJOBS: "USAJOBS",
    REED: "Reed",
    REMOTIVE: "Remotive",
    JOBICY: "Jobicy",
    CAREERONESTOP: "CareerOneStop",
    JOOBLE: "Jooble",
    GREENHOUSE: "Greenhouse",
    LEVER: "Lever",
    ASHBY: "Ashby",
    SMARTRECRUITERS: "SmartRecruiters",
    WORKABLE: "Workable",
    WORKDAY: "Workday",
    TEAMTAILOR: "Teamtailor",
    RECRUITEE: "Recruitee",
    COMPANY_SITE: "Company Site",
    STRUCTURED_DATA: "Structured Data",
    MANUAL: "Manual",
  };
  return sourceNames[source] ?? source;
}
