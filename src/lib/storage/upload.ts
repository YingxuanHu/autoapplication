import { promises as fs } from "fs";
import path from "path";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

async function ensureUploadsDir(): Promise<void> {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

export async function saveFile(
  buffer: Buffer,
  fileName: string,
  _mimeType: string,
): Promise<string> {
  await ensureUploadsDir();

  const timestamp = Date.now();
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  const safeName = `${base}-${timestamp}${ext}`;
  const filePath = path.join(UPLOADS_DIR, safeName);

  await fs.writeFile(filePath, buffer);

  return `/uploads/${safeName}`;
}

export async function deleteFile(filePath: string): Promise<void> {
  const absolutePath = getFilePath(filePath);
  try {
    await fs.unlink(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export function getFilePath(relativePath: string): string {
  const cleaned = relativePath.replace(/^\//, "");
  return path.join(process.cwd(), cleaned);
}
