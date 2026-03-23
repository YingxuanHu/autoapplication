/**
 * Per-domain rate limiter for web crawling.
 * Enforces a minimum delay between requests to the same domain.
 */
export class RateLimiter {
  private lastRequestTime: Map<string, number> = new Map();
  private crawlDelays: Map<string, number> = new Map();
  private defaultDelayMs: number;

  constructor(defaultDelayMs = 1000) {
    this.defaultDelayMs = defaultDelayMs;
  }

  /**
   * Set a custom crawl delay for a specific domain (e.g. from robots.txt).
   */
  setCrawlDelay(domain: string, delaySeconds: number): void {
    this.crawlDelays.set(domain, delaySeconds * 1000);
  }

  /**
   * Get the effective delay for a domain in milliseconds.
   */
  getDelay(domain: string): number {
    return this.crawlDelays.get(domain) ?? this.defaultDelayMs;
  }

  /**
   * Wait until it is safe to make a request to the given domain.
   * Blocks until the minimum delay has elapsed since the last request.
   */
  async waitForSlot(domain: string): Promise<void> {
    const now = Date.now();
    const lastTime = this.lastRequestTime.get(domain) ?? 0;
    const delay = this.getDelay(domain);
    const elapsed = now - lastTime;

    if (elapsed < delay) {
      const waitMs = delay - elapsed;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    this.lastRequestTime.set(domain, Date.now());
  }

  /**
   * Record that a request was just made to the domain (without waiting).
   */
  recordRequest(domain: string): void {
    this.lastRequestTime.set(domain, Date.now());
  }

  /**
   * Clear all tracked state.
   */
  reset(): void {
    this.lastRequestTime.clear();
    this.crawlDelays.clear();
  }
}

/** Shared singleton rate limiter instance. */
export const rateLimiter = new RateLimiter();
