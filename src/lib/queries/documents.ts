import { prisma } from "@/lib/db";
import { DEMO_USER_ID } from "@/lib/constants";

export async function getDocuments(type?: "RESUME" | "COVER_LETTER") {
  return prisma.document.findMany({
    where: { userId: DEMO_USER_ID, ...(type ? { type } : {}) },
    orderBy: { createdAt: "desc" },
    include: { resumeVariant: { select: { id: true, label: true } } },
  });
}

export async function getDocument(id: string) {
  return prisma.document.findFirst({
    where: { id, userId: DEMO_USER_ID },
    include: { resumeVariant: { select: { id: true, label: true } } },
  });
}

export async function createDocumentWithVariant(data: {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  type: "RESUME" | "COVER_LETTER";
  extractedText?: string | null;
}) {
  // Create Document and link it to a new ResumeVariant in one transaction
  return prisma.$transaction(async (tx) => {
    const doc = await tx.document.create({
      data: {
        userId: DEMO_USER_ID,
        type: data.type,
        filename: data.filename,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        storageKey: data.storageKey,
        extractedText: data.extractedText ?? null,
        extractedAt: data.extractedText ? new Date() : null,
      },
    });

    // Only create a ResumeVariant for RESUME type documents
    if (data.type === "RESUME") {
      const label = data.filename.replace(/\.[^.]+$/, "");
      await tx.resumeVariant.create({
        data: {
          userId: DEMO_USER_ID,
          label,
          documentId: doc.id,
          content: data.extractedText ?? null,
        },
      });
    }

    return doc;
  });
}

export async function deleteDocument(id: string) {
  // Cascade: ResumeVariant.documentId is SET NULL on delete
  return prisma.document.delete({ where: { id } });
}
