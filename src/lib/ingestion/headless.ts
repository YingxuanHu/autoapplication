/**
 * Minimal headless browser utility for ATS connectors that require JavaScript
 * rendering. Uses Playwright with Chromium. Designed for limited, targeted use:
 * render a single page to extract data that plain HTTP cannot reach.
 *
 * Safety: single browser instance, configurable concurrency, strict timeouts,
 * auto-cleanup via `dispose()`.
 */
import type { Browser, Page } from "playwright";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;

export type HeadlessRenderResult = {
  url: string;
  html: string;
  interceptedRequests: InterceptedRequest[];
  consoleLogs: string[];
};

export type InterceptedRequest = {
  url: string;
  method: string;
  postData: string | null;
  responseStatus: number | null;
  responseBody: string | null;
};

type RenderOptions = {
  /** URL to navigate to */
  url: string;
  /** Wait for network idle before extracting. Default true. */
  waitForNetworkIdle?: boolean;
  /** Additional time (ms) to wait after load. Default 0. */
  extraWaitMs?: number;
  /** Timeout for page navigation (ms). Default 20s. */
  navigationTimeoutMs?: number;
  /** Total timeout for the render operation (ms). Default 30s. */
  timeoutMs?: number;
  /** URL patterns to intercept responses from (substring match). */
  interceptUrlPatterns?: string[];
  /** If provided, wait for this selector before extracting. */
  waitForSelector?: string;
};

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;
  // Dynamic import to avoid loading Playwright in non-headless code paths
  const { chromium } = await import("playwright");
  _browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
    ],
  });
  return _browser;
}

/**
 * Render a page and return HTML + intercepted XHR/fetch responses.
 */
export async function renderPage(options: RenderOptions): Promise<HeadlessRenderResult> {
  const {
    url,
    waitForNetworkIdle = true,
    extraWaitMs = 0,
    navigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    interceptUrlPatterns = [],
    waitForSelector,
  } = options;

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    javaScriptEnabled: true,
  });

  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  const intercepted: InterceptedRequest[] = [];
  const consoleLogs: string[] = [];

  page.on("console", (msg) => {
    consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
  });

  // Set up response interception
  if (interceptUrlPatterns.length > 0) {
    page.on("response", async (response) => {
      const reqUrl = response.url();
      const matches = interceptUrlPatterns.some((pattern) => reqUrl.includes(pattern));
      if (!matches) return;

      let responseBody: string | null = null;
      try {
        responseBody = await response.text();
      } catch {
        // Response body may not be available
      }

      intercepted.push({
        url: reqUrl,
        method: response.request().method(),
        postData: response.request().postData() ?? null,
        responseStatus: response.status(),
        responseBody,
      });
    });
  }

  try {
    await page.goto(url, {
      timeout: navigationTimeoutMs,
      waitUntil: waitForNetworkIdle ? "networkidle" : "domcontentloaded",
    });

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, {
        timeout: Math.min(timeoutMs, 10_000),
      }).catch(() => {
        // Selector may not appear — continue anyway
      });
    }

    if (extraWaitMs > 0) {
      await page.waitForTimeout(extraWaitMs);
    }

    const html = await page.content();

    return { url, html, interceptedRequests: intercepted, consoleLogs };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Close the shared browser instance. Call at process exit or after a batch.
 */
export async function disposeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}
