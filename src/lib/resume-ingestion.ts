import "server-only";

import { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import {
  buildProfileTextCopies,
  makeEmptyContact,
  normalizeContact,
  normalizeEducations,
  normalizeExperiences,
  normalizeProjects,
  normalizeSkills,
  type ProfileContact,
  type ProfileEducation,
  type ProfileExperience,
  type ProfileProject,
  type ProfileSkill,
} from "@/lib/profile";
import { getFastModel, getOpenAIClient, getOpenAIReadiness } from "@/lib/openai";
import {
  type MergeCollectionSummary,
  type ResumeImportSummary,
} from "@/lib/resume-shared";

type ResumeExtractionMode = "text" | "file" | "image" | "pdf_image" | "heuristic";

export type EditableProfileValues = {
  headline: string;
  summary: string;
  contact: ProfileContact;
  skills: ProfileSkill[];
  educations: ProfileEducation[];
  experiences: ProfileExperience[];
  projects: ProfileProject[];
};

type ResumeExtractionOverview = {
  fullName: string;
  headline: string;
  summary: string;
  email: string;
  phone: string;
  location: string;
  linkedInUrl: string;
  githubUrl: string;
  portfolioUrl: string;
};

const resumeExtractionSchema = z.object({
  overview: z.object({
    fullName: z.string(),
    headline: z.string(),
    summary: z.string(),
    email: z.string(),
    phone: z.string(),
    location: z.string(),
    linkedInUrl: z.string(),
    githubUrl: z.string(),
    portfolioUrl: z.string(),
  }),
  skills: z.array(
    z.object({
      name: z.string(),
    })
  ),
  experiences: z.array(
    z.object({
      title: z.string(),
      time: z.string(),
      company: z.string(),
      location: z.string(),
      description: z.string(),
    })
  ),
  educations: z.array(
    z.object({
      school: z.string(),
      degree: z.string(),
      time: z.string(),
      location: z.string(),
      description: z.string(),
    })
  ),
  projects: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      time: z.string(),
      location: z.string(),
      description: z.string(),
    })
  ),
});

export type ResumeExtractionResult = z.infer<typeof resumeExtractionSchema>;

export type ResumeIngestionResult = {
  extractionMode: ResumeExtractionMode;
  extractionModel: string;
  extractedProfile: ResumeExtractionResult;
  extractedText: string;
  importSummary: ResumeImportSummary;
  mergedProfile: EditableProfileValues;
  keywords: string[];
  sectionsSnapshot: {
    extractionMode: ResumeExtractionMode;
    counts: {
      skills: number;
      experiences: number;
      educations: number;
      projects: number;
    };
    overviewPresent: boolean;
  };
};

type ExtractedResumePayload = {
  extractionMode: ResumeExtractionMode;
  extractedText: string;
  profile: ResumeExtractionResult;
  modelLabel: string;
  warnings: string[];
};

const supportedResumeExtensions = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".txt",
  ".rtf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
]);

const imageMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

const MAX_PROFILE_ITEMS = 25;
const MIN_RELIABLE_TEXT_LENGTH = 280;

const extractionInstructions = `
You convert resumes into structured profile data for a job-application tracker.

Rules:
- Return only information grounded in the resume or image content.
- If a field is missing or uncertain, return an empty string or empty array.
- Separate each work experience into its own entry.
- Separate each education item into its own entry.
- Separate each project into its own entry.
- Put bullet points, accomplishments, and responsibilities only in description.
- Do not place bullets into company, title, school, degree, project name, time, or location fields.
- Preserve the date range text as it appears, but clean obvious OCR spacing artifacts.
- Use headline only if the resume clearly presents a role focus or professional title.
- Use summary only if the resume clearly contains a summary/profile/objective/about section or introductory professional summary.
- Skills should be atomic skill names, not long phrases or sentences.
- Keep descriptions concise but informative, using newline-separated bullet text with no bullet characters.
`.trim();

export function isSupportedResumeFile(fileName: string, mimeType: string) {
  const extension = fileNameExtension(fileName);
  if (supportedResumeExtensions.has(extension)) {
    return true;
  }

  return imageMimeTypes.has(mimeType.toLowerCase());
}

export function baseResumeTitle(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").trim() || "Resume";
}

export function makeEmptyEditableProfile(
  user: { name?: string | null; email?: string | null } = {}
): EditableProfileValues {
  return {
    headline: "",
    summary: "",
    contact: {
      ...makeEmptyContact(),
      fullName: user.name ?? "",
      email: user.email ?? "",
    },
    skills: [],
    educations: [],
    experiences: [],
    projects: [],
  };
}

