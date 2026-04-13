import type { Region } from "@/generated/prisma/client";

export type GeoScope =
  | "US"
  | "CA"
  | "NORTH_AMERICA"
  | "EUROPE"
  | "LATAM"
  | "APAC"
  | "MIDDLE_EAST_AFRICA"
  | "GLOBAL"
  | "UNKNOWN";

const NORTH_AMERICA_MARKERS = [
  "NORTH AMERICA",
  "AMERICAS",
  "US & CANADA",
  "US/CANADA",
  "US AND CANADA",
  "CANADA / US",
  "CANADA/US",
  "UNITED STATES OR CANADA",
];

const EUROPE_MARKERS = [
  "EUROPE",
  "EU",
  "EUROPEAN UNION",
  "UNITED KINGDOM",
  "UK",
  "IRELAND",
  "GERMANY",
  "FRANCE",
  "NETHERLANDS",
  "BELGIUM",
  "SPAIN",
  "ITALY",
  "POLAND",
  "SWEDEN",
  "DENMARK",
  "NORWAY",
  "FINLAND",
  "PORTUGAL",
  "SWITZERLAND",
  "AUSTRIA",
  "CZECH",
  "ROMANIA",
  "HUNGARY",
  "GREECE",
];

const LATAM_MARKERS = [
  "LATAM",
  "LATIN AMERICA",
  "MEXICO",
  "BRAZIL",
  "ARGENTINA",
  "CHILE",
  "COLOMBIA",
  "PERU",
  "URUGUAY",
  "COSTA RICA",
];

const APAC_MARKERS = [
  "APAC",
  "ASIA PACIFIC",
  "ASIA",
  "AUSTRALIA",
  "NEW ZEALAND",
  "INDIA",
  "JAPAN",
  "SINGAPORE",
  "KOREA",
  "HONG KONG",
  "TAIWAN",
  "PHILIPPINES",
  "MALAYSIA",
  "THAILAND",
  "VIETNAM",
  "INDONESIA",
];

const MEA_MARKERS = [
  "MIDDLE EAST",
  "AFRICA",
  "MEA",
  "EMEA",
  "UAE",
  "UNITED ARAB EMIRATES",
  "SAUDI ARABIA",
  "QATAR",
  "ISRAEL",
  "SOUTH AFRICA",
  "NIGERIA",
  "KENYA",
  "EGYPT",
];

const GLOBAL_MARKERS = [
  "GLOBAL",
  "WORLDWIDE",
  "ANYWHERE",
  "EVERYWHERE",
];

export function inferGeoScope(location: string, region: Region | null): GeoScope {
  if (region === "US") return "US";
  if (region === "CA") return "CA";

  const normalizedLocation = location.toUpperCase();

  if (NORTH_AMERICA_MARKERS.some((marker) => normalizedLocation.includes(marker))) {
    return "NORTH_AMERICA";
  }
  if (GLOBAL_MARKERS.some((marker) => normalizedLocation.includes(marker))) {
    return "GLOBAL";
  }
  if (LATAM_MARKERS.some((marker) => normalizedLocation.includes(marker))) {
    return "LATAM";
  }
  if (APAC_MARKERS.some((marker) => normalizedLocation.includes(marker))) {
    return "APAC";
  }
  if (MEA_MARKERS.some((marker) => normalizedLocation.includes(marker))) {
    return "MIDDLE_EAST_AFRICA";
  }
  if (EUROPE_MARKERS.some((marker) => normalizedLocation.includes(marker))) {
    return "EUROPE";
  }

  return "UNKNOWN";
}

export function formatGeoScopeLabel(scope: GeoScope) {
  switch (scope) {
    case "US":
      return "US";
    case "CA":
      return "Canada";
    case "NORTH_AMERICA":
      return "North America";
    case "EUROPE":
      return "Europe";
    case "LATAM":
      return "Latin America";
    case "APAC":
      return "APAC";
    case "MIDDLE_EAST_AFRICA":
      return "MEA";
    case "GLOBAL":
      return "Global";
    default:
      return "Unknown";
  }
}
