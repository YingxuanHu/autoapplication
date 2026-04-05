import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

const execFileAsync = promisify(execFile);

export const tailoredResumeSchema = z.object({
  contact: z.object({
    name: z.string(),
    email: z.string(),
    phone: z.string(),
    location: z.string(),
    linkedin: z.string(),
    github: z.string(),
    portfolio: z.string(),
  }),
  summary: z.string(),
  skills: z.array(z.string()),
  experience: z.array(
    z.object({
      title: z.string(),
      company: z.string(),
      time: z.string(),
      location: z.string(),
      bullets: z.array(z.string()),
    })
  ),
  education: z.array(
    z.object({
      degree: z.string(),
      school: z.string(),
      time: z.string(),
      location: z.string(),
      description: z.string(),
    })
  ),
  projects: z.array(
    z.object({
      name: z.string(),
      time: z.string(),
      bullets: z.array(z.string()),
    })
  ),
});

export type TailoredResume = z.infer<typeof tailoredResumeSchema>;
type ResumeTightness = "standard" | "tight";

export type CompiledResumePdf = {
  pdfBuffer: Buffer;
  compiler: string;
  pageCount: number | null;
  maxOverfullPoints: number;
  log: string;
};

function tex(value: string) {
  if (!value) return "";
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/[&%$#_{}]/g, (match) => `\\${match}`)
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/</g, "\\ensuremath{<}")
    .replace(/>/g, "\\ensuremath{>}");
}

