import {
  fetchBestFormattedJobDescriptionFromUrls,
  getJobDescriptionCandidateUrls,
  isLowQualityJobDescription,
  isRenderableJobDescription,
  parseJobDescriptionBlocks,
  pickBestFormattedJobDescription,
} from "@/lib/job-description-format";

type JobDescriptionSectionProps = {
  title?: string;
  job: {
    description: string;
    applyUrl: string;
    sourceMappings: Array<{
      sourceUrl: string | null;
      isPrimary: boolean;
    }>;
    primaryExternalLink: { href: string } | null;
    sourcePostingLink: { href: string } | null;
  };
};

export async function JobDescriptionSection({
  title = "Description",
  job,
}: JobDescriptionSectionProps) {
  const candidateUrls = getJobDescriptionCandidateUrls({
    applyUrl: job.applyUrl,
    primaryExternalLink: job.primaryExternalLink,
    sourcePostingLink: job.sourcePostingLink,
    sourceMappings: job.sourceMappings,
  });
  const preferredSourceUrl = candidateUrls[0] ?? null;
  const storedDescriptionLowQuality = isLowQualityJobDescription(job.description);
  const fetchedDescription = storedDescriptionLowQuality
    ? await fetchBestFormattedJobDescriptionFromUrls(candidateUrls, 3)
    : null;
  const displayDescription =
    pickBestFormattedJobDescription([fetchedDescription, job.description]) ?? job.description;
  const descriptionBlocks = parseJobDescriptionBlocks(displayDescription);
  const descriptionUsable = isRenderableJobDescription(displayDescription);
  const sourceAccessFailed =
    storedDescriptionLowQuality && candidateUrls.length > 0 && fetchedDescription === null;

  return (
    <div className="border-t border-border py-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[15px] font-medium text-muted-foreground">{title}</p>
      </div>

      {descriptionUsable ? (
        <div className="mt-4 space-y-4 text-sm text-foreground/85">
          {descriptionBlocks.map((block, index) => {
            if (block.kind === "header") {
              return (
                <p
                  key={index}
                  className="pt-1 text-[12px] font-semibold uppercase tracking-[0.12em] text-foreground/60 first:pt-0"
                >
                  {block.text}
                </p>
              );
            }

            if (block.kind === "list") {
              return (
                <ul key={index} className="ml-5 space-y-2 list-disc marker:text-muted-foreground/60">
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex} className="leading-7">
                      {item}
                    </li>
                  ))}
                </ul>
              );
            }

            return (
              <p key={index} className="leading-7 text-foreground/80">
                {block.text}
              </p>
            );
          })}
        </div>
      ) : (
        <p className="mt-4 text-sm leading-7 text-muted-foreground">
          {sourceAccessFailed
            ? "The original job posting could not be accessed automatically, so a reliable full description is not available yet."
            : "A reliable full job description was not available from the current source."}{" "}
          {preferredSourceUrl ? "Use the original posting link for the full page." : ""}
        </p>
      )}
    </div>
  );
}
