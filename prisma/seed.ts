import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { faker } from "@faker-js/faker";
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

faker.seed(42);

// ─── Constants ──────────────────────────────────────────

const DEMO_USER_ID = "demo-user-001";

const TECH_ROLES = [
  { title: "Software Engineer", family: "SWE" },
  { title: "Senior Software Engineer", family: "SWE" },
  { title: "Frontend Developer", family: "SWE" },
  { title: "Backend Engineer", family: "SWE" },
  { title: "Full Stack Developer", family: "SWE" },
  { title: "Data Analyst", family: "Data Analyst" },
  { title: "Senior Data Analyst", family: "Data Analyst" },
  { title: "Data Scientist", family: "Data Science" },
  { title: "Product Analyst", family: "Product Analyst" },
  { title: "Business Analyst", family: "Business Analyst" },
  { title: "QA Engineer", family: "QA" },
  { title: "Solutions Engineer", family: "Solutions Engineering" },
  { title: "DevOps Engineer", family: "SWE" },
  { title: "Security Analyst", family: "Security" },
  { title: "Machine Learning Engineer", family: "Data Science" },
];

const FINANCE_ROLES = [
  { title: "Financial Analyst", family: "Financial Analyst" },
  { title: "Senior Financial Analyst", family: "Financial Analyst" },
  { title: "Investment Banking Analyst", family: "Investment Banking" },
  { title: "FP&A Analyst", family: "FP&A" },
  { title: "Risk Analyst", family: "Risk" },
  { title: "Corporate Finance Analyst", family: "Corporate Finance" },
  { title: "Compliance Analyst", family: "Compliance" },
  { title: "Credit Analyst", family: "Credit" },
  { title: "Operations Analyst", family: "Operations" },
  { title: "Wealth Management Associate", family: "Wealth Management" },
];

const TECH_COMPANIES = [
  "Stripe", "Shopify", "Datadog", "Cloudflare", "Figma", "Notion",
  "Vercel", "Supabase", "Linear", "Retool", "Plaid", "Rippling",
  "Databricks", "Snowflake", "GitLab", "HashiCorp", "Confluent",
  "MongoDB", "Elastic", "Twilio", "Airtable", "Amplitude",
  "Brex", "Canva", "Discord",
];

const FINANCE_COMPANIES = [
  "Goldman Sachs", "JPMorgan Chase", "Morgan Stanley", "BlackRock",
  "Citadel", "Two Sigma", "Bridgewater Associates", "RBC Capital Markets",
  "TD Securities", "BMO Capital Markets", "CIBC", "Scotiabank",
  "Deloitte", "PwC", "EY",
];

const US_CITIES = [
  "San Francisco, CA", "New York, NY", "Austin, TX", "Seattle, WA",
  "Chicago, IL", "Boston, MA", "Denver, CO", "Los Angeles, CA",
  "Miami, FL", "Portland, OR",
];

const CA_CITIES = [
  "Toronto, ON", "Vancouver, BC", "Montreal, QC", "Calgary, AB",
  "Ottawa, ON", "Waterloo, ON",
];

type WorkModeType = "REMOTE" | "HYBRID" | "ONSITE" | "FLEXIBLE";
type EmploymentTypeType = "FULL_TIME" | "PART_TIME" | "CONTRACT" | "INTERNSHIP";
type ExperienceLevelType = "ENTRY" | "MID" | "SENIOR" | "LEAD";
type RegionType = "US" | "CA";
type IndustryType = "TECH" | "FINANCE";
type SourceTierType = "TIER_1" | "TIER_2" | "TIER_3";
type JobStatusType = "LIVE" | "AGING" | "EXPIRED" | "REMOVED" | "STALE";
type SubmissionCategoryType = "AUTO_SUBMIT_READY" | "AUTO_FILL_REVIEW" | "MANUAL_ONLY";

const WORK_MODES: WorkModeType[] = ["REMOTE", "HYBRID", "ONSITE", "FLEXIBLE"];
const EMPLOYMENT_TYPES: EmploymentTypeType[] = ["FULL_TIME", "PART_TIME", "CONTRACT"];
const EXPERIENCE_LEVELS: ExperienceLevelType[] = ["ENTRY", "MID", "SENIOR", "LEAD"];

const SOURCES: { name: string; tier: SourceTierType }[] = [
  { name: "PartnerAPI-Alpha", tier: "TIER_1" },
  { name: "CompanyCareer-Direct", tier: "TIER_2" },
  { name: "BoardAggregator-X", tier: "TIER_3" },
];

