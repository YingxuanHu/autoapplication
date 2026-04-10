import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  createAdzunaConnector,
  createAshbyConnector,
  createGreenhouseConnector,
  createHimalayasConnector,
  createIcimsConnector,
  createJobicyConnector,
  createLeverConnector,
  createMuseConnector,
  createRemotiveConnector,
  createRecruiteeConnector,
  createRemoteOkConnector,
  createRipplingConnector,
  createSuccessFactorsConnector,
  createSmartRecruitersConnector,
  createTaleoConnector,
  createUsaJobsConnector,
  createWorkdayConnector,
  createWorkableConnector,
  createJobBankConnector,
} from "@/lib/ingestion/connectors";
import {
  ASHBY_DEFAULT_ORG_TOKENS,
  GREENHOUSE_DEFAULT_BOARD_TOKENS,
  LEVER_DEFAULT_SITE_TOKENS,
  RECRUITEE_DEFAULT_COMPANY_TOKENS,
  RIPPLING_DEFAULT_BOARD_TOKENS,
  SMARTRECRUITERS_DEFAULT_COMPANY_TOKENS,
  TALEO_DEFAULT_SOURCE_TOKENS,
  WORKABLE_DEFAULT_ACCOUNT_TOKENS,
} from "@/lib/ingestion/coverage";
import type { SourceConnector } from "@/lib/ingestion/types";

export type SupportedConnectorName =
  | "adzuna"
  | "ashby"
  | "greenhouse"
  | "himalayas"
  | "icims"
  | "jobicy"
  | "lever"
  | "remotive"
  | "themuse"
  | "recruitee"
  | "remoteok"
  | "rippling"
  | "successfactors"
  | "smartrecruiters"
  | "taleo"
  | "usajobs"
  | "workday"
  | "workable"
  | "jobbank";

export type ConnectorResolutionArgs = {
  board?: string;
  boards?: string;
  org?: string;
  orgs?: string;
  site?: string;
  sites?: string;
  company?: string;
  companies?: string;
  domain?: string;
  domains?: string;
  source?: string;
  sources?: string;
  account?: string;
  accounts?: string;
};

export type ScheduledConnectorDefinition = {
  cadenceMinutes: number;
  connector: SourceConnector;
};

type DiscoveryStore = {
  entries?: Array<{
    connectorName?: SupportedConnectorName;
    token?: string;
    status?: "pending" | "rejected" | "promoted";
  }>;
};

// ─── Defaults ─────────────────────────────────────────────────────────────────
// Comma-separated board/site/org tokens. Override via env vars for production.

const DEFAULT_GREENHOUSE_BOARDS = GREENHOUSE_DEFAULT_BOARD_TOKENS.join(",");

const DEFAULT_LEVER_SITES = LEVER_DEFAULT_SITE_TOKENS.join(",");

const DEFAULT_RECRUITEE_COMPANIES = RECRUITEE_DEFAULT_COMPANY_TOKENS.join(",");

const DEFAULT_RIPPLING_BOARDS = RIPPLING_DEFAULT_BOARD_TOKENS.join(",");

const DEFAULT_ASHBY_ORGS = ASHBY_DEFAULT_ORG_TOKENS.join(",");

const DEFAULT_TALEO_SOURCES = TALEO_DEFAULT_SOURCE_TOKENS.join(",");

const DISCOVERY_STORE_PATH = path.resolve(
  process.cwd(),
  "data/discovery/source-candidates.json"
);

// ─── Resolver ────────────────────────────────────────────────────────────────

