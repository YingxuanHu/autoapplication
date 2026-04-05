/**
 * Local file storage layer.
 *
 * Stores uploaded files under `data/uploads/<userId>/` on disk.
 * The storageKey format is: `<userId>/<timestamp>-<sanitized-filename>`
 *
 * Swap this module for an S3 implementation later without changing callers.
 */
import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises";
import path from "node:path";

const UPLOAD_ROOT = path.join(process.cwd(), "data", "uploads");

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

/** Build a unique storage key for a new upload. */
export function buildStorageKey(userId: string, filename: string): string {
  const ts = Date.now();
  return `${userId}/${ts}-${sanitizeFilename(filename)}`;
}

/** Resolve a storage key to an absolute path on disk. */
export function resolvePath(storageKey: string): string {
  return path.join(UPLOAD_ROOT, storageKey);
}

/** Save a buffer to disk. Creates directories as needed. */
export async function saveFile(storageKey: string, data: Buffer): Promise<void> {
  const filePath = resolvePath(storageKey);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, data);
}

/** Read a file from disk. Returns null if not found. */
export async function readStoredFile(storageKey: string): Promise<Buffer | null> {
  try {
    return await readFile(resolvePath(storageKey));
  } catch {
    return null;
  }
}

/** Delete a file from disk. Silently ignores missing files. */
export async function deleteFile(storageKey: string): Promise<void> {
  try {
    await unlink(resolvePath(storageKey));
  } catch {
    // ignore
  }
}

/** Check if a file exists and return its size, or null. */
export async function fileExists(storageKey: string): Promise<number | null> {
  try {
    const s = await stat(resolvePath(storageKey));
    return s.size;
  } catch {
    return null;
  }
}
