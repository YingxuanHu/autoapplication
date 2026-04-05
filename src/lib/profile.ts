export type ProfileSkill = {
  name: string;
};

export type ProfileExperience = {
  title: string;
  time: string;
  company: string;
  location: string;
  description: string;
};

export type ProfileEducation = {
  school: string;
  degree: string;
  time: string;
  location: string;
  description: string;
};

export type ProfileContact = {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedInUrl: string;
  githubUrl: string;
  portfolioUrl: string;
};

export type ProfileProject = {
  name: string;
  title: string;
  time: string;
  location: string;
  description: string;
};

export type ProfileFormValues = {
  headline: string;
  summary: string;
  contact: ProfileContact;
  skills: ProfileSkill[];
  educations: ProfileEducation[];
  experiences: ProfileExperience[];
  projects: ProfileProject[];
};

type StoredProfileLike = {
  headline?: string | null;
  summary?: string | null;
  skillsText?: string | null;
  experienceText?: string | null;
  educationText?: string | null;
  projectsText?: string | null;
  contactJson?: unknown;
  skillsJson?: unknown;
  educationsJson?: unknown;
  experiencesJson?: unknown;
  projectsJson?: unknown;
};

type SessionUserLike = {
  name?: string | null;
  email?: string | null;
};

const MAX_SECTION_ITEMS = 25;

function trimmedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function splitLegacyLines(value: string | null | undefined) {
  return String(value ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, MAX_SECTION_ITEMS);
}

function joinNonEmpty(parts: string[]) {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" | ");
}

function formatEntryDescription(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function textOrNull(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function parseJsonPayload(value: FormDataEntryValue | null): unknown {
  if (typeof value !== "string") {
    return [];
  }

  const input = value.trim();
  if (!input) {
    return [];
  }

  try {
    return JSON.parse(input);
  } catch {
    return [];
  }
}

export function normalizeSkills(value: unknown): ProfileSkill[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: ProfileSkill[] = [];
  for (const item of value) {
    let name = "";
    if (typeof item === "string") {
      name = trimmedText(item, 120);
    } else if (item && typeof item === "object") {
      name = trimmedText((item as { name?: unknown }).name, 120);
    }

    if (!name) {
      continue;
    }

    normalized.push({ name });
    if (normalized.length >= MAX_SECTION_ITEMS) {
      break;
    }
  }

  return normalized;
}

export function normalizeExperiences(value: unknown): ProfileExperience[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: ProfileExperience[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const objectValue = item as Record<string, unknown>;
    const entry = {
      title: trimmedText(objectValue.title, 140),
      time: trimmedText(objectValue.time, 100),
      company: trimmedText(objectValue.company, 140),
      location: trimmedText(objectValue.location, 140),
      description: trimmedText(objectValue.description, 3000),
    };

    if (!entry.title && !entry.company && !entry.description) {
      continue;
    }

    normalized.push(entry);
    if (normalized.length >= MAX_SECTION_ITEMS) {
      break;
    }
  }

  return normalized;
}

export function normalizeProjects(value: unknown): ProfileProject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: ProfileProject[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const objectValue = item as Record<string, unknown>;
    const entry = {
      name: trimmedText(objectValue.name, 160),
      title: trimmedText(objectValue.title, 140),
      time: trimmedText(objectValue.time, 100),
      location: trimmedText(objectValue.location, 140),
      description: trimmedText(objectValue.description, 3000),
    };

    if (!entry.name && !entry.title && !entry.description) {
      continue;
    }

    normalized.push(entry);
    if (normalized.length >= MAX_SECTION_ITEMS) {
      break;
    }
  }

  return normalized;
}

export function normalizeEducations(value: unknown): ProfileEducation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: ProfileEducation[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const objectValue = item as Record<string, unknown>;
    const entry = {
      school: trimmedText(objectValue.school, 160),
      degree: trimmedText(objectValue.degree, 160),
      time: trimmedText(objectValue.time, 100),
      location: trimmedText(objectValue.location, 140),
      description: trimmedText(objectValue.description, 3000),
    };

    if (!entry.school && !entry.degree && !entry.description) {
      continue;
    }

    normalized.push(entry);
    if (normalized.length >= MAX_SECTION_ITEMS) {
      break;
    }
  }

  return normalized;
}