export function buildResumeImportSuccessMessage(summary: ResumeImportSummary) {
  const parts = [
    summary.skills.added.length > 0 ? `${summary.skills.added.length} skill(s)` : null,
    summary.experiences.added.length + summary.experiences.updated.length > 0
      ? `${summary.experiences.added.length} new / ${summary.experiences.updated.length} updated experience`
      : null,
    summary.educations.added.length + summary.educations.updated.length > 0
      ? `${summary.educations.added.length} new / ${summary.educations.updated.length} updated education`
      : null,
    summary.projects.added.length + summary.projects.updated.length > 0
      ? `${summary.projects.added.length} new / ${summary.projects.updated.length} updated project`
      : null,
  ].filter(Boolean);

  if (parts.length === 0) {
    return "Resume imported. No new profile entries were added.";
  }

  return `Resume imported. ${parts.join(", ")} merged into your profile.`;
}

export function buildProfilePersistenceInput(profile: EditableProfileValues) {
  const textCopies = buildProfileTextCopies({
    skills: profile.skills,
    experiences: profile.experiences,
    educations: profile.educations,
    projects: profile.projects,
  });
  const hasContact = Object.values(profile.contact).some((value) => value.trim().length > 0);

  return {
    headline: profile.headline.trim() || null,
    summary: profile.summary.trim() || null,
    skillsText: textCopies.skillsText,
    experienceText: textCopies.experienceText,
    educationText: textCopies.educationText,
    projectsText: textCopies.projectsText,
    contactJson: hasContact ? profile.contact : null,
    skillsJson: profile.skills.length > 0 ? profile.skills : null,
    educationsJson: profile.educations.length > 0 ? profile.educations : null,
    experiencesJson: profile.experiences.length > 0 ? profile.experiences : null,
    projectsJson: profile.projects.length > 0 ? profile.projects : null,
  };
}

export async function ingestResumeIntoProfile(input: {
  existingProfile: EditableProfileValues;
  fileName: string;
  mimeType: string;
  fileBuffer: Buffer;
}) {
  const extraction = await extractStructuredResume({
    fileBuffer: input.fileBuffer,
    fileName: input.fileName,
    mimeType: input.mimeType,
  });

  const mergeResult = mergeResumeProfile({
    existingProfile: input.existingProfile,
    extractedProfile: extraction.profile,
    extractionMode: extraction.extractionMode,
    extractionModel: extraction.modelLabel,
    warnings: extraction.warnings,
  });

  return {
    extractionMode: extraction.extractionMode,
    extractionModel: extraction.modelLabel,
    extractedProfile: extraction.profile,
    extractedText: extraction.extractedText,
    importSummary: mergeResult.importSummary,
    mergedProfile: mergeResult.profile,
    keywords: buildAnalysisKeywords(extraction.profile),
    sectionsSnapshot: {
      extractionMode: extraction.extractionMode,
      counts: {
        skills: extraction.profile.skills.length,
        experiences: extraction.profile.experiences.length,
        educations: extraction.profile.educations.length,
        projects: extraction.profile.projects.length,
      },
      overviewPresent:
        Boolean(extraction.profile.overview.headline) ||
        Boolean(extraction.profile.overview.summary) ||
        Boolean(extraction.profile.overview.fullName) ||
        Boolean(extraction.profile.overview.email),
    },
  } satisfies ResumeIngestionResult;
}

async function extractStructuredResume(input: {
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
}): Promise<ExtractedResumePayload> {
  const localText = await extractLocalText(input.fileBuffer, input.fileName, input.mimeType);
  const openAIReadiness = getOpenAIReadiness();

  if (openAIReadiness.configured) {
    try {
      const extractionMode = await chooseExtractionMode({
        fileBuffer: input.fileBuffer,
        fileName: input.fileName,
        mimeType: input.mimeType,
        localText,
      });
      const profile = await requestResumeExtraction({
        fileBuffer: input.fileBuffer,
        fileName: input.fileName,
        mimeType: input.mimeType,
        localText,
        extractionMode: extractionMode.mode,
        pdfPreviewDataUrls: extractionMode.pdfPreviewDataUrls,
      });

      if (!hasExtractedProfileContent(profile)) {
        throw new Error("No profile data could be extracted from that resume.");
      }

      return {
        extractionMode: extractionMode.mode,
        extractedText: chooseExtractedText(localText, profile),
        profile,
        modelLabel: getFastModel(),
        warnings: [],
      };
    } catch (error) {
      if (!localText.trim()) {
        throw normalizeExtractionError(error);
      }

      const heuristicProfile = heuristicResumeExtraction(localText);
      if (!hasExtractedProfileContent(heuristicProfile)) {
        throw normalizeExtractionError(error);
      }

      return {
        extractionMode: "heuristic",
        extractedText: chooseExtractedText(localText, heuristicProfile),
        profile: heuristicProfile,
        modelLabel: "local-parser",
        warnings: [
          "OpenAI extraction was unavailable, so a local text parser was used instead.",
          normalizeExtractionError(error).message,
        ],
      };
    }
  }

  if (!localText.trim()) {
    throw new Error(
      "This resume needs OpenAI extraction. Configure OPENAI_API_KEY or upload a text-based PDF, DOCX, DOC, TXT, or RTF file."
    );
  }

  const heuristicProfile = heuristicResumeExtraction(localText);
  if (!hasExtractedProfileContent(heuristicProfile)) {
    throw new Error("No profile data could be extracted from that resume.");
  }

  return {
    extractionMode: "heuristic",
    extractedText: chooseExtractedText(localText, heuristicProfile),
    profile: heuristicProfile,
    modelLabel: "local-parser",
    warnings: [
      "OpenAI is not configured, so a local text parser was used for this import.",
    ],
  };
}

