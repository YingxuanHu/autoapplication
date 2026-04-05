"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  ProfileExperience,
  ProfileEducation,
  ProfileProject,
} from "@/types/profile";
import {
  parseSkills,
  parseExperiences,
  parseEducations,
  parseProjects,
  emptyExperience,
  emptyEducation,
  emptyProject,
} from "@/types/profile";

// ─── Types ──────────────────────────────────────────────────────────────────

type ProfileData = {
  name: string;
  email: string;
  phone: string | null;
  location: string | null;
  headline: string | null;
  summary: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  workAuthorization: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  preferredWorkMode: string | null;
  experienceLevel: string | null;
  automationMode: string;
  skillsJson: unknown;
  experiencesJson: unknown;
  educationsJson: unknown;
  projectsJson: unknown;
};

type Props = {
  profile: ProfileData;
};

// ─── Component ──────────────────────────────────────────────────────────────

export function ProfileEditor({ profile }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // ── Contact & identity ──
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [location, setLocation] = useState(profile.location ?? "");
  const [headline, setHeadline] = useState(profile.headline ?? "");
  const [summary, setSummary] = useState(profile.summary ?? "");
  const [linkedinUrl, setLinkedinUrl] = useState(profile.linkedinUrl ?? "");
  const [githubUrl, setGithubUrl] = useState(profile.githubUrl ?? "");
  const [portfolioUrl, setPortfolioUrl] = useState(profile.portfolioUrl ?? "");

  // ── Preferences ──
  const [workAuth, setWorkAuth] = useState(profile.workAuthorization ?? "");
  const [salaryMin, setSalaryMin] = useState(profile.salaryMin?.toString() ?? "");
  const [salaryMax, setSalaryMax] = useState(profile.salaryMax?.toString() ?? "");
  const [workMode, setWorkMode] = useState(profile.preferredWorkMode ?? "");
  const [expLevel, setExpLevel] = useState(profile.experienceLevel ?? "");
  const [autoMode, setAutoMode] = useState(profile.automationMode);

  // ── Structured data ──
  const [skillsText, setSkillsText] = useState(
    parseSkills(profile.skillsJson).join(", ")
  );
  const [experiences, setExperiences] = useState<ProfileExperience[]>(
    parseExperiences(profile.experiencesJson)
  );
  const [educations, setEducations] = useState<ProfileEducation[]>(
    parseEducations(profile.educationsJson)
  );
  const [projects, setProjects] = useState<ProfileProject[]>(
    parseProjects(profile.projectsJson)
  );

  function save() {
    if (isPending) return;
    setError(null);
    setSuccess(false);

    const skillsArr = skillsText
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const body = {
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim() || null,
      location: location.trim() || null,
      headline: headline.trim() || null,
      summary: summary.trim() || null,
      linkedinUrl: linkedinUrl.trim() || null,
      githubUrl: githubUrl.trim() || null,
      portfolioUrl: portfolioUrl.trim() || null,
      workAuthorization: workAuth.trim() || null,
      salaryMin: salaryMin ? parseInt(salaryMin, 10) : null,
      salaryMax: salaryMax ? parseInt(salaryMax, 10) : null,
      preferredWorkMode: workMode || null,
      experienceLevel: expLevel || null,
      automationMode: autoMode,
      skillsJson: skillsArr,
      experiencesJson: experiences.filter((e) => e.title || e.company),
      educationsJson: educations.filter((e) => e.school),
      projectsJson: projects.filter((p) => p.name),
    };

    startTransition(async () => {
      try {
        const res = await fetch("/api/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error ?? "Failed to save profile");
        }
        setSuccess(true);
        router.refresh();
        setTimeout(() => setSuccess(false), 3000);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save");
      }
    });
  }

  const spinner = isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null;

  return (
    <div className="space-y-6 [&>div:first-child]:border-t-0 [&>div:first-child]:pt-0">
      {/* ── Contact & Identity ── */}
      <Section title="Contact information">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <LabeledInput label="Full name" value={name} onChange={setName} />
          <LabeledInput label="Email" value={email} onChange={setEmail} type="email" />
          <LabeledInput label="Phone" value={phone} onChange={setPhone} placeholder="+1 555-000-0000" />
          <LabeledInput label="Location" value={location} onChange={setLocation} placeholder="New York, NY" />
        </div>
        <LabeledInput label="Headline" value={headline} onChange={setHeadline} placeholder="Senior Software Engineer · Full Stack" className="mt-3" />
        <div className="mt-3">
          <label className="mb-1 block text-xs text-muted-foreground">Summary</label>
          <Textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Brief professional summary..."
            rows={3}
            className="text-sm"
          />
        </div>
      </Section>

      {/* ── Links ── */}
      <Section title="Links">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <LabeledInput label="LinkedIn" value={linkedinUrl} onChange={setLinkedinUrl} placeholder="https://linkedin.com/in/..." />
          <LabeledInput label="GitHub" value={githubUrl} onChange={setGithubUrl} placeholder="https://github.com/..." />
          <LabeledInput label="Portfolio" value={portfolioUrl} onChange={setPortfolioUrl} placeholder="https://..." />
        </div>
      </Section>

      {/* ── Skills ── */}
      <Section title="Skills">
        <label className="mb-1 block text-xs text-muted-foreground">
          Comma-separated list
        </label>
        <Textarea
          value={skillsText}
          onChange={(e) => setSkillsText(e.target.value)}
          placeholder="TypeScript, React, PostgreSQL, Python, AWS..."
          rows={2}
          className="text-sm"
        />
      </Section>

      {/* ── Experience ── */}
      <Section title={`Experience (${experiences.length})`}>
        {experiences.map((exp, i) => (
          <EntryCard key={i} onRemove={() => setExperiences((prev) => prev.filter((_, j) => j !== i))}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <EntryInput label="Title" value={exp.title} onChange={(v) => updateExperience(i, "title", v)} />
              <EntryInput label="Company" value={exp.company} onChange={(v) => updateExperience(i, "company", v)} />
              <EntryInput label="Location" value={exp.location} onChange={(v) => updateExperience(i, "location", v)} />
              <div className="flex gap-2">
                <EntryInput label="Start" value={exp.startDate} onChange={(v) => updateExperience(i, "startDate", v)} placeholder="2022-01" />
                <EntryInput label="End" value={exp.endDate} onChange={(v) => updateExperience(i, "endDate", v)} placeholder="Present" />
              </div>
            </div>
            <EntryTextarea label="Description" value={exp.description} onChange={(v) => updateExperience(i, "description", v)} />
          </EntryCard>
        ))}
        <AddButton label="Add experience" onClick={() => setExperiences((prev) => [...prev, emptyExperience()])} />
      </Section>

      {/* ── Education ── */}
      <Section title={`Education (${educations.length})`}>
        {educations.map((edu, i) => (
          <EntryCard key={i} onRemove={() => setEducations((prev) => prev.filter((_, j) => j !== i))}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <EntryInput label="School" value={edu.school} onChange={(v) => updateEducation(i, "school", v)} />
              <EntryInput label="Degree" value={edu.degree} onChange={(v) => updateEducation(i, "degree", v)} />
              <EntryInput label="Field" value={edu.field} onChange={(v) => updateEducation(i, "field", v)} />
              <div className="flex gap-2">
                <EntryInput label="Start" value={edu.startDate} onChange={(v) => updateEducation(i, "startDate", v)} placeholder="2018" />
                <EntryInput label="End" value={edu.endDate} onChange={(v) => updateEducation(i, "endDate", v)} placeholder="2022" />
              </div>
            </div>
            <EntryTextarea label="Description" value={edu.description} onChange={(v) => updateEducation(i, "description", v)} />
          </EntryCard>
        ))}
        <AddButton label="Add education" onClick={() => setEducations((prev) => [...prev, emptyEducation()])} />
      </Section>

      {/* ── Projects ── */}
      <Section title={`Projects (${projects.length})`}>
        {projects.map((proj, i) => (
          <EntryCard key={i} onRemove={() => setProjects((prev) => prev.filter((_, j) => j !== i))}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <EntryInput label="Name" value={proj.name} onChange={(v) => updateProject(i, "name", v)} />
              <EntryInput label="URL" value={proj.url} onChange={(v) => updateProject(i, "url", v)} placeholder="https://..." />
              <EntryInput label="Technologies" value={proj.technologies} onChange={(v) => updateProject(i, "technologies", v)} placeholder="React, Node.js, PostgreSQL" className="sm:col-span-2" />
            </div>
            <EntryTextarea label="Description" value={proj.description} onChange={(v) => updateProject(i, "description", v)} />
          </EntryCard>
        ))}
        <AddButton label="Add project" onClick={() => setProjects((prev) => [...prev, emptyProject()])} />
      </Section>

      {/* ── Preferences ── */}
      <Section title="Preferences & automation">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <LabeledInput label="Work authorization" value={workAuth} onChange={setWorkAuth} placeholder="US Citizen, H1-B, etc." />
          <LabeledInput label="Salary min" value={salaryMin} onChange={setSalaryMin} type="number" placeholder="80000" />
          <LabeledInput label="Salary max" value={salaryMax} onChange={setSalaryMax} type="number" placeholder="150000" />
          <LabeledSelect label="Preferred work mode" value={workMode} onChange={setWorkMode} options={WORK_MODE_OPTIONS} />
          <LabeledSelect label="Experience level" value={expLevel} onChange={setExpLevel} options={EXP_LEVEL_OPTIONS} />
          <LabeledSelect label="Automation mode" value={autoMode} onChange={setAutoMode} options={AUTOMATION_MODE_OPTIONS} />
        </div>
      </Section>

      {/* ── Save ── */}
      <div className="flex items-center gap-3 border-t border-border pt-4">
        <Button onClick={save} disabled={isPending}>
          {spinner}
          Save profile
        </Button>
        {success ? <span className="text-xs text-green-600 dark:text-green-400">Saved</span> : null}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </div>
  );

  // ── Updaters for structured arrays ──

  function updateExperience<K extends keyof ProfileExperience>(i: number, key: K, value: string) {
    setExperiences((prev) => prev.map((e, j) => (j === i ? { ...e, [key]: value } : e)));
  }

  function updateEducation<K extends keyof ProfileEducation>(i: number, key: K, value: string) {
    setEducations((prev) => prev.map((e, j) => (j === i ? { ...e, [key]: value } : e)));
  }

  function updateProject<K extends keyof ProfileProject>(i: number, key: K, value: string) {
    setProjects((prev) => prev.map((p, j) => (j === i ? { ...p, [key]: value } : p)));
  }
}

