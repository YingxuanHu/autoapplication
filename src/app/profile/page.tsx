import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { FileText, Layers3, Sparkles } from "lucide-react";

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getOptionalSessionUser } from "@/lib/current-user";
import { getProfile } from "@/lib/queries/profile";
import { getDocuments } from "@/lib/queries/documents";
import { ProfileEditor } from "@/components/profile/profile-editor";
import { CompletenessIndicator } from "@/components/profile/completeness-indicator";
import { ProfileDocumentManager } from "@/components/profile/profile-document-manager";
import { formatDisplayLabel } from "@/lib/job-display";

export default async function ProfilePage() {
  const sessionUser = await getOptionalSessionUser();
  if (!sessionUser) {
    redirect("/sign-in");
  }

  const [profile, resumeDocuments, coverLetterDocuments] = await Promise.all([
    getProfile(),
    getDocuments("RESUME"),
    getDocuments("COVER_LETTER"),
  ]);

  if (!profile) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="flex items-start justify-between pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Keep your profile, resume library, variants, and cover letters in one place.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Link href="/documents/compare" className="hover:text-foreground">
            Compare docs
          </Link>
          <Link href="/dashboard" className="hover:text-foreground">
            Tracker
          </Link>
          <Link href="/jobs" className="hover:text-foreground">
            Back to feed
          </Link>
        </div>
      </div>

      <section className="mb-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Resumes and variants</CardTitle>
            <CardDescription>
              Upload resume versions here, parse them into your structured profile, and keep
              linked variants ready for application packages.
            </CardDescription>
            <CardAction>
              <Link
                href="/documents/compare"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Compare docs
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-6">
            <ProfileDocumentManager
              aiAvailable={!!process.env.OPENAI_API_KEY}
              documents={resumeDocuments.map((doc) => ({
                id: doc.id,
                filename: doc.filename,
                mimeType: doc.mimeType,
                sizeBytes: doc.sizeBytes,
                extractedText: doc.extractedText,
                createdAt: doc.createdAt.toISOString(),
                downloadHref: `/api/profile/documents/${doc.id}/download`,
                resumeVariant: doc.resumeVariant,
              }))}
              type="RESUME"
            />

            <div className="border-t border-border/60 pt-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium text-foreground">Resume variants</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    These are the structured variants the apply flow selects from.
                  </p>
                </div>
                <span className="text-xs text-muted-foreground">
                  {profile.resumeVariants.length} variant{profile.resumeVariants.length === 1 ? "" : "s"}
                </span>
              </div>

              <div className="mt-4 space-y-3">
                {profile.resumeVariants.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border/70 bg-background/40 p-6 text-sm text-muted-foreground">
                    No resume variants yet. Upload a resume to create one automatically.
                  </div>
                ) : null}

                {profile.resumeVariants.map((resume) => (
                  <div
                    key={resume.id}
                    className="rounded-lg border border-border/70 bg-background/40 p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-foreground">{resume.label}</p>
                      {resume.isDefault ? (
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                          Default
                        </span>
                      ) : null}
                      {resume.targetRoleFamily ? (
                        <span className="text-xs text-muted-foreground">
                          {resume.targetRoleFamily}
                        </span>
                      ) : null}
                    </div>
                    {resume.content ? (
                      <p className="mt-2 line-clamp-4 text-sm text-muted-foreground">
                        {resume.content}
                      </p>
                    ) : (
                      <p className="mt-2 text-sm text-muted-foreground">
                        No stored content preview for this variant yet.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Profile readiness</CardTitle>
            <CardDescription>
              A more complete profile improves job matching, auto-fill quality, and AI outputs.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <MetricTile
                icon={<FileText className="h-4 w-4" />}
                label="Resumes"
                value={String(resumeDocuments.length)}
              />
              <MetricTile
                icon={<Sparkles className="h-4 w-4" />}
                label="Cover letters"
                value={String(coverLetterDocuments.length)}
              />
              <MetricTile
                icon={<Layers3 className="h-4 w-4" />}
                label="Variants"
                value={String(profile.resumeVariants.length)}
              />
              <MetricTile
                icon={<Sparkles className="h-4 w-4" />}
                label="Automation"
                value={formatDisplayLabel(profile.automationMode).replace(" Before Submit", "")}
              />
            </div>

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
                hasDocuments: resumeDocuments.length > 0,
              }}
            />
          </CardContent>
        </Card>
      </section>

      <section className="mb-6">
        <Card>
          <CardHeader>
            <CardTitle>Cover letters</CardTitle>
            <CardDescription>
              Keep reusable cover letters in your profile library for manual submissions and
              tracker linking.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileDocumentManager
              documents={coverLetterDocuments.map((doc) => ({
                id: doc.id,
                filename: doc.filename,
                mimeType: doc.mimeType,
                sizeBytes: doc.sizeBytes,
                extractedText: doc.extractedText,
                createdAt: doc.createdAt.toISOString(),
                downloadHref: `/api/profile/documents/${doc.id}/download`,
                resumeVariant: doc.resumeVariant,
              }))}
              type="COVER_LETTER"
            />
          </CardContent>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader>
            <CardTitle>Profile data</CardTitle>
            <CardDescription>
              Structured profile data used for auto-fill, fit analysis, and generated application
              materials.
            </CardDescription>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function MetricTile({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-background/50 p-3">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-2 text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}