function chooseExtractedText(localText: string, profile: ResumeExtractionResult) {
  if (localText.trim()) {
    return localText;
  }

  const textCopies = buildProfileTextCopies({
    skills: normalizeSkills(profile.skills),
    experiences: normalizeExperiences(profile.experiences),
    educations: normalizeEducations(profile.educations),
    projects: normalizeProjects(profile.projects),
  });

  return [
    textCopies.skillsText,
    textCopies.experienceText,
    textCopies.educationText,
    textCopies.projectsText,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function chooseExtractionMode(input: {
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
  localText: string;
}) {
  if (isImageFile(input.fileName, input.mimeType)) {
    return {
      mode: "image" as const,
      pdfPreviewDataUrls: [] as string[],
    };
  }

  const extension = fileNameExtension(input.fileName);
  if (extension === ".pdf" && input.localText.length < MIN_RELIABLE_TEXT_LENGTH) {
    const previewDataUrls = await renderPdfPreviewDataUrls(input.fileBuffer);
    if (previewDataUrls.length > 0) {
      return {
        mode: "pdf_image" as const,
        pdfPreviewDataUrls: previewDataUrls,
      };
    }
  }

  if (input.localText.length > 0) {
    return {
      mode: "text" as const,
      pdfPreviewDataUrls: [] as string[],
    };
  }

  return {
    mode: "file" as const,
    pdfPreviewDataUrls: [] as string[],
  };
}

async function requestResumeExtraction(input: {
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
  localText: string;
  extractionMode: Exclude<ResumeExtractionMode, "heuristic">;
  pdfPreviewDataUrls: string[];
}) {
  const client = getOpenAIClient();

  const prompt = [
    `Resume file name: ${input.fileName}`,
    `Content type: ${input.mimeType || "unknown"}`,
    input.extractionMode === "text"
      ? "Parse the following extracted resume text into the schema."
      : "Parse the attached resume content into the schema.",
  ].join("\n");

  const content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string; detail: "high" | "auto" }
    | { type: "input_file"; file_id: string }
  > = [
    {
      type: "input_text",
      text:
        input.extractionMode === "text"
          ? `${prompt}\n\nResume text:\n${input.localText}`
          : prompt,
    },
  ];

  if (input.extractionMode === "image") {
    content.push({
      type: "input_image",
      image_url: bufferToDataUrl(input.fileBuffer, input.mimeType || "image/png"),
      detail: "high",
    });
  } else if (input.extractionMode === "pdf_image") {
    for (const dataUrl of input.pdfPreviewDataUrls) {
      content.push({
        type: "input_image",
        image_url: dataUrl,
        detail: "high",
      });
    }
  } else if (input.extractionMode === "file") {
    const uploadedFile = await client.files.create({
      file: await toFile(input.fileBuffer, input.fileName, {
        type: input.mimeType || "application/octet-stream",
      }),
      purpose: "user_data",
    });

    content.push({
      type: "input_file",
      file_id: uploadedFile.id,
    });

    try {
      const response = await client.responses.parse({
        model: getFastModel(),
        instructions: extractionInstructions,
        input: [
          {
            role: "user",
            content,
          },
        ],
        text: {
          format: zodTextFormat(resumeExtractionSchema, "resume_profile_extract"),
        },
      });

      const parsed = response.output_parsed;
      if (!parsed) {
        throw new Error("Resume extraction returned no structured output.");
      }

      return sanitizeExtraction(parsed);
    } finally {
      try {
        await client.files.delete(uploadedFile.id);
      } catch {
        // Best-effort cleanup for temporary OpenAI input files.
      }
    }
  }

  const response = await client.responses.parse({
    model: getFastModel(),
    instructions: extractionInstructions,
    input: [
      {
        role: "user",
        content,
      },
    ],
    text: {
      format: zodTextFormat(resumeExtractionSchema, "resume_profile_extract"),
    },
  });

  const parsed = response.output_parsed;
  if (!parsed) {
    throw new Error("Resume extraction returned no structured output.");
  }

  return sanitizeExtraction(parsed);
}

async function extractLocalText(fileBuffer: Buffer, fileName: string, mimeType: string) {
  const extension = fileNameExtension(fileName);

  try {
    if (extension === ".txt") {
      return sanitizePlainText(fileBuffer.toString("utf8"));
    }

    if (extension === ".rtf") {
      return sanitizePlainText(stripRtfMarkup(fileBuffer.toString("utf8")));
    }

    if (extension === ".docx") {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      return sanitizePlainText(result.value);
    }

    if (extension === ".doc") {
      const { default: WordExtractor } = await import("word-extractor");
      const extractor = new WordExtractor();
      const document = await extractor.extract(fileBuffer);
      return sanitizePlainText(document.getBody());
    }

    if (extension === ".pdf" || mimeType === "application/pdf") {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: fileBuffer });
      try {
        const result = await parser.getText();
        return sanitizePlainText(result.text);
      } finally {
        await parser.destroy();
      }
    }
  } catch {
    return "";
  }

  return "";
}

