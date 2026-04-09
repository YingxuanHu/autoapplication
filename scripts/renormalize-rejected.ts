/**
 * Re-normalization script for previously rejected raw jobs.
 *
 * Finds raw jobs without source mappings, re-runs them through the
 * (now expanded) normalization pipeline, and upserts any that pass.
 *
 * Usage:
 *   npx tsx -r dotenv/config scripts/renormalize-rejected.ts [--limit=5000] [--source=Adzuna%]
 */
import { prisma } from "@/lib/db";
import { normalizeSourceJob } from "@/lib/ingestion/normalize";
import { findCrossSourceCanonicalMatch } from "@/lib/ingestion/dedupe";
import { deriveSourceIdentitySnapshot } from "@/lib/ingestion/source-quality";
import type { SourceConnectorJob } from "@/lib/ingestion/types";
import type { Prisma } from "@/generated/prisma/client";

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const sourceArg = args.find((a) => a.startsWith("--source="));
const BATCH_LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : 10000;
const SOURCE_FILTER = sourceArg ? sourceArg.split("=")[1] : "%";
const BATCH_SIZE = 500;

async function main() {
  console.log(`Re-normalizing unmapped raw jobs (limit: ${BATCH_LIMIT}, source: ${SOURCE_FILTER})`);
  const startTime = Date.now();
  let totalProcessed = 0;
  let totalAccepted = 0;
  let totalRejected = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalDeduped = 0;
  let offset = 0;
  const now = new Date();

  while (totalProcessed < BATCH_LIMIT) {
    const batchSize = Math.min(BATCH_SIZE, BATCH_LIMIT - totalProcessed);
    const rawJobs = await prisma.$queryRaw<
      Array<{
        id: string;
        sourceId: string;
        sourceName: string;
        sourceTier: string;
        rawPayload: Prisma.JsonValue;
        fetchedAt: Date;
      }>
    >`
      SELECT j.id, j."sourceId", j."sourceName", j."sourceTier", j."rawPayload", j."fetchedAt"
      FROM "JobRaw" j
      LEFT JOIN "JobSourceMapping" m ON m."rawJobId" = j.id
      WHERE m.id IS NULL
        AND j."sourceName" LIKE ${SOURCE_FILTER}
      ORDER BY j."fetchedAt" DESC
      LIMIT ${batchSize}
      OFFSET ${offset}
    `;

    if (rawJobs.length === 0) {
      console.log("No more unmapped raw jobs found.");
      break;
    }

    for (const raw of rawJobs) {
      totalProcessed++;
      const sourceJob = rawPayloadToSourceJob(raw.rawPayload, raw.sourceId);
      if (!sourceJob) {
        totalRejected++;
        continue;
      }

      const result = normalizeSourceJob({ job: sourceJob, fetchedAt: raw.fetchedAt });
      if (result.kind === "rejected") {
        totalRejected++;
        continue;
      }

      totalAccepted++;
      const normalized = result.job;
      const sourceIdentity = deriveSourceIdentitySnapshot({
        sourceName: raw.sourceName,
        sourceId: sourceJob.sourceId,
        sourceUrl: sourceJob.sourceUrl,
        applyUrl: normalized.applyUrl,
        metadata: sourceJob.metadata,
      });

      // Find existing canonical match
      const crossMatch = await findCrossSourceCanonicalMatch(normalized, sourceIdentity);
      if (crossMatch) {
        totalDeduped++;
      }

      const existingCanonical = crossMatch?.canonical ?? null;

      if (existingCanonical) {
        // Update existing canonical and add source mapping
        await prisma.jobCanonical.update({
          where: { id: existingCanonical.id },
          data: {
            status: "LIVE",
            lastSeenAt: now,
            updatedAt: now,
          },
        });

        // Check if mapping already exists
        const existingMapping = await prisma.jobSourceMapping.findFirst({
          where: { rawJobId: raw.id, canonicalJobId: existingCanonical.id },
        });
        if (existingMapping) {
          await prisma.jobSourceMapping.update({
            where: { id: existingMapping.id },
            data: { lastSeenAt: now },
          });
        } else {
          await prisma.jobSourceMapping.create({
            data: {
              rawJobId: raw.id,
              canonicalJobId: existingCanonical.id,
              sourceName: raw.sourceName,
              sourceUrl: sourceJob.sourceUrl,
              lastSeenAt: now,
            },
          });
        }

        totalUpdated++;
      } else {
        // Create new canonical job
        const canonical = await prisma.jobCanonical.create({
          data: {
            title: normalized.title,
            company: normalized.company,
            companyKey: normalized.companyKey,
            titleKey: normalized.titleKey,
            titleCoreKey: normalized.titleCoreKey,
            descriptionFingerprint: normalized.descriptionFingerprint,
            location: normalized.location,
            locationKey: normalized.locationKey,
            region: normalized.region,
            workMode: normalized.workMode,
            salaryMin: normalized.salaryMin,
            salaryMax: normalized.salaryMax,
            salaryCurrency: normalized.salaryCurrency,
            employmentType: normalized.employmentType,
            experienceLevel: normalized.experienceLevel,
            description: normalized.description,
            shortSummary: normalized.shortSummary,
            industry: normalized.industry,
            roleFamily: normalized.roleFamily,
            applyUrl: normalized.applyUrl,
            applyUrlKey: normalized.applyUrlKey,
            postedAt: normalized.postedAt,
            deadline: normalized.deadline,
            duplicateClusterId: normalized.duplicateClusterId,
            status: "LIVE",
            lastSeenAt: now,
          },
        });

        await prisma.jobSourceMapping.create({
          data: {
            rawJobId: raw.id,
            canonicalJobId: canonical.id,
            sourceName: raw.sourceName,
            sourceUrl: sourceJob.sourceUrl,
            lastSeenAt: now,
          },
        });

        totalCreated++;
      }
    }

    offset += rawJobs.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `Processed: ${totalProcessed} | Accepted: ${totalAccepted} (${totalCreated} new, ${totalUpdated} updated, ${totalDeduped} deduped) | Rejected: ${totalRejected} | ${elapsed}s`
    );
  }

  const total = await prisma.jobCanonical.count({ where: { status: "LIVE" } });
  console.log(`\nDone. Total LIVE pool: ${total}`);
}

