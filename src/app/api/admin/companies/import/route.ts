import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getCategories,
  seedAllCategories,
  seedCategory,
  type CompanyCategory,
} from "@/lib/discovery/company-lists";

const MAX_BATCH_SIZE = 500;

interface ImportEntry {
  domain: string;
  name?: string;
}

interface ImportResult {
  created: number;
  skipped: number;
  errors: Array<{ domain: string; error: string }>;
}

/**
 * Normalize a domain string: lowercase, strip protocol, www prefix, and path.
 */
function normalizeDomain(raw: string): string | null {
  const cleaned = raw
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");

  if (!cleaned || !cleaned.includes(".")) return null;
  return cleaned;
}

/**
 * Parse a CSV body into ImportEntry[].
 * Expected format: domain,name (header row optional).
 */
function parseCSV(text: string): ImportEntry[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  // Skip header row if it looks like one
  const firstLine = lines[0].toLowerCase();
  const startIndex =
    firstLine.startsWith("domain") || firstLine.startsWith("name") ? 1 : 0;

  const entries: ImportEntry[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const parts = lines[i].split(",").map((p) => p.trim());
    if (parts.length === 0 || !parts[0]) continue;

    entries.push({
      domain: parts[0],
      name: parts[1] || undefined,
    });
  }

  return entries;
}

/**
 * Derive a company name from its domain when no name is provided.
 */
function nameFromDomain(domain: string): string {
  const base = domain.split(".")[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * POST /api/admin/companies/import
 *
 * Accepts either:
 *   - JSON body with { domains: string[] } or { companies: Array<{ domain, name? }> }
 *   - CSV text (Content-Type: text/csv) with domain,name pairs
 *
 * Deduplicates against existing companies and creates new ones with PENDING status.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let entries: ImportEntry[] = [];

    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("text/csv")) {
      const text = await request.text();
      entries = parseCSV(text);
    } else {
      const body = await request.json();
      const preset = typeof body.preset === "string" ? body.preset : null;

      if (preset) {
        if (preset === "ALL") {
          const summary = await seedAllCategories();
          return NextResponse.json({
            preset: "ALL",
            summary: {
              total: summary.created + summary.skipped,
              created: summary.created,
              skipped: summary.skipped,
              sourcesCreated: summary.sourcesCreated,
            },
          });
        }

        const categories = getCategories();
        if (!categories.includes(preset as CompanyCategory)) {
          return NextResponse.json(
            {
              error: `Unknown preset "${preset}". Valid presets: ALL, ${categories.join(", ")}`,
            },
            { status: 400 },
          );
        }

        const summary = await seedCategory(preset as CompanyCategory);
        return NextResponse.json({
          preset,
          summary: {
            total: summary.created + summary.skipped,
            created: summary.created,
            skipped: summary.skipped,
            sourcesCreated: summary.sourcesCreated,
          },
        });
      }

      if (Array.isArray(body.domains)) {
        entries = (body.domains as string[]).map((d) => ({ domain: d }));
      } else if (Array.isArray(body.companies)) {
        entries = body.companies as ImportEntry[];
      } else if (Array.isArray(body)) {
        // Accept a plain JSON array of domain strings or objects
        entries = body.map((item: string | ImportEntry) =>
          typeof item === "string" ? { domain: item } : item,
        );
      } else {
        return NextResponse.json(
          {
            error:
              'Request body must include "domains" (string[]) or "companies" (array of {domain, name?}), or be CSV text.',
          },
          { status: 400 },
        );
      }
    }

    if (entries.length === 0) {
      return NextResponse.json(
        { error: "No entries provided" },
        { status: 400 },
      );
    }

    if (entries.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `Too many entries. Maximum is ${MAX_BATCH_SIZE} per request.` },
        { status: 400 },
      );
    }

    // Normalize and validate domains
    const normalized: Array<{ domain: string; name: string }> = [];
    const result: ImportResult = { created: 0, skipped: 0, errors: [] };

    for (const entry of entries) {
      const domain = normalizeDomain(entry.domain);
      if (!domain) {
        result.errors.push({
          domain: entry.domain,
          error: "Invalid domain format",
        });
        continue;
      }

      // Deduplicate within the batch
      if (normalized.some((n) => n.domain === domain)) {
        result.errors.push({
          domain: entry.domain,
          error: "Duplicate within batch",
        });
        continue;
      }

      normalized.push({
        domain,
        name: entry.name || nameFromDomain(domain),
      });
    }

    // Check which domains already exist in the database
    const existingCompanies = await prisma.company.findMany({
      where: { domain: { in: normalized.map((n) => n.domain) } },
      select: { domain: true },
    });

    const existingSet = new Set(existingCompanies.map((c) => c.domain));

    // Separate into create vs skip
    const toCreate: Array<{ domain: string; name: string }> = [];

    for (const entry of normalized) {
      if (existingSet.has(entry.domain)) {
        result.skipped++;
      } else {
        toCreate.push(entry);
      }
    }

    // Batch create
    if (toCreate.length > 0) {
      await prisma.company.createMany({
        data: toCreate.map((entry) => ({
          name: entry.name,
          domain: entry.domain,
          crawlStatus: "PENDING",
          trustScore: 0.5,
        })),
        skipDuplicates: true,
      });
      result.created = toCreate.length;
    }

    return NextResponse.json({
      summary: {
        total: entries.length,
        created: result.created,
        skipped: result.skipped,
        errors: result.errors.length,
      },
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (error) {
    console.error("Failed to import companies:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