async function renderPdfPreviewDataUrls(fileBuffer: Buffer) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: fileBuffer });

  try {
    const result = await parser.getScreenshot({
      first: 2,
      imageBuffer: false,
      imageDataUrl: true,
      scale: 1.8,
    });

    return result.pages.map((page) => page.dataUrl).filter(Boolean);
  } catch {
    return [];
  } finally {
    await parser.destroy();
  }
}

function sanitizeExtraction(parsed: ResumeExtractionResult): ResumeExtractionResult {
  const overview = sanitizeOverview(parsed.overview);

  return {
    overview,
    skills: normalizeSkills(parsed.skills).map((entry) => ({
      name: entry.name,
    })),
    experiences: normalizeExperiences(parsed.experiences).map((entry) => ({
      title: entry.title,
      time: entry.time,
      company: entry.company,
      location: entry.location,
      description: normalizeDescription(entry.description, 3000),
    })),
    educations: normalizeEducations(parsed.educations).map((entry) => ({
      school: entry.school,
      degree: entry.degree,
      time: entry.time,
      location: entry.location,
      description: normalizeDescription(entry.description, 3000),
    })),
    projects: normalizeProjects(parsed.projects).map((entry) => ({
      name: entry.name,
      title: entry.title,
      time: entry.time,
      location: entry.location,
      description: normalizeDescription(entry.description, 3000),
    })),
  };
}

function sanitizeOverview(overview: ResumeExtractionOverview) {
  const normalized = normalizeContact({
    fullName: overview.fullName,
    email: overview.email,
    phone: overview.phone,
    location: overview.location,
    linkedInUrl: overview.linkedInUrl,
    githubUrl: overview.githubUrl,
    portfolioUrl: overview.portfolioUrl,
  });

  return {
    ...normalized,
    headline: trimmedSingleLine(overview.headline, 200),
    summary: normalizeDescription(overview.summary, 1200),
  };
}

function mergeResumeProfile(input: {
  existingProfile: EditableProfileValues;
  extractedProfile: ResumeExtractionResult;
  extractionMode: ResumeExtractionMode;
  extractionModel: string;
  warnings: string[];
}) {
  const profile: EditableProfileValues = {
    headline: input.existingProfile.headline.trim(),
    summary: input.existingProfile.summary.trim(),
    contact: normalizeContact(input.existingProfile.contact),
    skills: normalizeSkills(input.existingProfile.skills),
    educations: normalizeEducations(input.existingProfile.educations),
    experiences: normalizeExperiences(input.existingProfile.experiences),
    projects: normalizeProjects(input.existingProfile.projects),
  };

  const importSummary: ResumeImportSummary = {
    extractionMode: input.extractionMode,
    model: input.extractionModel,
    overview: {
      headlineFilled: false,
      summaryFilled: false,
      contactAdded: [],
      contactPreserved: [],
    },
    skills: createEmptyMergeSummary(),
    experiences: createEmptyMergeSummary(),
    educations: createEmptyMergeSummary(),
    projects: createEmptyMergeSummary(),
    warnings: [...input.warnings],
  };

  mergeOverview(profile, input.extractedProfile.overview, importSummary);
  mergeSkills(profile, input.extractedProfile.skills, importSummary.skills);
  mergeExperiences(profile, input.extractedProfile.experiences, importSummary.experiences);
  mergeEducations(profile, input.extractedProfile.educations, importSummary.educations);
  mergeProjects(profile, input.extractedProfile.projects, importSummary.projects);

  return {
    profile,
    importSummary,
  };
}

function createEmptyMergeSummary(): MergeCollectionSummary {
  return {
    added: [],
    updated: [],
    duplicates: [],
    omitted: [],
  };
}

function mergeOverview(
  profile: EditableProfileValues,
  overview: ResumeExtractionResult["overview"],
  summary: ResumeImportSummary
) {
  if (!profile.headline && overview.headline) {
    profile.headline = overview.headline;
    summary.overview.headlineFilled = true;
  }

  if (!profile.summary && overview.summary) {
    profile.summary = overview.summary;
    summary.overview.summaryFilled = true;
  }

  const contactFields: Array<{
    key: keyof ProfileContact;
    label: string;
    value: string;
  }> = [
    { key: "fullName", label: "full name", value: overview.fullName },
    { key: "email", label: "email", value: overview.email },
    { key: "phone", label: "phone", value: overview.phone },
    { key: "location", label: "location", value: overview.location },
    { key: "linkedInUrl", label: "LinkedIn", value: overview.linkedInUrl },
    { key: "githubUrl", label: "GitHub", value: overview.githubUrl },
    { key: "portfolioUrl", label: "portfolio", value: overview.portfolioUrl },
  ];

  for (const field of contactFields) {
    if (!field.value) {
      continue;
    }

    if (!profile.contact[field.key]) {
      profile.contact[field.key] = field.value;
      summary.overview.contactAdded.push(field.label);
    } else if (!sameComparable(profile.contact[field.key], field.value)) {
      summary.overview.contactPreserved.push(field.label);
    }
  }
}