// ─── Shared sub-components ──────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border pt-4">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="text-sm"
      />
    </div>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="">Not set</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function EntryCard({
  children,
  onRemove,
}: {
  children: React.ReactNode;
  onRemove: () => void;
}) {
  return (
    <div className="relative mb-3 rounded-md border border-border/60 p-3">
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
        title="Remove"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <div className="space-y-2 pr-6">{children}</div>
    </div>
  );
}

function EntryInput({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="mb-0.5 block text-[11px] text-muted-foreground">{label}</label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 text-sm"
      />
    </div>
  );
}

function EntryTextarea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="mt-2">
      <label className="mb-0.5 block text-[11px] text-muted-foreground">{label}</label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        className="text-sm"
      />
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"
    >
      <Plus className="h-3 w-3" />
      {label}
    </button>
  );
}

// ─── Select options ─────────────────────────────────────────────────────────

const WORK_MODE_OPTIONS = [
  { value: "REMOTE", label: "Remote" },
  { value: "HYBRID", label: "Hybrid" },
  { value: "ONSITE", label: "On-site" },
  { value: "FLEXIBLE", label: "Flexible" },
];

const EXP_LEVEL_OPTIONS = [
  { value: "ENTRY", label: "Entry" },
  { value: "MID", label: "Mid" },
  { value: "SENIOR", label: "Senior" },
  { value: "LEAD", label: "Lead" },
  { value: "EXECUTIVE", label: "Executive" },
];

const AUTOMATION_MODE_OPTIONS = [
  { value: "DISCOVERY_ONLY", label: "Discovery only" },
  { value: "ASSIST", label: "Assist" },
  { value: "REVIEW_BEFORE_SUBMIT", label: "Review before submit" },
  { value: "STRICT_AUTO_APPLY", label: "Strict auto-apply" },
];
