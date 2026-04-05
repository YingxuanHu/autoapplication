import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  buildProfileFormValues,
} from "@/lib/profile";
import {
  baseResumeTitle,
  buildProfilePersistenceInput,
  buildResumeImportSuccessMessage,
  ingestResumeIntoProfile,
  isSupportedResumeFile,
  makeEmptyEditableProfile,
} from "@/lib/resume-ingestion";
import { supportedResumeAcceptValue } from "@/lib/resume-shared";
import {
  buildDocumentStorageKey,
  deleteFile,
  readStoredFile,
  saveFile,
} from "@/lib/storage";

const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;

type ProfileUser = {
  id: string;
  name?: string | null;
  email?: string | null;
};

export function inferProfileDocumentMimeType(fileName: string, mimeType: string) {
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

  return "application/octet-stream";
}

async function loadEditableProfileValues(user: ProfileUser) {
  const storedProfile = await prisma.userProfile.findUnique({
    where: {
      id: user.id,
    },
    select: {
      headline: true,
      summary: true,
      skillsText: true,
      experienceText: true,
      educationText: true,
      projectsText: true,
      contactJson: true,
      skillsJson: true,
      educationsJson: true,
      experiencesJson: true,
      projectsJson: true,
    },
  });

  return storedProfile
    ? buildProfileFormValues(storedProfile, user)
    : makeEmptyEditableProfile(user);
}

function dbJsonValue<T>(value: T | null) {
  return value === null ? Prisma.DbNull : value;
}

async function upsertResumeAnalysis(tx: Prisma.TransactionClient, input: {
  documentId: string;
  extractedText: string;
  keywords: string[];
  sectionsSnapshot: {
    extractionMode: "text" | "file" | "image" | "pdf_image" | "heuristic";
    counts: {
      skills: number;
      experiences: number;
      educations: number;
      projects: number;
    };
    overviewPresent: boolean;
  };
  structuredProfileJson: unknown;
  importSummaryJson: unknown;
  importedAt: Date;
}) {
  await tx.documentAnalysis.upsert({
    where: { documentId: input.documentId },
    update: {
      extractedText: input.extractedText,
      keywordsJson: input.keywords,
      sectionsJson: input.sectionsSnapshot,
      structuredProfileJson: input.structuredProfileJson as Prisma.InputJsonValue,
      importSummaryJson: input.importSummaryJson as Prisma.InputJsonValue,
      updatedAt: input.importedAt,
    },
    create: {
      documentId: input.documentId,
      extractedText: input.extractedText,
      keywordsJson: input.keywords as Prisma.InputJsonValue,
      sectionsJson: input.sectionsSnapshot as Prisma.InputJsonValue,
      structuredProfileJson: input.structuredProfileJson as Prisma.InputJsonValue,
      importSummaryJson: input.importSummaryJson as Prisma.InputJsonValue,
      createdAt: input.importedAt,
      updatedAt: input.importedAt,
    },
  });
}

function resumeUploadError(message: string) {
  return new Error(message);
}

function resumeExtension(fileName: string) {
  return /\.[^.]+$/.exec(fileName)?.[0] || ".pdf";
}