function mergeSkills(
  profile: EditableProfileValues,
  incoming: ResumeExtractionResult["skills"],
  summary: MergeCollectionSummary
) {
  for (const entry of normalizeSkills(incoming)) {
    const label = entry.name;
    const existing = profile.skills.find((current) => sameComparable(current.name, entry.name));

    if (existing) {
      summary.duplicates.push(label);
      continue;
    }

    if (profile.skills.length >= MAX_PROFILE_ITEMS) {
      summary.omitted.push(label);
      continue;
    }

    profile.skills.push(entry);
    summary.added.push(label);
  }
}

function mergeExperiences(
  profile: EditableProfileValues,
  incoming: ResumeExtractionResult["experiences"],
  summary: MergeCollectionSummary
) {
  for (const entry of normalizeExperiences(incoming)) {
    const label = experienceLabel(entry);
    const existingIndex = profile.experiences.findIndex((current) => isSameExperience(current, entry));

    if (existingIndex === -1) {
      if (profile.experiences.length >= MAX_PROFILE_ITEMS) {
        summary.omitted.push(label);
        continue;
      }

      profile.experiences.push(entry);
      summary.added.push(label);
      continue;
    }

    const merged = mergeExperience(profile.experiences[existingIndex], entry);
    if (isSameExperienceRecord(profile.experiences[existingIndex], merged)) {
      summary.duplicates.push(label);
      continue;
    }

    profile.experiences[existingIndex] = merged;
    summary.updated.push(label);
  }
}

function mergeEducations(
  profile: EditableProfileValues,
  incoming: ResumeExtractionResult["educations"],
  summary: MergeCollectionSummary
) {
  for (const entry of normalizeEducations(incoming)) {
    const label = educationLabel(entry);
    const existingIndex = profile.educations.findIndex((current) => isSameEducation(current, entry));

    if (existingIndex === -1) {
      if (profile.educations.length >= MAX_PROFILE_ITEMS) {
        summary.omitted.push(label);
        continue;
      }

      profile.educations.push(entry);
      summary.added.push(label);
      continue;
    }

    const merged = mergeEducation(profile.educations[existingIndex], entry);
    if (isSameEducationRecord(profile.educations[existingIndex], merged)) {
      summary.duplicates.push(label);
      continue;
    }

    profile.educations[existingIndex] = merged;
    summary.updated.push(label);
  }
}

function mergeProjects(
  profile: EditableProfileValues,
  incoming: ResumeExtractionResult["projects"],
  summary: MergeCollectionSummary
) {
  for (const entry of normalizeProjects(incoming)) {
    const label = projectLabel(entry);
    const existingIndex = profile.projects.findIndex((current) => isSameProject(current, entry));

    if (existingIndex === -1) {
      if (profile.projects.length >= MAX_PROFILE_ITEMS) {
        summary.omitted.push(label);
        continue;
      }

      profile.projects.push(entry);
      summary.added.push(label);
      continue;
    }

    const merged = mergeProject(profile.projects[existingIndex], entry);
    if (isSameProjectRecord(profile.projects[existingIndex], merged)) {
      summary.duplicates.push(label);
      continue;
    }

    profile.projects[existingIndex] = merged;
    summary.updated.push(label);
  }
}

function mergeExperience(existing: ProfileExperience, incoming: ProfileExperience): ProfileExperience {
  return {
    title: mergeField(existing.title, incoming.title),
    time: mergeField(existing.time, incoming.time),
    company: mergeField(existing.company, incoming.company),
    location: mergeField(existing.location, incoming.location),
    description: mergeLongText(existing.description, incoming.description),
  };
}

function mergeEducation(existing: ProfileEducation, incoming: ProfileEducation): ProfileEducation {
  return {
    school: mergeField(existing.school, incoming.school),
    degree: mergeField(existing.degree, incoming.degree),
    time: mergeField(existing.time, incoming.time),
    location: mergeField(existing.location, incoming.location),
    description: mergeLongText(existing.description, incoming.description),
  };
}

function mergeProject(existing: ProfileProject, incoming: ProfileProject): ProfileProject {
  return {
    name: mergeField(existing.name, incoming.name),
    title: mergeField(existing.title, incoming.title),
    time: mergeField(existing.time, incoming.time),
    location: mergeField(existing.location, incoming.location),
    description: mergeLongText(existing.description, incoming.description),
  };
}

function mergeField(existing: string, incoming: string) {
  if (!existing.trim()) {
    return incoming.trim();
  }

  if (!incoming.trim()) {
    return existing.trim();
  }

  return incoming.trim().length > existing.trim().length ? incoming.trim() : existing.trim();
}

