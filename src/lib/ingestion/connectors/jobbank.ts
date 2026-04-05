/**
 * Job Bank Canada (jobbank.gc.ca) connector.
 *
 * Ingests from the Government of Canada's Open Data CSV dumps of all
 * Job Bank job postings. Updated monthly.
 *
 * Source: https://open.canada.ca/data/en/dataset/ea639e28-c0fc-48bf-b5dd-b8899bd43072
 *
 * Volume: 50K-100K+ Canadian jobs per monthly dump.
 * Region: Canada only.
 *
 * The CSV is UTF-16LE encoded, tab-separated.
 * Columns include: Job Title, Province/Territory, City, Salary, Employment Type, NOC codes, etc.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { EmploymentType, WorkMode } from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";

// The CSV URL pattern — we construct the latest month's URL dynamically
const JOBBANK_DATASET_BASE =
  "https://open.canada.ca/data/dataset/ea639e28-c0fc-48bf-b5dd-b8899bd43072/resource";

// Known resource IDs for recent months (newest first)
const KNOWN_RESOURCES: Array<{ year: number; month: number; resourceId: string; label: string }> = [
  { year: 2026, month: 2, resourceId: "e8c27948-6a40-452b-8d7d-2e1b799ca8aa", label: "feb2026" },
  { year: 2026, month: 1, resourceId: "c00b8591-7e90-4ac8-8fa3-652c2cce0ab6", label: "jan2026" },
  { year: 2025, month: 12, resourceId: "32d6617f-0a84-40bc-8d7b-6bfabd3c16f6", label: "december2025" },
];

type JobBankConnectorOptions = {
  resourceId?: string;
  label?: string;
  maxJobs?: number;
};

export function createJobBankConnector(
  options: JobBankConnectorOptions = {}
): SourceConnector {
  // Use the most recent known resource by default
  const resource = options.resourceId
    ? { resourceId: options.resourceId, label: options.label ?? "custom" }
    : KNOWN_RESOURCES[0];

  const maxJobs = options.maxJobs ?? 100_000;

  return {
    key: `jobbank:${resource.label}`,
    sourceName: `JobBank:${resource.label}`,
    sourceTier: "TIER_2",
    freshnessMode: "INCREMENTAL",

    async fetchJobs(fetchOptions: SourceConnectorFetchOptions): Promise<SourceConnectorFetchResult> {
      const log = fetchOptions.log ?? console.log;
      const csvUrl = buildCsvUrl(resource.resourceId, resource.label);
      log(`[JobBank] Fetching CSV from: ${csvUrl}`);

      const response = await fetch(csvUrl, {
        signal: fetchOptions.signal,
      });

      if (!response.ok) {
        log(`[JobBank] HTTP ${response.status} fetching CSV`);
        return { jobs: [], metadata: { error: `HTTP ${response.status}` } };
      }

      const buffer = await response.arrayBuffer();
      const text = decodeUtf16Le(buffer);

      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      if (lines.length < 2) {
        log("[JobBank] CSV has no data rows");
        return { jobs: [], metadata: { totalRows: 0 } };
      }

      const headers = parseTabLine(lines[0]);
      const headerIndex = buildHeaderIndex(headers);

      log(`[JobBank] CSV has ${lines.length - 1} data rows, ${headers.length} columns`);

      const jobs: SourceConnectorJob[] = [];
      let skipped = 0;

      for (let i = 1; i < lines.length && jobs.length < maxJobs; i++) {
        const fields = parseTabLine(lines[i]);
        const job = parseJobRow(fields, headerIndex);
        if (job) {
          jobs.push(job);
        } else {
          skipped++;
        }
      }

      log(
        `[JobBank] Parsed ${jobs.length} jobs, skipped ${skipped} rows`
      );

      return {
        jobs,
        metadata: {
          totalRows: lines.length - 1,
          parsed: jobs.length,
          skipped,
          resource: resource.label,
        },
      };
    },
  };
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

function buildCsvUrl(resourceId: string, label: string): string {
  return `${JOBBANK_DATASET_BASE}/${resourceId}/download/job-bank-open-data-all-job-postings-en-${label}.csv`;
}

function decodeUtf16Le(buffer: ArrayBuffer): string {
  // The Job Bank CSVs are UTF-16LE encoded with BOM
  const uint8 = new Uint8Array(buffer);
  // Check for BOM (FF FE)
  const start = uint8[0] === 0xff && uint8[1] === 0xfe ? 2 : 0;
  const decoder = new TextDecoder("utf-16le");
  return decoder.decode(uint8.slice(start));
}

function parseTabLine(line: string): string[] {
  return line.split("\t").map((f) => f.trim());
}

function buildHeaderIndex(headers: string[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < headers.length; i++) {
    index.set(headers[i].toLowerCase(), i);
  }
  return index;
}

function getField(fields: string[], headerIndex: Map<string, number>, name: string): string {
  const idx = headerIndex.get(name.toLowerCase());
  if (idx === undefined || idx >= fields.length) return "";
  const val = fields[idx];
  return val === "NA" || val === "*No data" ? "" : val;
}

function parseJobRow(
  fields: string[],
  headerIndex: Map<string, number>
): SourceConnectorJob | null {
  const snapshotId = getField(fields, headerIndex, "WIC Job Location Snapshot ID");
  const title = getField(fields, headerIndex, "Job Title") || getField(fields, headerIndex, "Original Job Title");
  const province = getField(fields, headerIndex, "Province/Territory");
  const city = getField(fields, headerIndex, "City");

  if (!title || !snapshotId) return null;

  // Build location string
  const locationParts = [city, province, "Canada"].filter(Boolean);
  const location = locationParts.join(", ");

  // Build apply URL
  const applyUrl = `https://www.jobbank.gc.ca/jobsearch/jobposting/${snapshotId}`;

  // Parse salary
  const salaryMin = parseFloat(getField(fields, headerIndex, "Salary Minimum")) || null;
  const salaryMax = parseFloat(getField(fields, headerIndex, "Salary Maximum")) || null;
  const salaryPer = getField(fields, headerIndex, "Salary Per").toLowerCase();

  // Annualize hourly wages for consistency
  let annualMin = salaryMin;
  let annualMax = salaryMax;
  if (salaryPer === "hour" && salaryMin) {
    annualMin = Math.round(salaryMin * 2080); // 40h/week × 52 weeks
    annualMax = salaryMax ? Math.round(salaryMax * 2080) : null;
  } else if (salaryPer === "week" && salaryMin) {
    annualMin = Math.round(salaryMin * 52);
    annualMax = salaryMax ? Math.round(salaryMax * 52) : null;
  } else if (salaryPer === "month" && salaryMin) {
    annualMin = Math.round(salaryMin * 12);
    annualMax = salaryMax ? Math.round(salaryMax * 12) : null;
  }

  // Parse employment type
  const empTypeRaw = getField(fields, headerIndex, "Employment Type").toLowerCase();
  let employmentType: EmploymentType | null = null;
  if (empTypeRaw.includes("full time")) employmentType = "FULL_TIME";
  else if (empTypeRaw.includes("part time")) employmentType = "PART_TIME";

  // Parse work mode from telework field
  const telework = getField(fields, headerIndex, "Employment Term Telework").toLowerCase();
  let workMode: WorkMode | null = null;
  if (telework === "yes" || telework === "1") workMode = "REMOTE";

  // Parse posted date
  const postedStr = getField(fields, headerIndex, "First Posting Date");
  const postedAt = postedStr ? new Date(postedStr) : null;

  // Build description from available fields
  const nocCode = getField(fields, headerIndex, "NOC21 Code Name") || getField(fields, headerIndex, "NOC 2016 Code Name");
  const education = getField(fields, headerIndex, "Education LOS");
  const experience = getField(fields, headerIndex, "Experience Level");
  const empTerm = getField(fields, headerIndex, "Employment Term");
  const hours = getField(fields, headerIndex, "Work Hours");

  const descParts = [
    `Position: ${title}`,
    nocCode ? `Occupation: ${nocCode}` : "",
    location ? `Location: ${location}` : "",
    education ? `Education: ${education}` : "",
    experience ? `Experience: ${experience}` : "",
    empTerm ? `Term: ${empTerm}` : "",
    hours ? `Hours: ${hours}` : "",
    salaryMin ? `Salary: $${salaryMin} - $${salaryMax ?? salaryMin} per ${salaryPer || "year"}` : "",
  ].filter(Boolean);

  const description = descParts.join("\n");

  // Company is not in the CSV — Job Bank anonymizes employers.
  // Use NAICS industry description when available, otherwise "Job Bank Employer"
  // to satisfy the normalization pipeline's company requirement.
  const naics = getField(fields, headerIndex, "NAICS");
  const company = naics || "Job Bank Employer";

  return {
    sourceId: `jobbank:${snapshotId}`,
    sourceUrl: applyUrl,
    title,
    company,
    location,
    description,
    applyUrl,
    postedAt: postedAt && !isNaN(postedAt.getTime()) ? postedAt : null,
    deadline: null,
    employmentType,
    workMode,
    salaryMin: annualMin,
    salaryMax: annualMax,
    salaryCurrency: annualMin ? "CAD" : null,
    metadata: {
      nocCode: getField(fields, headerIndex, "NOC21 Code") || getField(fields, headerIndex, "NOC 2016 Code"),
      nocCodeName: nocCode,
      province,
      city,
      salaryPer,
      rawSalaryMin: salaryMin,
      rawSalaryMax: salaryMax,
    } as Prisma.InputJsonValue,
  };
}
