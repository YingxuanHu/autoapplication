"use client";

import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SignOutButtonProps {
  className?: string;
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  fullWidth?: boolean;
  label?: string;
}

export function SignOutButton({
  className,
  variant = "outline",
  fullWidth = false,
  label = "Sign Out",
}: SignOutButtonProps) {
  return (
    <Button
      type="button"
      variant={variant}
      className={className}
      onClick={() => signOut({ callbackUrl: "/login" })}
    >
      <LogOut className="size-4" />
      <span className={fullWidth ? "flex-1 text-left" : ""}>{label}</span>
    </Button>
  );
}
