import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { getOptionalSessionUser, requireCurrentProfileId } from "@/lib/current-user";
import { buildProfileFormValues } from "@/lib/profile";
import { type ResumeImportSummary } from "@/lib/resume-shared";
import { getStorageReadiness } from "@/lib/storage";
import { CoverLetterManager } from "@/components/profile/cover-letter-manager";
import { ProfileForm } from "@/components/profile/profile-form";
import { ResumeManager } from "@/components/profile/resume-manager";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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

  return (
    <div className="app-page space-y-6">
      <div className="space-y-1">
        <h1 className="page-title">Profile</h1>
        <p className="page-description">
          Keep your profile, resume history, templates, and cover letters in one place.
        </p>
      </div>

      <section>
        <Card>
          <CardHeader>
            <CardTitle>Resumes and templates</CardTitle>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader>
            <CardTitle>Cover letters</CardTitle>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader>
            <CardTitle>Profile data</CardTitle>
          </CardHeader>
          <CardContent>
            <ProfileForm
              key={profileFormKey}
              initialValues={{
                headline: initialValues.headline,
                summary: initialValues.summary,
                contact: initialValues.contact,
                skills: initialValues.skills,
                educations: initialValues.educations,
                experiences: initialValues.experiences,
                projects: initialValues.projects,
              }}
            />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
