import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getCompanySourcesHealth } from "@/lib/discovery/health-monitor";
import type { ATSType, CrawlStatus, Prisma } from "@/generated/prisma";

type SortField = "name" | "trustScore" | "lastSyncAt" | "createdAt";
type SortOrder = "asc" | "desc";

/**
 * GET /api/admin/companies
 *
 * List companies with filters:
 *   - status (crawlStatus): PENDING | CRAWLING | SUCCESS | FAILED | ...
 *   - atsType: GREENHOUSE | LEVER | ASHBY | ...
 *   - hasSource: true/false  - whether company has at least one source
 *   - lastSyncBefore: ISO date - companies not synced since this date
 *   - q: text search on name/domain
 *   - health: filter by overall health status (HEALTHY | DEGRADED | UNHEALTHY | DEAD)
 *   - sortBy: name | trustScore | lastSyncAt | createdAt (default: createdAt)
 *   - sortOrder: asc | desc (default: desc)
 *   - page / limit: pagination
 *   - includeHealth: true - include per-company source health summary (slower)
 */
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const params = request.nextUrl.searchParams;

    // Pagination
    const page = Math.max(1, parseInt(params.get("page") || "1", 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(params.get("limit") || "20", 10)),
    );
    const skip = (page - 1) * limit;

    // Sorting
    const sortBy = (params.get("sortBy") as SortField) || "createdAt";
    const sortOrder = (params.get("sortOrder") as SortOrder) || "desc";
    const validSortFields: SortField[] = [
      "name",
      "trustScore",
      "lastSyncAt",
      "createdAt",
    ];
    const orderBy: Prisma.CompanyOrderByWithRelationInput = validSortFields.includes(sortBy)
      ? { [sortBy]: sortOrder }
      : { createdAt: "desc" };

    // Filters
    const where: Prisma.CompanyWhereInput = {};

    const q = params.get("q");
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { domain: { contains: q, mode: "insensitive" } },
      ];
    }

    const status = params.get("status") as CrawlStatus | null;
    if (status) {
      where.crawlStatus = status;
    }

    const atsType = params.get("atsType") as ATSType | null;
    if (atsType) {
      where.detectedATS = atsType;
    }

    const hasSource = params.get("hasSource");
    if (hasSource === "true") {
      where.sources = { some: {} };
    } else if (hasSource === "false") {
      where.sources = { none: {} };
    }

    const lastSyncBefore = params.get("lastSyncBefore");
    if (lastSyncBefore) {
      const date = new Date(lastSyncBefore);
      if (!isNaN(date.getTime())) {
        where.OR = [
          ...(Array.isArray(where.OR) ? where.OR : []),
          { lastSyncAt: { lt: date } },
          { lastSyncAt: null },
        ];
        // If we already have OR from text search, wrap everything in AND
        if (q) {
          where.AND = [
            {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { domain: { contains: q, mode: "insensitive" } },
              ],
            },
            {
              OR: [{ lastSyncAt: { lt: date } }, { lastSyncAt: null }],
            },
          ];
          delete where.OR;
        }
      }
    }

    const [companies, total] = await Promise.all([
      prisma.company.findMany({
        where,
        include: {
          sources: {
            select: {
              id: true,
              sourceType: true,
              atsType: true,
              sourceUrl: true,
              isVerified: true,
              isActive: true,
              lastCrawlStatus: true,
              lastCrawlAt: true,
              lastJobCount: true,
              failCount: true,
              successCount: true,
            },
          },
          _count: {
            select: { sources: true, jobs: true, crawlRuns: true },
          },
        },
        orderBy,
        skip,
        take: limit,
      }),
      prisma.company.count({ where }),
    ]);

    // Optionally include health summary per company
    const includeHealth = params.get("includeHealth") === "true";
    let companiesWithHealth = companies;

    if (includeHealth) {
      const enriched = await Promise.all(
        companies.map(async (company) => {
          const sourceHealth = await getCompanySourcesHealth(company.id);
          const healthSummary = {
            healthy: sourceHealth.filter((s) => s.healthStatus === "HEALTHY").length,
            degraded: sourceHealth.filter((s) => s.healthStatus === "DEGRADED").length,
            unhealthy: sourceHealth.filter((s) => s.healthStatus === "UNHEALTHY").length,
            dead: sourceHealth.filter((s) => s.healthStatus === "DEAD").length,
          };
          return { ...company, healthSummary };
        }),
      );
      companiesWithHealth = enriched as typeof companies;
    }

    return NextResponse.json({
      companies: companiesWithHealth,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Failed to list companies (admin):", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
