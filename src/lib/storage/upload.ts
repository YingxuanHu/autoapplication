import { constants, promises as fs } from "fs";
import path from "path";

const UPLOADS_DIR = path.join(process.cwd(), "public", "uploads");

async function ensureUploadsDir(): Promise<void> {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

function buildSafeFileName(fileName: string, mimeType?: string): string {
  const originalExt = path.extname(fileName);
  const ext = originalExt || (mimeType === "application/pdf" ? ".pdf" : "");
  const base = path
    .basename(fileName, originalExt)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "file";

  return `${base}-${Date.now()}${ext}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function saveFile(
  buffer: Buffer,
  fileName: string,
  mimeType?: string,
): Promise<string> {
  await ensureUploadsDir();

  const safeName = buildSafeFileName(fileName, mimeType);
  const filePath = path.join(UPLOADS_DIR, safeName);

  await fs.writeFile(filePath, buffer);

  return `/uploads/${safeName}`;
}

export async function deleteFile(filePath: string): Promise<void> {
  const absolutePath = await getFilePath(filePath);
  try {
    await fs.unlink(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function getFilePath(relativePath: string): Promise<string> {
  const cleaned = relativePath.replace(/^\//, "");
  const publicPath = path.join(process.cwd(), "public", cleaned);
  if (await fileExists(publicPath)) {
    return publicPath;
  }

  const legacyPath = path.join(process.cwd(), cleaned);
  if (await fileExists(legacyPath)) {
    return legacyPath;
  }

  return publicPath;
}
