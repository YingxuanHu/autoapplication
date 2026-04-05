"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

type FileInputProps = Omit<React.ComponentProps<"input">, "type"> & {
  buttonLabel?: string;
};

function FileInput({
  buttonLabel = "Choose file",
  className,
  multiple,
  onChange,
  ...props
}: FileInputProps) {
  const [fileLabel, setFileLabel] = React.useState("");

  return (
    <div
      className={cn(
        "relative flex h-9 w-full items-center gap-3 overflow-hidden rounded-lg border border-input/80 bg-background/70 px-2.5 text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 dark:bg-background/50",
        className
      )}
    >
      <span className="inline-flex h-6 shrink-0 items-center rounded-md border border-border/70 bg-muted px-3 text-xs font-medium text-foreground">
        {buttonLabel}
      </span>
      <span className={cn("min-w-0 truncate text-sm", fileLabel ? "text-foreground" : "text-muted-foreground")}>
        {fileLabel || "No file chosen"}
      </span>
      <input
        {...props}
        className="absolute inset-0 cursor-pointer opacity-0"
        multiple={multiple}
        onChange={(event) => {
          const files = event.target.files;
          if (!files || files.length === 0) {
            setFileLabel("");
          } else if (multiple && files.length > 1) {
            setFileLabel(`${files.length} files selected`);
          } else {
            setFileLabel(files[0]?.name ?? "");
          }
          onChange?.(event);
        }}
        type="file"
      />
    </div>
  );
}

export { FileInput };
