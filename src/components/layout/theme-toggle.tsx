"use client";

import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
  const selectedTheme =
    mounted && (theme === "light" || theme === "dark" || theme === "system")
      ? theme
      : "system";
  const selectedIndex = THEME_OPTIONS.findIndex(
    (option) => option.value === selectedTheme
  );

  return (
    <div
      aria-label="Theme"
      className="relative grid w-full max-w-sm grid-cols-3 rounded-2xl border border-border/70 bg-background/70 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
      role="radiogroup"
    >
      <div
        aria-hidden="true"
        className="absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/3)] rounded-xl bg-foreground shadow-sm transition-transform duration-200 ease-out"
        style={{ transform: `translateX(${selectedIndex * 100}%)` }}
      />
      {THEME_OPTIONS.map((option) => {
        const Icon = option.icon;
        const isActive = option.value === selectedTheme;

        return (
          <button
            aria-checked={isActive}
            className={cn(
              "relative z-10 inline-flex h-10 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium transition-colors",
              isActive ? "text-background" : "text-muted-foreground hover:text-foreground"
            )}
            key={option.value}
            onClick={() => setTheme(option.value)}
            role="radio"
            type="button"
          >
            <Icon className="h-4 w-4" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
