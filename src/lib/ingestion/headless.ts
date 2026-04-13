/**
 * Minimal headless browser utility for ATS connectors that require JavaScript
 * rendering. Uses Playwright with Chromium. Designed for limited, targeted use:
 * render a single page to extract data that plain HTTP cannot reach.
 *
 * Safety: single browser instance, configurable concurrency, strict timeouts,
 * auto-cleanup via `dispose()`.
 */
import type { Browser } from "playwright";

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
let _browserLaunchPromise: Promise<Browser> | null = null;
let _activeRenderCount = 0;
let _disposePending = false;

async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;

  // If a launch is already in-flight, reuse that promise instead of starting
  // a second Chromium process. Without this guard, concurrent renderPage()
  // calls (e.g. 4 workers after a resetBrowser()) each race to launch their
  // own browser, exhaust resources, and overwrite each other's _browser ref.
  if (_browserLaunchPromise) return _browserLaunchPromise;

  _browserLaunchPromise = (async () => {
    // Dynamic import to avoid loading Playwright in non-headless code paths
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-extensions",
      ],
    });
    _browser = browser;
    _disposePending = false;
    _browserLaunchPromise = null;
    return browser;
  })();

  return _browserLaunchPromise;
}

async function closeBrowser(): Promise<void> {
  if (_browser) {
    await Promise.race([
      _browser.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]).catch(() => {});
    _browser = null;
  }
}

/**
 * Render a page and return HTML + intercepted XHR/fetch responses.
 *
 * A hard deadline (timeoutMs + 15s) wraps the entire operation. If Playwright
 * hangs (e.g. a server that never responds causing page.goto to stall beyond
 * its own timeout), the hard deadline fires, forcibly resets the browser
 * (unblocking any zombie CDP operations), and rejects. This prevents the
 * Node.js process from hanging indefinitely on unresponsive ATS pages.
 */
export async function renderPage(options: RenderOptions): Promise<HeadlessRenderResult> {
  const hardDeadlineMs = (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 15_000;

  let hardTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const hardTimeoutPromise = new Promise<never>((_, reject) => {
    hardTimeoutId = setTimeout(() => {
      // Force-abandon the browser so any zombie CDP operations are unblocked.
      resetBrowser();
      reject(new Error(`renderPage hard timeout after ${hardDeadlineMs}ms for ${options.url}`));
    }, hardDeadlineMs);
  });

  try {
    const result = await Promise.race([doRenderPage(options), hardTimeoutPromise]);
    clearTimeout(hardTimeoutId);
    return result;
  } catch (error) {
    clearTimeout(hardTimeoutId);
    throw error;
  }
}

async function doRenderPage(options: RenderOptions): Promise<HeadlessRenderResult> {
  const {
    url,
    waitForNetworkIdle = true,
    extraWaitMs = 0,
    navigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    interceptUrlPatterns = [],
    waitForSelector,
  } = options;

  _activeRenderCount++;
  try {
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
      // Hard-cap context close at 5s — a pending navigation can cause
      // context.close() to hang indefinitely on some sites.
      await Promise.race([
        context.close(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]).catch(() => {});
    }
  } finally {
    _activeRenderCount--;
    if (_disposePending && _activeRenderCount === 0) {
      _disposePending = false;
      await closeBrowser();
    }
  }
}

/**
 * Signal that the caller is done with the browser. If renders are still
 * in-flight, the actual close is deferred until the last one finishes.
 * Safe to call from multiple concurrent connectors.
 */
export async function disposeBrowser(): Promise<void> {
  if (_activeRenderCount > 0) {
    _disposePending = true;
    return;
  }
  await closeBrowser();
}

/**
 * Force-abandon the current browser instance immediately without waiting
 * for it to close. The old instance is discarded (fire-and-forget close);
 * the next `renderPage` call will launch a fresh browser.
 *
 * Use this after a navigation timeout leaves the browser in a dirty state
 * (e.g. a hung context.close() still queued in the CDP pipeline) so that
 * subsequent renders are not blocked by it.
 */
export function resetBrowser(): void {
  _activeRenderCount = 0;
  _disposePending = false;
  _browserLaunchPromise = null;
  if (_browser) {
    const stale = _browser;
    _browser = null;
    // Force-kill the underlying Chromium process first (SIGKILL) to prevent
    // zombie browser processes when CDP connections are hung. The graceful
    // close() is also attempted but may not succeed if the pipe is broken.
    try {
      const browserWithProcess = stale as typeof stale & {
        process?: () => { kill(signal?: NodeJS.Signals | number): void } | null;
      };
      browserWithProcess.process?.()?.kill("SIGKILL");
    } catch {
      // Browser process may already be dead — ignore
    }
    void stale.close().catch(() => {});
  }
}
