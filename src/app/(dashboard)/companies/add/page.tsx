"use client";

import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  ArrowLeft,
  Globe,
  Loader2,
  CheckCircle,
  AlertCircle,
  Search,
  List,
} from "lucide-react";

interface DiscoveryResult {
  domain: string;
  status: "success" | "error" | "pending";
  atsType: string | null;
  careersUrl: string | null;
  sourcesFound: number;
  companyName: string | null;
  error?: string;
}

type Mode = "single" | "bulk";

export default function AddCompanyPage() {
  const [mode, setMode] = useState<Mode>("single");
  const [singleDomain, setSingleDomain] = useState("");
  const [bulkDomains, setBulkDomains] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [importingStarterList, setImportingStarterList] = useState(false);
  const [results, setResults] = useState<DiscoveryResult[]>([]);

  const handleImportStarterList = async () => {
    setImportingStarterList(true);
    try {
      const importRes = await fetch("/api/admin/companies/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset: "ALL" }),
      });
      if (!importRes.ok) throw new Error("Import failed");
      const importData = await importRes.json();

      const syncRes = await fetch("/api/companies/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const syncData = syncRes.ok ? await syncRes.json() : null;

      toast.success(
        `Imported ${importData.summary.created} companies, added ${importData.summary.sourcesCreated} verified sources${
          syncData ? `, queued ${syncData.enqueued} companies for sync` : ""
        }`,
      );
    } catch {
      toast.error("Failed to import starter list");
    } finally {
      setImportingStarterList(false);
    }
  };

  const handleDiscoverSingle = async () => {
    const domain = singleDomain.trim();
    if (!domain) {
      toast.error("Please enter a domain");
      return;
    }

    setDiscovering(true);
    setResults([{ domain, status: "pending", atsType: null, careersUrl: null, sourcesFound: 0, companyName: null }]);

    try {
      const res = await fetch("/api/companies/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: [domain] }),
      });
      if (!res.ok) throw new Error("Discovery failed");
      const data = await res.json();
      setResults(
        data.results.map((r: DiscoveryResult) => ({
          ...r,
          status: r.error ? "error" : "success",
        }))
      );
      toast.success("Discovery complete");
    } catch {
      setResults([
        {
          domain,
          status: "error",
          atsType: null,
          careersUrl: null,
          sourcesFound: 0,
          companyName: null,
          error: "Failed to discover company",
        },
      ]);
      toast.error("Discovery failed");
    } finally {
      setDiscovering(false);
    }
  };

  const handleDiscoverBulk = async () => {
    const domains = bulkDomains
      .split("\n")
      .map((d) => d.trim())
      .filter(Boolean);
    if (domains.length === 0) {
      toast.error("Please enter at least one domain");
      return;
    }

    setDiscovering(true);
    setResults(
      domains.map((domain) => ({
        domain,
        status: "pending" as const,
        atsType: null,
        careersUrl: null,
        sourcesFound: 0,
        companyName: null,
      }))
    );

    try {
      const res = await fetch("/api/companies/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains }),
      });
      if (!res.ok) throw new Error("Discovery failed");
      const data = await res.json();
      setResults(
        data.results.map((r: DiscoveryResult) => ({
          ...r,
          status: r.error ? "error" : "success",
        }))
      );
      toast.success(`Discovered ${data.results.length} companies`);
    } catch {
      toast.error("Bulk discovery failed");
    } finally {
      setDiscovering(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Header */}
      <div>
        <Link
          href="/companies"
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          Back to Companies
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Add Company</h1>
        <p className="text-sm text-muted-foreground">
          Enter a company domain to discover their career pages and job sources.
        </p>
      </div>

      {/* Mode Toggle */}
      <div className="flex gap-2">
        <Button
          variant={mode === "single" ? "default" : "outline"}
          size="sm"
          onClick={() => setMode("single")}
        >
          <Search className="size-3.5" />
          Single Domain
        </Button>
        <Button
          variant={mode === "bulk" ? "default" : "outline"}
          size="sm"
          onClick={() => setMode("bulk")}
        >
          <List className="size-3.5" />
          Bulk Import
        </Button>
      </div>

      {/* Input */}
      <Card>
        <CardHeader>
          <CardTitle>
            {mode === "single" ? "Discover Company" : "Bulk Discovery"}
          </CardTitle>
          <CardDescription>
            {mode === "single"
              ? "Enter a company domain to detect their ATS and job listings."
              : "Enter multiple domains, one per line, to discover in bulk."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {mode === "single" ? (
            <div className="space-y-2">
              <Label htmlFor="domain">Company Domain</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Globe className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="domain"
                    placeholder="e.g., stripe.com"
                    className="pl-9"
                    value={singleDomain}
                    onChange={(e) => setSingleDomain(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleDiscoverSingle();
                    }}
                    disabled={discovering}
                  />
                </div>
                <Button onClick={handleDiscoverSingle} disabled={discovering}>
                  {discovering ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Search className="size-4" />
                  )}
                  Discover
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="bulk-domains">Company Domains</Label>
              <Textarea
                id="bulk-domains"
                placeholder={"stripe.com\ngithub.com\nlinear.app\nvercel.com"}
                rows={6}
                value={bulkDomains}
                onChange={(e) => setBulkDomains(e.target.value)}
                disabled={discovering}
              />
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  One domain per line
                </p>
                <Button onClick={handleDiscoverBulk} disabled={discovering}>
                  {discovering ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Search className="size-4" />
                  )}
                  Discover All
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Verified Starter List</CardTitle>
          <CardDescription>
            Import the built-in direct-source company catalog so you can start
            with a much larger job surface area immediately.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">53 companies</Badge>
              <Badge variant="secondary">Verified ATS sources</Badge>
              <Badge variant="secondary">Bulk sync ready</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Includes FAANG, unicorns, YC companies, and remote-first teams.
            </p>
          </div>
          <Button onClick={handleImportStarterList} disabled={importingStarterList}>
            {importingStarterList ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <List className="size-4" />
            )}
            Import Starter List
          </Button>
        </CardContent>
      </Card>

      {/* Results */}
      {results.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Discovery Results</CardTitle>
            <CardDescription>
              {results.filter((r) => r.status === "success").length} of{" "}
              {results.length} discovered successfully
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {results.map((result) => (
                <div
                  key={result.domain}
                  className="flex items-center gap-4 py-3 first:pt-0 last:pb-0"
                >
                  {/* Status Icon */}
                  <div className="shrink-0">
                    {result.status === "pending" && (
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    )}
                    {result.status === "success" && (
                      <CheckCircle className="size-5 text-emerald-600" />
                    )}
                    {result.status === "error" && (
                      <AlertCircle className="size-5 text-red-500" />
                    )}
                  </div>

                  {/* Details */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {result.companyName || result.domain}
                      </span>
                      {result.companyName && (
                        <span className="text-xs text-muted-foreground truncate">
                          {result.domain}
                        </span>
                      )}
                    </div>

                    {result.status === "success" && (
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        {result.atsType && (
                          <Badge variant="secondary">{result.atsType}</Badge>
                        )}
                        {result.careersUrl && (
                          <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {result.careersUrl}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {result.sourcesFound}{" "}
                          {result.sourcesFound === 1 ? "source" : "sources"}{" "}
                          found
                        </span>
                      </div>
                    )}

                    {result.status === "error" && result.error && (
                      <p className="mt-1 text-xs text-red-600">
                        {result.error}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
