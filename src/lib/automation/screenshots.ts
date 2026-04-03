import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";

const SCREENSHOTS_ROOT = join(process.cwd(), "data", "automation-screenshots");

/**
 * Ensure the screenshot directory for a job run exists.
 * Returns the absolute path.
 */
export function ensureScreenshotDir(jobId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(SCREENSHOTS_ROOT, jobId, timestamp);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Take a full-page screenshot and save it with a descriptive label.
 * Returns the file path.
 */
export async function captureScreenshot(
  page: Page,
  dir: string,
  label: string
): Promise<string> {
  const filename = `${label.replace(/[^a-z0-9_-]/gi, "_")}.png`;
  const filepath = join(dir, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  return filepath;
}
