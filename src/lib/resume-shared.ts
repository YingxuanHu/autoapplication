export type MergeCollectionSummary = {
  added: string[];
  updated: string[];
  duplicates: string[];
  omitted: string[];
};

export type ResumeImportSummary = {
  extractionMode: "text" | "file" | "image" | "pdf_image" | "heuristic";
  model: string;
  overview: {
    headlineFilled: boolean;
    summaryFilled: boolean;
    contactAdded: string[];
    contactPreserved: string[];
  };
  skills: MergeCollectionSummary;
  experiences: MergeCollectionSummary;
  educations: MergeCollectionSummary;
  projects: MergeCollectionSummary;
  warnings: string[];
};

export const supportedResumeAcceptValue =
  ".pdf,.doc,.docx,.txt,.rtf,.png,.jpg,.jpeg,.webp";