function mergeLongText(existing: string, incoming: string) {
  const existingLines = splitDescriptionLines(existing);
  const incomingLines = splitDescriptionLines(incoming);
  const mergedLines = [...existingLines];

  for (const line of incomingLines) {
    if (!mergedLines.some((current) => sameComparable(current, line))) {
      mergedLines.push(line);
    }
  }

  return normalizeDescription(mergedLines.join("\n"), 3000);
}

function splitDescriptionLines(value: string) {
  return normalizeDescription(value, 3000)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isSameExperience(left: ProfileExperience, right: ProfileExperience) {
  const sameCompany = sameComparable(left.company, right.company);
  const sameTitle = sameComparable(left.title, right.title);
  const sameTime = sameComparable(left.time, right.time);

  return (sameCompany && sameTitle && sameTime) || (sameCompany && sameTitle);
}

function isSameEducation(left: ProfileEducation, right: ProfileEducation) {
  const sameSchool = sameComparable(left.school, right.school);
  const sameDegree = sameComparable(left.degree, right.degree);
  const sameTime = sameComparable(left.time, right.time);

  return (sameSchool && sameDegree && sameTime) || (sameSchool && sameDegree);
}

function isSameProject(left: ProfileProject, right: ProfileProject) {
  const sameName = sameComparable(left.name, right.name);
  const sameTitle = sameComparable(left.title, right.title);
  const sameTime = sameComparable(left.time, right.time);

  return (sameName && sameTitle && sameTime) || sameName;
}

function isSameExperienceRecord(left: ProfileExperience, right: ProfileExperience) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSameEducationRecord(left: ProfileEducation, right: ProfileEducation) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSameProjectRecord(left: ProfileProject, right: ProfileProject) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function experienceLabel(entry: ProfileExperience) {
  return [entry.company, entry.title].filter(Boolean).join(" - ") || entry.title || entry.company || "Experience";
}

function educationLabel(entry: ProfileEducation) {
  return [entry.school, entry.degree].filter(Boolean).join(" - ") || entry.school || entry.degree || "Education";
}

function projectLabel(entry: ProfileProject) {
  return [entry.name, entry.title].filter(Boolean).join(" - ") || entry.name || entry.title || "Project";
}

function buildAnalysisKeywords(profile: ResumeExtractionResult) {
  const rawValues = [
    ...profile.skills.map((entry) => entry.name),
    ...profile.experiences.flatMap((entry) => [entry.title, entry.company]),
    ...profile.educations.flatMap((entry) => [entry.school, entry.degree]),
    ...profile.projects.flatMap((entry) => [entry.name, entry.title]),
  ];

  const keywords: string[] = [];
  for (const value of rawValues) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    if (keywords.some((current) => sameComparable(current, trimmed))) {
      continue;
    }

    keywords.push(trimmed);
    if (keywords.length >= 40) {
      break;
    }
  }

  return keywords;
}

function heuristicResumeExtraction(text: string): ResumeExtractionResult {
  const sanitizedText = sanitizePlainText(text);
  const sections = splitResumeSections(sanitizedText);
  const headerLines = splitIntoLines(sections.header).slice(0, 10);
  const fullName = inferFullName(headerLines);
  const email = findEmail(sanitizedText);
  const phone = findPhone(sanitizedText);
  const linkedInUrl = findLinkedInUrl(sanitizedText);
  const githubUrl = findGithubUrl(sanitizedText);
  const portfolioUrl = findPortfolioUrl(sanitizedText, linkedInUrl, githubUrl);
  const summary = parseSummarySection(sections.summary);
  const headline = inferHeadline(headerLines, fullName);
  const location = inferLocation(headerLines);

  return sanitizeExtraction({
    overview: {
      fullName,
      headline,
      summary,
      email,
      phone,
      location,
      linkedInUrl,
      githubUrl,
      portfolioUrl,
    },
    skills: parseSkillsSection(sections.skills),
    experiences: parseExperienceSection(sections.experience),
    educations: parseEducationSection(sections.education),
    projects: parseProjectSection(sections.projects),
  });
}

function splitResumeSections(text: string) {
  const sectionMap = {
    header: [] as string[],
    summary: [] as string[],
    skills: [] as string[],
    experience: [] as string[],
    education: [] as string[],
    projects: [] as string[],
  };

  let currentSection: keyof typeof sectionMap = "header";

  for (const line of splitIntoLines(text)) {
    const heading = detectSectionHeading(line);
    if (heading) {
      currentSection = heading;
      continue;
    }

    sectionMap[currentSection].push(line);
  }

  return {
    header: sectionMap.header.join("\n"),
    summary: sectionMap.summary.join("\n"),
    skills: sectionMap.skills.join("\n"),
    experience: sectionMap.experience.join("\n"),
    education: sectionMap.education.join("\n"),
    projects: sectionMap.projects.join("\n"),
  };
}

