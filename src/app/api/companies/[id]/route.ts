import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";

type CompanyDetailRecord = Prisma.CompanyGetPayload<{
  include: {
    sources: true;
    crawlRuns: true;
    discoveries: true;
    _count: {
      select: {
        sources: true;
        jobs: true;
        discoveries: true;
      };
    };
  };
}>;

function serializeCompany(company: CompanyDetailRecord) {
  return {
    id: company.id,
    name: company.name,
    domain: company.domain,
    careersUrl: company.careersUrl,
    detectedATS: company.detectedATS,
    atsType: company.detectedATS,
    trustScore: company.trustScore,
    crawlStatus: company.crawlStatus,
    isActive: company.isActive,
    metadata: company.metadata,
    lastSyncAt: company.lastSyncAt?.toISOString() ?? null,
    lastSuccessAt: company.lastSuccessAt?.toISOString() ?? null,
    createdAt: company.createdAt.toISOString(),
    updatedAt: company.updatedAt.toISOString(),
    counts: {
      sources: company._count.sources,
      jobs: company._count.jobs,
      discoveries: company._count.discoveries,
    },
    sources: company.sources.map((source) => ({
      id: source.id,
      sourceType: source.sourceType,
      type: source.sourceType,
      atsType: source.atsType,
      sourceUrl: source.sourceUrl,
      url: source.sourceUrl,
      boardToken: source.boardToken,
      isVerified: source.isVerified,
      verified: source.isVerified,
      isActive: source.isActive,
      active: source.isActive,
      priority: source.priority,
      lastCrawlStatus: source.lastCrawlStatus,
      lastCrawlAt: source.lastCrawlAt?.toISOString() ?? null,
      lastJobCount: source.lastJobCount,
      failCount: source.failCount,
      successCount: source.successCount,
      metadata: source.metadata,
      createdAt: source.createdAt.toISOString(),
      updatedAt: source.updatedAt.toISOString(),
    })),
    crawlRuns: company.crawlRuns.map((run) => ({
      id: run.id,
      sourceId: run.sourceId,
      status: run.status,
      jobsFound: run.jobsFound,
      jobsNew: run.jobsNew,
      jobsUpdated: run.jobsUpdated,
      jobsRemoved: run.jobsRemoved,
      errorMessage: run.errorMessage,
      durationMs: run.durationMs,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      metadata: run.metadata,
    })),
    discoveries: company.discoveries.map((discovery) => ({
      id: discovery.id,
      discoveredUrl: discovery.discoveredUrl,
      url: discovery.discoveredUrl,
      discoveryMethod: discovery.discoveryMethod,
      method: discovery.discoveryMethod,
      sourceType: discovery.sourceType,
      atsType: discovery.atsType,
      confidence: discovery.confidence,
      isPromoted: discovery.isPromoted,
      promoted: discovery.isPromoted,
      metadata: discovery.metadata,
      createdAt: discovery.createdAt.toISOString(),
      discoveredAt: discovery.createdAt.toISOString(),
    })),
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const company = await prisma.company.findUnique({
      where: { id },
      include: {
        sources: {
          orderBy: { priority: "desc" },
        },
        crawlRuns: {
          orderBy: { startedAt: "desc" },
          take: 10,
        },
        discoveries: {
          orderBy: { confidence: "desc" },
          take: 50,
        },
        _count: {
          select: { sources: true, jobs: true, discoveries: true },
        },
      },
    });

    if (!company) {
      return NextResponse.json(
        { error: "Company not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(serializeCompany(company));
  } catch (error) {
    console.error("Failed to get company:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json();
    const { name, careersUrl, isActive } = body as {
      name?: string;
      careersUrl?: string;
      isActive?: boolean;
    };

    const existing = await prisma.company.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "Company not found" },
        { status: 404 },
      );
    }

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (careersUrl !== undefined) data.careersUrl = careersUrl;
    if (isActive !== undefined) data.isActive = isActive;

    const company = await prisma.company.update({
      where: { id },
      data,
      include: {
        sources: true,
        _count: {
          select: { sources: true, jobs: true },
        },
      },
    });

    return NextResponse.json(company);
  } catch (error) {
    console.error("Failed to update company:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const existing = await prisma.company.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "Company not found" },
        { status: 404 },
      );
    }

    // Soft delete
    const company = await prisma.company.update({
      where: { id },
      data: { isActive: false },
    });

    return NextResponse.json({ success: true, company });
  } catch (error) {
    console.error("Failed to delete company:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
