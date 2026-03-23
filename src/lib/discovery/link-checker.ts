/**
 * Broken Apply Link Detection
 *
 * Validates whether job apply URLs are still active and accepting applications.
 * Uses HEAD requests first for speed, falls back to GET for content inspection.
 * Detects common ATS patterns for closed/filled positions.
 */

/**
 * Result of checking a single apply URL.
 */
export interface LinkCheckResult {
  /** The URL that was checked. */
  url: string;
  /** Whether the apply link appears to be valid and accepting applications. */
  isValid: boolean;
  /** HTTP status code returned. */
  statusCode: number | null;
  /** Final redirect URL if the request was redirected. */
  redirectUrl?: string;
  /** Human-readable reason if the link is invalid. */
  reason?: string;
}

/**
 * Text patterns indicating a job position has been closed or filled.
 */
const CLOSED_JOB_PATTERNS = [
  /this position has been filled/i,
  /no longer accepting/i,
  /position has been closed/i,
  /this job is no longer available/i,
  /this role has been filled/i,
  /job has expired/i,
  /listing has expired/i,
  /this posting has been removed/i,
  /application deadline has passed/i,
  /this vacancy has been closed/i,
  /sorry.*position.*filled/i,
  /this job has been removed/i,
  /no longer open/i,
  /we are no longer hiring/i,
];

/**
 * Default delay between requests in milliseconds (respects rate limiting).
 */
const DEFAULT_DELAY_MS = 500;

/**
 * Request timeout in milliseconds.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Check if a URL is a redirect to a generic careers/board root page,
 * indicating the specific job listing no longer exists.
 */
