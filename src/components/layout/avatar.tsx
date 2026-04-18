import { cn } from "@/lib/utils";

const SIZE_CLASS = {
  sm: "h-7 w-7 text-[11px]",
  md: "h-9 w-9 text-sm",
  lg: "h-12 w-12 text-base",
} as const;

type AvatarSize = keyof typeof SIZE_CLASS;

function initialsFrom(name: string | null | undefined, email?: string | null) {
  const source = (name ?? "").trim() || (email ?? "").trim();
  if (!source) return "?";

  // Email: first letter
  if (!name?.trim() && email) {
    return email.trim().charAt(0).toUpperCase();
  }

  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].charAt(0).toUpperCase();
  }
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

export function Avatar({
  name,
  email,
  image,
  size = "md",
  className,
}: {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  const initials = initialsFrom(name, email);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-foreground font-semibold text-background",
        SIZE_CLASS[size],
        className
      )}
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          className="h-full w-full object-cover"
          src={image}
        />
      ) : (
        <span className="select-none">{initials}</span>
      )}
    </span>
  );
}
