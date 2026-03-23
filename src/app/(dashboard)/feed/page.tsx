"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { findBestResume } from "@/lib/resume/matcher";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  X,
  Bookmark,
  Check,
  RefreshCw,
  MapPin,
  Building2,
  DollarSign,
  Loader2,
  Briefcase,
  ChevronDown,
  ChevronUp,
  Filter,
} from "lucide-react";
import { SourceBadge } from "@/components/jobs/source-badge";
import { MatchReasonChips } from "@/components/jobs/match-reason";

import type { SourceType } from "@/components/jobs/source-badge";

interface ScoredJob {
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
  skills: string[];
  jobType: string | null;
  postedAt: string | null;
  score: number;
  matchReasons: string[];
  sourceLabel: string | null;
  sourceType: SourceType | null;
  source: string | null;
  isDirectApply: boolean | null;
  trustScore: number | null;
  sourceTrust: number | null;
}

interface Resume {
  id: string;
  name: string;
  fileName: string;
  skills: string[];
  isPrimary: boolean;
}

type FeedAction = "APPLY" | "PASS" | "SAVE";
type SwipeDirection = "left" | "down" | "right" | null;

interface FeedActionPayload {
  jobId: string;
  action: FeedAction;
  score: number;
  resumeId?: string;
  coverLetter?: string;
}

function formatSalary(min: number | null, max: number | null, currency: string | null) {
  const cur = currency || "USD";
  const fmt = (n: number) => {
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return n.toString();
  };
  if (min && max) return `$${fmt(min)} - $${fmt(max)} ${cur}`;
  if (min) return `$${fmt(min)}+ ${cur}`;
  if (max) return `Up to $${fmt(max)} ${cur}`;
  return null;
}

function scoreColor(score: number) {
  if (score > 70) return "bg-emerald-100 text-emerald-800";
  if (score > 40) return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-800";
}

