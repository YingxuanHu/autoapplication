import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { discoverCompany } from "@/lib/discovery/company-discovery";
import type { DiscoveryResult } from "@/lib/discovery/company-discovery";

const MAX_DOMAINS_PER_REQUEST = 10;

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { domains } = body as { domains?: string[] };

    if (!Array.isArray(domains) || domains.length === 0) {
      return NextResponse.json(
        { error: "An array of domains is required" },
        { status: 400 },
      );
    }

    if (domains.length > MAX_DOMAINS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Maximum ${MAX_DOMAINS_PER_REQUEST} domains per request` },
        { status: 400 },
      );
    }

    // Normalize and validate domains
    const normalizedDomains = domains
      .map((d) =>
        String(d)
          .toLowerCase()
          .trim()
          .replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .replace(/\/.*$/, ""),
      )
      .filter((d) => d && d.includes("."));

    if (normalizedDomains.length === 0) {
      return NextResponse.json(
        { error: "No valid domains provided" },
        { status: 400 },
      );
    }

    // Discover each domain
    const results: Array<{
      domain: string;
      success: boolean;
      result?: DiscoveryResult;
      error?: string;
    }> = [];

    for (const domain of normalizedDomains) {
      try {
        const result = await discoverCompany(domain);
        results.push({ domain, success: true, result });
      } catch (err) {
        results.push({
          domain,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const normalizedResults = results.map((entry) => ({
      domain: entry.domain,
      success: entry.success,
      companyId: entry.result?.companyId ?? null,
      companyName: entry.result?.companyName ?? null,
      careersUrl: entry.result?.careersUrl ?? null,
      atsType: entry.result?.detectedATS ?? null,
      sourcesFound: entry.result?.sourcesCreated ?? 0,
      discoveriesFound: entry.result?.discoveriesCreated ?? 0,
      jobPostingsFound: entry.result?.jobPostingsFound ?? 0,
      trustScore: entry.result?.trustScore ?? null,
      error: entry.error,
      errors: entry.result?.errors ?? [],
    }));

    return NextResponse.json({
      summary: {
        total: normalizedDomains.length,
        succeeded,
        failed,
        totalSourcesCreated: results.reduce(
          (sum, r) => sum + (r.result?.sourcesCreated ?? 0),
          0,
        ),
        totalJobPostingsFound: results.reduce(
          (sum, r) => sum + (r.result?.jobPostingsFound ?? 0),
          0,
        ),
      },
      results: normalizedResults,
    });
  } catch (error) {
    console.error("Failed to discover companies:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
