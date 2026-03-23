interface ResumeLike {
  id: string;
  skills: string[];
}

interface JobLike {
  skills: string[];
  description: string;
}

export function findBestResume<T extends ResumeLike>(
  resumes: T[],
  job: JobLike,
): T | null {
  if (resumes.length === 0) return null;

  const jobSkillsLower = job.skills.map((s) => s.toLowerCase());
  const descLower = job.description.toLowerCase();

  let bestResume: T | null = null;
  let bestScore = -1;

  for (const resume of resumes) {
    let overlap = 0;

    for (const skill of resume.skills) {
      const skillLower = skill.toLowerCase();
      if (
        jobSkillsLower.includes(skillLower) ||
        descLower.includes(skillLower)
      ) {
        overlap++;
      }
    }

    if (overlap > bestScore) {
      bestScore = overlap;
      bestResume = resume;
    }
  }

  return bestResume;
}