function detectSectionHeading(line: string): "summary" | "skills" | "experience" | "education" | "projects" | null {
  const normalized = line.trim().toLowerCase().replace(/[^a-z ]+/g, " ");

  if ([
    "summary",
    "professional summary",
    "profile",
    "about",
    "objective",
  ].includes(normalized)) {
    return "summary";
  }

  if ([
    "skills",
    "technical skills",
    "skills and tools",
  ].includes(normalized)) {
    return "skills";
  }

  if ([
    "experience",
    "work experience",
    "professional experience",
    "employment",
  ].includes(normalized)) {
    return "experience";
  }

  if ([
    "education",
    "academic background",
  ].includes(normalized)) {
    return "education";
  }

  if ([
    "projects",
    "personal projects",
    "selected projects",
  ].includes(normalized)) {
    return "projects";
  }

  return null;
}

function parseSummarySection(text: string) {
  return normalizeDescription(text, 1200);
}

function parseSkillsSection(text: string): ResumeExtractionResult["skills"] {
  const lines = splitIntoLines(text);
  const values = lines
    .flatMap((line) =>
      line
        .replace(/^[A-Za-z ]+:\s*/, "")
        .split(/[,|•]/)
    )
    .map((value) => trimmedSingleLine(value, 120))
    .filter(Boolean);

  const uniqueValues: string[] = [];
  for (const value of values) {
    if (uniqueValues.some((current) => sameComparable(current, value))) {
      continue;
    }

    uniqueValues.push(value);
    if (uniqueValues.length >= MAX_PROFILE_ITEMS) {
      break;
    }
  }

  return uniqueValues.map((name) => ({ name }));
}

function parseExperienceSection(text: string): ResumeExtractionResult["experiences"] {
  return splitSectionBlocks(text)
    .map(parseExperienceBlock)
    .filter((entry) => Boolean(entry.title || entry.company || entry.description))
    .slice(0, MAX_PROFILE_ITEMS);
}

function parseEducationSection(text: string): ResumeExtractionResult["educations"] {
  return splitSectionBlocks(text)
    .map(parseEducationBlock)
    .filter((entry) => Boolean(entry.school || entry.degree || entry.description))
    .slice(0, MAX_PROFILE_ITEMS);
}

function parseProjectSection(text: string): ResumeExtractionResult["projects"] {
  return splitSectionBlocks(text)
    .map(parseProjectBlock)
    .filter((entry) => Boolean(entry.name || entry.title || entry.description))
    .slice(0, MAX_PROFILE_ITEMS);
}

function parseExperienceBlock(block: string) {
  const lines = splitIntoLines(block);
  const joined = lines.join("\n");
  const time = extractDateRange(joined);
  const location = extractLocation(lines);
  const titleLine = lines[0] ?? "";
  const secondLine = lines[1] ?? "";
  const title = looksLikeOrganization(secondLine) ? titleLine : titleLine;
  const company = looksLikeOrganization(secondLine) ? secondLine : "";

  return {
    title: cleanedLine(title),
    time,
    company: cleanedLine(company),
    location,
    description: normalizeDescription(
      lines.slice(company ? 2 : 1).filter((line) => !sameComparable(line, time) && !sameComparable(line, location)).join("\n"),
      3000
    ),
  };
}

function parseEducationBlock(block: string) {
  const lines = splitIntoLines(block);
  const joined = lines.join("\n");
  const time = extractDateRange(joined);
  const location = extractLocation(lines);

  return {
    school: cleanedLine(lines[0] ?? ""),
    degree: cleanedLine(lines[1] ?? ""),
    time,
    location,
    description: normalizeDescription(
      lines.slice(2).filter((line) => !sameComparable(line, time) && !sameComparable(line, location)).join("\n"),
      3000
    ),
  };
}

function parseProjectBlock(block: string) {
  const lines = splitIntoLines(block);
  const joined = lines.join("\n");
  const time = extractDateRange(joined);
  const location = extractLocation(lines);

  return {
    name: cleanedLine(lines[0] ?? ""),
    title: cleanedLine(lines[1] ?? ""),
    time,
    location,
    description: normalizeDescription(
      lines.slice(2).filter((line) => !sameComparable(line, time) && !sameComparable(line, location)).join("\n"),
      3000
    ),
  };
}