export async function importUploadedResumeForProfile(input: {
  user: ProfileUser;
  file: File;
  titleRaw: string;
  makePrimary: boolean;
}) {
  if (input.file.size === 0) {
    throw resumeUploadError(`Choose a supported resume file (${supportedResumeAcceptValue}).`);
  }

  if (input.file.size > MAX_DOCUMENT_SIZE_BYTES) {
    throw resumeUploadError("Resume files must stay under 10 MB.");
  }

  const mimeType = inferProfileDocumentMimeType(input.file.name, input.file.type);
  if (!isSupportedResumeFile(input.file.name, mimeType)) {
    throw resumeUploadError(
      "Unsupported resume format. Use PDF, DOCX, DOC, TXT, RTF, PNG, JPG, JPEG, or WEBP."
    );
  }

  const fileBuffer = Buffer.from(await input.file.arrayBuffer());
  const existingProfile = await loadEditableProfileValues(input.user);

  const ingestion = await ingestResumeIntoProfile({
    existingProfile,
    fileBuffer,
    fileName: input.file.name,
    mimeType,
  });

  const title = input.titleRaw || baseResumeTitle(input.file.name);
  const storageKey = buildDocumentStorageKey({
    userId: input.user.id,
    title,
    extension: resumeExtension(input.file.name),
    type: "RESUME",
  });

  let markedPrimary = false;

  try {
    await saveFile(storageKey, fileBuffer, { contentType: mimeType });

    await prisma.$transaction(async (tx) => {
      const existingResumeCount = await tx.document.count({
        where: {
          userId: input.user.id,
          type: "RESUME",
        },
      });

      markedPrimary = input.makePrimary || existingResumeCount === 0;

      if (markedPrimary) {
        await tx.document.updateMany({
          where: {
            userId: input.user.id,
            type: "RESUME",
            isPrimary: true,
          },
          data: {
            isPrimary: false,
          },
        });

        await tx.resumeVariant.updateMany({
          where: {
            userId: input.user.id,
            isDefault: true,
          },
          data: {
            isDefault: false,
          },
        });
      }

      const importedAt = new Date();
      const document = await tx.document.create({
        data: {
          userId: input.user.id,
          type: "RESUME",
          title,
          originalFileName: input.file.name,
          filename: input.file.name,
          storageKey,
          mimeType,
          sizeBytes: input.file.size,
          isPrimary: markedPrimary,
          extractedText: ingestion.extractedText,
          extractedAt: importedAt,
        },
      });

      await tx.resumeVariant.create({
        data: {
          userId: input.user.id,
          label: title,
          documentId: document.id,
          content: ingestion.extractedText,
          isDefault: markedPrimary,
        },
      });

      await upsertResumeAnalysis(tx, {
        documentId: document.id,
        extractedText: ingestion.extractedText,
        keywords: ingestion.keywords,
        sectionsSnapshot: ingestion.sectionsSnapshot,
        structuredProfileJson: ingestion.extractedProfile,
        importSummaryJson: {
          ...ingestion.importSummary,
          primaryAssigned: markedPrimary,
        },
        importedAt,
      });

      const persistence = buildProfilePersistenceInput(ingestion.mergedProfile);
      await tx.userProfile.update({
        where: {
          id: input.user.id,
        },
        data: {
          headline: persistence.headline,
          summary: persistence.summary,
          skillsText: persistence.skillsText,
          experienceText: persistence.experienceText,
          educationText: persistence.educationText,
          projectsText: persistence.projectsText,
          contactJson: dbJsonValue(persistence.contactJson),
          skillsJson: dbJsonValue(persistence.skillsJson),
          educationsJson: dbJsonValue(persistence.educationsJson),
          experiencesJson: dbJsonValue(persistence.experiencesJson),
          projectsJson: dbJsonValue(persistence.projectsJson),
        },
      });
    });
  } catch (error) {
    try {
      await deleteFile(storageKey);
    } catch {
      // Best-effort cleanup if the DB write fails after upload.
    }
    throw error;
  }

  return {
    message: `${buildResumeImportSuccessMessage(ingestion.importSummary)}${
      markedPrimary ? " Marked as primary." : ""
    }`,
  };
}

export async function syncStoredResumeForProfile(input: {
  user: ProfileUser;
  documentId: string;
}) {
  const document = await prisma.document.findFirst({
    where: {
      id: input.documentId,
      userId: input.user.id,
      type: "RESUME",
    },
    select: {
      id: true,
      title: true,
      originalFileName: true,
      mimeType: true,
      storageKey: true,
      isPrimary: true,
      resumeVariant: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!document) {
    throw resumeUploadError("Resume not found.");
  }

  const fileBuffer = await readStoredFile(document.storageKey);
  if (!fileBuffer) {
    throw resumeUploadError("Stored resume file could not be read.");
  }

  const existingProfile = await loadEditableProfileValues(input.user);
  const ingestion = await ingestResumeIntoProfile({
    existingProfile,
    fileBuffer,
    fileName: document.originalFileName,
    mimeType: document.mimeType,
  });

  await prisma.$transaction(async (tx) => {
    const importedAt = new Date();

    await tx.document.update({
      where: {
        id: document.id,
      },
      data: {
        extractedText: ingestion.extractedText,
        extractedAt: importedAt,
      },
    });

    if (document.resumeVariant) {
      await tx.resumeVariant.update({
        where: {
          id: document.resumeVariant.id,
        },
        data: {
          label: document.title,
          content: ingestion.extractedText,
          isDefault: document.isPrimary,
        },
      });
    } else {
      await tx.resumeVariant.create({
        data: {
          userId: input.user.id,
          label: document.title,
          documentId: document.id,
          content: ingestion.extractedText,
          isDefault: document.isPrimary,
        },
      });
    }

    await upsertResumeAnalysis(tx, {
      documentId: document.id,
      extractedText: ingestion.extractedText,
      keywords: ingestion.keywords,
      sectionsSnapshot: ingestion.sectionsSnapshot,
      structuredProfileJson: ingestion.extractedProfile,
      importSummaryJson: {
        ...ingestion.importSummary,
        primaryAssigned: document.isPrimary,
      },
      importedAt,
    });

    const persistence = buildProfilePersistenceInput(ingestion.mergedProfile);
    await tx.userProfile.update({
      where: {
        id: input.user.id,
      },
      data: {
        headline: persistence.headline,
        summary: persistence.summary,
        skillsText: persistence.skillsText,
        experienceText: persistence.experienceText,
        educationText: persistence.educationText,
        projectsText: persistence.projectsText,
        contactJson: dbJsonValue(persistence.contactJson),
        skillsJson: dbJsonValue(persistence.skillsJson),
        educationsJson: dbJsonValue(persistence.educationsJson),
        experiencesJson: dbJsonValue(persistence.experiencesJson),
        projectsJson: dbJsonValue(persistence.projectsJson),
      },
    });
  });

  return {
    message: buildResumeImportSuccessMessage(ingestion.importSummary),
  };
}
