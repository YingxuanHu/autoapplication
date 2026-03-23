export { discoverCareerPages } from "./career-finder";
export type { CareerPageResult } from "./career-finder";

export { detectATS } from "./ats-detector";
export type { ATSDetectionResult } from "./ats-detector";

export { parseJobPostings, extractJobPostingsFromHtml } from "./structured-data-parser";
export type { ParsedJobPosting } from "./structured-data-parser";

export { crawlCustomCareerPage } from "./custom-crawler";
export type { CrawledJob } from "./custom-crawler";

export {
  normalizeJob,
  generateFingerprint,
  deduplicateJobs,
  normalizeWorkMode,
  normalizeLocation,
  normalizeSalary,
} from "./normalizer";

export {
  calculateSourceTrust,
  calculateJobTrust,
  rankByTrust,
} from "./trust-scorer";
export type { TrustableSource, TrustableCrawlRun } from "./trust-scorer";

export {
  fetchRobotsTxt,
  isAllowed,
  getCrawlDelay,
  getSitemapUrls,
  getCareerPaths,
} from "./robots-parser";
export type { RobotsTxt } from "./robots-parser";

export { RateLimiter, rateLimiter } from "./rate-limiter";

export { discoverCompany } from "./company-discovery";
export type { DiscoveryResult } from "./company-discovery";