export function resolveConnectors(
  connectorName: SupportedConnectorName,
  args: ConnectorResolutionArgs
): SourceConnector[] {
  if (connectorName === "adzuna") {
    const countries = resolveTokens(
      args.sources ?? args.source ?? process.env.ADZUNA_COUNTRIES ?? "ca,us"
    );
    return countries.map((token) => {
      const [country, profile] = token.split(":");
      return createAdzunaConnector({ country, profile });
    });
  }

  if (connectorName === "himalayas") {
    const profiles = resolveTokens(
      args.sources ?? args.source ?? process.env.HIMALAYAS_SOURCES ?? "global"
    );
    return profiles.map((profile) => createHimalayasConnector({ profile }));
  }

  if (connectorName === "jobicy") {
    return [createJobicyConnector()];
  }

  if (connectorName === "remotive") {
    return [createRemotiveConnector()];
  }

  if (connectorName === "themuse") {
    return [createMuseConnector()];
  }

  if (connectorName === "remoteok") {
    return [createRemoteOkConnector()];
  }

  if (connectorName === "usajobs") {
    const keywords = resolveTokens(
      args.sources ?? args.source ?? process.env.USAJOBS_KEYWORDS ?? ""
    );
    if (keywords.length === 0) {
      // Single broad connector
      return [createUsaJobsConnector()];
    }
    return keywords.map((keyword) => createUsaJobsConnector({ keyword }));
  }

  if (connectorName === "ashby") {
    const orgTokens = resolveTokens(
      args.orgs ?? args.org ?? process.env.ASHBY_ORG_TOKENS ?? DEFAULT_ASHBY_ORGS
    );

    if (orgTokens.length === 0) {
      throw new Error(
        "No Ashby orgs configured. Pass --org=notion or set ASHBY_ORG_TOKENS."
      );
    }

    return orgTokens.map((orgSlug) => createAshbyConnector({ orgSlug }));
  }

  if (connectorName === "greenhouse") {
    const boardTokens = resolveTokens(
      args.boards ??
        args.board ??
        process.env.GREENHOUSE_BOARD_TOKENS ??
        DEFAULT_GREENHOUSE_BOARDS
    );

    if (boardTokens.length === 0) {
      throw new Error(
        "No Greenhouse boards configured. Pass --board=vercel or set GREENHOUSE_BOARD_TOKENS."
      );
    }

    return boardTokens.map((boardToken) => createGreenhouseConnector({ boardToken }));
  }

  if (connectorName === "lever") {
    const siteTokens = resolveTokens(
      args.sites ??
        args.site ??
        process.env.LEVER_SITE_TOKENS ??
        DEFAULT_LEVER_SITES
    );

    if (siteTokens.length === 0) {
      throw new Error(
        "No Lever sites configured. Pass --site=plaid or set LEVER_SITE_TOKENS."
      );
    }

    return siteTokens.map((siteToken) => createLeverConnector({ siteToken }));
  }

  if (connectorName === "recruitee") {
    const companyTokens = resolveTokens(
      args.companies ??
        args.company ??
        process.env.RECRUITEE_COMPANY_TOKENS ??
        DEFAULT_RECRUITEE_COMPANIES
    );

    if (companyTokens.length === 0) {
      throw new Error(
        "No Recruitee companies configured. Pass --company=deephealth or set RECRUITEE_COMPANY_TOKENS."
      );
    }

    return companyTokens.map((companyIdentifier) =>
      createRecruiteeConnector({ companyIdentifier })
    );
  }

  if (connectorName === "rippling") {
    const boardTokens = resolveTokens(
      args.boards ??
        args.board ??
        process.env.RIPPLING_BOARD_TOKENS ??
        DEFAULT_RIPPLING_BOARDS
    );

    if (boardTokens.length === 0) {
      throw new Error(
        "No Rippling boards configured. Pass --board=rippling or set RIPPLING_BOARD_TOKENS."
      );
    }

    return boardTokens.map((boardSlug) => createRipplingConnector({ boardSlug }));
  }

  if (connectorName === "successfactors") {
    const domainTokens = resolveTokens(
      args.domains ??
        args.domain ??
        process.env.SUCCESSFACTORS_DOMAIN_TOKENS ??
        ""
    );

    if (domainTokens.length === 0) {
      throw new Error(
        "No SuccessFactors domains configured. Pass --domain=jobs.sap.com or set SUCCESSFACTORS_DOMAIN_TOKENS."
      );
    }

    return domainTokens.map((sourceToken) =>
      createSuccessFactorsConnector({ sourceToken })
    );
  }

  if (connectorName === "workable") {
    const accountTokens = resolveTokens(
      args.accounts ??
        args.account ??
        process.env.WORKABLE_ACCOUNT_TOKENS ??
        WORKABLE_DEFAULT_ACCOUNT_TOKENS.join(",")
    );

    if (accountTokens.length === 0) {
      throw new Error(
        "No Workable accounts configured. Pass --account=fairmoney or set WORKABLE_ACCOUNT_TOKENS."
      );
    }

    return accountTokens.map((accountToken) =>
      createWorkableConnector({ accountToken })
    );
  }

  if (connectorName === "icims") {
    const portalTokens = resolveTokens(
      args.sources ??
        args.source ??
        process.env.ICIMS_PORTAL_TOKENS ??
        ""
    );

    if (portalTokens.length === 0) {
      throw new Error(
        "No iCIMS portals configured. Pass --source=jobs-microsoft or set ICIMS_PORTAL_TOKENS."
      );
    }

    return portalTokens.map((portalSubdomain) =>
      createIcimsConnector({ portalSubdomain })
    );
  }

  if (connectorName === "taleo") {
    const sourceTokens = resolveTokens(
      args.sources ??
        args.source ??
        process.env.TALEO_SOURCE_TOKENS ??
        DEFAULT_TALEO_SOURCES
    );

    if (sourceTokens.length === 0) {
      throw new Error(
        "No Taleo sources configured. Pass --source=tenant/section or set TALEO_SOURCE_TOKENS."
      );
    }

    return sourceTokens.map((sourceToken) =>
      createTaleoConnector({ sourceToken })
    );
  }

  if (connectorName === "workday") {
    const sourceTokens = resolveTokens(
      args.sources ??
        args.source ??
        process.env.WORKDAY_SOURCE_TOKENS ??
        ""
    );

    if (sourceTokens.length === 0) {
      throw new Error(
        "No Workday sources configured. Pass --source=host|tenant|site or set WORKDAY_SOURCE_TOKENS."
      );
    }

    return sourceTokens.map((sourceToken) =>
      createWorkdayConnector({ sourceToken })
    );
  }

  if (connectorName === "jobbank") {
    return [createJobBankConnector()];
  }

  // smartrecruiters
  const companyTokens = resolveTokens(
    args.companies ??
      args.company ??
      process.env.SMARTRECRUITERS_COMPANY_TOKENS ??
      SMARTRECRUITERS_DEFAULT_COMPANY_TOKENS.join(",")
  );

  if (companyTokens.length === 0) {
    throw new Error(
      "No SmartRecruiters companies configured. Pass --company=visa or set SMARTRECRUITERS_COMPANY_TOKENS."
    );
  }

  return companyTokens.map((companyIdentifier) =>
    createSmartRecruitersConnector({ companyIdentifier })
  );
}

