"use client";

import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Loader2, X, Save } from "lucide-react";

interface Profile {
  id: string;
  jobTitles: string[];
  jobAreas: string[];
  locations: string[];
  workModes: string[];
  experienceLevel: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  excludeCompanies: string[];
  excludeKeywords: string[];
}

const WORK_MODES = [
  { value: "REMOTE", label: "Remote" },
  { value: "HYBRID", label: "Hybrid" },
  { value: "ONSITE", label: "Onsite" },
];

const EXPERIENCE_LEVELS = [
  { value: "ENTRY", label: "Entry Level" },
  { value: "MID", label: "Mid Level" },
  { value: "SENIOR", label: "Senior" },
  { value: "LEAD", label: "Lead" },
  { value: "EXECUTIVE", label: "Executive" },
];

function TagInput({
  tags,
  onChange,
  placeholder,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder: string;
}) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const trimmed = input.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInput("");
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    } else if (e.key === "Backspace" && !input && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className="gap-1 pr-1"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="rounded-full p-0.5 hover:bg-muted-foreground/20"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
      </div>
      <Input
        placeholder={placeholder}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={addTag}
      />
      <p className="text-xs text-muted-foreground">
        Type and press Enter to add
      </p>
    </div>
  );
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form state
  const [jobTitles, setJobTitles] = useState<string[]>([]);
  const [jobAreas, setJobAreas] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [workModes, setWorkModes] = useState<string[]>([]);
  const [experienceLevel, setExperienceLevel] = useState("");
  const [salaryMin, setSalaryMin] = useState("");
  const [salaryMax, setSalaryMax] = useState("");
  const [excludeCompanies, setExcludeCompanies] = useState<string[]>([]);
  const [excludeKeywords, setExcludeKeywords] = useState<string[]>([]);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/profile");
      if (!res.ok) throw new Error("Failed to fetch profile");
      const data: Profile = await res.json();
      setProfile(data);
      setJobTitles(data.jobTitles);
      setJobAreas(data.jobAreas);
      setLocations(data.locations);
      setWorkModes(data.workModes);
      setExperienceLevel(data.experienceLevel || "");
      setSalaryMin(data.salaryMin?.toString() || "");
      setSalaryMax(data.salaryMax?.toString() || "");
      setExcludeCompanies(data.excludeCompanies);
      setExcludeKeywords(data.excludeKeywords);
    } catch {
      toast.error("Failed to load profile");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        jobTitles,
        jobAreas,
        locations,
        workModes,
        excludeCompanies,
        excludeKeywords,
      };
      if (experienceLevel) body.experienceLevel = experienceLevel;
      if (salaryMin) body.salaryMin = parseInt(salaryMin, 10);
      if (salaryMax) body.salaryMax = parseInt(salaryMax, 10);

      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to save profile");
      toast.success("Preferences saved!");
    } catch {
      toast.error("Failed to save preferences");
    } finally {
      setSaving(false);
    }
  };

  const toggleWorkMode = (mode: string, checked: boolean) => {
    if (checked) {
      setWorkModes((prev) => [...prev, mode]);
    } else {
      setWorkModes((prev) => prev.filter((m) => m !== mode));
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-32" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-10 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Preferences</h1>
          <p className="text-sm text-muted-foreground">
            Configure your job search preferences
          </p>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Save Changes
        </Button>
      </div>

      {/* Job Titles */}
      <Card>
        <CardHeader>
          <CardTitle>Job Titles</CardTitle>
          <CardDescription>
            What job titles are you looking for?
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TagInput
            tags={jobTitles}
            onChange={setJobTitles}
            placeholder="e.g. Software Engineer"
          />
        </CardContent>
      </Card>

      {/* Job Areas */}
      <Card>
        <CardHeader>
          <CardTitle>Job Areas</CardTitle>
          <CardDescription>
            What areas or industries interest you?
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TagInput
            tags={jobAreas}
            onChange={setJobAreas}
            placeholder="e.g. Frontend, Machine Learning"
          />
        </CardContent>
      </Card>

      {/* Locations */}
      <Card>
        <CardHeader>
          <CardTitle>Locations</CardTitle>
          <CardDescription>
            Preferred work locations
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TagInput
            tags={locations}
            onChange={setLocations}
            placeholder="e.g. San Francisco, New York"
          />
        </CardContent>
      </Card>

      {/* Work Modes */}
      <Card>
        <CardHeader>
          <CardTitle>Work Modes</CardTitle>
          <CardDescription>
            Select your preferred work arrangements
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            {WORK_MODES.map((mode) => (
              <label
                key={mode.value}
                className="flex cursor-pointer items-center gap-2"
              >
                <Checkbox
                  checked={workModes.includes(mode.value)}
                  onCheckedChange={(checked: boolean) =>
                    toggleWorkMode(mode.value, checked)
                  }
                />
                <span className="text-sm font-medium">{mode.label}</span>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Experience Level */}
      <Card>
        <CardHeader>
          <CardTitle>Experience Level</CardTitle>
          <CardDescription>
            Your current career level
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={experienceLevel} onValueChange={(val) => setExperienceLevel(val ?? "")}>
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder="Select level" />
            </SelectTrigger>
            <SelectContent>
              {EXPERIENCE_LEVELS.map((level) => (
                <SelectItem key={level.value} value={level.value}>
                  {level.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Salary Range */}
      <Card>
        <CardHeader>
          <CardTitle>Salary Range</CardTitle>
          <CardDescription>
            Your target salary range (annual, USD)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Minimum</Label>
              <Input
                type="number"
                placeholder="e.g. 80000"
                value={salaryMin}
                onChange={(e) => setSalaryMin(e.target.value)}
              />
            </div>
            <span className="mt-5 text-muted-foreground">to</span>
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Maximum</Label>
              <Input
                type="number"
                placeholder="e.g. 150000"
                value={salaryMax}
                onChange={(e) => setSalaryMax(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Excluded Companies */}
      <Card>
        <CardHeader>
          <CardTitle>Excluded Companies</CardTitle>
          <CardDescription>
            Companies you do not want to see in your feed
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TagInput
            tags={excludeCompanies}
            onChange={setExcludeCompanies}
            placeholder="e.g. Acme Corp"
          />
        </CardContent>
      </Card>

      {/* Excluded Keywords */}
      <Card>
        <CardHeader>
          <CardTitle>Excluded Keywords</CardTitle>
          <CardDescription>
            Keywords to filter out from job listings
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TagInput
            tags={excludeKeywords}
            onChange={setExcludeKeywords}
            placeholder="e.g. internship, unpaid"
          />
        </CardContent>
      </Card>

      {/* Bottom save button */}
      <div className="flex justify-end pb-4">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Save Changes
        </Button>
      </div>
    </div>
  );
}
