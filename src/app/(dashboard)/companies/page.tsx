"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Building2,
  Search,
  RefreshCw,
  ExternalLink,
  CheckCircle,
  AlertCircle,
  Clock,
  Globe,
  Shield,
  Plus,
  Loader2,
  Activity,
} from "lucide-react";

interface Company {
  id: string;
  name: string;
  domain: string;
  careersUrl: string | null;
  atsType: string | null;
  trustScore: number;
  crawlStatus: string;
  activeSourceCount: number;
  lastSyncedAt: string | null;
}

interface CompaniesResponse {
  companies: Company[];
  total: number;
  page: number;
  pageSize: number;
}

interface SyncStatusResponse {
  worker: {
    isRunning: boolean;
    successRate: number;
  };
  queue: {
    depth: number;
    running: number;
    completed: number;
    failed: number;
  };
  scheduledCompanies: number;
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

function crawlStatusBadge(status: string) {
  switch (status) {
    case "SUCCESS":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
          <CheckCircle className="size-3" />
          Synced
        </span>
      );
    case "CRAWLING":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-blue-700">
          <RefreshCw className="size-3 animate-spin" />
          Crawling
        </span>
      );
    case "FAILED":
    case "BLOCKED":
    case "RATE_LIMITED":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-red-700">
          <AlertCircle className="size-3" />
          Failed
        </span>
      );
    case "PENDING":
    default:
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="size-3" />
          Pending
        </span>
      );
  }
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

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [crawlingId, setCrawlingId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
  const autoSyncStartedRef = useRef(false);
  const pageSize = 12;

  const fetchCompanies = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
      });
      if (search) params.set("search", search);
      const res = await fetch(`/api/companies?${params}`);
      if (!res.ok) throw new Error("Failed to fetch companies");
      const data: CompaniesResponse = await res.json();
      setCompanies(data.companies);
      setTotal(data.total);
    } catch {
      toast.error("Failed to load companies");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    fetchCompanies();
  }, [fetchCompanies]);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/companies/sync");
      if (!res.ok) throw new Error("Failed to fetch sync status");
      const data: SyncStatusResponse = await res.json();
      setSyncStatus(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  const handleSyncAll = useCallback(
    async (silent = false) => {
      setSyncingAll(true);
      try {
        const res = await fetch("/api/companies/sync", {
          method: "POST",
        });
        if (!res.ok) throw new Error("Bulk sync failed");
        const data = await res.json();
        setSyncStatus((current) => ({
          worker: data.worker,
          queue: data.queue,
          scheduledCompanies: current?.scheduledCompanies ?? 0,
        }));
        if (!silent) {
          toast.success(
            data.message || `Queued ${data.enqueued ?? 0} companies for refresh`,
          );
        }
      } catch {
        if (!silent) {
          toast.error("Failed to start company sync");
        }
      } finally {
        setSyncingAll(false);
      }
    },
    [],
  );

  useEffect(() => {
    void fetchSyncStatus();
  }, [fetchSyncStatus]);

  useEffect(() => {
    if (autoSyncStartedRef.current) return;
    autoSyncStartedRef.current = true;
    void handleSyncAll(true);
  }, [handleSyncAll]);

  useEffect(() => {
    const interval = setInterval(async () => {
      const status = await fetchSyncStatus();
      if (
        status &&
        (status.queue.depth > 0 || status.queue.running > 0 || status.worker.isRunning)
      ) {
        void fetchCompanies();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchCompanies, fetchSyncStatus]);

  const handleCrawl = async (companyId: string) => {
    setCrawlingId(companyId);
    try {
      const res = await fetch(`/api/companies/${companyId}/crawl`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Crawl failed");
      const data = await res.json();
      toast.success(data.message || "Crawl completed");
      fetchCompanies();
    } catch {
      toast.error("Failed to start crawl");
    } finally {
      setCrawlingId(null);
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Company Sources
          </h1>
          <p className="text-sm text-muted-foreground">
            Discover and manage company career pages
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => void handleSyncAll()}
            disabled={syncingAll}
          >
            {syncingAll ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Sync Due Companies
          </Button>
          <Link href="/companies/add">
            <Button>
              <Plus className="size-4" />
              Add Company
            </Button>
          </Link>
        </div>
      </div>

      {syncStatus && (
        <Card>
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm">
              <Activity className="size-4 text-muted-foreground" />
              <span className="font-medium">Background refresh</span>
              <span className="text-muted-foreground">
                {syncStatus.queue.running} running, {syncStatus.queue.depth} queued,{" "}
                {syncStatus.queue.completed} completed
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {syncStatus.scheduledCompanies} companies scheduled
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search companies by name or domain..."
          className="pl-9"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-3 w-2/3" />
                <div className="flex gap-2">
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-5 w-16" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : companies.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Building2 className="mb-4 size-12 text-muted-foreground/50" />
            <h3 className="text-lg font-semibold">No companies yet</h3>
            <p className="mt-2 max-w-xs text-sm text-muted-foreground">
              Add a company domain to start discovering jobs.
            </p>
            <Link href="/companies/add">
              <Button variant="outline" className="mt-4">
                <Plus className="size-4" />
                Add Company
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {companies.map((company) => (
            <Card key={company.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <CardTitle className="truncate">
                      {company.name}
                    </CardTitle>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Globe className="size-3 shrink-0" />
                      <span className="truncate">{company.domain}</span>
                    </div>
                  </div>
                  {company.atsType && (
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${atsColor(company.atsType)}`}
                    >
                      {company.atsType}
                    </span>
                  )}
                </div>
              </CardHeader>

              <CardContent className="flex-1 space-y-3">
                {/* Trust Score */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <Shield className="size-3" />
                      Trust Score
                    </span>
                    <span className="font-medium">
                      {Math.round(company.trustScore * 100)}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full transition-all ${trustScoreColor(company.trustScore)}`}
                      style={{
                        width: `${Math.round(company.trustScore * 100)}%`,
                      }}
                    />
                  </div>
                </div>

                {/* Status row */}
                <div className="flex items-center justify-between">
                  {crawlStatusBadge(company.crawlStatus)}
                  <span className="text-xs text-muted-foreground">
                    {company.activeSourceCount} active{" "}
                    {company.activeSourceCount === 1 ? "source" : "sources"}
                  </span>
                </div>

                {/* Last synced */}
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="size-3" />
                  Last synced: {relativeTime(company.lastSyncedAt)}
                </div>
              </CardContent>

              <CardFooter className="gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleCrawl(company.id)}
                  disabled={crawlingId === company.id}
                >
                  {crawlingId === company.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  Crawl
                </Button>
                <Link href={`/companies/${company.id}`} className="ml-auto">
                  <Button variant="ghost" size="sm">
                    View
                    <ExternalLink className="size-3.5" />
                  </Button>
                </Link>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
