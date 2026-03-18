"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  ArrowLeft,
  Bookmark,
  ExternalLink,
  MapPin,
  Building2,
  DollarSign,
  Clock,
  Briefcase,
  Loader2,
} from "lucide-react";

interface Job {
  id: string;
  title: string;
  company: string;
  companyLogo: string | null;
  location: string | null;
  workMode: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  description: string;
  summary: string | null;
  url: string;
  applyUrl: string | null;
  skills: string[];
  jobType: string | null;
  postedAt: string | null;
  createdAt: string;
}

interface Resume {
  id: string;
  name: string;
  isPrimary: boolean;
}

function formatSalary(min: number | null, max: number | null, currency: string | null) {
  const cur = currency || "USD";
  const fmt = (n: number) =>
    n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;
  if (min && max) return `${fmt(min)} - ${fmt(max)} ${cur}`;
  if (min) return `${fmt(min)}+ ${cur}`;
  if (max) return `Up to ${fmt(max)} ${cur}`;
  return null;
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function JobDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [selectedResumeId, setSelectedResumeId] = useState("");
  const [coverLetter, setCoverLetter] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fetchJob = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (!res.ok) {
        if (res.status === 404) {
          setError("Job not found");
          return;
        }
        throw new Error("Failed to fetch job");
      }
      const data = await res.json();
      setJob(data);
    } catch {
      setError("Failed to load job details");
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchResumes = useCallback(async () => {
    try {
      const res = await fetch("/api/resumes");
      if (!res.ok) return;
      const data = await res.json();
      setResumes(data);
      const primary = data.find((r: Resume) => r.isPrimary);
      if (primary) setSelectedResumeId(primary.id);
      else if (data.length > 0) setSelectedResumeId(data[0].id);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchJob();
    fetchResumes();
  }, [fetchJob, fetchResumes]);

  const handleSave = async () => {
    if (!job) return;
    setSaving(true);
    try {
      await fetch("/api/feed/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, action: "SAVE" }),
      });
      toast.success("Job saved!");
    } catch {
      toast.error("Failed to save job");
    } finally {
      setSaving(false);
    }
  };

  const handleApplySubmit = async () => {
    if (!job) return;
    setSubmitting(true);
    try {
      await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: job.id,
          resumeId: selectedResumeId || undefined,
          coverLetter: coverLetter || undefined,
        }),
      });
      toast.success("Application prepared!");
      setApplyOpen(false);
      setCoverLetter("");
    } catch {
      toast.error("Failed to apply");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Skeleton className="h-8 w-24" />
        <div className="space-y-4">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Briefcase className="mb-4 size-12 text-muted-foreground/50" />
          <h3 className="text-lg font-semibold">{error || "Job not found"}</h3>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => router.push("/jobs")}
          >
            <ArrowLeft className="size-4" />
            Back to Jobs
          </Button>
        </div>
      </div>
    );
  }

  const salary = formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency);
  const postedDate = formatDate(job.postedAt || job.createdAt);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Back button */}
      <Button variant="ghost" size="sm" render={<Link href="/jobs" />}>
        <ArrowLeft className="size-4" />
        Back to Jobs
      </Button>

      {/* Job header */}
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{job.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Building2 className="size-4" />
              {job.company}
            </span>
            {job.location && (
              <span className="flex items-center gap-1.5">
                <MapPin className="size-4" />
                {job.location}
              </span>
            )}
            {job.workMode && (
              <Badge variant="outline">{job.workMode}</Badge>
            )}
            {job.jobType && (
              <Badge variant="secondary">{job.jobType}</Badge>
            )}
          </div>
        </div>

        {/* Meta info */}
        <div className="flex flex-wrap items-center gap-4">
          {salary && (
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <DollarSign className="size-4 text-muted-foreground" />
              {salary}
            </span>
          )}
          {postedDate && (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Clock className="size-4" />
              Posted {postedDate}
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => setApplyOpen(true)}>
            Apply
          </Button>
          <Button variant="outline" onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Bookmark className="size-4" />
            )}
            Save
          </Button>
          <Button
            variant="outline"
            render={
              <a href={job.url} target="_blank" rel="noopener noreferrer" />
            }
          >
            <ExternalLink className="size-4" />
            View Original
          </Button>
        </div>
      </div>

      {/* Skills */}
      {job.skills.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Skills</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {job.skills.map((skill) => (
                <Badge key={skill} variant="secondary">
                  {skill}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Description */}
      <Card>
        <CardHeader>
          <CardTitle>Job Description</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="prose prose-sm max-w-none dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: job.description }}
          />
        </CardContent>
      </Card>

      {/* Apply Dialog */}
      <Dialog open={applyOpen} onOpenChange={setApplyOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Apply to {job.title}</DialogTitle>
            <DialogDescription>
              {job.company}
              {job.location ? ` - ${job.location}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Resume</label>
              {resumes.length > 0 ? (
                <Select
                  value={selectedResumeId}
                  onValueChange={(val) => setSelectedResumeId(val ?? "")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a resume" />
                  </SelectTrigger>
                  <SelectContent>
                    {resumes.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                        {r.isPrimary ? " (Primary)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No resumes uploaded. Visit the Resumes page to upload one.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Cover Letter{" "}
                <span className="text-muted-foreground">(optional)</span>
              </label>
              <Textarea
                placeholder="Write a cover letter or leave blank..."
                value={coverLetter}
                onChange={(e) => setCoverLetter(e.target.value)}
                rows={5}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApplyOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleApplySubmit} disabled={submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Prepare Application
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
