import { redirect } from "next/navigation";
import { FileText, Mail, Star, User2 } from "lucide-react";

import { prisma } from "@/lib/db";
import { getOptionalSessionUser, requireCurrentProfileId } from "@/lib/current-user";
import { buildProfileFormValues } from "@/lib/profile";
import { type ResumeImportSummary } from "@/lib/resume-shared";
import { getStorageReadiness } from "@/lib/storage";
import { CoverLetterManager } from "@/components/profile/cover-letter-manager";
import { ProfileForm } from "@/components/profile/profile-form";
import { ResumeManager } from "@/components/profile/resume-manager";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

type ProfileSummary = {
  headline: boolean;
  summary: boolean;
  location: boolean;
  contact: boolean;
  skills: boolean;
  experiences: boolean;
  educations: boolean;
};

function buildCompleteness(values: ReturnType<typeof buildProfileFormValues>): {
  pct: number;
  filled: number;
  total: number;
  missing: string[];
} {
  const parts: Array<[keyof ProfileSummary, boolean, string]> = [
    ["headline", Boolean(values.headline?.trim()), "headline"],
    ["summary", Boolean(values.summary?.trim()), "summary"],
    ["location", Boolean(values.location?.trim()), "location"],
    [
      "contact",
      Boolean(values.contact.email?.trim() || values.contact.phone?.trim()),
      "contact info",
    ],
    ["skills", values.skills.length > 0, "skills"],
    ["experiences", values.experiences.length > 0, "experience"],
    ["educations", values.educations.length > 0, "education"],
  ];
  const filled = parts.filter(([, done]) => done).length;
  const total = parts.length;
  const missing = parts.filter(([, done]) => !done).map(([, , label]) => label);
  const pct = Math.round((filled / total) * 100);
  return { pct, filled, total, missing };
}

