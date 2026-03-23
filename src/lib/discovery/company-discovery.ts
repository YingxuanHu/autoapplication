import { ATSType, SourceType, CrawlStatus, DiscoveryMethod } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { discoverCareerPages } from "./career-finder";
import { detectATS } from "./ats-detector";
import { parseJobPostings } from "./structured-data-parser";
import { fetchRobotsTxt, isAllowed, getCrawlDelay } from "./robots-parser";
import { rateLimiter } from "./rate-limiter";
import { calculateSourceTrust } from "./trust-scorer";

export interface DiscoveryResult {
  companyId: string;
  domain: string;
  companyName: string;
  careersUrl: string | null;
  detectedATS: ATSType | null;
  sourcesCreated: number;
  discoveriesCreated: number;
  jobPostingsFound: number;
  trustScore: number;
  errors: string[];
}

/**
 * Main orchestrator: discover career pages, detect ATS, parse structured data,
 * and store everything in the database for a given domain.
 */
export async function discoverCompany(domain: string): Promise<DiscoveryResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  let careersUrl: string | null = null;
  let detectedATS: ATSType | null = null;
  let boardToken: string | undefined;
  let sourcesCreated = 0;
  let discoveriesCreated = 0;
  let jobPostingsFound = 0;

  // Step 1: Check robots.txt and set crawl delay
  const robotsTxt = await fetchRobotsTxt(domain);
  if (robotsTxt) {
    const delay = getCrawlDelay(robotsTxt);
    if (delay != null) {
      rateLimiter.setCrawlDelay(domain, delay);
    }
  }

  // Step 2: Create or get the company record
  const company = await prisma.company.upsert({
    where: { domain },
    update: {
      crawlStatus: CrawlStatus.CRAWLING,
      updatedAt: new Date(),
    },
    create: {
      name: domainToCompanyName(domain),
      domain,
      crawlStatus: CrawlStatus.CRAWLING,
    },
  });

  // Step 3: Create a crawl run to track the discovery process
  const crawlRun = await prisma.sourceCrawlRun.create({
    data: {
      companyId: company.id,
      status: CrawlStatus.CRAWLING,
      startedAt: new Date(),
    },
  });

  try {
    // Step 4: Discover career pages
    const careerPages = await discoverCareerPages(domain);

    // Store all discovered URLs
    for (const page of careerPages) {
      // Check robots.txt compliance
      if (robotsTxt && !isAllowed(page.url, robotsTxt)) {
        continue;
      }

      await prisma.sourceDiscovery.create({
        data: {
          companyId: company.id,
          crawlRunId: crawlRun.id,
          discoveredUrl: page.url,
          discoveryMethod: page.method,
          confidence: page.confidence,
        },
      });
      discoveriesCreated++;
    }

    // Step 5: Take the best career URL and run ATS detection
    const bestCareerPage = careerPages[0];
    if (bestCareerPage) {
      careersUrl = bestCareerPage.url;

      // Check robots.txt compliance before fetching
      if (!robotsTxt || isAllowed(careersUrl, robotsTxt)) {
        try {
          const atsResult = await detectATS(careersUrl);
          detectedATS = atsResult.atsType;
          boardToken = atsResult.boardToken;

          if (atsResult.atsType) {
            await prisma.sourceDiscovery.create({
              data: {
                companyId: company.id,
                crawlRunId: crawlRun.id,
                discoveredUrl: careersUrl,
                discoveryMethod: DiscoveryMethod.ATS_DETECTION,
                atsType: atsResult.atsType,
                confidence: atsResult.confidence,
                metadata: {
                  evidence: atsResult.evidence,
                  boardToken: atsResult.boardToken,
                },
              },
            });
            discoveriesCreated++;
          }
        } catch (err) {
          errors.push(`ATS detection failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Step 6: Try structured data parsing on career pages
    const pagesToParse = careerPages.slice(0, 3); // Parse top 3 pages
    for (const page of pagesToParse) {
      if (robotsTxt && !isAllowed(page.url, robotsTxt)) continue;

      try {
        const postings = await parseJobPostings(page.url);
        if (postings.length > 0) {
          jobPostingsFound += postings.length;

          await prisma.sourceDiscovery.create({
            data: {
              companyId: company.id,
              crawlRunId: crawlRun.id,
              discoveredUrl: page.url,
              discoveryMethod: DiscoveryMethod.STRUCTURED_DATA,
              sourceType: SourceType.STRUCTURED_DATA,
              confidence: 0.8,
              metadata: {
                jobCount: postings.length,
              },
            },
          });
          discoveriesCreated++;
        }
      } catch (err) {
        errors.push(`Structured data parsing failed for ${page.url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 7: Create CompanySource records
    // Career page source
    if (careersUrl) {
      const sourceType = detectedATS ? SourceType.ATS_BOARD : SourceType.CAREER_PAGE;
      const atsType = detectedATS ?? (sourceType === SourceType.CAREER_PAGE ? ATSType.CUSTOM_SITE : null);

      await prisma.companySource.updateMany({
        where: {
          companyId: company.id,
          isActive: true,
          sourceType: SourceType.CAREER_PAGE,
          sourceUrl: { not: careersUrl },
        },
        data: {
          isActive: false,
          metadata: {
            replacedBy: careersUrl,
            deactivatedAt: new Date().toISOString(),
          },
        },
      });

      await prisma.companySource.updateMany({
        where: {
          companyId: company.id,
          isActive: true,
          sourceType: SourceType.ATS_BOARD,
          boardToken: null,
          sourceUrl: { not: careersUrl },
        },
        data: {
          isActive: false,
          metadata: {
            replacedBy: careersUrl,
            deactivatedAt: new Date().toISOString(),
            disabledReason: "Replaced by canonical careers page",
          },
        },
      });

      await prisma.companySource.upsert({
        where: {
          companyId_sourceUrl: {
            companyId: company.id,
            sourceUrl: careersUrl,
          },
        },
        update: {
          sourceType,
          atsType,
          boardToken,
          lastCrawlStatus: CrawlStatus.SUCCESS,
          lastCrawlAt: new Date(),
          isActive: true,
          priority: 2,
          updatedAt: new Date(),
        },
        create: {
          companyId: company.id,
          sourceType,
          atsType,
          sourceUrl: careersUrl,
          boardToken,
          lastCrawlStatus: CrawlStatus.SUCCESS,
          lastCrawlAt: new Date(),
          priority: 2,
        },
      });
      sourcesCreated++;
    }

    // Structured data source (if found on a different URL)
    if (jobPostingsFound > 0) {
      for (const page of pagesToParse) {
        if (page.url === careersUrl) continue;
        if (robotsTxt && !isAllowed(page.url, robotsTxt)) continue;

        const postings = await parseJobPostings(page.url);
        if (postings.length > 0) {
          await prisma.companySource.upsert({
            where: {
              companyId_sourceUrl: {
                companyId: company.id,
                sourceUrl: page.url,
              },
            },
            update: {
              sourceType: SourceType.STRUCTURED_DATA,
              lastCrawlStatus: CrawlStatus.SUCCESS,
              lastCrawlAt: new Date(),
              lastJobCount: postings.length,
              isActive: true,
              updatedAt: new Date(),
            },
            create: {
              companyId: company.id,
              sourceType: SourceType.STRUCTURED_DATA,
              sourceUrl: page.url,
              lastCrawlStatus: CrawlStatus.SUCCESS,
              lastCrawlAt: new Date(),
              lastJobCount: postings.length,
              priority: 0,
            },
          });
          sourcesCreated++;
        }
      }
    }

    // Step 8: Calculate trust score
    const sources = await prisma.companySource.findMany({
      where: { companyId: company.id },
    });

    const crawlRuns = await prisma.sourceCrawlRun.findMany({
      where: { companyId: company.id },
      orderBy: { startedAt: "desc" },
      take: 10,
    });

    let maxTrust = 0.5;
    for (const source of sources) {
      const trust = calculateSourceTrust(
        {
          sourceType: source.sourceType,
          isVerified: source.isVerified,
          isActive: source.isActive,
          failCount: source.failCount,
          successCount: source.successCount,
          lastCrawlAt: source.lastCrawlAt,
          lastCrawlStatus: source.lastCrawlStatus,
        },
        crawlRuns.map((r) => ({
          status: r.status,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          jobsFound: r.jobsFound,
        })),
      );
      maxTrust = Math.max(maxTrust, trust);
    }

    // Step 9: Update company record with results
    await prisma.company.update({
      where: { id: company.id },
      data: {
        name: company.name === domainToCompanyName(domain) ? domainToCompanyName(domain) : company.name,
        careersUrl,
        detectedATS,
        trustScore: maxTrust,
        crawlStatus: CrawlStatus.SUCCESS,
        lastSyncAt: new Date(),
        lastSuccessAt: new Date(),
      },
    });

    // Step 10: Complete the crawl run
    await prisma.sourceCrawlRun.update({
      where: { id: crawlRun.id },
      data: {
        status: CrawlStatus.SUCCESS,
        jobsFound: jobPostingsFound,
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
      },
    });

    return {
      companyId: company.id,
      domain,
      companyName: company.name,
      careersUrl,
      detectedATS,
      sourcesCreated,
      discoveriesCreated,
      jobPostingsFound,
      trustScore: maxTrust,
      errors,
    };
  } catch (err) {
    // Mark crawl as failed
    const errorMessage = err instanceof Error ? err.message : String(err);
    errors.push(`Discovery failed: ${errorMessage}`);

    await prisma.sourceCrawlRun.update({
      where: { id: crawlRun.id },
      data: {
        status: CrawlStatus.FAILED,
        errorMessage,
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
      },
    });

    await prisma.company.update({
      where: { id: company.id },
      data: {
        crawlStatus: CrawlStatus.FAILED,
        lastSyncAt: new Date(),
      },
    });

    return {
      companyId: company.id,
      domain,
      companyName: company.name,
      careersUrl,
      detectedATS,
      sourcesCreated,
      discoveriesCreated,
      jobPostingsFound,
      trustScore: company.trustScore,
      errors,
    };
  }
}

/**
 * Convert a domain to a human-readable company name.
 */
function domainToCompanyName(domain: string): string {
  // Remove common TLDs and subdomains
  const name = domain
    .replace(/^www\./i, "")
    .replace(/\.(com|org|net|io|co|dev|ai|app|tech|inc|ltd|llc|corp|company)$/i, "")
    .replace(/\./g, " ");

  // Capitalize
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
