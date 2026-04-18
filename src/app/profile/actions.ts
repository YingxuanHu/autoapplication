"use server";

import { revalidatePath } from "next/cache";

import { Prisma } from "@/generated/prisma/client";
import { requireCurrentUserProfile, UnauthorizedError } from "@/lib/current-user";
import { prisma } from "@/lib/db";
import {
  buildProfileTextCopies,
  normalizeContact,
  normalizeEducations,
  normalizeExperiences,
  normalizeProjects,
  normalizeSkills,
  parseJsonPayload,
} from "@/lib/profile";
import {
  buildDocumentStorageKey,
  deleteFile,
  getStorageReadiness,
  saveFile,
} from "@/lib/storage";

type ProfileActionState = {
  error: string | null;
  success: string | null;
};

const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_TEMPLATE_SIZE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_TEMPLATE_EXTENSIONS = [
  ".tex",
  ".cls",
  ".sty",
  ".typ",
  ".txt",
  ".md",
  ".html",
  ".css",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".rtf",
];
const SUPPORTED_TEMPLATE_ACCEPT =
  ".tex,.cls,.sty,.typ,.txt,.md,.html,.css,.json,.yaml,.yml,.xml,.rtf";

async function requireProfileForAction() {
  try {
    return await requireCurrentUserProfile();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return null;
    }
    throw error;
  }
}

function revalidateProfileViews() {
  revalidatePath("/profile");
  revalidatePath("/applications");
  revalidatePath("/applications/history");
  revalidatePath("/dashboard");
}

function inferMimeType(fileName: string, mimeType: string) {
  if (mimeType.trim()) {
    return mimeType;
  }

  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lowerName.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lowerName.endsWith(".doc")) {
    return "application/msword";
  }
  if (lowerName.endsWith(".txt")) {
    return "text/plain";
  }
  if (lowerName.endsWith(".rtf")) {
    return "application/rtf";
  }
  if (lowerName.endsWith(".png")) {
    return "image/png";
  }
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lowerName.endsWith(".webp")) {
    return "image/webp";
  }
  if (lowerName.endsWith(".tex")) {
    return "text/x-tex";
  }
  if (lowerName.endsWith(".md")) {
    return "text/markdown";
  }
  if (lowerName.endsWith(".html")) {
    return "text/html";
  }
  if (lowerName.endsWith(".css")) {
    return "text/css";
  }
  if (lowerName.endsWith(".yaml") || lowerName.endsWith(".yml")) {
    return "application/yaml";
  }
  if (lowerName.endsWith(".json")) {
    return "application/json";
  }
  if (lowerName.endsWith(".xml")) {
    return "application/xml";
  }

  return "application/octet-stream";
}

async function promotePrimaryResume(tx: Prisma.TransactionClient, userId: string, documentId: string) {
  await tx.document.updateMany({
    where: {
      userId,
      type: "RESUME",
      isPrimary: true,
    },
    data: {
      isPrimary: false,
    },
  });

  await tx.resumeVariant.updateMany({
    where: {
      userId,
      isDefault: true,
    },
    data: {
      isDefault: false,
    },
  });

  await tx.document.update({
    where: { id: documentId },
    data: { isPrimary: true },
  });

  await tx.resumeVariant.updateMany({
    where: {
      userId,
      documentId,
    },
    data: {
      isDefault: true,
    },
  });
}

