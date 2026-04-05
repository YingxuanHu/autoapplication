/**
 * Spaces-backed storage layer.
 *
 * New uploads are stored in S3-compatible object storage such as DigitalOcean Spaces.
 * Existing legacy files under `data/uploads/` remain readable during migration.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const UPLOAD_ROOT = path.join(
  /* turbopackIgnore: true */ process.cwd(),
  "data",
  "uploads"
);
const TEMP_DOWNLOAD_PREFIX = path.join(os.tmpdir(), "autoapplication-storage-");

const REQUIRED_STORAGE_ENV_KEYS = [
  "STORAGE_BUCKET",
  "STORAGE_REGION",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
] as const;

type StorageReadiness = {
  configured: boolean;
  providerLabel: string;
  missingKeys: string[];
};

type MaterializedStoredFile = {
  filePath: string;
  cleanup: (() => Promise<void>) | null;
};

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

function sanitizeStorageSegment(name: string): string {
  return sanitizeFilename(name).replace(/\.+/g, ".").replace(/^[_./-]+|[_./-]+$/g, "") || "file";
}

function readStorageConfig() {
  const providerLabel = process.env.STORAGE_PROVIDER?.trim() || "S3-compatible storage";
  const bucket = process.env.STORAGE_BUCKET?.trim() || "";
  const region = process.env.STORAGE_REGION?.trim() || "";
  const endpoint = process.env.STORAGE_ENDPOINT?.trim() || undefined;
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID?.trim() || "";
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY?.trim() || "";
  const forcePathStyle = process.env.STORAGE_FORCE_PATH_STYLE === "true";

  return {
    providerLabel,
    bucket,
    region,
    endpoint,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
  };
}

export function getStorageReadiness(): StorageReadiness {
  const config = readStorageConfig();
  const missingKeys = REQUIRED_STORAGE_ENV_KEYS.filter((key) => !process.env[key]?.trim());

  return {
    configured: missingKeys.length === 0,
    providerLabel: config.providerLabel,
    missingKeys,
  };
}

let storageClient: S3Client | null = null;

function getStorageClient() {
  const readiness = getStorageReadiness();
  if (!readiness.configured) {
    throw new Error(
      `Storage is not configured. Missing: ${readiness.missingKeys.join(", ")}`
    );
  }

  const config = readStorageConfig();
  storageClient ??= new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    bucket: config.bucket,
    client: storageClient,
  };
}

function isMissingStorageObjectError(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "$metadata" in error
      ? String((error as { name?: string }).name ?? "")
      : "";

  return (
    code === "NoSuchKey" ||
    code === "NotFound" ||
    code === "NoSuchBucket" ||
    (typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof (error as { message: unknown }).message === "string" &&
      /(NoSuchKey|NotFound|key does not exist)/i.test(
        (error as { message: string }).message
      ))
  );
}

export function buildDocumentStorageKey(input: {
  userId: string;
  title: string;
  extension: string;
  type: "RESUME" | "COVER_LETTER" | "RESUME_TEMPLATE";
}) {
  const ts = Date.now();
  const safeType = input.type.toLowerCase();
  const safeTitle = sanitizeStorageSegment(input.title);
  const safeExtension = input.extension.startsWith(".") ? input.extension : `.${input.extension}`;
  return `${input.userId}/${safeType}/${ts}-${randomUUID()}-${safeTitle}${safeExtension}`;
}

/** Resolve a legacy local storage key to an absolute path on disk. */
export function resolvePath(storageKey: string): string {
  return path.join(UPLOAD_ROOT, storageKey);
}

async function readLocalStoredFile(storageKey: string): Promise<Buffer | null> {
  try {
    return await readFile(resolvePath(storageKey));
  } catch {
    return null;
  }
}

async function deleteLocalStoredFile(storageKey: string): Promise<void> {
  try {
    await unlink(resolvePath(storageKey));
  } catch {
    // ignore missing local files during migration cleanup
  }
}

async function downloadRemoteFile(storageKey: string): Promise<Buffer | null> {
  const readiness = getStorageReadiness();
  if (!readiness.configured) {
    return null;
  }

  const { client, bucket } = getStorageClient();

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: storageKey,
      })
    );

    if (!response.Body) {
      return null;
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  } catch (error) {
    if (isMissingStorageObjectError(error)) {
      return null;
    }
    throw error;
  }
}

/** Save a buffer to Spaces. Requires storage env configuration. */
export async function saveFile(
  storageKey: string,
  data: Buffer,
  options?: { contentType?: string }
): Promise<void> {
  const { client, bucket } = getStorageClient();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: storageKey,
      Body: data,
      ContentType: options?.contentType,
    })
  );
}

/**
 * Read a stored file.
 *
 * Reads legacy local files first so pre-migration uploads keep working, then
 * falls back to Spaces for new uploads.
 */
export async function readStoredFile(storageKey: string): Promise<Buffer | null> {
  const localFile = await readLocalStoredFile(storageKey);
  if (localFile) {
    return localFile;
  }

  return downloadRemoteFile(storageKey);
}

/**
 * Delete a stored file.
 *
 * Deletes from Spaces and also cleans up any legacy local copy if present.
 */
export async function deleteFile(storageKey: string): Promise<void> {
  const deletions: Array<Promise<unknown>> = [deleteLocalStoredFile(storageKey)];
  const readiness = getStorageReadiness();

  if (readiness.configured) {
    const { client, bucket } = getStorageClient();
    deletions.push(
      client
        .send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: storageKey,
          })
        )
        .catch((error) => {
          if (!isMissingStorageObjectError(error)) {
            throw error;
          }
        })
    );
  }

  await Promise.allSettled(deletions);
}

/** Check if a file exists and return its size, or null. */
export async function fileExists(storageKey: string): Promise<number | null> {
  try {
    const s = await stat(resolvePath(storageKey));
    return s.size;
  } catch {
    const remoteFile = await downloadRemoteFile(storageKey);
    return remoteFile?.byteLength ?? null;
  }
}

/**
 * Materialize a stored file to a local path for APIs that need one, such as
 * Playwright file uploads.
 */
export async function materializeStoredFile(
  storageKey: string,
  filename?: string
): Promise<MaterializedStoredFile | null> {
  try {
    await stat(resolvePath(storageKey));
    return {
      filePath: resolvePath(storageKey),
      cleanup: null,
    };
  } catch {
    // continue to remote download
  }

  const remoteFile = await downloadRemoteFile(storageKey);
  if (!remoteFile) {
    return null;
  }

  const tempDir = await mkdtemp(TEMP_DOWNLOAD_PREFIX);
  const extension = path.extname(filename ?? storageKey) || ".bin";
  const tempPath = path.join(tempDir, `${randomUUID()}${extension}`);
  await mkdir(path.dirname(tempPath), { recursive: true });
  await writeFile(tempPath, remoteFile);

  return {
    filePath: tempPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