function splitSectionBlocks(text: string) {
  const normalized = sanitizePlainText(text);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function inferFullName(lines: string[]) {
  for (const line of lines) {
    const cleaned = cleanedLine(line);
    if (!cleaned) {
      continue;
    }

    if (detectSectionHeading(cleaned)) {
      continue;
    }

    if (cleaned.includes("@") || /^https?:\/\//i.test(cleaned)) {
      continue;
    }

    if (/\d/.test(cleaned)) {
      continue;
    }

    return cleaned;
  }

  return "";
}

function inferHeadline(lines: string[], fullName: string) {
  for (const line of lines) {
    const cleaned = cleanedLine(line);
    if (!cleaned || sameComparable(cleaned, fullName)) {
      continue;
    }

    if (cleaned.includes("@") || cleaned.includes("linkedin") || cleaned.includes("github")) {
      continue;
    }

    if (detectSectionHeading(cleaned)) {
      continue;
    }

    if (cleaned.split(" ").length <= 12) {
      return cleaned;
    }
  }

  return "";
}

function inferLocation(lines: string[]) {
  for (const line of lines) {
    const cleaned = cleanedLine(line);
    if (!cleaned || cleaned.includes("@")) {
      continue;
    }

    if (/remote/i.test(cleaned)) {
      return cleaned;
    }

    if (/[A-Za-z]+,\s*[A-Za-z]{2,}/.test(cleaned)) {
      return cleaned;
    }
  }

  return "";
}

function findEmail(text: string) {
  return cleanedLine(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "");
}

function findPhone(text: string) {
  return cleanedLine(text.match(/(?:\+\d{1,3}[\s-]?)?(?:\(?\d{3}\)?[\s-]?)\d{3}[\s-]?\d{4}/)?.[0] ?? "");
}

function findLinkedInUrl(text: string) {
  return cleanedLine(text.match(/https?:\/\/(?:www\.)?linkedin\.com\/[^\s)]+/i)?.[0] ?? "");
}

function findGithubUrl(text: string) {
  return cleanedLine(text.match(/https?:\/\/(?:www\.)?github\.com\/[^\s)]+/i)?.[0] ?? "");
}

function findPortfolioUrl(text: string, linkedInUrl: string, githubUrl: string) {
  const matches = text.match(/https?:\/\/[^\s)]+/gi) ?? [];
  for (const match of matches) {
    if (sameComparable(match, linkedInUrl) || sameComparable(match, githubUrl)) {
      continue;
    }

    return cleanedLine(match);
  }

  return "";
}

function extractDateRange(text: string) {
  const normalized = text.replace(/\u2013|\u2014/g, "-");
  const match = normalized.match(
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)?\.?\s*\d{4}\s*-\s*(?:Present|Current|Now|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)?\.?\s*\d{4})\b/i
  );

  return cleanedLine(match?.[0] ?? "");
}

function extractLocation(lines: string[]) {
  for (const line of lines) {
    const cleaned = cleanedLine(line);
    if (!cleaned) {
      continue;
    }

    if (/remote/i.test(cleaned)) {
      return cleaned;
    }

    if (/[A-Za-z]+,\s*[A-Za-z]{2,}/.test(cleaned)) {
      return cleaned;
    }
  }

  return "";
}

function looksLikeOrganization(line: string) {
  const cleaned = cleanedLine(line);
  if (!cleaned) {
    return false;
  }

  return /\b(university|college|inc|corp|company|ltd|llc|technologies|systems|software|lab|laboratories)\b/i.test(cleaned);
}

function cleanedLine(value: string) {
  return trimmedSingleLine(
    value.replace(/^[•\-*]+\s*/, "").replace(/\s+/g, " "),
    200
  );
}

function normalizeDescription(value: string, maxLength: number) {
  return value
    .replace(/[•●▪■]/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean)
    .join("\n")
    .slice(0, maxLength);
}

function sanitizePlainText(value: string) {
  return value
    .replace(/\r/g, "")
    .replace(/\u0000/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F\u2010-\u201F]/g, " ")
    .trim();
}

function splitIntoLines(value: string) {
  return sanitizePlainText(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function stripRtfMarkup(value: string) {
  return value
    .replace(/\\par[d]?/gi, "\n")
    .replace(/\\tab/gi, " ")
    .replace(/\\'[0-9a-f]{2}/gi, (match) =>
      String.fromCharCode(Number.parseInt(match.slice(2), 16))
    )
    .replace(/\\u-?\d+\??/gi, " ")
    .replace(/\\[a-z]+-?\d* ?/gi, " ")
    .replace(/[{}]/g, " ");
}

function fileNameExtension(fileName: string) {
  const match = /\.[^.]+$/.exec(fileName.toLowerCase());
  return match ? match[0] : "";
}

function isImageFile(fileName: string, mimeType: string) {
  return imageMimeTypes.has(mimeType.toLowerCase()) ||
    [".png", ".jpg", ".jpeg", ".webp"].includes(fileNameExtension(fileName));
}

function bufferToDataUrl(buffer: Buffer, mimeType: string) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function trimmedSingleLine(value: string, maxLength: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function toComparable(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sameComparable(left: string, right: string) {
  if (!left.trim() || !right.trim()) {
    return false;
  }

  return toComparable(left) === toComparable(right);
}

function hasExtractedProfileContent(profile: ResumeExtractionResult) {
  return (
    Boolean(profile.overview.fullName) ||
    Boolean(profile.overview.email) ||
    Boolean(profile.overview.summary) ||
    profile.skills.length > 0 ||
    profile.experiences.length > 0 ||
    profile.educations.length > 0 ||
    profile.projects.length > 0
  );
}

function normalizeExtractionError(error: unknown) {
  if (error instanceof Error) {
    return error;
  }

  return new Error("Resume extraction failed.");
}