const ELIGIBILITY_CONFIGS: {
  category: SubmissionCategoryType;
  reasonCode: string;
  reasonDescription: string;
  customizationLevel: number;
  confidenceRange: [number, number];
}[] = [
  {
    category: "AUTO_SUBMIT_READY",
    reasonCode: "structured_ats_flow",
    reasonDescription: "Structured ATS flow detected with standard fields. No custom writing required.",
    customizationLevel: 1,
    confidenceRange: [0.82, 0.98],
  },
  {
    category: "AUTO_FILL_REVIEW",
    reasonCode: "optional_custom_question",
    reasonDescription: "Mostly structured application with optional custom question detected. Review recommended.",
    customizationLevel: 2,
    confidenceRange: [0.55, 0.80],
  },
  {
    category: "MANUAL_ONLY",
    reasonCode: "custom_written_response_required",
    reasonDescription: "Application requires custom written responses or uses an unsupported portal.",
    customizationLevel: 3,
    confidenceRange: [0.15, 0.50],
  },
];

// ─── Helpers ────────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(faker.number.float({ min: 0, max: 0.999 }) * arr.length)];
}

function salaryRange(level: ExperienceLevelType): { min: number; max: number } {
  const ranges: Record<ExperienceLevelType, [number, number]> = {
    ENTRY: [55000, 85000],
    MID: [80000, 130000],
    SENIOR: [120000, 190000],
    LEAD: [150000, 220000],
  };
  const [lo, hi] = ranges[level];
  const min = faker.number.int({ min: lo, max: lo + (hi - lo) / 2 });
  const max = faker.number.int({ min: min + 10000, max: hi });
  return { min, max };
}

function generateDescription(title: string, company: string): string {
  return `${company} is looking for a ${title} to join our team. You will work on challenging problems, collaborate with talented engineers, and help us build products that millions of people use every day.\n\nResponsibilities:\n- Design and implement high-quality software solutions\n- Collaborate with cross-functional teams to define and ship new features\n- Write clean, maintainable, and well-tested code\n- Participate in code reviews and contribute to technical decisions\n- Mentor junior team members and contribute to engineering culture\n\nRequirements:\n- Strong problem-solving skills and attention to detail\n- Excellent communication and teamwork abilities\n- Experience with modern development practices and tools\n- Passion for building great products`;
}

function generateSummary(title: string, company: string, workMode: string): string {
  return `${company} is hiring a ${title}. ${workMode === "REMOTE" ? "Fully remote position." : workMode === "HYBRID" ? "Hybrid role with flexible office days." : "On-site position."} Join a fast-moving team building impactful products.`;
}

// ─── Main seed ──────────────────────────────────────────