// ─── Scheduled connector list ─────────────────────────────────────────────────

export function getScheduledConnectors(): ScheduledConnectorDefinition[] {
  const promotedDiscoveryTargets = loadPromotedDiscoveryTargets();

  return [
    ...resolveConnectors("ashby", {
      orgs: mergeTokenValues(
        process.env.ASHBY_ORG_TOKENS ?? DEFAULT_ASHBY_ORGS,
        promotedDiscoveryTargets.ashby
      ),
    }).map((connector) => ({
      connector,
      cadenceMinutes: resolveCadenceMinutes(
        process.env.ASHBY_SCHEDULE_MINUTES,
        120
      ),
    })),
    ...resolveConnectors("greenhouse", {
      boards: mergeTokenValues(
        process.env.GREENHOUSE_BOARD_TOKENS ?? DEFAULT_GREENHOUSE_BOARDS,
        promotedDiscoveryTargets.greenhouse
      ),
    }).map((connector) => ({
      connector,
      cadenceMinutes: resolveCadenceMinutes(
        process.env.GREENHOUSE_SCHEDULE_MINUTES,
        180
      ),
    })),
    ...resolveConnectors("lever", {
      sites: mergeTokenValues(
        process.env.LEVER_SITE_TOKENS ?? DEFAULT_LEVER_SITES,
        promotedDiscoveryTargets.lever
      ),
    }).map((connector) => ({
      connector,
      cadenceMinutes: resolveCadenceMinutes(
        process.env.LEVER_SCHEDULE_MINUTES,
        120
      ),
    })),
    ...resolveConnectors("recruitee", {
      companies: mergeTokenValues(
        process.env.RECRUITEE_COMPANY_TOKENS ?? DEFAULT_RECRUITEE_COMPANIES,
        promotedDiscoveryTargets.recruitee
      ),
    }).map((connector) => ({
      connector,
      cadenceMinutes: resolveCadenceMinutes(
        process.env.RECRUITEE_SCHEDULE_MINUTES,
        180
      ),
    })),
    ...resolveConnectors("rippling", {
      boards: mergeTokenValues(
        process.env.RIPPLING_BOARD_TOKENS ?? DEFAULT_RIPPLING_BOARDS,
        promotedDiscoveryTargets.rippling
      ),
    }).map((connector) => ({
      connector,
      cadenceMinutes: resolveCadenceMinutes(
        process.env.RIPPLING_SCHEDULE_MINUTES,
        180
      ),
    })),
    ...resolveOptionalSuccessFactorsScheduledConnectors(
      promotedDiscoveryTargets.successfactors
    ),
    ...resolveOptionalSmartRecruitersScheduledConnectors(
      promotedDiscoveryTargets.smartrecruiters
    ),
    ...resolveOptionalWorkableScheduledConnectors(
      promotedDiscoveryTargets.workable
    ),
    ...resolveOptionalWorkdayScheduledConnectors(promotedDiscoveryTargets.workday),
    ...resolveOptionalAdzunaScheduledConnectors(),
    ...resolveOptionalHimalayasScheduledConnectors(),
    ...resolveOptionalJobicyScheduledConnectors(),
    ...resolveOptionalRemotiveScheduledConnectors(),
    ...resolveOptionalMuseScheduledConnectors(),
    ...resolveOptionalRemoteOkScheduledConnectors(),
    ...resolveOptionalUsaJobsScheduledConnectors(),
    ...resolveOptionalTaleoScheduledConnectors(promotedDiscoveryTargets.taleo),
    ...resolveOptionalIcimsScheduledConnectors(promotedDiscoveryTargets.icims),
    ...resolveOptionalJobBankScheduledConnectors(),
  ];
}

