import { successResponse, errorResponse } from "@/lib/api-utils";
import { UnauthorizedError } from "@/lib/current-user";
import { getDocument, deleteDocument } from "@/lib/queries/documents";
import { deleteFile } from "@/lib/storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const doc = await getDocument(id);
    if (!doc) return errorResponse("Document not found", 404);
    return successResponse(doc);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    console.error("GET /api/profile/documents/[id] error:", error);
    return errorResponse("Failed to fetch document", 500);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const doc = await getDocument(id);
    if (!doc) return errorResponse("Document not found", 404);

    // Delete file from storage
    await deleteFile(doc.storageKey);

    // Delete DB record (ResumeVariant.documentId set null via cascade)
    await deleteDocument(id);

    return successResponse({ deleted: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    console.error("DELETE /api/profile/documents/[id] error:", error);
    return errorResponse("Failed to delete document", 500);
  }
}