function socialHandle(value: string, prefixPattern: RegExp) {
  return value
    .replace(/^https?:\/\/(www\.)?/i, "")
    .replace(prefixPattern, "")
    .replace(/\/$/, "");
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateWords(value: string, maxWords: number, maxChars: number) {
  const words = normalizeWhitespace(value).split(" ").filter(Boolean);
  const truncated = words.slice(0, maxWords).join(" ");
  return truncated.length > maxChars ? truncated.slice(0, maxChars).trim() : truncated;
}

function clampArray<T>(values: T[], maxItems: number) {
  return values.slice(0, maxItems);
}

function cleanBullet(value: string, maxWords: number, maxChars: number) {
  return truncateWords(value, maxWords, maxChars)
    .replace(/^[\-\u2022\s]+/, "")
    .trim();
}

function cleanLine(value: string, maxWords: number, maxChars: number) {
  return truncateWords(value, maxWords, maxChars);
}

export function compactTailoredResume(
  data: TailoredResume,
  tightness: ResumeTightness = "standard"
): TailoredResume {
  const isTight = tightness === "tight";

  const maxSkills = isTight ? 12 : 25;
  const maxExperiences = isTight ? 3 : 5;
  const maxExperienceBullets = isTight ? 2 : 5;
  const maxEducations = isTight ? 2 : 3;
  const maxProjects = isTight ? 2 : 4;
  const maxProjectBullets = isTight ? 2 : 3;

  return {
    contact: {
      name: cleanLine(data.contact.name, 8, 80),
      email: normalizeWhitespace(data.contact.email),
      phone: cleanLine(data.contact.phone, 6, 40),
      location: cleanLine(data.contact.location, 6, 50),
      linkedin: normalizeWhitespace(data.contact.linkedin),
      github: normalizeWhitespace(data.contact.github),
      portfolio: normalizeWhitespace(data.contact.portfolio),
    },
    summary: cleanLine(data.summary, isTight ? 40 : 70, isTight ? 250 : 450),
    skills: clampArray(
      data.skills
        .map((skill) => cleanLine(skill, 4, 30))
        .filter(Boolean),
      maxSkills
    ),
    experience: clampArray(
      data.experience
        .map((entry) => ({
          title: cleanLine(entry.title, 8, 80),
          company: cleanLine(entry.company, 8, 80),
          time: cleanLine(entry.time, 8, 40),
          location: cleanLine(entry.location, 6, 40),
          bullets: clampArray(
            entry.bullets
              .map((bullet) => cleanBullet(bullet, isTight ? 20 : 30, isTight ? 140 : 200))
              .filter(Boolean),
            maxExperienceBullets
          ),
        }))
        .filter((entry) => entry.title || entry.company || entry.bullets.length > 0),
      maxExperiences
    ),
    education: clampArray(
      data.education
        .map((entry) => ({
          degree: cleanLine(entry.degree, 10, 90),
          school: cleanLine(entry.school, 10, 90),
          time: cleanLine(entry.time, 8, 40),
          location: cleanLine(entry.location, 6, 40),
          description: cleanLine(entry.description, isTight ? 18 : 30, isTight ? 120 : 200),
        }))
        .filter((entry) => entry.degree || entry.school),
      maxEducations
    ),
    projects: clampArray(
      data.projects
        .map((entry) => ({
          name: cleanLine(entry.name, 8, 80),
          time: cleanLine(entry.time, 8, 40),
          bullets: clampArray(
            entry.bullets
              .map((bullet) => cleanBullet(bullet, isTight ? 20 : 30, isTight ? 140 : 200))
              .filter(Boolean),
            maxProjectBullets
          ),
        }))
        .filter((entry) => entry.name || entry.bullets.length > 0),
      maxProjects
    ),
  };
}

export function looksLikeLatexDocument(source: string) {
  return /\\documentclass|\\begin\{document\}/.test(source);
}

export function stabilizeTeXSource(source: string) {
  const normalized = source.replace(/\r\n/g, "\n").trim();

  if (!looksLikeLatexDocument(normalized) || !/\\begin\{document\}/.test(normalized)) {
    return normalized;
  }

  const alreadyHardened =
    /\\sloppy|\\emergencystretch|\\raggedbottom|\\hbadness=/.test(normalized);

  if (alreadyHardened) {
    return normalized;
  }

  return normalized.replace(
    /\\begin\{document\}/,
    String.raw`\raggedbottom
\sloppy
\hbadness=10000
\hfuzz=2pt
\emergencystretch=3em

\begin{document}`
  );
}

export function generateResumeTeX(data: TailoredResume): string {
  const lines: string[] = [];

  lines.push(String.raw`\documentclass[11pt,a4paper,sans]{moderncv}`);
  lines.push(String.raw`\moderncvstyle[nosymbols]{banking}`);
  lines.push(String.raw`\moderncvcolor{black}`);
  lines.push(String.raw`\moderncvicons{awesome}`);
  lines.push("");
  lines.push(String.raw`\usepackage[utf8]{inputenc}`);
  lines.push(String.raw`\usepackage{enumitem}`);
  lines.push(String.raw`\usepackage{times}`);
  lines.push(String.raw`\usepackage{graphicx}`);
  lines.push(String.raw`\usepackage{xcolor}`);
  lines.push("");
  lines.push(String.raw`\usepackage[top=0.8cm, bottom=0.3cm, left=1cm, right=1cm]{geometry}`);
  lines.push("");
  lines.push(
    String.raw`\setlist[itemize]{label={\Large\textbullet},leftmargin=0.4cm,itemsep=1.8pt,parsep=0pt,topsep=0pt,partopsep=0pt,`
  );
  lines.push(String.raw`  before=\linespread{0.93}\selectfont,`);
  lines.push(String.raw`  after=\linespread{1}\selectfont}`);
  lines.push("");

  const nameParts = data.contact.name.split(" ");
  const firstName = tex(nameParts[0] ?? "");
  const lastName = tex(nameParts.slice(1).join(" "));
  lines.push(String.raw`\name{${firstName}}{${lastName}}`);

  if (data.contact.location) {
    lines.push(String.raw`\address{${tex(data.contact.location)}}{}`);
  }
  if (data.contact.phone) {
    lines.push(String.raw`\mobile{${tex(data.contact.phone)}}`);
  }
  if (data.contact.email) {
    lines.push(String.raw`\email{${tex(data.contact.email)}}`);
  }
  if (data.contact.linkedin) {
    lines.push(
      String.raw`\social[linkedin]{${tex(
        socialHandle(data.contact.linkedin, /^linkedin\.com\/(in\/)?/i)
      )}}`
    );
  }
  if (data.contact.github) {
    lines.push(
      String.raw`\social[github]{${tex(socialHandle(data.contact.github, /^github\.com\//i))}}`
    );
  }
  if (data.contact.portfolio) {
    lines.push(String.raw`\homepage{${tex(socialHandle(data.contact.portfolio, /^/))}}`);
  }

  lines.push(String.raw`\begin{document}`);
  lines.push("");
  lines.push(String.raw`\makecvtitle`);
  lines.push(String.raw`\vspace{-2.5em}`);
  lines.push("");

  if (data.summary) {
    lines.push(String.raw`\section{Summary}`);
    lines.push(String.raw`\cvitem{}{${tex(data.summary)}}`);
    lines.push("");
  }

  if (data.education.length > 0) {
    lines.push(String.raw`\section{Education}`);
    for (const education of data.education) {
      lines.push(String.raw`\cventry{${tex(education.time)}}{${tex(education.degree)}}`);
      lines.push(String.raw`{${tex(education.school)}}`);
      lines.push(String.raw`{${tex(education.location)}}{}{${tex(education.description)}}`);
      lines.push("");
    }
  }

  if (data.experience.length > 0) {
    lines.push(String.raw`\section{Work Experience}`);
    for (const experience of data.experience) {
      lines.push(
        String.raw`\cventry{${tex(experience.time)}}{${tex(experience.title)}}{${tex(
          experience.company
        )}}`
      );
      lines.push(String.raw`{${tex(experience.location)}}{}%`);
      lines.push("  {");
      lines.push(String.raw`		  \begin{itemize}`);
      for (const bullet of experience.bullets) {
        lines.push(String.raw`		    \item ${tex(bullet)}`);
      }
      lines.push(String.raw`		  \end{itemize}`);
      lines.push("  }");
      lines.push("");
    }
  }

  if (data.projects.length > 0) {
    lines.push(String.raw`\section{Projects}`);
    for (const project of data.projects) {
      lines.push(String.raw`\cventry{${tex(project.time)}}{}{${tex(project.name)}}{}{}{%`);
      lines.push("	    \\begin{itemize}");
      for (const bullet of project.bullets) {
        lines.push(String.raw`	        \item ${tex(bullet)}`);
      }
      lines.push("	    \\end{itemize}");
      lines.push("    }");
      lines.push("");
    }
  }

  if (data.skills.length > 0) {
    lines.push(String.raw`\vspace{-1.2em}`);
    lines.push(String.raw`\section{Skills}`);
    lines.push("{");
    lines.push(String.raw`  \footnotesize`);
    lines.push(String.raw`  \begin{itemize}[itemsep=0.5pt]`);
    lines.push(String.raw`    \item ${data.skills.map(tex).join(", ")}`);
    lines.push(String.raw`  \end{itemize}`);
    lines.push("}");
  }

  lines.push(String.raw`\end{document}`);
  lines.push("");

  return lines.join("\n");
}

function parsePageCount(log: string) {
  const normalized = log.replace(/\s+/g, " ");
  const match = normalized.match(/Output written on .*?\((\d+) page/);
  return match ? Number(match[1]) : null;
}

function parsePageCountFromPdf(pdfBuffer: Buffer) {
  const rawPdf = pdfBuffer.toString("latin1");
  const matches = [...rawPdf.matchAll(/\/Count\s+(\d+)/g)];
  if (matches.length === 0) {
    return null;
  }

  return matches.reduce((max, match) => Math.max(max, Number(match[1] ?? 0)), 0);
}

function parseMaxOverfullPoints(log: string) {
  const matches = [...log.matchAll(/Overfull \\hbox \(([\d.]+)pt too wide\)/g)];
  return matches.reduce((max, match) => Math.max(max, Number(match[1] ?? 0)), 0);
}

async function runLatexCompiler(compiler: string, texPath: string, tempDir: string) {
  const pdfPath = texPath.replace(/\.tex$/i, ".pdf");
  const logPath = texPath.replace(/\.tex$/i, ".log");

  try {
    const { stdout, stderr } = await execFileAsync(
      compiler,
      [
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
        `-output-directory=${tempDir}`,
        texPath,
      ],
      {
        cwd: tempDir,
        encoding: "utf8",
        timeout: 45000,
        maxBuffer: 20 * 1024 * 1024,
      }
    );

    const [pdfBuffer, logFile] = await Promise.all([
      readFile(pdfPath),
      readFile(logPath, "utf8").catch(() => ""),
    ]);

    return {
      pdfBuffer,
      compiler,
      log: [stdout, stderr, logFile].filter(Boolean).join("\n"),
    };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    const logFile = await readFile(logPath, "utf8").catch(() => "");
    const log = [err.stdout ?? "", err.stderr ?? "", logFile, err.message ?? ""]
      .filter(Boolean)
      .join("\n");

    throw new Error(`${compiler} failed.\n${log}`);
  }
}

export async function compileResumePdf(
  texSource: string,
  fileStem = "tailored-resume"
): Promise<CompiledResumePdf> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "apptracker-resume-"));
  const texPath = path.join(tempDir, `${fileStem}.tex`);

  try {
    await writeFile(texPath, texSource, "utf8");

    const preferredCompiler =
      /\\usepackage\{fontspec\}|\\setmainfont|\\setsansfont|\\setmonofont/.test(texSource)
        ? "xelatex"
        : "pdflatex";
    const compilerOrder =
      preferredCompiler === "xelatex"
        ? ["xelatex", "pdflatex"]
        : ["pdflatex", "xelatex"];

    let lastError: Error | null = null;

    for (const compiler of compilerOrder) {
      try {
        const result = await runLatexCompiler(compiler, texPath, tempDir);
        return {
          ...result,
          pageCount: parsePageCount(result.log) ?? parsePageCountFromPdf(result.pdfBuffer),
          maxOverfullPoints: parseMaxOverfullPoints(result.log),
        };
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error("Unknown LaTeX compile failure.");
      }
    }

    throw lastError ?? new Error("Unable to compile tailored resume PDF.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