function isGenericCareersRedirect(originalUrl: string, redirectUrl: string): boolean {
  try {
    const original = new URL(originalUrl);
    const redirect = new URL(redirectUrl);

    // Greenhouse: redirects from /jobs/123 to /jobs or board root
    if (original.pathname.match(/\/jobs\/\d+/) && redirect.pathname === "/jobs") {
      return true;
    }

    // General: redirect to root careers page
    const careersRoots = ["/careers", "/jobs", "/openings", "/opportunities", "/join"];
    const originalIsSpecific = original.pathname.split("/").length > 2;
    const redirectIsRoot = careersRoots.some(
      (root) => redirect.pathname === root || redirect.pathname === root + "/",
    );

    if (originalIsSpecific && redirectIsRoot) {
      return true;
    }

    // Redirect to a completely different domain
    if (original.hostname !== redirect.hostname) {
      // Allow known ATS redirects (these are normal)
      const atsHosts = [
        "boards.greenhouse.io",
        "jobs.lever.co",
        "jobs.ashbyhq.com",
        "jobs.smartrecruiters.com",
      ];
      if (!atsHosts.some((h) => redirect.hostname.includes(h))) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a single apply URL is still valid and accepting applications.
 *
 * Performs a HEAD request first for speed. If the HEAD request fails or
 * returns ambiguous results, falls back to a GET request to inspect page content
 * for "position filled" text patterns.
 *
 * @param url - The apply URL to check.
 * @returns A LinkCheckResult with validity information.
 */
export async function checkApplyLink(url: string): Promise<LinkCheckResult> {
  if (!url) {
    return { url, isValid: false, statusCode: null, reason: "Empty URL" };
  }

  try {
    // Validate URL format
    new URL(url);
  } catch {
    return { url, isValid: false, statusCode: null, reason: "Invalid URL format" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    // Step 1: HEAD request (fast check)
    const headResponse = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AutoApplication/1.0; +https://autoapplication.dev)",
      },
    });

    const statusCode = headResponse.status;
    const finalUrl = headResponse.url;

    // Definitive failures
    if (statusCode === 404 || statusCode === 410) {
      return {
        url,
        isValid: false,
        statusCode,
        redirectUrl: finalUrl !== url ? finalUrl : undefined,
        reason: statusCode === 404 ? "Page not found (404)" : "Job removed (410 Gone)",
      };
    }

    // Server errors
    if (statusCode >= 500) {
      return {
        url,
        isValid: false,
        statusCode,
        reason: `Server error (${statusCode})`,
      };
    }

    // Check for generic careers page redirect
    if (finalUrl !== url && isGenericCareersRedirect(url, finalUrl)) {
      return {
        url,
        isValid: false,
        statusCode,
        redirectUrl: finalUrl,
        reason: "Redirected to generic careers page",
      };
    }

    // If HEAD succeeded with 2xx, do a GET to check content for closed indicators
    if (statusCode >= 200 && statusCode < 300) {
      clearTimeout(timeout);
      return await checkContentForClosedJob(url, statusCode, finalUrl);
    }

    // HEAD returned unexpected status, try GET
    clearTimeout(timeout);
    return await checkContentForClosedJob(url, statusCode, finalUrl);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { url, isValid: false, statusCode: null, reason: "Request timed out" };
    }

    // HEAD might not be supported; fall back to GET
    clearTimeout(timeout);
    try {
      return await checkContentForClosedJob(url, null, undefined);
    } catch {
      return {
        url,
        isValid: false,
        statusCode: null,
        reason: `Network error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Perform a GET request and check the page content for indicators
 * that the job is closed or filled.
 */
async function checkContentForClosedJob(
  url: string,
  headStatusCode: number | null,
  headRedirectUrl: string | undefined,
): Promise<LinkCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AutoApplication/1.0; +https://autoapplication.dev)",
      },
    });

    const statusCode = response.status;
    const finalUrl = response.url;

    if (statusCode === 404 || statusCode === 410) {
      return {
        url,
        isValid: false,
        statusCode,
        redirectUrl: finalUrl !== url ? finalUrl : undefined,
        reason: statusCode === 404 ? "Page not found (404)" : "Job removed (410 Gone)",
      };
    }

    if (statusCode >= 500) {
      return {
        url,
        isValid: false,
        statusCode,
        reason: `Server error (${statusCode})`,
      };
    }

    // Check for redirect to generic careers page
    if (finalUrl !== url && isGenericCareersRedirect(url, finalUrl)) {
      return {
        url,
        isValid: false,
        statusCode,
        redirectUrl: finalUrl,
        reason: "Redirected to generic careers page",
      };
    }

    // Read body text and check for closed-job patterns
    const text = await response.text();

    // Only check a reasonable amount of text to avoid false positives in long pages
    const searchText = text.substring(0, 10_000);

    for (const pattern of CLOSED_JOB_PATTERNS) {
      if (pattern.test(searchText)) {
        return {
          url,
          isValid: false,
          statusCode,
          redirectUrl: finalUrl !== url ? finalUrl : undefined,
          reason: `Closed job detected: matched pattern "${pattern.source}"`,
        };
      }
    }

    // All checks passed
    return {
      url,
      isValid: true,
      statusCode,
      redirectUrl: finalUrl !== url ? finalUrl : headRedirectUrl,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { url, isValid: false, statusCode: null, reason: "Request timed out" };
    }
    return {
      url,
      isValid: false,
      statusCode: headStatusCode,
      reason: `GET request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Wait for a specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Batch check multiple apply URLs with rate limiting.
 *
 * Processes URLs sequentially with a configurable delay between requests
 * to respect rate limits and avoid overwhelming target servers.
 *
 * @param urls - Array of URLs to check.
 * @param options - Configuration options.
 * @param options.delayMs - Delay between requests in milliseconds (default 500).
 * @param options.concurrency - Number of concurrent requests (default 1).
 * @param options.onProgress - Optional callback invoked after each URL is checked.
 * @returns Array of LinkCheckResults in the same order as input URLs.
 */
export async function batchCheckApplyLinks(
  urls: string[],
  options: {
    delayMs?: number;
    concurrency?: number;
    onProgress?: (completed: number, total: number, result: LinkCheckResult) => void;
  } = {},
): Promise<LinkCheckResult[]> {
  const { delayMs = DEFAULT_DELAY_MS, concurrency = 1, onProgress } = options;

  if (concurrency <= 1) {
    // Sequential processing
    const results: LinkCheckResult[] = [];
    for (let i = 0; i < urls.length; i++) {
      const result = await checkApplyLink(urls[i]!);
      results.push(result);
      onProgress?.(i + 1, urls.length, result);

      // Delay between requests (skip after last)
      if (i < urls.length - 1) {
        await sleep(delayMs);
      }
    }
    return results;
  }

  // Concurrent processing with limited concurrency
  const results: LinkCheckResult[] = new Array(urls.length);
  let nextIndex = 0;
  let completedCount = 0;

  async function processNext(): Promise<void> {
    while (nextIndex < urls.length) {
      const idx = nextIndex++;
      const result = await checkApplyLink(urls[idx]!);
      results[idx] = result;
      completedCount++;
      onProgress?.(completedCount, urls.length, result);

      if (nextIndex < urls.length) {
        await sleep(delayMs);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () =>
    processNext(),
  );
  await Promise.all(workers);

  return results;
}