export default async function ProfilePage() {
  const sessionUser = await getOptionalSessionUser();

  if (!sessionUser) {
    redirect("/sign-in");
  }

  const profileId = await requireCurrentProfileId();
  const storageReadiness = getStorageReadiness();

  const [profile, resumes, templates, coverLetters] = await Promise.all([
    prisma.userProfile.findUnique({
      where: { id: profileId },
      select: {
        updatedAt: true,
        location: true,
        headline: true,
        summary: true,
        skillsText: true,
        experienceText: true,
        educationText: true,
        projectsText: true,
        contactJson: true,
        skillsJson: true,
        educationsJson: true,
        experiencesJson: true,
        projectsJson: true,
      },
    }),
    prisma.document.findMany({
      where: { userId: profileId, type: "RESUME" },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        originalFileName: true,
        mimeType: true,
        sizeBytes: true,
        createdAt: true,
        isPrimary: true,
        analysis: {
          select: {
            importSummaryJson: true,
          },
        },
      },
    }),
    prisma.document.findMany({
      where: { userId: profileId, type: "RESUME_TEMPLATE" },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        originalFileName: true,
        mimeType: true,
        isPrimary: true,
      },
    }),
    prisma.document.findMany({
      where: { userId: profileId, type: "COVER_LETTER" },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        originalFileName: true,
        mimeType: true,
        sizeBytes: true,
        createdAt: true,
      },
    }),
  ]);

  const initialValues = buildProfileFormValues(profile, sessionUser);
  const profileFormKey = profile?.updatedAt?.toISOString() ?? "blank-profile";

  const completeness = buildCompleteness(initialValues);
  const resumeCount = resumes.length;
  const primaryResume = resumes.find((resume) => resume.isPrimary) ?? null;
  const coverLetterCount = coverLetters.length;

  // Pick a sensible default tab: resumes if none uploaded yet, else About-you
  // if profile is incomplete, else resumes.
  const defaultTab = resumeCount === 0
    ? "resumes"
    : completeness.pct < 70
    ? "about"
    : "resumes";

  return (
    <div className="app-page space-y-6">
      <header className="space-y-1">
        <h1 className="page-title">Profile</h1>
        <p className="page-description">
          Your identity across applications — resumes, cover letters, and the details we send with every submission.
        </p>
      </header>

      {/* Summary strip */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile
          icon={<User2 className="h-4 w-4" />}
          label="Profile complete"
          value={`${completeness.pct}%`}
          hint={
            completeness.missing.length === 0
              ? "Everything filled in."
              : `Missing: ${completeness.missing.slice(0, 3).join(", ")}${
                  completeness.missing.length > 3 ? "…" : ""
                }`
          }
          progress={completeness.pct}
        />
        <SummaryTile
          icon={<FileText className="h-4 w-4" />}
          label="Resumes"
          value={resumeCount.toString()}
          hint={
            primaryResume
              ? `Primary: ${primaryResume.title || primaryResume.originalFileName}`
              : resumeCount > 0
              ? "No primary set"
              : "Upload one to start applying"
          }
        />
        <SummaryTile
          icon={<Mail className="h-4 w-4" />}
          label="Cover letters"
          value={coverLetterCount.toString()}
          hint={
            coverLetterCount > 0
              ? "Ready to attach to applications"
              : "Optional — add one for personalized submissions"
          }
        />
        <SummaryTile
          icon={<Star className="h-4 w-4" />}
          label="Templates"
          value={templates.length.toString()}
          hint={
            templates.length > 0
              ? "Used to format generated resumes"
              : "No template uploaded"
          }
        />
      </section>

      {/* Tabs */}
      <Tabs defaultValue={defaultTab} className="w-full">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="resumes">Resumes &amp; templates</TabsTrigger>
          <TabsTrigger value="cover-letters">Cover letters</TabsTrigger>
          <TabsTrigger value="about">About you</TabsTrigger>
        </TabsList>

        <TabsContent value="resumes" className="mt-4">
          <div className="surface-panel p-4 sm:p-5">
            <ResumeManager
              resumes={resumes.map((resume) => ({
                id: resume.id,
                title: resume.title,
                originalFileName: resume.originalFileName,
                mimeType: resume.mimeType,
                sizeLabel: formatBytes(resume.sizeBytes),
                createdAtLabel: formatDateTime(resume.createdAt),
                isPrimary: resume.isPrimary,
                downloadHref: `/api/profile/documents/${resume.id}/download`,
                importSummary:
                  (resume.analysis?.importSummaryJson as ResumeImportSummary | null) ?? null,
                isImported: resume.analysis !== null,
              }))}
              templates={templates.map((template) => ({
                id: template.id,
                title: template.title,
                originalFileName: template.originalFileName,
                mimeType: template.mimeType,
                isPrimary: template.isPrimary,
                downloadHref: `/api/profile/documents/${template.id}/download`,
              }))}
              storageConfigured={storageReadiness.configured}
            />
          </div>
        </TabsContent>

        <TabsContent value="cover-letters" className="mt-4">
          <div className="surface-panel p-4 sm:p-5">
            <CoverLetterManager
              coverLetters={coverLetters.map((coverLetter) => ({
                id: coverLetter.id,
                title: coverLetter.title,
                originalFileName: coverLetter.originalFileName,
                mimeType: coverLetter.mimeType,
                sizeLabel: formatBytes(coverLetter.sizeBytes),
                createdAtLabel: formatDateTime(coverLetter.createdAt),
                downloadHref: `/api/profile/documents/${coverLetter.id}/download`,
              }))}
              storageConfigured={storageReadiness.configured}
            />
          </div>
        </TabsContent>

        <TabsContent value="about" className="mt-4">
          <div className="surface-panel p-4 sm:p-5">
            <ProfileForm
              key={profileFormKey}
              initialValues={{
                headline: initialValues.headline,
                summary: initialValues.summary,
                location: initialValues.location,
                contact: initialValues.contact,
                skills: initialValues.skills,
                educations: initialValues.educations,
                experiences: initialValues.experiences,
                projects: initialValues.projects,
              }}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SummaryTile({
  icon,
  label,
  value,
  hint,
  progress,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
  progress?: number;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-foreground">
          {icon}
        </span>
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-3 text-2xl font-semibold text-foreground">{value}</p>
      {typeof progress === "number" ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-foreground transition-all"
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
      ) : null}
      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
