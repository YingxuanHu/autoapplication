import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { discoverCompany } from "@/lib/discovery/company-discovery";
import type { ATSType, CrawlStatus } from "@/generated/prisma";

function normalizeCompanySummary(company: {
  id: string;
  name: string;
  domain: string;
  careersUrl: string | null;
  detectedATS: ATSType | null;
  trustScore: number;
  crawlStatus: CrawlStatus;
  lastSyncAt: Date | null;
  lastSuccessAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  sources: Array<{ isActive: boolean }>;
  _count: { sources: number; jobs: number };
}) {
  const activeSourceCount = company.sources.filter((source) => source.isActive).length;

  return {
    id: company.id,
    name: company.name,
    domain: company.domain,
    careersUrl: company.careersUrl,
    detectedATS: company.detectedATS,
    atsType: company.detectedATS,
    trustScore: company.trustScore,
    crawlStatus: company.crawlStatus,
    activeSourceCount,
    sourceCount: company._count.sources,
    jobCount: company._count.jobs,
    lastSyncAt: company.lastSyncAt?.toISOString() ?? null,
    lastSyncedAt: company.lastSyncAt?.toISOString() ?? null,
    lastSuccessAt: company.lastSuccessAt?.toISOString() ?? null,
    createdAt: company.createdAt.toISOString(),
    updatedAt: company.updatedAt.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const q = searchParams.get("q") ?? searchParams.get("search") ?? undefined;
    const atsType = searchParams.get("atsType") as ATSType | null;
    const crawlStatus = searchParams.get("crawlStatus") as CrawlStatus | null;
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(
      100,
      Math.max(
        1,
        parseInt(
          searchParams.get("limit") || searchParams.get("pageSize") || "20",
          10,
        ),
      ),
    );
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { isActive: true };

    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { domain: { contains: q, mode: "insensitive" } },
      ];
    }

    if (atsType) {
      where.detectedATS = atsType;
    }

    if (crawlStatus) {
      where.crawlStatus = crawlStatus;
    }

    const [companies, total] = await Promise.all([
      prisma.company.findMany({
        where,
        include: {
          sources: {
            select: { isActive: true },
          },
          _count: {
            select: { sources: true, jobs: true },
          },
        },
        orderBy: { updatedAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.company.count({ where }),
    ]);

    const normalizedCompanies = companies.map(normalizeCompanySummary);

    return NextResponse.json({
      companies: normalizedCompanies,
      total,
      page,
      pageSize: limit,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Failed to list companies:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { domain, name } = body as { domain?: string; name?: string };

    if (!domain || typeof domain !== "string") {
      return NextResponse.json(
        { error: "Domain is required" },
        { status: 400 },
      );
    }

    // Normalize domain
    const normalizedDomain = domain
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "");

    if (!normalizedDomain || !normalizedDomain.includes(".")) {
      return NextResponse.json(
        { error: "Invalid domain format" },
        { status: 400 },
      );
    }

    // Run discovery
    const result = await discoverCompany(normalizedDomain);

    // Update name if provided
    if (name) {
      await prisma.company.update({
        where: { id: result.companyId },
        data: { name },
      });
    }

    const company = await prisma.company.findUnique({
      where: { id: result.companyId },
      include: {
        sources: {
          select: { isActive: true },
        },
        _count: {
          select: { sources: true, jobs: true },
        },
      },
    });

    return NextResponse.json({
      company: company ? normalizeCompanySummary(company) : null,
      discovery: {
        sourcesCreated: result.sourcesCreated,
        discoveriesCreated: result.discoveriesCreated,
        jobPostingsFound: result.jobPostingsFound,
        trustScore: result.trustScore,
        errors: result.errors,
      },
    });
  } catch (error) {
    console.error("Failed to add company:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