async function main() {
  console.log("🌱 Seeding database...");

  // Clean existing data
  await prisma.userBehaviorSignal.deleteMany();
  await prisma.applicationSubmission.deleteMany();
  await prisma.applicationPackage.deleteMany();
  await prisma.savedJob.deleteMany();
  await prisma.userPreference.deleteMany();
  await prisma.jobSourceMapping.deleteMany();
  await prisma.jobEligibility.deleteMany();
  await prisma.jobCanonical.deleteMany();
  await prisma.jobRaw.deleteMany();
  await prisma.resumeVariant.deleteMany();
  await prisma.userProfile.deleteMany();

  // 1. Demo user
  const user = await prisma.userProfile.create({
    data: {
      id: DEMO_USER_ID,
      email: "demo@autoapplication.dev",
      name: "Alex Chen",
      linkedinUrl: "https://linkedin.com/in/alexchen",
      githubUrl: "https://github.com/alexchen",
      portfolioUrl: "https://alexchen.dev",
      workAuthorization: "US Citizen",
      salaryMin: 80000,
      salaryMax: 150000,
      salaryCurrency: "USD",
      preferredWorkMode: "REMOTE",
      experienceLevel: "MID",
      automationMode: "REVIEW_BEFORE_SUBMIT",
    },
  });
  console.log(`  ✅ User: ${user.name}`);

  // 2. Resume variants
  const resumes = await Promise.all([
    prisma.resumeVariant.create({
      data: {
        userId: DEMO_USER_ID,
        label: "SWE General",
        targetRoleFamily: "SWE",
        content: "Experienced software engineer with 4 years in full-stack development. Proficient in TypeScript, React, Node.js, Python, PostgreSQL. Built scalable microservices at Stripe. CS degree from University of Waterloo.",
        isDefault: true,
      },
    }),
    prisma.resumeVariant.create({
      data: {
        userId: DEMO_USER_ID,
        label: "Data & Analytics",
        targetRoleFamily: "Data Analyst",
        content: "Data-focused engineer with strong SQL, Python, and visualization skills. Experience building data pipelines and dashboards. Comfortable with Pandas, dbt, Looker, and BigQuery.",
        isDefault: false,
      },
    }),
    prisma.resumeVariant.create({
      data: {
        userId: DEMO_USER_ID,
        label: "Finance / Quantitative",
        targetRoleFamily: "Financial Analyst",
        content: "Quantitative professional with software engineering background. Proficient in Python, R, financial modeling, and risk analysis. Experience with Bloomberg Terminal and capital markets data.",
        isDefault: false,
      },
    }),
  ]);
  console.log(`  ✅ Resumes: ${resumes.length}`);

  // 3. User preferences
  await prisma.userPreference.createMany({
    data: [
      { userId: DEMO_USER_ID, key: "hardFilter:region", value: "US,CA", isHardFilter: true },
      { userId: DEMO_USER_ID, key: "hardFilter:workMode", value: "REMOTE,HYBRID", isHardFilter: true },
      { userId: DEMO_USER_ID, key: "hardFilter:industry", value: "TECH,FINANCE", isHardFilter: true },
      { userId: DEMO_USER_ID, key: "softSignal:preferredCompanySize", value: "startup,midsize", isHardFilter: false },
      { userId: DEMO_USER_ID, key: "softSignal:preferredRoleFamily", value: "SWE,Data Analyst", isHardFilter: false },
    ],
  });
  console.log("  ✅ Preferences: 5");

  // 4. Generate jobs
  const rawJobs: { id: string; sourceIdx: number }[] = [];
  const canonicalJobs: { id: string; industry: IndustryType }[] = [];

  // Helper: create a raw + canonical job pair
  async function createJobPair(index: number, industry: IndustryType) {
    const isTech = industry === "TECH";
    const role = isTech ? pick(TECH_ROLES) : pick(FINANCE_ROLES);
    const company = isTech ? pick(TECH_COMPANIES) : pick(FINANCE_COMPANIES);
    const isUS = faker.number.float() > 0.35;
    const region: RegionType = isUS ? "US" : "CA";
    const city = isUS ? pick(US_CITIES) : pick(CA_CITIES);
    const workMode = pick(WORK_MODES);
    const employmentType = pick(EMPLOYMENT_TYPES);
    const expLevel = pick(EXPERIENCE_LEVELS);
    const salary = salaryRange(expLevel);
    const source = pick(SOURCES);
    const daysAgo = faker.number.int({ min: 0, max: 40 });
    const postedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const hasDeadline = faker.number.float() > 0.7;
    const deadline = hasDeadline
      ? new Date(Date.now() + faker.number.int({ min: 3, max: 30 }) * 24 * 60 * 60 * 1000)
      : null;

    let status: JobStatusType = "LIVE";
    if (daysAgo > 35) status = "STALE";
    if (index < 3) status = "EXPIRED";

    const rawId = `raw-${index.toString().padStart(3, "0")}`;
    const canonId = `job-${index.toString().padStart(3, "0")}`;

    // Create raw job
    const raw = await prisma.jobRaw.create({
      data: {
        id: rawId,
        sourceId: `ext-${faker.string.alphanumeric(8)}`,
        sourceName: source.name,
        sourceTier: source.tier,
        rawPayload: {
          title: role.title,
          company,
          location: city,
          description: generateDescription(role.title, company),
        },
        fetchedAt: new Date(postedAt.getTime() + 2 * 60 * 60 * 1000),
      },
    });

    // Create canonical job
    const canonical = await prisma.jobCanonical.create({
      data: {
        id: canonId,
        title: role.title,
        company,
        location: city,
        region,
        workMode,
        salaryMin: salary.min,
        salaryMax: salary.max,
        salaryCurrency: "USD",
        employmentType,
        experienceLevel: expLevel,
        description: generateDescription(role.title, company),
        shortSummary: generateSummary(role.title, company, workMode),
        industry,
        roleFamily: role.family,
        applyUrl: `https://careers.${company.toLowerCase().replace(/\s+/g, "")}.com/jobs/${faker.string.alphanumeric(6)}`,
        postedAt,
        deadline,
        status,
        duplicateClusterId: `cluster-${index.toString().padStart(3, "0")}`,
      },
    });

    // Create source mapping
    await prisma.jobSourceMapping.create({
      data: {
        canonicalJobId: canonical.id,
        rawJobId: raw.id,
        sourceName: source.name,
        sourceUrl: `https://${source.name.toLowerCase()}.com/jobs/${raw.sourceId}`,
        isPrimary: true,
      },
    });

    rawJobs.push({ id: raw.id, sourceIdx: SOURCES.indexOf(source) });
    canonicalJobs.push({ id: canonical.id, industry });

    return { raw, canonical };
  }

  // Create 25 tech jobs + 15 finance jobs = 40 canonical
  for (let i = 0; i < 25; i++) {
    await createJobPair(i, "TECH");
  }
  for (let i = 25; i < 40; i++) {
    await createJobPair(i, "FINANCE");
  }
  console.log(`  ✅ Canonical jobs: ${canonicalJobs.length}`);

  // Create 10 duplicate raw jobs mapping to existing canonical jobs
  for (let i = 40; i < 50; i++) {
    const targetCanonical = canonicalJobs[i - 40];
    const source = pick(SOURCES);
    const raw = await prisma.jobRaw.create({
      data: {
        id: `raw-${i.toString().padStart(3, "0")}`,
        sourceId: `ext-dup-${faker.string.alphanumeric(8)}`,
        sourceName: source.name,
        sourceTier: source.tier,
        rawPayload: { duplicate: true, originalJobId: targetCanonical.id },
        fetchedAt: new Date(),
      },
    });
    await prisma.jobSourceMapping.create({
      data: {
        canonicalJobId: targetCanonical.id,
        rawJobId: raw.id,
        sourceName: source.name,
        sourceUrl: `https://${source.name.toLowerCase()}.com/jobs/${raw.sourceId}`,
        isPrimary: false,
      },
    });
  }
  console.log("  ✅ Duplicate raw jobs: 10");

  // 5. Job eligibility records
  for (let i = 0; i < 40; i++) {
    let configIdx: number;
    if (i < 15) configIdx = 0; // AUTO_SUBMIT_READY
    else if (i < 30) configIdx = 1; // AUTO_FILL_REVIEW
    else configIdx = 2; // MANUAL_ONLY

    const config = ELIGIBILITY_CONFIGS[configIdx];
    const [lo, hi] = config.confidenceRange;

    await prisma.jobEligibility.create({
      data: {
        canonicalJobId: canonicalJobs[i].id,
        submissionCategory: config.category,
        reasonCode: config.reasonCode,
        reasonDescription: config.reasonDescription,
        jobValidityConfidence: parseFloat(faker.number.float({ min: lo, max: hi }).toFixed(2)),
        formAutomationConfidence: parseFloat(faker.number.float({ min: lo, max: hi }).toFixed(2)),
        packageFitConfidence: parseFloat(faker.number.float({ min: lo, max: hi }).toFixed(2)),
        submissionQualityConfidence: parseFloat(faker.number.float({ min: lo, max: hi }).toFixed(2)),
        customizationLevel: config.customizationLevel,
        evaluatedAt: new Date(),
      },
    });
  }
  console.log("  ✅ Eligibility records: 40");

  // 6. Saved jobs
  const savedJobIds = [canonicalJobs[2].id, canonicalJobs[7].id, canonicalJobs[15].id, canonicalJobs[22].id, canonicalJobs[30].id];
  for (const jobId of savedJobIds) {
    await prisma.savedJob.create({
      data: {
        userId: DEMO_USER_ID,
        canonicalJobId: jobId,
        status: "ACTIVE",
      },
    });
  }
  console.log("  ✅ Saved jobs: 5");

  // 7. Behavior signals
  const actions: ("APPLY" | "PASS" | "SAVE" | "VIEW_DETAILS")[] = ["APPLY", "PASS", "SAVE", "VIEW_DETAILS"];
  for (let i = 0; i < 10; i++) {
    await prisma.userBehaviorSignal.create({
      data: {
        userId: DEMO_USER_ID,
        canonicalJobId: canonicalJobs[i].id,
        action: pick(actions),
        metadata: { timeSpentMs: faker.number.int({ min: 1000, max: 30000 }) },
      },
    });
  }
  console.log("  ✅ Behavior signals: 10");

  // 8. Application submissions
  await prisma.applicationSubmission.create({
    data: {
      userId: DEMO_USER_ID,
      canonicalJobId: canonicalJobs[0].id,
      status: "SUBMITTED",
      submittedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      submissionMethod: "auto",
    },
  });
  await prisma.applicationSubmission.create({
    data: {
      userId: DEMO_USER_ID,
      canonicalJobId: canonicalJobs[5].id,
      status: "DRAFT",
      submissionMethod: "review",
    },
  });
  console.log("  ✅ Application submissions: 2");

  console.log("\n🎉 Seed complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
