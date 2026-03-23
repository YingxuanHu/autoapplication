import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("🌱 Seeding database...\n");

  // 1. Create a test user
  const passwordHash = await bcrypt.hash("password123", 12);
  const user = await prisma.user.upsert({
    where: { email: "test@example.com" },
    update: {},
    create: {
      email: "test@example.com",
      name: "Test User",
      passwordHash,
    },
  });
  console.log(`✅ User: ${user.email}`);

  // 2. Create user profile
  await prisma.userProfile.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      jobTitles: ["Software Engineer", "Full Stack Developer", "Frontend Engineer"],
      jobAreas: ["Engineering", "Technology"],
      locations: ["San Francisco", "New York", "Remote"],
      workModes: ["REMOTE", "HYBRID"],
      experienceLevel: "MID",
      salaryMin: 120000,
      salaryMax: 200000,
      skills: ["TypeScript", "React", "Node.js", "Python", "PostgreSQL", "AWS"],
      yearsExperience: 4,
      automationLevel: "REVIEW_BEFORE_SUBMIT",
    },
  });
  console.log("✅ User profile created");

  // 3. Seed companies for discovery testing
  const companyDomains = [
    { name: "Stripe", domain: "stripe.com" },
    { name: "Vercel", domain: "vercel.com" },
    { name: "Linear", domain: "linear.app" },
    { name: "Notion", domain: "notion.so" },
    { name: "Figma", domain: "figma.com" },
    { name: "Shopify", domain: "shopify.com" },
    { name: "Datadog", domain: "datadoghq.com" },
    { name: "Cloudflare", domain: "cloudflare.com" },
    { name: "GitLab", domain: "gitlab.com" },
    { name: "Postman", domain: "postman.com" },
  ];

  for (const { name, domain } of companyDomains) {
    const company = await prisma.company.upsert({
      where: { domain },
      update: {},
      create: {
        name,
        domain,
        crawlStatus: "PENDING",
        trustScore: 0.5,
      },
    });
    console.log(`✅ Company: ${company.name} (${company.domain})`);
  }

  // 4. Seed some known ATS sources for companies we know about
  const knownSources = [
    {
      domain: "stripe.com",
      sourceType: "ATS_BOARD" as const,
      atsType: "GREENHOUSE" as const,
      sourceUrl: "https://boards.greenhouse.io/stripe",
      boardToken: "stripe",
      isVerified: true,
    },
    {
      domain: "vercel.com",
      sourceType: "ATS_BOARD" as const,
      atsType: "GREENHOUSE" as const,
      sourceUrl: "https://boards.greenhouse.io/vercel",
      boardToken: "vercel",
      isVerified: true,
    },
    {
      domain: "linear.app",
      sourceType: "ATS_BOARD" as const,
      atsType: "ASHBY" as const,
      sourceUrl: "https://jobs.ashbyhq.com/linear",
      boardToken: "linear",
      isVerified: true,
    },
    {
      domain: "notion.so",
      sourceType: "ATS_BOARD" as const,
      atsType: "GREENHOUSE" as const,
      sourceUrl: "https://boards.greenhouse.io/notion",
      boardToken: "notion",
      isVerified: true,
    },
    {
      domain: "figma.com",
      sourceType: "ATS_BOARD" as const,
      atsType: "GREENHOUSE" as const,
      sourceUrl: "https://boards.greenhouse.io/figma",
      boardToken: "figma",
      isVerified: true,
    },
    {
      domain: "shopify.com",
      sourceType: "ATS_BOARD" as const,
      atsType: "GREENHOUSE" as const,
      sourceUrl: "https://boards.greenhouse.io/shopify",
      boardToken: "shopify",
      isVerified: true,
    },
    {
      domain: "cloudflare.com",
      sourceType: "ATS_BOARD" as const,
      atsType: "GREENHOUSE" as const,
      sourceUrl: "https://boards.greenhouse.io/cloudflare",
      boardToken: "cloudflare",
      isVerified: true,
    },
    {
      domain: "gitlab.com",
      sourceType: "ATS_BOARD" as const,
      atsType: "GREENHOUSE" as const,
      sourceUrl: "https://boards.greenhouse.io/gitlab",
      boardToken: "gitlab",
      isVerified: true,
    },
  ];

  for (const src of knownSources) {
    const company = await prisma.company.findUnique({
      where: { domain: src.domain },
    });
    if (!company) continue;

    await prisma.companySource.upsert({
      where: {
        companyId_sourceUrl: {
          companyId: company.id,
          sourceUrl: src.sourceUrl,
        },
      },
      update: {},
      create: {
        companyId: company.id,
        sourceType: src.sourceType,
        atsType: src.atsType,
        sourceUrl: src.sourceUrl,
        boardToken: src.boardToken,
        isVerified: src.isVerified,
        isActive: true,
        priority: 1,
      },
    });
    console.log(`  ↳ Source: ${src.atsType} for ${src.domain}`);
  }

  console.log("\n🎉 Seed complete!");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
