import Link from "next/link";
import { notFound } from "next/navigation";
import { Link2 } from "lucide-react";
import { formatDisplayLabel, formatSalary } from "@/lib/job-display";
import { getProfile } from "@/lib/queries/profile";

export default async function ProfilePage() {
  const profile = await getProfile();

  if (!profile) {
    notFound();
  }

  const hardFilters = profile.preferences.filter((p) => p.isHardFilter);
  const softSignals = profile.preferences.filter((p) => !p.isHardFilter);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="flex items-start justify-between pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{profile.name}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {profile.email}
            {profile.experienceLevel ? (
              <>
                <Sep />
                {formatDisplayLabel(profile.experienceLevel)}
              </>
            ) : null}
            {profile.preferredWorkMode ? (
              <>
                <Sep />
                {formatDisplayLabel(profile.preferredWorkMode)}
              </>
            ) : null}
          </p>
        </div>
        <Link href="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
          Back to feed
        </Link>
      </div>

      {/* Key fields */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-2 border-t border-border py-3 sm:grid-cols-3">
        <Field label="Automation mode" value={formatDisplayLabel(profile.automationMode)} />
        <Field label="Work authorization" value={profile.workAuthorization ?? "Not set"} />
        <Field
          label="Target salary"
          value={formatSalary(profile.salaryMin, profile.salaryMax, profile.salaryCurrency)}
        />
      </div>

      {/* Links */}
      <div className="border-t border-border py-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Links
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {[
            { label: "LinkedIn", href: profile.linkedinUrl },
            { label: "GitHub", href: profile.githubUrl },
            { label: "Portfolio", href: profile.portfolioUrl },
          ].map(({ label, href }) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{label}:</span>
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline"
                >
                  <Link2 className="h-3 w-3" />
                  {href}
                </a>
              ) : (
                <span className="text-sm text-muted-foreground">Not set</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Hard filters */}
      <div className="border-t border-border py-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Hard filters
          <span className="ml-1.5 opacity-60">{hardFilters.length}</span>
        </p>
        {hardFilters.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hard filters configured.</p>
        ) : (
          <div className="space-y-2">
            {hardFilters.map((pref) => (
              <KV key={pref.key} label={pref.key} value={pref.value} />
            ))}
          </div>
        )}
      </div>

      {/* Soft signals */}
      <div className="border-t border-border py-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Soft signals
          <span className="ml-1.5 opacity-60">{softSignals.length}</span>
        </p>
        {softSignals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No soft signals configured.</p>
        ) : (
          <div className="space-y-2">
            {softSignals.map((pref) => (
              <KV key={pref.key} label={pref.key} value={pref.value} />
            ))}
          </div>
        )}
      </div>

      {/* Resume variants */}
      <div className="border-t border-border py-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Resume variants
          <span className="ml-1.5 opacity-60">{profile.resumeVariants.length}</span>
        </p>
        <div className="space-y-4">
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}:</span>
      <span className="text-sm text-foreground">{value}</span>
    </div>
  );
}

function Sep() {
  return <span className="mx-1.5 text-border">·</span>;
}
