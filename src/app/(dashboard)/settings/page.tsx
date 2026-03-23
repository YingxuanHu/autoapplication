"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { toast } from "sonner";
import { Loader2, Save, Search, ShieldCheck, Zap, User } from "lucide-react";

type AutomationLevel = "DISCOVERY" | "REVIEW_BEFORE_SUBMIT" | "FULL_AUTO";

interface Profile {
  automationLevel: AutomationLevel;
}

const AUTOMATION_OPTIONS: {
  value: AutomationLevel;
  title: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    value: "DISCOVERY",
    title: "Discovery Only",
    description:
      "Find jobs and present them. You decide everything.",
    icon: <Search className="size-6" />,
  },
  {
    value: "REVIEW_BEFORE_SUBMIT",
    title: "Review Before Submit",
    description:
      "Prepare application packages automatically. You approve before sending.",
    icon: <ShieldCheck className="size-6" />,
  },
  {
    value: "FULL_AUTO",
    title: "Full Auto-Apply",
    description:
      "Automatically submit applications for high-match jobs.",
    icon: <Zap className="size-6" />,
  },
];

export default function SettingsPage() {
  const { data: session } = useSession();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [automationLevel, setAutomationLevel] =
    useState<AutomationLevel>("DISCOVERY");

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/profile");
      if (!res.ok) throw new Error("Failed to fetch profile");
      const data: Profile = await res.json();
      setAutomationLevel(data.automationLevel);
    } catch {
      toast.error("Failed to load settings");
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
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automationLevel }),
      });
      if (!res.ok) throw new Error("Failed to save settings");
      toast.success("Settings saved!");
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <Skeleton className="h-8 w-32" />
        <div className="grid gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure your automation and account settings
        </p>
      </div>

      {/* Automation Level */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Automation Level</h2>
          <p className="text-sm text-muted-foreground">
            Choose how much AutoApplication does for you
          </p>
        </div>

        <div className="grid gap-3">
          {AUTOMATION_OPTIONS.map((option) => {
            const selected = automationLevel === option.value;
            return (
              <Card
                key={option.value}
                className={`cursor-pointer transition-all ${
                  selected
                    ? "ring-2 ring-primary"
                    : "hover:ring-1 hover:ring-muted-foreground/20"
                }`}
                onClick={() => setAutomationLevel(option.value)}
              >
                <CardContent className="flex items-start gap-4 py-4">
                  <div
                    className={`flex size-12 shrink-0 items-center justify-center rounded-lg ${
                      selected
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {option.icon}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium">{option.title}</h3>
                      {selected && (
                        <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">
                          Active
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {option.description}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center">
                    <div
                      className={`size-5 rounded-full border-2 transition-colors ${
                        selected
                          ? "border-primary bg-primary"
                          : "border-muted-foreground/30"
                      }`}
                    >
                      {selected && (
                        <div className="flex size-full items-center justify-center">
                          <div className="size-2 rounded-full bg-primary-foreground" />
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save Settings
          </Button>
        </div>
      </section>

      <Separator />

      {/* Account Section */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Account</h2>
          <p className="text-sm text-muted-foreground">
            Your account information
          </p>
        </div>

        <Card>
          <CardContent className="flex items-center gap-4 py-4">
            <div className="flex size-10 items-center justify-center rounded-full bg-muted">
              <User className="size-5 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">
                {session?.user?.name || "User"}
              </p>
              <p className="text-sm text-muted-foreground">
                {session?.user?.email || "No email"}
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <SignOutButton variant="outline" />
        </div>
      </section>
    </div>
  );
}
