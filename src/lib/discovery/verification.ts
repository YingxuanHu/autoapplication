import { prisma } from "@/lib/prisma";
import type { ATSType } from "@/generated/prisma";
import { detectATS } from "./ats-detector";

const REQUEST_TIMEOUT = 15_000;
const USER_AGENT = "AutoApplicationBot/1.0";

export interface VerificationResult {
  domain: string;
  domainValid: boolean;
  careerPageAccessible: boolean;
  careerPageUrl?: string;
  atsBoardValid: boolean;
  atsType?: ATSType | null;
  boardToken?: string;
  details: string[];
  overallValid: boolean;
}

/**
 * Verify that a company domain is real by checking DNS resolution.
 */
export async function verifyDomain(domain: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(`https://${domain}`, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
    });

    clearTimeout(timeout);
    return response.ok || response.status === 403 || response.status === 301;
  } catch {
    // Try HTTP as a fallback
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const response = await fetch(`http://${domain}`, {
        method: "HEAD",
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT },
      });

      clearTimeout(timeout);
      return response.ok || response.status === 403;
    } catch {
      return false;
    }
  }
}

/**
 * Verify that a career page URL is accessible and returns a valid response.
 */
export async function verifyCareerPage(url: string): Promise<{
  accessible: boolean;
  statusCode?: number;
  redirectUrl?: string;
}> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
    });

    clearTimeout(timeout);

    return {
      accessible: response.ok,
      statusCode: response.status,
      redirectUrl: response.redirected ? response.url : undefined,
    };
  } catch {
    return { accessible: false };
  }
}

/**
 * Verify that an ATS board token returns valid job data.
 */
export async function verifyATSBoard(
  atsType: ATSType,
  boardToken: string,
): Promise<{ valid: boolean; jobCount?: number; details: string }> {
  const urls: Record<string, string> = {
    GREENHOUSE: `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs`,
    LEVER: `https://api.lever.co/v0/postings/${boardToken}?limit=1`,
    ASHBY: `https://api.ashbyhq.com/posting-api/job-board/${boardToken}`,
    SMARTRECRUITERS: `https://api.smartrecruiters.com/v1/companies/${boardToken}/postings`,
  };

  const url = urls[atsType];
  if (!url) {
    return { valid: false, details: `No API verification available for ${atsType}` };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return {
        valid: false,
        details: `ATS API returned ${response.status} for ${atsType}/${boardToken}`,
      };
    }

    const data = await response.json();
    let jobCount = 0;

    if (atsType === "GREENHOUSE" && data?.jobs) {
      jobCount = data.jobs.length;
    } else if (atsType === "LEVER" && Array.isArray(data)) {
      jobCount = data.length;
    } else if (atsType === "ASHBY" && data?.jobs) {
      jobCount = data.jobs.length;
    } else if (atsType === "SMARTRECRUITERS" && data?.content) {
      jobCount = data.content.length;
    }

    return {
      valid: true,
      jobCount,
      details: `${atsType}/${boardToken} verified with ${jobCount} jobs`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      valid: false,
      details: `Failed to verify ${atsType}/${boardToken}: ${message}`,
    };
  }
}

/**
 * Run full verification on a company: domain, career page, and ATS board.
 * Updates the CompanySource.isVerified flag in the database.
 */
export async function verifyCompany(
  companyId: string,
): Promise<VerificationResult> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: { sources: true },
  });

  if (!company) {
    return {
      domain: "",
      domainValid: false,
      careerPageAccessible: false,
      atsBoardValid: false,
      details: ["Company not found"],
      overallValid: false,
    };
  }

  const details: string[] = [];
  let domainValid = false;
  let careerPageAccessible = false;
  let atsBoardValid = false;
  let resolvedAtsType: ATSType | null = null;
  let resolvedBoardToken: string | undefined;

  // Step 1: Verify domain
  domainValid = await verifyDomain(company.domain);
  details.push(
    domainValid
      ? `Domain ${company.domain} is reachable`
      : `Domain ${company.domain} is not reachable`,
  );

  if (!domainValid) {
    return {
      domain: company.domain,
      domainValid,
      careerPageAccessible,
      atsBoardValid,
      details,
      overallValid: false,
    };
  }

  // Step 2: Verify career page if we have one
  if (company.careersUrl) {
    const careerResult = await verifyCareerPage(company.careersUrl);
    careerPageAccessible = careerResult.accessible;
    details.push(
      careerPageAccessible
        ? `Career page accessible at ${company.careersUrl}`
        : `Career page not accessible at ${company.careersUrl} (status: ${careerResult.statusCode ?? "N/A"})`,
    );

    // Try ATS detection on the career page
    if (careerPageAccessible) {
      const atsResult = await detectATS(company.careersUrl);
      if (atsResult.atsType) {
        resolvedAtsType = atsResult.atsType;
        resolvedBoardToken = atsResult.boardToken;
        details.push(
          `Detected ATS: ${atsResult.atsType} (confidence: ${atsResult.confidence})`,
        );
      }
    }
  }

  // Step 3: Verify each ATS source
  for (const source of company.sources) {
    if (!source.atsType || !source.boardToken) continue;

    const boardResult = await verifyATSBoard(source.atsType, source.boardToken);
    details.push(boardResult.details);

    if (boardResult.valid) {
      atsBoardValid = true;
      resolvedAtsType = source.atsType;
      resolvedBoardToken = source.boardToken;
    }

    // Update source verification status
    await prisma.companySource.update({
      where: { id: source.id },
      data: {
        isVerified: boardResult.valid,
        lastJobCount: boardResult.jobCount ?? source.lastJobCount,
        updatedAt: new Date(),
      },
    });
  }

  // Update company-level ATS info if we discovered something new
  if (resolvedAtsType && resolvedAtsType !== company.detectedATS) {
    await prisma.company.update({
      where: { id: company.id },
      data: { detectedATS: resolvedAtsType },
    });
  }

  const overallValid = domainValid && (careerPageAccessible || atsBoardValid);

  return {
    domain: company.domain,
    domainValid,
    careerPageAccessible,
    careerPageUrl: company.careersUrl ?? undefined,
    atsBoardValid,
    atsType: resolvedAtsType,
    boardToken: resolvedBoardToken,
    details,
    overallValid,
  };
}
