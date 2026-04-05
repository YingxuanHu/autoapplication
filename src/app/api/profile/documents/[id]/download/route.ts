import { errorResponse } from "@/lib/api-utils";
import { UnauthorizedError, requireCurrentProfileId } from "@/lib/current-user";
import { prisma } from "@/lib/db";
import { readStoredFile } from "@/lib/storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const userId = await requireCurrentProfileId();
    const document = await prisma.document.findFirst({
      where: {
        id,
        userId,
      },
      select: {
        storageKey: true,
        mimeType: true,
        originalFileName: true,
        filename: true,
      },
    });

    if (!document) {
      return errorResponse("Document not found", 404);
    }

    const file = await readStoredFile(document.storageKey);
    if (!file) {
      return errorResponse("Stored file not found", 404);
    }

    return new Response(new Uint8Array(file), {
      status: 200,
      headers: {
        "Content-Type": document.mimeType,
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.originalFileName ?? document.filename)}`,
      },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    console.error("GET /api/profile/documents/[id]/download error:", error);
    return errorResponse("Failed to download document", 500);
  }
}
