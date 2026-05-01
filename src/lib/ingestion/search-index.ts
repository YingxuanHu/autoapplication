import { prisma } from "@/lib/db";
import {
  buildSearchText,
  computeFreshnessScore,
  computeRankingScore,
  computeTrustScore,
} from "@/lib/ingestion/quality";

export async function upsertJobFeedIndex(canonicalJobId: string) {
  const canonical = await prisma.jobCanonical.findUniqueOrThrow({
    where: { id: canonicalJobId },
    include: {
      sourceMappings: {
        where: { removedAt: null },
        orderBy: [{ sourceQualityRank: "desc" }, { lastSeenAt: "desc" }],
      },
      eligibility: true,
    },
  });

  const primarySource = canonical.sourceMappings[0] ?? null;
  const sourceCount = canonical.sourceMappings.length;
  const trustScore = computeTrustScore({
    sourceReliability: primarySource?.sourceReliability ?? null,
    sourceType: primarySource?.sourceType ?? null,
    sourceQualityKind: primarySource?.sourceQualityKind ?? null,
    sourceCount,
  });
  const freshnessScore = computeFreshnessScore({
    postedAt: canonical.postedAt,
    lastSeenAt: canonical.lastSeenAt,
    lastConfirmedAliveAt: canonical.lastConfirmedAliveAt,
    status: canonical.status,
    deadline: canonical.deadline,
  });
  const qualityScore = canonical.qualityScore;
  const rankingScore = computeRankingScore({
    qualityScore,
    trustScore,
    freshnessScore,
    sourceCount,
    submissionCategory: canonical.eligibility?.submissionCategory ?? null,
  });

  await prisma.$transaction([
    prisma.jobCanonical.update({
      where: { id: canonicalJobId },
      data: {
        trustScore,
        freshnessScore,
      },
    }),
    prisma.jobFeedIndex.upsert({
      where: { canonicalJobId },
      create: {
        canonicalJobId,
        status: canonical.status,
        submissionCategory: canonical.eligibility?.submissionCategory ?? null,
        title: canonical.title,
        company: canonical.company,
        location: canonical.location,
        region: canonical.region,
        workMode: canonical.workMode,
        employmentType: canonical.employmentType,
        experienceLevel: canonical.experienceLevel,
        industry: canonical.industry,
        roleFamily: canonical.roleFamily,
        salaryMin: canonical.salaryMin,
        salaryMax: canonical.salaryMax,
        salaryCurrency: canonical.salaryCurrency,
        postedAt: canonical.postedAt,
        deadline: canonical.deadline,
        qualityScore,
        trustScore,
        freshnessScore,
        rankingScore,
        sourceCount,
        applyUrl: canonical.applyUrl,
        searchText: buildSearchText({
          title: canonical.title,
          company: canonical.company,
          location: canonical.location,
          roleFamily: canonical.roleFamily,
          shortSummary: canonical.shortSummary,
          description: canonical.description,
        }),
        metadataJson: {
          availabilityScore: canonical.availabilityScore,
          lastConfirmedAliveAt: canonical.lastConfirmedAliveAt?.toISOString() ?? null,
          sourceQualityKind: primarySource?.sourceQualityKind ?? null,
        },
        indexedAt: new Date(),
      },
      update: {
        status: canonical.status,
        submissionCategory: canonical.eligibility?.submissionCategory ?? null,
        title: canonical.title,
        company: canonical.company,
        location: canonical.location,
        region: canonical.region,
        workMode: canonical.workMode,
        employmentType: canonical.employmentType,
        experienceLevel: canonical.experienceLevel,
        industry: canonical.industry,
        roleFamily: canonical.roleFamily,
        salaryMin: canonical.salaryMin,
        salaryMax: canonical.salaryMax,
        salaryCurrency: canonical.salaryCurrency,
        postedAt: canonical.postedAt,
        deadline: canonical.deadline,
        qualityScore,
        trustScore,
        freshnessScore,
        rankingScore,
        sourceCount,
        applyUrl: canonical.applyUrl,
        searchText: buildSearchText({
          title: canonical.title,
          company: canonical.company,
          location: canonical.location,
          roleFamily: canonical.roleFamily,
          shortSummary: canonical.shortSummary,
          description: canonical.description,
        }),
        metadataJson: {
          availabilityScore: canonical.availabilityScore,
          lastConfirmedAliveAt: canonical.lastConfirmedAliveAt?.toISOString() ?? null,
          sourceQualityKind: primarySource?.sourceQualityKind ?? null,
        },
        indexedAt: new Date(),
      },
    }),
  ]);
}