export function normalizeContact(value: unknown): ProfileContact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return makeEmptyContact();
  }

  const objectValue = value as Record<string, unknown>;

  return {
    fullName: trimmedText(objectValue.fullName, 160),
    email: trimmedText(objectValue.email, 160),
    phone: trimmedText(objectValue.phone, 80),
    location: trimmedText(objectValue.location, 140),
    linkedInUrl: trimmedText(objectValue.linkedInUrl ?? objectValue.linkedinUrl, 280),
    githubUrl: trimmedText(objectValue.githubUrl, 280),
    portfolioUrl: trimmedText(objectValue.portfolioUrl, 280),
  };
}

export function makeEmptySkill(): ProfileSkill {
  return { name: "" };
}

export function makeEmptyExperience(): ProfileExperience {
  return {
    title: "",
    time: "",
    company: "",
    location: "",
    description: "",
  };
}

export function makeEmptyProject(): ProfileProject {
  return {
    name: "",
    title: "",
    time: "",
    location: "",
    description: "",
  };
}

export function makeEmptyEducation(): ProfileEducation {
  return {
    school: "",
    degree: "",
    time: "",
    location: "",
    description: "",
  };
}

export function makeEmptyContact(): ProfileContact {
  return {
    fullName: "",
    email: "",
    phone: "",
    location: "",
    linkedInUrl: "",
    githubUrl: "",
    portfolioUrl: "",
  };
}

export function buildProfileTextCopies(input: {
  skills: ProfileSkill[];
  experiences: ProfileExperience[];
  educations: ProfileEducation[];
  projects: ProfileProject[];
  legacyEducationText?: string;
}) {
  const skillsText = textOrNull(
    input.skills
      .map((entry) => entry.name.trim())
      .filter(Boolean)
      .join("\n")
  );
  const experienceText = textOrNull(
    input.experiences
      .map((entry) =>
        [
          joinNonEmpty([entry.title, entry.company]),
          joinNonEmpty([entry.time, entry.location]),
          formatEntryDescription(entry.description),
        ]
          .filter(Boolean)
          .join("\n")
      )
      .filter(Boolean)
      .join("\n\n")
  );

  const educationText =
    textOrNull(
      input.educations
        .map((entry) =>
          [
            joinNonEmpty([entry.school, entry.degree]),
            joinNonEmpty([entry.time, entry.location]),
            formatEntryDescription(entry.description),
          ]
            .filter(Boolean)
            .join("\n")
        )
        .filter(Boolean)
        .join("\n\n")
    ) ?? textOrNull(input.legacyEducationText ?? "");

  const projectsText = textOrNull(
    input.projects
      .map((entry) =>
        [
          joinNonEmpty([entry.name, entry.title]),
          joinNonEmpty([entry.time, entry.location]),
          formatEntryDescription(entry.description),
        ]
          .filter(Boolean)
          .join("\n")
      )
      .filter(Boolean)
      .join("\n\n")
  );

  return {
    skillsText,
    experienceText,
    educationText,
    projectsText,
  };
}

export function buildProfileFormValues(
  profile: StoredProfileLike | null | undefined,
  user?: SessionUserLike
): ProfileFormValues {
  const contact = normalizeContact(profile?.contactJson);
  const skills = normalizeSkills(profile?.skillsJson);
  const educations = normalizeEducations(profile?.educationsJson);
  const experiences = normalizeExperiences(profile?.experiencesJson);
  const projects = normalizeProjects(profile?.projectsJson);

  const fallbackContact =
    Object.values(contact).some((value) => value.length > 0)
      ? contact
      : {
          fullName: user?.name ?? "",
          email: user?.email ?? "",
          phone: "",
          location: "",
          linkedInUrl: "",
          githubUrl: "",
          portfolioUrl: "",
        };

  return {
    headline: profile?.headline?.trim() ?? "",
    summary: profile?.summary?.trim() ?? "",
    contact: fallbackContact,
    skills:
      skills.length > 0
        ? skills
        : splitLegacyLines(profile?.skillsText).map((entry) => ({ name: entry })),
    educations:
      educations.length > 0
        ? educations
        : profile?.educationText
          ? [
              {
                school: "",
                degree: "",
                time: "",
                location: "",
                description: profile.educationText,
              },
            ]
          : [],
    experiences:
      experiences.length > 0
        ? experiences
        : profile?.experienceText
          ? [
              {
                title: "",
                time: "",
                company: "",
                location: "",
                description: profile.experienceText,
              },
            ]
          : [],
    projects:
      projects.length > 0
        ? projects
        : profile?.projectsText
          ? [
              {
                name: "",
                title: "",
                time: "",
                location: "",
                description: profile.projectsText,
              },
            ]
          : [],
  };
}