export function getScheduledConnectorSnapshot() {
  return getScheduledConnectors().map((definition) => ({
    connectorKey: definition.connector.key,
    sourceName: definition.connector.sourceName,
    cadenceMinutes: definition.cadenceMinutes,
  }));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveOptionalSuccessFactorsScheduledConnectors(promotedTokens: string[]) {
  const tokens = resolveTokens(
    mergeTokenValues(process.env.SUCCESSFACTORS_DOMAIN_TOKENS ?? "", promotedTokens)
  );
  if (tokens.length === 0) return [];

  return tokens.map((sourceToken) => ({
    connector: createSuccessFactorsConnector({ sourceToken }),
    cadenceMinutes: resolveCadenceMinutes(
      process.env.SUCCESSFACTORS_SCHEDULE_MINUTES,
      240
    ),
  }));
}

function resolveOptionalSmartRecruitersScheduledConnectors(
  promotedTokens: string[]
) {
  const defaults = SMARTRECRUITERS_DEFAULT_COMPANY_TOKENS.join(",");
  const tokens = resolveTokens(
    mergeTokenValues(process.env.SMARTRECRUITERS_COMPANY_TOKENS ?? defaults, promotedTokens)
  );
  if (tokens.length === 0) return [];

  return tokens.map((companyIdentifier) => ({
    connector: createSmartRecruitersConnector({ companyIdentifier }),
    cadenceMinutes: resolveCadenceMinutes(
      process.env.SMARTRECRUITERS_SCHEDULE_MINUTES,
      240
    ),
  }));
}

function resolveOptionalWorkableScheduledConnectors(promotedTokens: string[]) {
  const defaults = WORKABLE_DEFAULT_ACCOUNT_TOKENS.join(",");
  const tokens = resolveTokens(
    mergeTokenValues(process.env.WORKABLE_ACCOUNT_TOKENS ?? defaults, promotedTokens)
  );
  if (tokens.length === 0) return [];

  return tokens.map((accountToken) => ({
    connector: createWorkableConnector({ accountToken }),
    cadenceMinutes: resolveCadenceMinutes(
      process.env.WORKABLE_SCHEDULE_MINUTES,
      240
    ),
  }));
}

function resolveOptionalIcimsScheduledConnectors(promotedTokens: string[]) {
  const tokens = resolveTokens(
    mergeTokenValues(process.env.ICIMS_PORTAL_TOKENS ?? "", promotedTokens)
  );
  if (tokens.length === 0) return [];

  return tokens.map((portalSubdomain) => ({
    connector: createIcimsConnector({ portalSubdomain }),
    cadenceMinutes: resolveCadenceMinutes(
      process.env.ICIMS_SCHEDULE_MINUTES,
      240
    ),
  }));
}

function resolveOptionalHimalayasScheduledConnectors() {
  const profiles = resolveTokens(process.env.HIMALAYAS_SOURCES ?? "global");
  return profiles.map((profile) => ({
    connector: createHimalayasConnector({ profile }),
    cadenceMinutes: resolveCadenceMinutes(
      process.env.HIMALAYAS_SCHEDULE_MINUTES,
      720
    ),
  }));
}

function resolveOptionalJobicyScheduledConnectors() {
  return [
    {
      connector: createJobicyConnector(),
      cadenceMinutes: resolveCadenceMinutes(
        process.env.JOBICY_SCHEDULE_MINUTES,
        720
      ),
    },
  ];
}

function resolveOptionalRemotiveScheduledConnectors() {
  return [
    {
      connector: createRemotiveConnector(),
      cadenceMinutes: resolveCadenceMinutes(
        process.env.REMOTIVE_SCHEDULE_MINUTES,
        720
      ),
    },
  ];
}

function resolveOptionalMuseScheduledConnectors() {
  return [
    {
      connector: createMuseConnector(),
      cadenceMinutes: resolveCadenceMinutes(
        process.env.THEMUSE_SCHEDULE_MINUTES,
        720
      ),
    },
  ];
}

function resolveOptionalAdzunaScheduledConnectors() {
  const appId = process.env.ADZUNA_APP_ID ?? "";
  const appKey = process.env.ADZUNA_APP_KEY ?? "";
  if (!appId || !appKey) return [];

  const countries = resolveTokens(
    process.env.ADZUNA_COUNTRIES ??
      "au,be,br,ca,de,fr,gb,in,it,mx,nl,nz,pl,sg,us,za"
  );
  const cadence = resolveCadenceMinutes(process.env.ADZUNA_SCHEDULE_MINUTES, 360);

  // Primary broad connectors per country
  const primary = countries.map((country) => ({
    connector: createAdzunaConnector({ country, appId, appKey }),
    cadenceMinutes: cadence,
  }));

  // Additional profile connectors for deeper per-category coverage
  const additionalProfiles = ["techcore", "specialist", "discovery"] as const;
  const additional = countries.flatMap((country) =>
    additionalProfiles.map((profile) => ({
      connector: createAdzunaConnector({ country, appId, appKey, profile }),
      cadenceMinutes: cadence,
    }))
  );

  return [...primary, ...additional];
}

function resolveOptionalRemoteOkScheduledConnectors() {
  return [
    {
      connector: createRemoteOkConnector(),
      cadenceMinutes: resolveCadenceMinutes(
        process.env.REMOTEOK_SCHEDULE_MINUTES,
        720
      ),
    },
  ];
}

function resolveOptionalUsaJobsScheduledConnectors() {
  const apiKey = process.env.USAJOBS_API_KEY ?? "";
  const email = process.env.USAJOBS_EMAIL ?? "";
  if (!apiKey || !email) return [];

  return [
    {
      connector: createUsaJobsConnector({ apiKey, email }),
      cadenceMinutes: resolveCadenceMinutes(
        process.env.USAJOBS_SCHEDULE_MINUTES,
        720
      ),
    },
  ];
}

function resolveOptionalJobBankScheduledConnectors() {
  // Job Bank CSV is updated monthly — run once per day (1440 min)
  return [
    {
      connector: createJobBankConnector(),
      cadenceMinutes: resolveCadenceMinutes(
        process.env.JOBBANK_SCHEDULE_MINUTES,
        1440
      ),
    },
  ];
}

function resolveOptionalTaleoScheduledConnectors(promotedTokens: string[]) {
  const tokens = resolveTokens(
    mergeTokenValues(process.env.TALEO_SOURCE_TOKENS ?? DEFAULT_TALEO_SOURCES, promotedTokens)
  );
  if (tokens.length === 0) return [];

  return tokens.map((sourceToken) => ({
    connector: createTaleoConnector({ sourceToken }),
    cadenceMinutes: resolveCadenceMinutes(
      process.env.TALEO_SCHEDULE_MINUTES,
      360
    ),
  }));
}

function resolveOptionalWorkdayScheduledConnectors(promotedTokens: string[]) {
  const tokens = resolveTokens(
    mergeTokenValues(process.env.WORKDAY_SOURCE_TOKENS ?? "", promotedTokens)
  );
  if (tokens.length === 0) return [];

  return tokens.map((sourceToken) => ({
    connector: createWorkdayConnector({ sourceToken }),
    cadenceMinutes: resolveCadenceMinutes(
      process.env.WORKDAY_SCHEDULE_MINUTES,
      240
    ),
  }));
}

function resolveCadenceMinutes(
  rawValue: string | undefined,
  fallback: number
) {
  if (!rawValue) return fallback;
  const parsedValue = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsedValue) || parsedValue <= 0) return fallback;
  return parsedValue;
}

