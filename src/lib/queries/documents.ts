import { prisma } from "@/lib/db";
import { requireCurrentProfileId } from "@/lib/current-user";

export async function getDocuments(type?: "RESUME" | "COVER_LETTER") {
  const userId = await requireCurrentProfileId();
  return prisma.document.findMany({
    where: { userId, ...(type ? { type } : {}) },
    orderBy: { createdAt: "desc" },
    include: { resumeVariant: { select: { id: true, label: true } } },
  });
}

export async function getDocument(id: string) {
  const userId = await requireCurrentProfileId();
  return prisma.document.findFirst({
    where: { id, userId },
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
  const userId = await requireCurrentProfileId();
  // Create Document and link it to a new ResumeVariant in one transaction
  return prisma.$transaction(async (tx) => {
    const doc = await tx.document.create({
      data: {
        userId,
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
          userId,
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
