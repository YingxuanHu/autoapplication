import Link from "next/link";
import { notFound } from "next/navigation";
import { Link2 } from "lucide-react";
import { getProfile } from "@/lib/queries/profile";
import { getDocuments } from "@/lib/queries/documents";
import { ProfileEditor } from "@/components/profile/profile-editor";
import { ResumeUpload } from "@/components/profile/resume-upload";
import { CompletenessIndicator } from "@/components/profile/completeness-indicator";

export default async function ProfilePage() {
  const [profile, documents] = await Promise.all([getProfile(), getDocuments("RESUME")]);

  if (!profile) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="flex items-start justify-between pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Your professional information, used for auto-fill and job matching.
          </p>
        </div>
        <Link href="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
          Back to feed
        </Link>
      </div>

      {/* Completeness indicator */}
      <div className="mb-6">
        <CompletenessIndicator
          profile={{
            name: profile.name,
            email: profile.email,
            phone: profile.phone,
            location: profile.location,
            headline: profile.headline,
            summary: profile.summary,
            linkedinUrl: profile.linkedinUrl,
            githubUrl: profile.githubUrl,
            workAuthorization: profile.workAuthorization,
            skillsJson: profile.skillsJson,
            experiencesJson: profile.experiencesJson,
            educationsJson: profile.educationsJson,
            hasDocuments: documents.length > 0,
          }}
        />
      </div>

      {/* Profile editor */}
      <ProfileEditor
        profile={{
          name: profile.name,
          email: profile.email,
          phone: profile.phone,
          location: profile.location,
          headline: profile.headline,
          summary: profile.summary,
          linkedinUrl: profile.linkedinUrl,
          githubUrl: profile.githubUrl,
          portfolioUrl: profile.portfolioUrl,
          workAuthorization: profile.workAuthorization,
          salaryMin: profile.salaryMin,
          salaryMax: profile.salaryMax,
          salaryCurrency: profile.salaryCurrency,
          preferredWorkMode: profile.preferredWorkMode,
          experienceLevel: profile.experienceLevel,
          automationMode: profile.automationMode,
          skillsJson: profile.skillsJson,
          experiencesJson: profile.experiencesJson,
          educationsJson: profile.educationsJson,
          projectsJson: profile.projectsJson,
        }}
      />

      {/* Document upload */}
      <div className="mt-6 border-t border-border pt-4">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Documents
          <span className="ml-1.5 opacity-60">{documents.length}</span>
        </h2>
        <ResumeUpload
          aiAvailable={!!process.env.ANTHROPIC_API_KEY}
          documents={documents.map((d) => ({
            id: d.id,
            filename: d.filename,
            mimeType: d.mimeType,
            sizeBytes: d.sizeBytes,
            extractedText: d.extractedText,
            createdAt: d.createdAt.toISOString(),
            resumeVariant: d.resumeVariant,
          }))}
        />
      </div>

      {/* Resume variants */}
      <div className="mt-6 border-t border-border pt-4">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Resume variants
          <span className="ml-1.5 opacity-60">{profile.resumeVariants.length}</span>
        </h2>
        <div className="space-y-4">
          {profile.resumeVariants.length === 0 ? (
            <p className="text-sm text-muted-foreground">No resume variants yet.</p>
          ) : null}
          {profile.resumeVariants.map((resume) => (
            <div
              key={resume.id}
              className="border-b border-border/60 pb-4 last:border-b-0 last:pb-0"
            >
              <div className="flex items-baseline gap-2">
                <p className="text-sm font-medium text-foreground">{resume.label}</p>
                {resume.isDefault ? (
                  <span className="text-xs text-muted-foreground">(default)</span>
                ) : null}
                {resume.targetRoleFamily ? (
                  <span className="text-xs text-muted-foreground">· {resume.targetRoleFamily}</span>
                ) : null}
              </div>
              {resume.content ? (
                <p className="mt-1 line-clamp-4 text-sm text-muted-foreground">{resume.content}</p>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">No content preview stored.</p>
              )}
              {resume.fileUrl ? (
                <a
                  href={resume.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline"
                >
                  <Link2 className="h-3 w-3" />
                  Open file
                </a>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