export async function saveProfile(
  _prevState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
  const user = await requireProfileForAction();
  if (!user) {
    return {
      error: "You must sign in before updating profile.",
      success: null,
    };
  }

  const headline = String(formData.get("headline") ?? "").trim();
  const summary = String(formData.get("summary") ?? "").trim();
  const location = String(formData.get("location") ?? "").trim();
  const legacyEducationText = String(formData.get("educationText") ?? "").trim();
  const contact = normalizeContact(parseJsonPayload(formData.get("contactJson")));
  const skills = normalizeSkills(parseJsonPayload(formData.get("skillsJson")));
  const educations = normalizeEducations(parseJsonPayload(formData.get("educationsJson")));
  const experiences = normalizeExperiences(parseJsonPayload(formData.get("experiencesJson")));
  const projects = normalizeProjects(parseJsonPayload(formData.get("projectsJson")));

  if (headline.length > 200) {
    return {
      error: "Headline is too long (max 200 characters).",
      success: null,
    };
  }

  const textCopies = buildProfileTextCopies({
    skills,
    experiences,
    educations,
    projects,
    legacyEducationText,
  });
  const skillsJson = skills.length > 0 ? skills : Prisma.DbNull;
  const hasContact = Object.values(contact).some((value) => value.length > 0);
  const contactJson = hasContact ? contact : Prisma.DbNull;
  const educationsJson = educations.length > 0 ? educations : Prisma.DbNull;
  const experiencesJson = experiences.length > 0 ? experiences : Prisma.DbNull;
  const projectsJson = projects.length > 0 ? projects : Prisma.DbNull;

  await prisma.userProfile.update({
    where: {
      id: user.id,
    },
    data: {
      location: location || null,
      headline: headline || null,
      summary: summary || null,
      skillsText: textCopies.skillsText,
      experienceText: textCopies.experienceText,
      educationText: textCopies.educationText,
      projectsText: textCopies.projectsText,
      contactJson,
      skillsJson,
      educationsJson,
      experiencesJson,
      projectsJson,
    },
  });

  revalidateProfileViews();

  return {
    error: null,
    success: "Profile saved.",
  };
}

export async function setPrimaryProfileResume(
  _prevState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
  const user = await requireProfileForAction();
  if (!user) {
    return {
      error: "You must sign in before updating your primary resume.",
      success: null,
    };
  }

  const documentId = String(formData.get("documentId") ?? "").trim();
  if (!documentId) {
    return {
      error: "Resume ID is missing.",
      success: null,
    };
  }

  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      userId: user.id,
      type: "RESUME",
    },
    select: {
      id: true,
    },
  });

  if (!document) {
    return {
      error: "Resume not found.",
      success: null,
    };
  }

  await prisma.$transaction(async (tx) => {
    await promotePrimaryResume(tx, user.id, document.id);
  });

  revalidateProfileViews();

  return {
    error: null,
    success: "Primary resume updated.",
  };
}

export async function uploadProfileCoverLetter(
  _prevState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
  const user = await requireProfileForAction();
  if (!user) {
    return {
      error: "You must sign in before uploading a cover letter.",
      success: null,
    };
  }

  const storageReadiness = getStorageReadiness();
  if (!storageReadiness.configured) {
    return {
      error: `Storage is not configured. Missing: ${storageReadiness.missingKeys.join(", ")}.`,
      success: null,
    };
  }

  const file = formData.get("file");
  const titleRaw = String(formData.get("title") ?? "").trim();

  if (!(file instanceof File) || file.size === 0) {
    return {
      error: "Choose a file to upload.",
      success: null,
    };
  }

  if (file.size > MAX_DOCUMENT_SIZE_BYTES) {
    return {
      error: "Cover letter files must stay under 10 MB.",
      success: null,
    };
  }

  const mimeType = inferMimeType(file.name, file.type);
  const title = titleRaw || file.name.replace(/\.[^.]+$/, "");
  const extension = /\.[^.]+$/.exec(file.name)?.[0] || ".pdf";
  const storageKey = buildDocumentStorageKey({
    userId: user.id,
    title,
    extension,
    type: "COVER_LETTER",
  });

  try {
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    await saveFile(storageKey, fileBuffer, {
      contentType: mimeType,
    });

    await prisma.document.create({
      data: {
        userId: user.id,
        type: "COVER_LETTER",
        title,
        originalFileName: file.name,
        filename: file.name,
        storageKey,
        mimeType,
        sizeBytes: file.size,
        isPrimary: false,
      },
    });
  } catch (error) {
    try {
      await deleteFile(storageKey);
    } catch {
      // Best-effort cleanup.
    }

    return {
      error: error instanceof Error ? error.message : "Cover letter upload failed.",
      success: null,
    };
  }

  revalidateProfileViews();

  return {
    error: null,
    success: "Cover letter uploaded.",
  };
}

export async function deleteProfileCoverLetter(
  _prevState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
  const user = await requireProfileForAction();
  if (!user) {
    return {
      error: "You must sign in before deleting a cover letter.",
      success: null,
    };
  }

  const documentId = String(formData.get("documentId") ?? "").trim();
  if (!documentId) {
    return {
      error: "Cover letter ID is missing.",
      success: null,
    };
  }

  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      userId: user.id,
      type: "COVER_LETTER",
    },
    select: {
      id: true,
      storageKey: true,
    },
  });

  if (!document) {
    return {
      error: "Cover letter not found.",
      success: null,
    };
  }

  try {
    await deleteFile(document.storageKey);
  } catch {
    return {
      error: "Could not delete the file from storage. Please try again.",
      success: null,
    };
  }

  await prisma.document.delete({
    where: {
      id: document.id,
    },
  });

  revalidateProfileViews();

  return {
    error: null,
    success: "Cover letter deleted.",
  };
}