function resolveTokens(rawValue: string) {
  return rawValue
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function mergeTokenValues(baseValue: string, promotedTokens: string[]) {
  const mergedTokens = [...new Set([...resolveTokens(baseValue), ...promotedTokens])];
  return mergedTokens.join(",");
}

function loadPromotedDiscoveryTargets() {
  const emptyTargets: Record<SupportedConnectorName, string[]> = {
    adzuna: [],
    ashby: [],
    greenhouse: [],
    himalayas: [],
    icims: [],
    jobicy: [],
    lever: [],
    remotive: [],
    themuse: [],
    recruitee: [],
    remoteok: [],
    rippling: [],
    successfactors: [],
    smartrecruiters: [],
    taleo: [],
    usajobs: [],
    workday: [],
    workable: [],
    jobbank: [],
  };

  if (!existsSync(DISCOVERY_STORE_PATH)) {
    return emptyTargets;
  }

  try {
    const store = JSON.parse(
      readFileSync(DISCOVERY_STORE_PATH, "utf8")
    ) as DiscoveryStore;

    for (const entry of store.entries ?? []) {
      if (
        !entry ||
        entry.status !== "promoted" ||
        !entry.connectorName ||
        !entry.token
      ) {
        continue;
      }

      emptyTargets[entry.connectorName].push(entry.token);
    }
  } catch {
    return emptyTargets;
  }

  for (const connectorName of Object.keys(emptyTargets) as SupportedConnectorName[]) {
    emptyTargets[connectorName] = [...new Set(emptyTargets[connectorName])];
  }

  return emptyTargets;
}
