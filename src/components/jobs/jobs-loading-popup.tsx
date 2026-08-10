import { LoadingSpinner } from "@/components/ui/loading-spinner";

type JobsLoadingPopupProps = {
  description?: string;
  label?: string;
};

export function JobsLoadingPopup({
  description = "Updating the job list with your latest search and filters.",
  label = "Loading jobs",
}: JobsLoadingPopupProps) {
  return (
    <div
      aria-live="polite"
      aria-busy="true"
      className="pointer-events-none fixed left-1/2 top-5 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 px-4 sm:top-6"
      role="status"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        <LoadingSpinner className="h-4 w-4 shrink-0 text-primary" />
        <span className="shrink-0">{label}</span>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <span className="hidden truncate text-muted-foreground sm:inline">{description}</span>
        <span className="sr-only">{description}</span>
      </div>
    </div>
  );
}
