import { revalidatePath } from "next/cache";
import { errorResponse, successResponse } from "@/lib/api-utils";
import { buildProfileContext } from "@/lib/ai/context-builders";
import { formatFitAnalysisForStorage } from "@/lib/ai/fit-analysis-format";
import type { JobContext } from "@/lib/ai/job-fit";
import { UnauthorizedError, requireCurrentAuthUserId } from "@/lib/current-user";
import { prisma } from "@/lib/db";

function revalidateApplication(applicationId: string) {
  revalidatePath("/applications");
  revalidatePath("/applications/history");
  revalidatePath("/dashboard");
  revalidatePath(`/applications/${applicationId}`);
  revalidatePath(`/dashboard/${applicationId}`);
}

async function buildTrackedApplicationJobContext(
  applicationId: string,
  authUserId: string
): Promise<JobContext | null> {
  const application = await prisma.trackedApplication.findFirst({
    where: { id: applicationId, userId: authUserId },
    select: {
      id: true,
      company: true,
      roleTitle: true,
      jobDescription: true,
      canonicalJob: {
        select: {
          title: true,
          company: true,
          location: true,
          workMode: true,
          experienceLevel: true,
          roleFamily: true,
          salaryMin: true,
          salaryMax: true,
          salaryCurrency: true,
          description: true,
        },
      },
    },
  });

  if (!application) {
    return null;
  }

  const canonicalJob = application.canonicalJob;
  const description =
    application.jobDescription?.trim() || canonicalJob?.description?.trim() || "";

  if (!description) {
    return null;
  }

  return {
    title: canonicalJob?.title ?? application.roleTitle,
    company: canonicalJob?.company ?? application.company,
    location: canonicalJob?.location ?? "Unknown",
    workMode: canonicalJob?.workMode ?? "FLEXIBLE",
    experienceLevel: canonicalJob?.experienceLevel ?? null,
    roleFamily: canonicalJob?.roleFamily ?? "General",
    salaryMin: canonicalJob?.salaryMin ?? null,
    salaryMax: canonicalJob?.salaryMax ?? null,
    salaryCurrency: canonicalJob?.salaryCurrency ?? null,
    description,
  };
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!process.env.OPENAI_API_KEY) {
      return errorResponse("OPENAI_API_KEY not configured", 503);
    }

    const authUserId = await requireCurrentAuthUserId();

    const [jobCtx, profileCtx] = await Promise.all([
      buildTrackedApplicationJobContext(id, authUserId),
      buildProfileContext(),
    ]);

    if (!jobCtx) {
      return errorResponse(
        "Add a job description first, or use a pool-linked application that already has one.",
        400
      );
    }
    if (!profileCtx) {
      return errorResponse("Profile not found", 404);
    }

    const { analyzeJobFit } = await import("@/lib/ai/job-fit");
    const result = await analyzeJobFit(jobCtx, profileCtx);

    await prisma.trackedApplication.update({
      where: { id },
      data: {
        fitAnalysis: formatFitAnalysisForStorage(result),
      },
    });

    revalidateApplication(id);
    return successResponse(result);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    console.error("POST /api/applications/[id]/ai/analyze error:", error);
    const message = error instanceof Error ? error.message : "Analysis failed";
    return errorResponse(message, 500);
  }
}