export async function deleteProfileResume(
  _prevState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
  const user = await requireProfileForAction();
  if (!user) {
    return {
      error: "You must sign in before deleting a resume.",
      success: null,
    };
  }

  const documentId = String(formData.get("documentId") ?? "").trim();
  if (!documentId) {
    return {
      error: "Resume ID is missing.",
      success: null,
    };
  }

  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      userId: user.id,
      type: "RESUME",
    },
    select: {
      id: true,
      storageKey: true,
      isPrimary: true,
    },
  });

  if (!document) {
    return {
      error: "Resume not found.",
      success: null,
    };
  }

  try {
    await deleteFile(document.storageKey);
  } catch {
    return {
      error: "Could not delete the file from storage. Please try again.",
      success: null,
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.document.delete({
      where: {
        id: document.id,
      },
    });

    if (document.isPrimary) {
      const next = await tx.document.findFirst({
        where: {
          userId: user.id,
          type: "RESUME",
        },
        orderBy: [{ createdAt: "desc" }],
        select: { id: true },
      });
      if (next) {
        await promotePrimaryResume(tx, user.id, next.id);
      }
    }
  });

  revalidateProfileViews();

  return {
    error: null,
    success: "Resume deleted.",
  };
}

export async function importDocumentToProfile(
  _prevState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
  const user = await requireProfileForAction();
  if (!user) {
    return {
      error: "You must sign in before importing a resume into your profile.",
      success: null,
    };
  }

  const documentId = String(formData.get("documentId") ?? "").trim();
  if (!documentId) {
    return {
      error: "Resume ID is missing.",
      success: null,
    };
  }

  try {
    const { syncStoredResumeForProfile } = await import("@/lib/profile-resume-service");
    const result = await syncStoredResumeForProfile({
      user,
      documentId,
    });

    revalidateProfileViews();

    return {
      error: null,
      success: result.message,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Resume import failed.",
      success: null,
    };
  }
}

export async function uploadTemplate(
  _prevState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
  const user = await requireProfileForAction();
  if (!user) {
    return {
      error: "Sign in required.",
      success: null,
    };
  }

  const storageReadiness = getStorageReadiness();
  if (!storageReadiness.configured) {
    return {
      error: `Storage not configured. Missing: ${storageReadiness.missingKeys.join(", ")}.`,
      success: null,
    };
  }

  const file = formData.get("file");
  const titleRaw = String(formData.get("title") ?? "").trim();
  const makePrimary = formData.get("makePrimary") === "on";

  if (!(file instanceof File) || file.size === 0) {
    return {
      error: `Choose a template file (${SUPPORTED_TEMPLATE_ACCEPT}).`,
      success: null,
    };
  }

  if (file.size > MAX_TEMPLATE_SIZE_BYTES) {
    return {
      error: "Template files must stay under 5 MB.",
      success: null,
    };
  }

  const ext = /\.[^.]+$/.exec(file.name.toLowerCase())?.[0] ?? "";
  if (!SUPPORTED_TEMPLATE_EXTENSIONS.includes(ext)) {
    return {
      error: "Unsupported format. Use a text-readable source file: .tex, .typ, .md, .html, .json, .yaml, .txt, etc.",
      success: null,
    };
  }

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const mimeType = inferMimeType(file.name, file.type);
  const title = titleRaw || file.name.replace(/\.[^.]+$/, "");

  const textContent = fileBuffer.toString("utf-8");

  const storageKey = buildDocumentStorageKey({
    userId: user.id,
    title,
    extension: ext,
    type: "RESUME_TEMPLATE",
  });

  try {
    await saveFile(storageKey, fileBuffer, { contentType: mimeType });

    await prisma.$transaction(async (tx) => {
      const existingCount = await tx.document.count({
        where: { userId: user.id, type: "RESUME_TEMPLATE" },
      });

      const shouldBePrimary = makePrimary || existingCount === 0;

      if (shouldBePrimary) {
        await tx.document.updateMany({
          where: { userId: user.id, type: "RESUME_TEMPLATE", isPrimary: true },
          data: { isPrimary: false },
        });
      }

      const document = await tx.document.create({
        data: {
          userId: user.id,
          type: "RESUME_TEMPLATE",
          title,
          originalFileName: file.name,
          filename: file.name,
          storageKey,
          mimeType,
          sizeBytes: file.size,
          isPrimary: shouldBePrimary,
          extractedText: textContent,
          extractedAt: new Date(),
        },
      });

      await tx.documentAnalysis.create({
        data: {
          documentId: document.id,
          extractedText: textContent,
          keywordsJson: [],
          sectionsJson: {},
        },
      });
    });
  } catch (error) {
    try {
      await deleteFile(storageKey);
    } catch {
      // best-effort cleanup
    }
    return {
      error: error instanceof Error ? error.message : "Template upload failed.",
      success: null,
    };
  }

  revalidateProfileViews();
  return {
    error: null,
    success: "Template uploaded.",
  };
}

