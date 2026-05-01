import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const RUNTIME_DIR = path.join(process.cwd(), ".runtime");

type ProcessLock = {
  pid: number;
  startedAt: string;
  argv: string[];
  key: string;
};

async function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockPathForKey(key: string) {
  const normalized = key.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase();
  return path.join(RUNTIME_DIR, `${normalized}.lock.json`);
}

export async function acquireRuntimeLock(key: string) {
  const lockPath = lockPathForKey(key);
  await mkdir(RUNTIME_DIR, { recursive: true });

  try {
    const existingRaw = await readFile(lockPath, "utf8");
    const existing = JSON.parse(existingRaw) as Partial<ProcessLock>;
    const existingPid = typeof existing.pid === "number" ? existing.pid : null;

    if (existingPid && existingPid !== process.pid && (await processExists(existingPid))) {
      return {
        acquired: false as const,
        existingPid,
        release: async () => {},
      };
    }
  } catch {
    // no existing lock or unreadable stale lock; overwrite below
  }

  const lock: ProcessLock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(2),
    key,
  };

  await writeFile(lockPath, JSON.stringify(lock, null, 2), "utf8");

  return {
    acquired: true as const,
    existingPid: null,
    release: async () => {
      try {
        const existingRaw = await readFile(lockPath, "utf8");
        const existing = JSON.parse(existingRaw) as Partial<ProcessLock>;
        if (existing.pid === process.pid) {
          await rm(lockPath, { force: true });
        }
      } catch {
        // already gone or unreadable
      }
    },
  };
}
