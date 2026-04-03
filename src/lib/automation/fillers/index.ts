import type { ATSFiller } from "../types";
import { greenhouseFiller } from "./greenhouse";
import { leverFiller } from "./lever";
import { ashbyFiller } from "./ashby";

/**
 * All registered ATS fillers, checked in order.
 * Add new fillers here as they're implemented.
 */
const ALL_FILLERS: ATSFiller[] = [
  greenhouseFiller,
  leverFiller,
  ashbyFiller,
];

/**
 * Find the right filler for a given apply URL.
 * Returns null if no filler can handle this URL.
 */
export function resolveATSFiller(applyUrl: string): ATSFiller | null {
  for (const filler of ALL_FILLERS) {
    if (filler.urlPattern.test(applyUrl)) {
      return filler;
    }
  }
  return null;
}

/**
 * Check if a URL is handleable by any registered filler.
 */
export function canAutomate(applyUrl: string): boolean {
  return resolveATSFiller(applyUrl) !== null;
}

/**
 * Get list of supported ATS names for display.
 */
export function getSupportedATSNames(): string[] {
  return ALL_FILLERS.map((f) => f.atsName);
}
