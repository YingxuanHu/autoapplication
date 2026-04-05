"use client";

import Link from "next/link";

type ProfileSnapshot = {
  name: string;
  email: string;
  phone: string | null;
  location: string | null;
  headline: string | null;
  summary: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  workAuthorization: string | null;
  skillsJson: unknown;
  experiencesJson: unknown;
  educationsJson: unknown;
  hasDocuments: boolean;
};

type CheckItem = {
  label: string;
  done: boolean;
  weight: number; // relative importance for score
  hint?: string;
};

function buildChecklist(p: ProfileSnapshot): CheckItem[] {
  const skills = Array.isArray(p.skillsJson) ? p.skillsJson : [];
  const exps = Array.isArray(p.experiencesJson) ? p.experiencesJson : [];
  const edus = Array.isArray(p.educationsJson) ? p.educationsJson : [];

  return [
    { label: "Name & email", done: !!(p.name && p.email), weight: 10 },
    { label: "Phone number", done: !!p.phone, weight: 5 },
    { label: "Location", done: !!p.location, weight: 5 },
    { label: "Headline", done: !!p.headline, weight: 8, hint: "Used as the opening line of auto-fill forms" },
    { label: "Summary", done: !!p.summary, weight: 8, hint: "Used in cover letter generation" },
    { label: "LinkedIn URL", done: !!p.linkedinUrl, weight: 5 },
    { label: "Work authorization", done: !!p.workAuthorization, weight: 8, hint: "Required for US job eligibility screening" },
    { label: "Skills (3+)", done: skills.length >= 3, weight: 12, hint: "Powers job matching and AI fit analysis" },
    { label: "Work experience (1+)", done: exps.length >= 1, weight: 15, hint: "Core content for AI-generated cover letters" },
    { label: "Education", done: edus.length >= 1, weight: 8 },
    { label: "Resume uploaded", done: p.hasDocuments, weight: 16, hint: "Required for auto-fill file upload fields" },
  ];
}

export function CompletenessIndicator({ profile }: { profile: ProfileSnapshot }) {
  const checklist = buildChecklist(profile);
  const totalWeight = checklist.reduce((s, c) => s + c.weight, 0);
  const doneWeight = checklist.filter((c) => c.done).reduce((s, c) => s + c.weight, 0);
  const pct = Math.round((doneWeight / totalWeight) * 100);

  const tier =
    pct >= 90 ? "complete" :
    pct >= 65 ? "good" :
    pct >= 40 ? "partial" : "minimal";

  const tierColor = {
    complete: "text-green-600 dark:text-green-400",
    good: "text-blue-600 dark:text-blue-400",
    partial: "text-yellow-600 dark:text-yellow-400",
    minimal: "text-red-600 dark:text-red-400",
  }[tier];

  const barColor = {
    complete: "bg-green-500",
    good: "bg-blue-500",
    partial: "bg-yellow-500",
    minimal: "bg-red-500",
  }[tier];

  const missing = checklist.filter((c) => !c.done);

  return (
    <div className="rounded-md border border-border/60 p-4">
      {/* Score row */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className={`text-2xl font-bold ${tierColor}`}>{pct}%</span>
          <span className="text-xs capitalize text-muted-foreground">{tier}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {checklist.filter((c) => c.done).length}/{checklist.length} fields
        </span>
      </div>

      {/* Progress bar */}
      <div className="mb-4 h-1.5 w-full rounded-full bg-muted">
        <div
          className={`h-1.5 rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Missing items */}
      {missing.length > 0 && (
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Still missing:</p>
          <ul className="space-y-1">
            {missing.map((item) => (
              <li key={item.label} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <span className="mt-0.5 shrink-0 opacity-40">○</span>
                <span>
                  {item.label}
                  {item.hint && (
                    <span className="ml-1 opacity-60">— {item.hint}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pct === 100 && (
        <p className="text-xs text-green-600 dark:text-green-400">
          Profile complete — all auto-apply fields populated.
        </p>
      )}

      {pct < 40 && (
        <p className="mt-2 text-xs text-muted-foreground">
          A more complete profile improves auto-fill accuracy and AI match quality.{" "}
          <Link href="/profile" className="underline underline-offset-2 hover:text-foreground">
            Complete your profile →
          </Link>
        </p>
      )}
    </div>
  );
}
