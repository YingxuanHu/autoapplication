import { type NextRequest } from "next/server";
import { getJobs } from "@/lib/queries/jobs";
import { paginatedResponse, errorResponse, parseIntParam } from "@/lib/api-utils";

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const result = await getJobs({
      search: sp.get("search") ?? undefined,
      region: sp.get("region") ?? undefined,
      workMode: sp.get("workMode") ?? undefined,
      industry: sp.get("industry") ?? undefined,
      roleFamily: sp.get("roleFamily") ?? undefined,
      salaryMin: sp.get("salaryMin") ? parseInt(sp.get("salaryMin")!) : undefined,
      experienceLevel: sp.get("experienceLevel") ?? undefined,
      submissionCategory: sp.get("submissionCategory") ?? undefined,
      status: sp.get("status") ?? undefined,
      sortBy: sp.get("sortBy") ?? undefined,
      page: parseIntParam(sp.get("page"), 1),
    });

    return paginatedResponse(result.data, result.total, result.page, result.pageSize);
  } catch (error) {
    console.error("GET /api/jobs error:", error);
    return errorResponse("Failed to fetch jobs", 500);
  }
}
