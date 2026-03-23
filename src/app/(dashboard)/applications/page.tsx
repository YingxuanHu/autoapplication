"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { FileText, ChevronLeft, ChevronRight } from "lucide-react";

type ApplicationStatus =
  | "PREPARED"
  | "SUBMITTED"
  | "VIEWED"
  | "INTERVIEWING"
  | "OFFER"
  | "REJECTED"
  | "WITHDRAWN";

interface Application {
  id: string;
  status: ApplicationStatus;
  coverLetter: string | null;
  submittedAt: string | null;
  createdAt: string;
  job: {
    id: string;
    title: string;
    company: string;
    location: string | null;
  };
  resume: {
    id: string;
    name: string;
  } | null;
}

interface ApplicationsResponse {
  applications: Application[];
  total: number;
  page: number;
  totalPages: number;
}

const STATUS_COLORS: Record<ApplicationStatus, string> = {
  PREPARED: "bg-gray-100 text-gray-700",
  SUBMITTED: "bg-blue-100 text-blue-700",
  VIEWED: "bg-purple-100 text-purple-700",
  INTERVIEWING: "bg-amber-100 text-amber-700",
  OFFER: "bg-emerald-100 text-emerald-700",
  REJECTED: "bg-red-100 text-red-700",
  WITHDRAWN: "bg-gray-100 text-gray-500",
};

const STATUS_OPTIONS: { value: ApplicationStatus; label: string }[] = [
  { value: "PREPARED", label: "Prepared" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "VIEWED", label: "Viewed" },
  { value: "INTERVIEWING", label: "Interviewing" },
  { value: "OFFER", label: "Offer" },
  { value: "REJECTED", label: "Rejected" },
  { value: "WITHDRAWN", label: "Withdrawn" },
];

const TAB_FILTERS = [
  { value: "ALL", label: "All" },
  { value: "PREPARED", label: "Prepared" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "INTERVIEWING", label: "Interviewing" },
  { value: "OFFER", label: "Offer" },
  { value: "REJECTED", label: "Rejected" },
];

function formatDate(dateStr: string | null) {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ApplicationsPage() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const fetchApplications = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      params.set("page", page.toString());
      params.set("limit", "20");

      const res = await fetch(`/api/applications?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch applications");
      const data: ApplicationsResponse = await res.json();
      setApplications(data.applications);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch {
      toast.error("Failed to load applications");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    fetchApplications();
  }, [fetchApplications]);

  const handleStatusChange = async (
    appId: string,
    newStatus: ApplicationStatus
  ) => {
    setUpdatingId(appId);
    try {
      const res = await fetch(`/api/applications/${appId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error("Failed to update status");
      const updated = await res.json();
      setApplications((prev) =>
        prev.map((a) =>
          a.id === appId ? { ...a, status: updated.status, submittedAt: updated.submittedAt } : a
        )
      );
      toast.success(`Status updated to ${newStatus.toLowerCase()}`);
    } catch {
      toast.error("Failed to update status");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleTabChange = (value: string | number) => {
    setStatusFilter(String(value));
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Applications</h1>
        <p className="text-sm text-muted-foreground">
          Track and manage your job applications
        </p>
      </div>

      <Tabs value={statusFilter} onValueChange={handleTabChange}>
        <TabsList>
          {TAB_FILTERS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={statusFilter} className="mt-4">
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 py-3">
                  <Skeleton className="h-5 w-48" />
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-5 w-24" />
                </div>
              ))}
            </div>
          ) : applications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <FileText className="mb-4 size-12 text-muted-foreground/50" />
              <h3 className="text-lg font-semibold">No applications yet</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Start applying to jobs from the Feed or Jobs page.
              </p>
            </div>
          ) : (
            <>
              <div className="mb-2 text-sm text-muted-foreground">
                {total} application{total !== 1 ? "s" : ""}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job Title</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Resume</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Applied</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {applications.map((app) => (
                    <React.Fragment key={app.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() =>
                          setExpandedId(
                            expandedId === app.id ? null : app.id
                          )
                        }
                      >
                        <TableCell className="font-medium">
                          {app.job.title}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {app.job.company}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {app.resume?.name || "-"}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[app.status]}`}
                          >
                            {app.status}
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDate(app.submittedAt || app.createdAt)}
                        </TableCell>
                        <TableCell
                          className="text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Select
                            value={app.status}
                            onValueChange={(val) =>
                              handleStatusChange(
                                app.id,
                                val as ApplicationStatus
                              )
                            }
                            disabled={updatingId === app.id}
                          >
                            <SelectTrigger className="h-7 w-[130px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {STATUS_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                      {expandedId === app.id && (
                        <TableRow>
                          <TableCell colSpan={6} className="bg-muted/30">
                            <div className="space-y-2 py-2">
                              {app.job.location && (
                                <p className="text-sm">
                                  <span className="font-medium">
                                    Location:
                                  </span>{" "}
                                  {app.job.location}
                                </p>
                              )}
                              {app.coverLetter && (
                                <div>
                                  <span className="text-sm font-medium">
                                    Cover Letter:
                                  </span>
                                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                                    {app.coverLetter}
                                  </p>
                                </div>
                              )}
                              {!app.coverLetter && !app.job.location && (
                                <p className="text-sm text-muted-foreground">
                                  No additional details available.
                                </p>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  ))}
                </TableBody>
              </Table>

              {totalPages > 1 && (
                <div className="mt-4 flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    Page {page} of {totalPages}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      <ChevronLeft className="size-4" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
