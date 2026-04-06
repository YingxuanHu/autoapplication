import type { FitAnalysis } from "./types";

export function formatFitAnalysisForStorage(analysis: FitAnalysis) {
  const lines: string[] = [
    "**Match Score**",
    `${analysis.score}/10 — ${analysis.summary}`,
  ];

  if (analysis.strengths.length > 0) {
    lines.push("", "**Strengths**", ...analysis.strengths.map((item) => `• ${item}`));
  }

  if (analysis.gaps.length > 0) {
    lines.push("", "**Gaps**", ...analysis.gaps.map((item) => `• ${item}`));
  }

  if (analysis.keywords.length > 0) {
    lines.push(
      "",
      "**Keywords To Include**",
      ...analysis.keywords.map((item) => `• ${item}`)
    );
  }

  return lines.join("\n").trim();
}

export function parseStoredFitAnalysis(raw: string | null | undefined): FitAnalysis | null {
  if (!raw?.trim()) {
    return null;
  }

  const normalized = raw.replace(/\r/g, "").trim();
  const sections = splitSections(normalized);
  const scoreSection = findSection(sections, "match score");

  if (!scoreSection?.content[0]) {
    return null;
  }

  const scoreLine = scoreSection.content[0];
  const scoreMatch = scoreLine.match(/(\d{1,2})\s*\/\s*10(?:\s*[—-]\s*(.+))?/);
  if (!scoreMatch) {
    return null;
  }

  const score = Math.min(10, Math.max(1, Number(scoreMatch[1])));
  const summary =
    scoreMatch[2]?.trim() ||
    scoreSection.content.slice(1).join(" ").trim() ||
    "Analysis available.";

  return {
    score,
    tier: scoreTier(score),
    summary,
    strengths: getBulletSection(
      sections,
      "strengths"
    ),
    gaps: getBulletSection(sections, "gaps"),
    keywords: getBulletSection(
      sections,
      "keywords to include",
      "what to emphasize",
      "recommended changes"
    ),
  };
}

type Section = {
  title: string;
  content: string[];
};

function splitSections(raw: string) {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    const title = parseSectionTitle(line);
    if (title) {
      current = { title, content: [] };
      sections.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    current.content.push(stripBullet(line));
  }

  return sections;
}

function parseSectionTitle(line: string) {
  const boldMatch = line.match(/^\*\*(.+?)\*\*$/);
  if (boldMatch?.[1]) {
    return normalizeSectionTitle(boldMatch[1]);
  }

  return null;
}

function normalizeSectionTitle(value: string) {
  return value.trim().replace(/:$/, "").toLowerCase();
}

function stripBullet(line: string) {
  return line.replace(/^[•*-]\s*/, "").trim();
}

function findSection(sections: Section[], ...titles: string[]) {
  const normalizedTitles = titles.map(normalizeSectionTitle);
  return sections.find((section) => normalizedTitles.includes(section.title));
}

function getBulletSection(sections: Section[], ...titles: string[]) {
  return findSection(sections, ...titles)?.content.filter(Boolean) ?? [];
}

function scoreTier(score: number): FitAnalysis["tier"] {
  if (score >= 8) return "strong";
  if (score >= 6) return "good";
  if (score >= 4) return "moderate";
  return "weak";
}
