"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  ArrowLeft,
  Building2,
  Globe,
  Shield,
  RefreshCw,
  ExternalLink,
  CheckCircle,
  AlertCircle,
  Clock,
  Loader2,
  Link as LinkIcon,
  Search,
  Activity,
} from "lucide-react";

interface CompanySource {
  id: string;
  type: string;
  url: string;
  verified: boolean;
  active: boolean;
  lastCrawlAt: string | null;
}

interface CrawlRun {
  id: string;
  status: string;
  jobsFound: number;
  jobsNew: number;
  jobsUpdated: number;
  durationMs: number | null;
  startedAt: string;
  completedAt: string | null;
}

interface Discovery {
  id: string;
  url: string;
  method: string;
  confidence: number;
  promoted: boolean;
  discoveredAt: string;
}

interface CompanyDetail {
  id: string;
  name: string;
  domain: string;
  careersUrl: string | null;
  atsType: string | null;
  trustScore: number;
  crawlStatus: string;
  sources: CompanySource[];
  crawlRuns: CrawlRun[];
  discoveries: Discovery[];
}

function atsColor(ats: string | null): string {
  switch (ats?.toLowerCase()) {
    case "greenhouse":
      return "bg-green-100 text-green-800";
    case "lever":
      return "bg-purple-100 text-purple-800";
    case "ashby":
      return "bg-blue-100 text-blue-800";
    case "smartrecruiters":
      return "bg-orange-100 text-orange-800";
    case "workday":
      return "bg-indigo-100 text-indigo-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

function trustScoreColor(score: number): string {
  if (score > 0.7) return "bg-emerald-500";
  if (score > 0.4) return "bg-amber-500";
  return "bg-red-500";
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "SUCCESS":
      return "bg-emerald-100 text-emerald-800";
    case "CRAWLING":
      return "bg-blue-100 text-blue-800";
    case "FAILED":
    case "BLOCKED":
    case "RATE_LIMITED":
      return "bg-red-100 text-red-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

export default function CompanyDetailPage() {
  const params = useParams();
  const companyId = params.id as string;

  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const fetchCompany = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/companies/${companyId}`);
      if (!res.ok) throw new Error("Failed to fetch company");
      const data = await res.json();
      setCompany(data);
    } catch {
      toast.error("Failed to load company details");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    fetchCompany();
  }, [fetchCompany]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/crawl`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Sync failed");
      const data = await res.json();
      toast.success(data.message || "Sync completed");
      fetchCompany();
    } catch {
      toast.error("Failed to start sync");
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <Skeleton className="h-6 w-32" />
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!company) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <Link
          href="/companies"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          Back to Companies
        </Link>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <AlertCircle className="mb-4 size-12 text-muted-foreground/50" />
            <h3 className="text-lg font-semibold">Company not found</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This company may have been removed or the URL is incorrect.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Back Link */}
      <Link
        href="/companies"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-3.5" />
        Back to Companies
      </Link>

      {/* Company Header */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <Building2 className="size-6 text-muted-foreground" />
                <CardTitle className="text-xl">{company.name}</CardTitle>
                {company.atsType && (
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${atsColor(company.atsType)}`}
                  >
                    {company.atsType}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Globe className="size-3.5" />
                  {company.domain}
                </span>
                {company.careersUrl && (
                  <a
                    href={company.careersUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 hover:text-foreground transition-colors"
                  >
                    <ExternalLink className="size-3.5" />
                    Careers Page
                  </a>
                )}
              </div>
            </div>
            <Button onClick={handleSync} disabled={syncing}>
              {syncing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Sync Jobs
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {/* Trust Score */}
          <div className="max-w-xs space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Shield className="size-3.5" />
                Trust Score
              </span>
              <span className="font-medium">
                {Math.round(company.trustScore * 100)}%
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${trustScoreColor(company.trustScore)}`}
                style={{
                  width: `${Math.round(company.trustScore * 100)}%`,
                }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Sources Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LinkIcon className="size-4" />
            Sources
          </CardTitle>
          <CardDescription>
            {company.sources.length} configured job{" "}
            {company.sources.length === 1 ? "source" : "sources"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {company.sources.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No sources configured yet. Run a crawl to discover sources.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Type</th>
                    <th className="pb-2 pr-4 font-medium">URL</th>
                    <th className="pb-2 pr-4 font-medium">Verified</th>
                    <th className="pb-2 pr-4 font-medium">Active</th>
                    <th className="pb-2 font-medium">Last Crawl</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {company.sources.map((source) => (
                    <tr key={source.id}>
                      <td className="py-2.5 pr-4">
                        <Badge variant="outline">{source.type}</Badge>
                      </td>
                      <td className="py-2.5 pr-4">
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors truncate max-w-[250px] inline-block"
                        >
                          {source.url}
                        </a>
                      </td>
                      <td className="py-2.5 pr-4">
                        {source.verified ? (
                          <CheckCircle className="size-4 text-emerald-600" />
                        ) : (
                          <Clock className="size-4 text-muted-foreground" />
                        )}
                      </td>
                      <td className="py-2.5 pr-4">
                        <span
                          className={`inline-block size-2 rounded-full ${
                            source.active ? "bg-emerald-500" : "bg-gray-300"
                          }`}
                        />
                      </td>
                      <td className="py-2.5 text-xs text-muted-foreground">
                        {relativeTime(source.lastCrawlAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Crawls Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4" />
            Recent Crawls
          </CardTitle>
          <CardDescription>
            History of crawl runs for this company
          </CardDescription>
        </CardHeader>
        <CardContent>
          {company.crawlRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No crawl runs yet. Click &quot;Sync Jobs&quot; to start.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Found</th>
                    <th className="pb-2 pr-4 font-medium">New</th>
                    <th className="pb-2 pr-4 font-medium">Updated</th>
                    <th className="pb-2 pr-4 font-medium">Duration</th>
                    <th className="pb-2 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {company.crawlRuns.map((run) => (
                    <tr key={run.id}>
                      <td className="py-2.5 pr-4">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(run.status)}`}
                        >
                          {run.status}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 font-medium">
                        {run.jobsFound}
                      </td>
                      <td className="py-2.5 pr-4 text-emerald-700">
                        +{run.jobsNew}
                      </td>
                      <td className="py-2.5 pr-4 text-amber-700">
                        {run.jobsUpdated}
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-muted-foreground">
                        {formatDuration(run.durationMs)}
                      </td>
                      <td className="py-2.5 text-xs text-muted-foreground">
                        {relativeTime(run.startedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Discoveries Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="size-4" />
            Discoveries
          </CardTitle>
          <CardDescription>
            URLs discovered during crawling
          </CardDescription>
        </CardHeader>
        <CardContent>
          {company.discoveries.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No discoveries yet. Run a crawl to discover job source URLs.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">URL</th>
                    <th className="pb-2 pr-4 font-medium">Method</th>
                    <th className="pb-2 pr-4 font-medium">Confidence</th>
                    <th className="pb-2 pr-4 font-medium">Promoted</th>
                    <th className="pb-2 font-medium">Discovered</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {company.discoveries.map((disc) => (
                    <tr key={disc.id}>
                      <td className="py-2.5 pr-4">
                        <a
                          href={disc.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors truncate max-w-[300px] inline-block"
                        >
                          {disc.url}
                        </a>
                      </td>
                      <td className="py-2.5 pr-4">
                        <Badge variant="outline">{disc.method}</Badge>
                      </td>
                      <td className="py-2.5 pr-4">
                        <span
                          className={`text-xs font-medium ${
                            disc.confidence > 0.7
                              ? "text-emerald-700"
                              : disc.confidence > 0.4
                                ? "text-amber-700"
                                : "text-red-700"
                          }`}
                        >
                          {Math.round(disc.confidence * 100)}%
                        </span>
                      </td>
                      <td className="py-2.5 pr-4">
                        {disc.promoted ? (
                          <CheckCircle className="size-4 text-emerald-600" />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            No
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-xs text-muted-foreground">
                        {relativeTime(disc.discoveredAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
