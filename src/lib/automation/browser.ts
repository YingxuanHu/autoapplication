/**
 * Interactive browser management for the auto-apply engine.
 *
 * Unlike `ingestion/headless.ts` which returns static HTML, this module provides
 * persistent interactive Page objects for form filling and submission.
 *
 * Design: one shared Browser instance, each automation run gets its own
 * BrowserContext (isolated cookies/storage), and a single Page within it.
 */
import type { Browser, BrowserContext, Page } from "playwright";

const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;
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

export type AutomationPage = {
  page: Page;
  context: BrowserContext;
  /** Close the context (and page). Always call when done. */
  dispose: () => Promise<void>;
};

/**
 * Create an interactive page for form automation.
 * The caller is responsible for calling `dispose()` when done.
 */
export async function createAutomationPage(): Promise<AutomationPage> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    javaScriptEnabled: true,
    acceptDownloads: false,
  });

  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

  return {
    page,
    context,
    dispose: async () => {
      await context.close().catch(() => {});
    },
  };
}

/**
 * Navigate to a URL and wait for it to settle.
 * Returns false if the page appears to show a closed/404 state.
 */
export async function navigateToForm(
  page: Page,
  url: string
): Promise<{ ok: boolean; finalUrl: string; statusHint: string }> {
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    // Wait a bit for SPAs to hydrate
    await page.waitForTimeout(2000);

    const status = response?.status() ?? 0;
    const finalUrl = page.url();

    if (status === 404 || status >= 500) {
      return { ok: false, finalUrl, statusHint: `HTTP ${status}` };
    }

    // Detect common "position closed" indicators
    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 5000 })
      .catch(() => "");
    const closedPatterns = [
      /this position has been (filled|closed)/i,
      /no longer accepting applications/i,
      /this job is no longer available/i,
      /this posting has (expired|been removed)/i,
      /sorry.*position.*closed/i,
    ];
    for (const pattern of closedPatterns) {
      if (pattern.test(bodyText)) {
        return { ok: false, finalUrl, statusHint: "position_closed" };
      }
    }

    return { ok: true, finalUrl, statusHint: "ok" };
  } catch (error) {
    return {
      ok: false,
      finalUrl: url,
      statusHint: error instanceof Error ? error.message : "navigation_failed",
    };
  }
}

/**
 * Detect common automation blockers on the current page.
 */
export async function detectBlockers(
  page: Page
): Promise<Array<{ type: string; detail: string }>> {
  const blockers: Array<{ type: string; detail: string }> = [];

  // CAPTCHA detection
  const captchaSelectors = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="captcha"]',
    '[class*="captcha"]',
    "#captcha",
    '[data-sitekey]',
  ];

  for (const selector of captchaSelectors) {
    const found = await page.locator(selector).count();
    if (found > 0) {
      blockers.push({ type: "captcha", detail: `Detected via ${selector}` });
      break;
    }
  }

  // Login wall detection
  const loginSelectors = [
    'input[type="password"]',
    'form[action*="login"]',
    'form[action*="signin"]',
    '[class*="login-form"]',
    '[class*="sign-in"]',
  ];

  for (const selector of loginSelectors) {
    const found = await page.locator(selector).count();
    if (found > 0) {
      blockers.push({
        type: "login_required",
        detail: `Login form detected via ${selector}`,
      });
      break;
    }
  }

  return blockers;
}

/**
 * Close the shared browser. Call at process exit.
 */
export async function disposeAutomationBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}