function rawPayloadToSourceJob(
  payload: Prisma.JsonValue,
  fallbackSourceId: string
): SourceConnectorJob | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const payloadObject = payload as Record<string, Prisma.JsonValue>;
  const title = readString(payloadObject.title)?.trim();
  const company =
    readString(payloadObject.company)?.trim() ??
    readString(payloadObject.company_name)?.trim() ??
    "";
  const location = readString(payloadObject.location)?.trim() ?? "";
  const description = readString(payloadObject.description)?.trim() ?? "";
  const applyUrl =
    readString(payloadObject.applyUrl)?.trim() ??
    readString(payloadObject.apply_url)?.trim() ??
    readString(payloadObject.sourceUrl)?.trim() ??
    "";

  if (!title || !applyUrl) return null;

  return {
    sourceId: readString(payloadObject.sourceId) ?? fallbackSourceId,
    sourceUrl: readString(payloadObject.sourceUrl) ?? null,
    title,
    company,
    location,
    description,
    applyUrl,
    postedAt: parseDateValue(payloadObject.postedAt),
    deadline: parseDateValue(payloadObject.deadline),
    employmentType: readEnumValue<SourceConnectorJob["employmentType"]>(
      payloadObject.employmentType
    ),
    workMode: readEnumValue<SourceConnectorJob["workMode"]>(payloadObject.workMode),
    salaryMin: readNumber(payloadObject.salaryMin),
    salaryMax: readNumber(payloadObject.salaryMax),
    salaryCurrency: readString(payloadObject.salaryCurrency) ?? null,
    metadata:
      payloadObject.metadata && typeof payloadObject.metadata === "object"
        ? (payloadObject.metadata as Prisma.InputJsonValue)
        : {},
  };
}

function readString(value: Prisma.JsonValue | undefined) {
  return typeof value === "string" ? value : null;
}

function readNumber(value: Prisma.JsonValue | undefined) {
  return typeof value === "number" ? value : null;
}

function parseDateValue(value: Prisma.JsonValue | undefined) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsedValue = new Date(value);
  return Number.isNaN(parsedValue.getTime()) ? null : parsedValue;
}

function readEnumValue<T>(value: Prisma.JsonValue | undefined) {
  return typeof value === "string" ? (value as T) : null;
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error("Re-normalization failed:", err);
    prisma.$disconnect();
    process.exit(1);
  });
