import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { generateHealthReport, autoDisableFailingSources } from "@/lib/discovery/health-monitor";

/**
 * GET /api/admin/health
 *
 * Returns an overall health dashboard including:
 *   - Total companies and active sources
 *   - Health breakdown (healthy / degraded / unhealthy / dead)
 *   - Recent failures list
 *   - Companies needing attention
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const report = await generateHealthReport();

    return NextResponse.json({
      generatedAt: report.generatedAt.toISOString(),
      overview: {
        totalCompanies: report.totalCompanies,
        totalSources: report.totalSources,
        activeSources: report.activeSources,
      },
      healthBreakdown: report.healthBreakdown,
      unhealthySources: report.unhealthySources.map((s) => ({
        sourceId: s.sourceId,
        companyName: s.companyName,
        companyDomain: s.companyDomain,
        sourceUrl: s.sourceUrl,
        atsType: s.atsType,
        healthStatus: s.healthStatus,
        consecutiveFailures: s.consecutiveFailures,
        successRate: Math.round(s.successRate * 100),
        avgResponseTimeMs: Math.round(s.avgResponseTimeMs),
        lastCrawlAt: s.lastCrawlAt?.toISOString() ?? null,
      })),
      recentFailures: report.recentFailures.map((f) => ({
        sourceId: f.sourceId,
        companyName: f.companyName,
        companyDomain: f.companyDomain,
        sourceUrl: f.sourceUrl,
        errorMessage: f.errorMessage,
        failedAt: f.failedAt.toISOString(),
      })),
      companiesNeedingAttention: report.companiesNeedingAttention,
    });
  } catch (error) {
    console.error("Failed to generate health report:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/admin/health
 *
 * Trigger maintenance actions:
 *   - action: "auto-disable" - disable sources exceeding failure threshold
 *
 * Body: { action: string, threshold?: number }
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { action, threshold } = body as {
      action?: string;
      threshold?: number;
    };

    if (action === "auto-disable") {
      const disabledIds = await autoDisableFailingSources(threshold);
      return NextResponse.json({
        action: "auto-disable",
        disabledCount: disabledIds.length,
        disabledSourceIds: disabledIds,
      });
    }

    return NextResponse.json(
      { error: 'Unknown action. Supported: "auto-disable"' },
      { status: 400 },
    );
  } catch (error) {
    console.error("Failed to run health action:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
