import { successResponse, errorResponse } from "@/lib/api-utils";
import { getDocuments, createDocumentWithVariant } from "@/lib/queries/documents";
import { buildStorageKey, saveFile } from "@/lib/storage";
import { extractText, isExtractionSupported, mimeTypeFromFilename } from "@/lib/documents/extract";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") as "RESUME" | "COVER_LETTER" | null;
    const docs = await getDocuments(type ?? undefined);
    return successResponse(docs);
  } catch (error) {
    console.error("GET /api/profile/documents error:", error);
    return errorResponse("Failed to fetch documents", 500);
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const docType = (formData.get("type") as string) || "RESUME";

    if (!file) {
      return errorResponse("No file provided", 400);
    }

    if (file.size > MAX_FILE_SIZE) {
      return errorResponse("File too large. Maximum size is 10 MB.", 400);
    }

    // Determine MIME type
    const mimeType = file.type || mimeTypeFromFilename(file.name);
    if (!mimeType) {
      return errorResponse("Could not determine file type. Please upload a PDF or DOCX file.", 400);
    }

    if (!isExtractionSupported(mimeType)) {
      return errorResponse("Unsupported file type. Please upload a PDF or DOCX file.", 400);
    }

    if (docType !== "RESUME" && docType !== "COVER_LETTER") {
      return errorResponse("Invalid document type. Must be RESUME or COVER_LETTER.", 400);
    }

    // Read file buffer
    const buffer = Buffer.from(await file.arrayBuffer());

    // Store file on disk
    const { DEMO_USER_ID } = await import("@/lib/constants");
    const storageKey = buildStorageKey(DEMO_USER_ID, file.name);
    await saveFile(storageKey, buffer);

    // Extract text
    let extractedText: string | null = null;
    try {
      extractedText = await extractText(buffer, mimeType);
    } catch (err) {
      console.error("Text extraction failed (non-fatal):", err);
    }

    // Create Document + ResumeVariant in DB
    const doc = await createDocumentWithVariant({
      filename: file.name,
      mimeType,
      sizeBytes: file.size,
      storageKey,
      type: docType,
      extractedText,
    });

    return successResponse(doc, 201);
  } catch (error) {
    console.error("POST /api/profile/documents error:", error);
    return errorResponse("Failed to upload document", 500);
  }
}
