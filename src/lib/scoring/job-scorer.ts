import type { Job, UserProfile, ScoredJob, ExperienceLevel } from "@/types/index";
import { DEFAULT_WEIGHTS } from "./weights";

const EXPERIENCE_ORDER: ExperienceLevel[] = [
  "ENTRY",
  "MID",
  "SENIOR",
  "LEAD",
  "EXECUTIVE",
];

function titleMatchScore(job: Job, profile: UserProfile): number {
  const jobTitle = job.title.toLowerCase();
  for (const title of profile.jobTitles) {
    if (jobTitle.includes(title.toLowerCase())) return 1;
  }
  // Partial match: check if any word from profile titles appears in job title
  for (const title of profile.jobTitles) {
    const words = title.toLowerCase().split(/\s+/);
    const matchedWords = words.filter((w) => w.length > 2 && jobTitle.includes(w));
    if (matchedWords.length > 0) return matchedWords.length / words.length;
  }
  return 0;
}

function skillsOverlapScore(job: Job, profile: UserProfile): number {
  if (profile.skills.length === 0) return 0;

  const jobSkillsLower = job.skills.map((s) => s.toLowerCase());
  const descLower = job.description.toLowerCase();

  let matched = 0;
  for (const skill of profile.skills) {
    const skillLower = skill.toLowerCase();
    if (
      jobSkillsLower.includes(skillLower) ||
      descLower.includes(skillLower)
    ) {
      matched++;
    }
  }

  return matched / profile.skills.length;
}

function locationMatchScore(job: Job, profile: UserProfile): number {
  // Work mode match
  if (
    profile.workModes.length > 0 &&
    job.workMode &&
    profile.workModes.includes(job.workMode)
  ) {
    return 1;
  }

  // Location match
  if (job.location && profile.locations.length > 0) {
    const jobLoc = job.location.toLowerCase();
    for (const loc of profile.locations) {
      if (jobLoc.includes(loc.toLowerCase())) return 1;
    }
  }

  // If profile has no preferences, neutral score
  if (profile.workModes.length === 0 && profile.locations.length === 0) {
    return 0.5;
  }

  return 0;
}

function salaryFitScore(job: Job, profile: UserProfile): number {
  if (!profile.salaryMin && !profile.salaryMax) return 0.5;
  if (!job.salaryMin && !job.salaryMax) return 0.5;

  const jobMin = job.salaryMin ?? 0;
  const jobMax = job.salaryMax ?? Infinity;
  const profMin = profile.salaryMin ?? 0;
  const profMax = profile.salaryMax ?? Infinity;

  // Full overlap
  if (jobMax >= profMin && jobMin <= profMax) return 1;

  // Calculate how far outside the range
  const gap = jobMax < profMin
    ? (profMin - jobMax) / profMin
    : (jobMin - profMax) / jobMin;

  return Math.max(0, 1 - gap * 2);
}

function experienceMatchScore(job: Job, profile: UserProfile): number {
  if (!profile.experienceLevel) return 0.5;

  // Try to infer level from job title
  const titleLower = job.title.toLowerCase();
  let jobLevel: ExperienceLevel | null = null;

  if (titleLower.includes("senior") || titleLower.includes("sr.")) {
    jobLevel = "SENIOR";
  } else if (titleLower.includes("lead") || titleLower.includes("principal")) {
    jobLevel = "LEAD";
  } else if (
    titleLower.includes("junior") ||
    titleLower.includes("jr.") ||
    titleLower.includes("entry")
  ) {
    jobLevel = "ENTRY";
  } else if (
    titleLower.includes("director") ||
    titleLower.includes("vp") ||
    titleLower.includes("chief")
  ) {
    jobLevel = "EXECUTIVE";
  } else if (titleLower.includes("mid") || titleLower.includes("intermediate")) {
    jobLevel = "MID";
  }

  if (!jobLevel) return 0.5;

  const profIdx = EXPERIENCE_ORDER.indexOf(profile.experienceLevel);
  const jobIdx = EXPERIENCE_ORDER.indexOf(jobLevel);

  if (profIdx === jobIdx) return 1;
  if (Math.abs(profIdx - jobIdx) === 1) return 0.5;
  return 0;
}

function buildMatchReasons(
  scores: Record<string, number>,
  job: Job,
  profile: UserProfile,
): string[] {
  const reasons: string[] = [];

  if (scores.titleMatch > 0.5) {
    reasons.push("Job title matches your preferences");
  }
  if (scores.skillsOverlap > 0.5) {
    const matched = profile.skills.filter((s) => {
      const lower = s.toLowerCase();
      return (
        job.skills.some((js) => js.toLowerCase() === lower) ||
        job.description.toLowerCase().includes(lower)
      );
    });
    reasons.push(`Skills match: ${matched.slice(0, 5).join(", ")}`);
  }
  if (scores.locationMatch > 0.5) {
    reasons.push("Location/work mode matches your preferences");
  }
  if (scores.salaryFit > 0.7) {
    reasons.push("Salary range aligns with your expectations");
  }
  if (scores.experienceMatch > 0.5) {
    reasons.push("Experience level is a good fit");
  }

  return reasons;
}

export function scoreJob(job: Job, profile: UserProfile): ScoredJob {
  const scores = {
    titleMatch: titleMatchScore(job, profile),
    skillsOverlap: skillsOverlapScore(job, profile),
    locationMatch: locationMatchScore(job, profile),
    salaryFit: salaryFitScore(job, profile),
    experienceMatch: experienceMatchScore(job, profile),
  };

  const totalWeight = Object.values(DEFAULT_WEIGHTS).reduce(
    (sum, w) => sum + w,
    0,
  );

  const weightedScore =
    (scores.titleMatch * DEFAULT_WEIGHTS.titleMatch +
      scores.skillsOverlap * DEFAULT_WEIGHTS.skillsOverlap +
      scores.locationMatch * DEFAULT_WEIGHTS.locationMatch +
      scores.salaryFit * DEFAULT_WEIGHTS.salaryFit +
      scores.experienceMatch * DEFAULT_WEIGHTS.experienceMatch) /
    totalWeight;

  const score = Math.round(weightedScore * 100);
  const matchReasons = buildMatchReasons(scores, job, profile);

  return {
    ...job,
    score,
    matchReasons,
  };
}

export function scoreJobs(jobs: Job[], profile: UserProfile): ScoredJob[] {
  return jobs
    .map((job) => scoreJob(job, profile))
    .sort((a, b) => b.score - a.score);
}