export async function setPrimaryTemplate(
  _prevState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
  const user = await requireProfileForAction();
  if (!user) {
    return { error: "Sign in required.", success: null };
  }

  const documentId = String(formData.get("documentId") ?? "").trim();
  if (!documentId) {
    return { error: "Template ID is missing.", success: null };
  }

  const document = await prisma.document.findFirst({
    where: { id: documentId, userId: user.id, type: "RESUME_TEMPLATE" },
    select: { id: true },
  });

  if (!document) {
    return { error: "Template not found.", success: null };
  }

  await prisma.$transaction(async (tx) => {
    await tx.document.updateMany({
      where: { userId: user.id, type: "RESUME_TEMPLATE", isPrimary: true },
      data: { isPrimary: false },
    });
    await tx.document.update({
      where: { id: document.id },
      data: { isPrimary: true },
    });
  });

  revalidateProfileViews();
  return { error: null, success: "Primary template updated." };
}

export async function deleteTemplate(
  _prevState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
  const user = await requireProfileForAction();
  if (!user) {
    return { error: "Sign in required.", success: null };
  }

  const documentId = String(formData.get("documentId") ?? "").trim();
  if (!documentId) {
    return { error: "Template ID is missing.", success: null };
  }

  const document = await prisma.document.findFirst({
    where: { id: documentId, userId: user.id, type: "RESUME_TEMPLATE" },
    select: { id: true, storageKey: true, isPrimary: true },
  });

  if (!document) {
    return { error: "Template not found.", success: null };
  }

  try {
    await deleteFile(document.storageKey);
  } catch {
    return {
      error: "Could not delete the file from storage. Please try again.",
      success: null,
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.document.delete({ where: { id: document.id } });

    if (document.isPrimary) {
      const next = await tx.document.findFirst({
        where: { userId: user.id, type: "RESUME_TEMPLATE" },
        orderBy: [{ createdAt: "desc" }],
        select: { id: true },
      });
      if (next) {
        await tx.document.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    }
  });

  revalidateProfileViews();
  return { error: null, success: "Template deleted." };
}

export async function renameDocument(
  _prevState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
  const user = await requireProfileForAction();
  if (!user) {
    return { error: "Sign in required.", success: null };
  }

  const documentId = String(formData.get("documentId") ?? "").trim();
  const newTitle = String(formData.get("title") ?? "").trim();

  if (!documentId) {
    return { error: "Document ID is missing.", success: null };
  }

  if (!newTitle || newTitle.length < 1) {
    return { error: "Title cannot be empty.", success: null };
  }

  if (newTitle.length > 200) {
    return { error: "Title is too long (max 200 characters).", success: null };
  }

  const document = await prisma.document.findFirst({
    where: { id: documentId, userId: user.id },
    select: { id: true, type: true },
  });

  if (!document) {
    return { error: "Document not found.", success: null };
  }

  await prisma.$transaction(async (tx) => {
    await tx.document.update({
      where: { id: document.id },
      data: { title: newTitle },
    });

    if (document.type === "RESUME") {
      await tx.resumeVariant.updateMany({
        where: { userId: user.id, documentId: document.id },
        data: { label: newTitle },
      });
    }
  });

  revalidateProfileViews();
  return { error: null, success: "Renamed." };
}