export default function FeedPage() {
  const [jobs, setJobs] = useState<ScoredJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [swipeDir, setSwipeDir] = useState<SwipeDirection>(null);
  const [animating, setAnimating] = useState(false);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [selectedResumeId, setSelectedResumeId] = useState<string>("");
  const [coverLetter, setCoverLetter] = useState("");
  const [submittingApply, setSubmittingApply] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [directOnly, setDirectOnly] = useState(false);
  const pendingActionRef = useRef<{ jobId: string; score: number } | null>(null);

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (directOnly) params.set("directOnly", "true");
      const res = await fetch(`/api/feed?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch feed");
      const data = await res.json();
      setJobs(data);
    } catch {
      toast.error("Failed to load job feed");
    } finally {
      setLoading(false);
    }
  }, [directOnly]);

  const fetchResumes = useCallback(async () => {
    try {
      const res = await fetch("/api/resumes");
      if (!res.ok) return;
      const data = await res.json();
      setResumes(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchJobs();
    fetchResumes();
  }, [fetchJobs, fetchResumes]);

  const currentJob = jobs[0] ?? null;
  const recommendedResume = currentJob
    ? findBestResume(resumes, currentJob)
    : null;

  useEffect(() => {
    if (!currentJob) {
      setSelectedResumeId("");
      return;
    }

    if (recommendedResume) {
      setSelectedResumeId(recommendedResume.id);
      return;
    }

    const primary = resumes.find((resume) => resume.isPrimary);
    if (primary) {
      setSelectedResumeId(primary.id);
      return;
    }

    setSelectedResumeId(resumes[0]?.id ?? "");
  }, [currentJob, recommendedResume, resumes]);

  // Reset expanded state when card changes
  useEffect(() => {
    setExpanded(false);
  }, [currentJob?.id]);

  const recordAction = useCallback(
    async (payload: FeedActionPayload) => {
      const res = await fetch("/api/feed/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        throw new Error(errorBody?.error || "Request failed");
      }

      return res.json().catch(() => null);
    },
    []
  );

  const animateAndRemove = useCallback(
    (direction: SwipeDirection, action: FeedAction) => {
      if (!currentJob || animating) return;

      if (action === "APPLY") {
        pendingActionRef.current = {
          jobId: currentJob.id,
          score: currentJob.score,
        };
        setApplyDialogOpen(true);
        return;
      }

      setSwipeDir(direction);
      setAnimating(true);
      setTimeout(() => {
        void (async () => {
          try {
            await recordAction({
              jobId: currentJob.id,
              action,
              score: currentJob.score,
            });
            setJobs((prev) => prev.slice(1));
          } catch (error) {
            toast.error(
              error instanceof Error ? error.message : "Failed to record action"
            );
          } finally {
            setSwipeDir(null);
            setAnimating(false);
          }
        })();
      }, 300);
    },
    [currentJob, animating, recordAction]
  );

  const handlePass = useCallback(() => animateAndRemove("left", "PASS"), [animateAndRemove]);
  const handleSave = useCallback(() => animateAndRemove("down", "SAVE"), [animateAndRemove]);
  const handleApply = useCallback(() => animateAndRemove("right", "APPLY"), [animateAndRemove]);

  const handleApplySubmit = useCallback(async () => {
    if (!pendingActionRef.current) return;
    if (!selectedResumeId) {
      toast.error("Select a resume before applying");
      return;
    }

    setSubmittingApply(true);
    try {
      const { jobId, score } = pendingActionRef.current;
      await recordAction({
        jobId,
        action: "APPLY",
        score,
        resumeId: selectedResumeId,
        coverLetter: coverLetter || undefined,
      });

      toast.success("Application prepared!");
      setJobs((prev) => prev.slice(1));
      setApplyDialogOpen(false);
      setCoverLetter("");
      pendingActionRef.current = null;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to apply"
      );
    } finally {
      setSubmittingApply(false);
    }
  }, [coverLetter, recordAction, selectedResumeId]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const aggregatorRes = await fetch("/api/jobs/sync", { method: "POST" });
      if (!aggregatorRes.ok) throw new Error("Sync failed");

      const aggregatorData = await aggregatorRes.json();

      toast.success(
        `Synced ${aggregatorData.newJobs ?? aggregatorData.synced ?? 0} jobs from aggregators`,
      );
      fetchJobs();
    } catch {
      toast.error("Failed to sync jobs");
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (applyDialogOpen) return;
      if (e.key === "ArrowLeft" || e.key.toLowerCase() === "p") handlePass();
      else if (e.key === "ArrowDown" || e.key.toLowerCase() === "s") handleSave();
      else if (e.key === "ArrowRight" || e.key.toLowerCase() === "a") handleApply();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handlePass, handleSave, handleApply, applyDialogOpen]);

  const swipeTransform = swipeDir === "left"
    ? "translate-x-[-120%] rotate-[-15deg]"
    : swipeDir === "right"
    ? "translate-x-[120%] rotate-[15deg]"
    : swipeDir === "down"
    ? "translate-y-[120%]"
    : "";

  const trustScore = currentJob?.sourceTrust ?? currentJob?.trustScore ?? null;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Job Feed</h1>
          <p className="text-sm text-muted-foreground">
            Swipe through matched jobs while refresh runs across all sources
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={directOnly ? "default" : "outline"}
            size="sm"
            onClick={() => setDirectOnly((v) => !v)}
            title="Show only direct-apply jobs"
          >
            <Filter className="size-4" />
            Direct Only
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={syncing}
          >
            {syncing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Refresh Jobs
          </Button>
        </div>
      </div>

      {/* Card Stack */}
      <div className="relative min-h-[460px]">
        {loading ? (
          <Card className="w-full">
            <CardHeader>
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
              <div className="flex gap-2">
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-5 w-16" />
              </div>
            </CardContent>
            <CardFooter className="justify-center gap-4">
              <Skeleton className="h-10 w-10 rounded-full" />
              <Skeleton className="h-10 w-10 rounded-full" />
              <Skeleton className="h-10 w-10 rounded-full" />
            </CardFooter>
          </Card>
        ) : !currentJob ? (
          <Card className="w-full">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Briefcase className="mb-4 size-12 text-muted-foreground/50" />
              <h3 className="text-lg font-semibold">No more jobs to review</h3>
              <p className="mt-2 max-w-xs text-sm text-muted-foreground">
                Try adjusting your preferences or syncing new jobs.
              </p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={handleSync}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Refresh Jobs
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Background cards for stack effect */}
            {jobs.length > 2 && (
              <Card className="absolute inset-x-0 top-2 scale-[0.94] opacity-40" />
            )}
            {jobs.length > 1 && (
              <Card className="absolute inset-x-0 top-1 scale-[0.97] opacity-60" />
            )}

            {/* Top card - direct-apply jobs get green left border */}
            <Card
              className={`relative w-full transition-transform duration-300 ease-out ${swipeTransform} ${
                currentJob.isDirectApply
                  ? "border-l-4 border-l-emerald-500"
                  : ""
              }`}
            >
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Building2 className="size-3.5 shrink-0" />
                      <span className="truncate">{currentJob.company}</span>
                    </div>
                    <CardTitle className="mt-1 text-lg leading-snug">
                      {currentJob.title}
                    </CardTitle>
                    {/* Source badge */}
                    <div className="mt-1.5">
                      <SourceBadge
                        sourceType={currentJob.sourceType}
                        sourceName={currentJob.source}
                        sourceLabel={currentJob.sourceLabel}
                        isDirectApply={currentJob.isDirectApply}
                        trustScore={trustScore}
                        compact
                      />
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${scoreColor(currentJob.score)}`}
                    >
                      {currentJob.score}%
                    </span>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                {/* Location & Work Mode */}
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  {currentJob.location && (
                    <span className="flex items-center gap-1">
                      <MapPin className="size-3.5" />
                      {currentJob.location}
                    </span>
                  )}
                  {currentJob.workMode && (
                    <Badge variant="outline">{currentJob.workMode}</Badge>
                  )}
                </div>

                {/* Salary */}
                {formatSalary(
                  currentJob.salaryMin,
                  currentJob.salaryMax,
                  currentJob.salaryCurrency
                ) && (
                  <div className="flex items-center gap-1 text-sm font-medium">
                    <DollarSign className="size-3.5 text-muted-foreground" />
                    {formatSalary(
                      currentJob.salaryMin,
                      currentJob.salaryMax,
                      currentJob.salaryCurrency
                    )}
                  </div>
                )}

                {/* Description preview */}
                <p className="line-clamp-4 text-sm leading-relaxed text-muted-foreground">
                  {currentJob.summary || currentJob.description}
                </p>

                {/* Skills */}
                {currentJob.skills.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {currentJob.skills.slice(0, 6).map((skill) => (
                      <Badge key={skill} variant="secondary">
                        {skill}
                      </Badge>
                    ))}
                    {currentJob.skills.length > 6 && (
                      <Badge variant="secondary">
                        +{currentJob.skills.length - 6}
                      </Badge>
                    )}
                  </div>
                )}

                {/* Match Reasons (always visible as compact chips) */}
                {currentJob.matchReasons.length > 0 && (
                  <MatchReasonChips matchReasons={currentJob.matchReasons} compact />
                )}

                {/* Expandable "Why this matches" section */}
                {currentJob.matchReasons.length > 0 && (
                  <button
                    type="button"
                    className="flex w-full items-center justify-center gap-1 rounded-md py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded ? (
                      <>
                        <ChevronUp className="size-3" />
                        Hide details
                      </>
                    ) : (
                      <>
                        <ChevronDown className="size-3" />
                        Why this matches
                      </>
                    )}
                  </button>
                )}
                {expanded && (
                  <div className="space-y-2 rounded-md bg-muted/50 p-3">
                    <p className="text-xs font-medium text-foreground">Match Details</p>
                    <ul className="space-y-1">
                      {currentJob.matchReasons.map((reason) => (
                        <li key={reason} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                          <Check className="mt-0.5 size-3 shrink-0 text-emerald-500" />
                          {reason}
                        </li>
                      ))}
                    </ul>
                    {trustScore != null && (
                      <div className="mt-2 flex items-center gap-2 border-t pt-2 text-xs text-muted-foreground">
                        <span>Source trust:</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full ${
                              trustScore > 0.8
                                ? "bg-emerald-500"
                                : trustScore >= 0.5
                                  ? "bg-amber-500"
                                  : "bg-gray-400"
                            }`}
                            style={{ width: `${Math.round(trustScore * 100)}%` }}
                          />
                        </div>
                        <span>{Math.round(trustScore * 100)}%</span>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>

              <CardFooter className="justify-center gap-4">
                <Button
                  variant="outline"
                  size="icon-lg"
                  className="rounded-full border-red-200 text-red-500 hover:bg-red-50 hover:text-red-600"
                  onClick={handlePass}
                  disabled={animating}
                  title="Pass (Left Arrow / P)"
                >
                  <X className="size-5" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-lg"
                  className="rounded-full border-amber-200 text-amber-500 hover:bg-amber-50 hover:text-amber-600"
                  onClick={handleSave}
                  disabled={animating}
                  title="Save (Down Arrow / S)"
                >
                  <Bookmark className="size-5" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-lg"
                  className={`rounded-full ${
                    currentJob.isDirectApply
                      ? "border-emerald-300 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 hover:text-emerald-700"
                      : "border-emerald-200 text-emerald-500 hover:bg-emerald-50 hover:text-emerald-600"
                  }`}
                  onClick={handleApply}
                  disabled={animating}
                  title="Apply (Right Arrow / A)"
                >
                  <Check className="size-5" />
                </Button>
              </CardFooter>
            </Card>

            {/* Keyboard shortcut hints */}
            <div className="mt-3 flex justify-center gap-6 text-xs text-muted-foreground">
              <span>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                  ←
                </kbd>{" "}
                Pass
              </span>
              <span>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                  ↓
                </kbd>{" "}
                Save
              </span>
              <span>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                  →
                </kbd>{" "}
                Apply
              </span>
            </div>
          </>
        )}
      </div>

      {/* Apply Dialog */}
      <Dialog
        open={applyDialogOpen}
        onOpenChange={(open) => {
          setApplyDialogOpen(open);
          if (!open && !submittingApply) {
            pendingActionRef.current = null;
            setCoverLetter("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Apply to {currentJob?.title}</DialogTitle>
            <DialogDescription>
              {currentJob?.company}
              {currentJob?.location ? ` - ${currentJob.location}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Direct apply indicator */}
            {currentJob?.isDirectApply && (
              <div className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                <Check className="size-4" />
                Direct to employer — no middleman
              </div>
            )}
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
              {recommendedResume && (
                <p className="text-xs text-muted-foreground">
                  Recommended based on skill overlap:{" "}
                  <span className="font-medium text-foreground">
                    {recommendedResume.name}
                  </span>
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
            <Button
              variant="outline"
              onClick={() => {
                setApplyDialogOpen(false);
                pendingActionRef.current = null;
                setCoverLetter("");
              }}
            >
              Cancel
            </Button>
            <Button
              className={
                currentJob?.isDirectApply
                  ? "bg-emerald-600 text-white hover:bg-emerald-700"
                  : ""
              }
              onClick={handleApplySubmit}
              disabled={submittingApply || resumes.length === 0 || !selectedResumeId}
            >
              {submittingApply && <Loader2 className="size-4 animate-spin" />}
              Prepare Application
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
