import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { discoverCompany } from "@/lib/discovery/company-discovery";
import { syncCompanyJobs } from "@/lib/discovery/sync-engine";

export async function POST(
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
    });

    if (!company) {
      return NextResponse.json(
        { error: "Company not found" },
        { status: 404 },
      );
    }

    if (!company.isActive) {
      return NextResponse.json(
        { error: "Company is inactive" },
        { status: 400 },
      );
    }

    // Step 1: Re-run discovery and ATS detection
    const discoveryResult = await discoverCompany(company.domain);

    // Step 2: Fetch jobs from all active sources
    const syncStats = await syncCompanyJobs(id);

    // Fetch the updated company
    const updatedCompany = await prisma.company.findUnique({
      where: { id },
      include: {
        sources: true,
        crawlRuns: {
          orderBy: { startedAt: "desc" },
          take: 5,
        },
        _count: {
          select: { sources: true, jobs: true },
        },
      },
    });

    return NextResponse.json({
      message: `Discovered ${discoveryResult.sourcesCreated} sources and synced ${syncStats.jobsFound} jobs`,
      company: updatedCompany,
      discovery: {
        sourcesCreated: discoveryResult.sourcesCreated,
        discoveriesCreated: discoveryResult.discoveriesCreated,
        detectedATS: discoveryResult.detectedATS,
        trustScore: discoveryResult.trustScore,
        errors: discoveryResult.errors,
      },
      sync: syncStats,
    });
  } catch (error) {
    console.error("Failed to crawl company:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
