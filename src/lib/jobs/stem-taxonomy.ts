import type { JobFamily } from "@/generated/prisma";

export interface StemFamilyRule {
  family: JobFamily;
  subfamily: string;
  titleKeywords: string[];
  descriptionKeywords: string[];
}

export const NORTH_AMERICA_POOL_LOCATIONS = ["United States", "Canada"] as const;

export const DEFAULT_NORTH_AMERICA_STEM_QUERY_PACK = [
  "software engineer",
  "backend engineer",
  "frontend engineer",
  "full stack engineer",
  "platform engineer",
  "cloud engineer",
  "site reliability engineer",
  "devops engineer",
  "security engineer",
  "machine learning engineer",
  "ai engineer",
  "data engineer",
  "data scientist",
  "data analyst",
  "analytics engineer",
  "quantitative researcher",
  "quantitative developer",
  "quantitative analyst",
  "actuarial analyst",
  "operations research analyst",
  "research scientist",
  "electrical engineer",
  "mechanical engineer",
  "civil engineer",
  "chemical engineer",
  "biomedical engineer",
  "industrial engineer",
  "firmware engineer",
  "robotics engineer",
  "controls engineer",
] as const;

export const STEM_FAMILY_RULES: StemFamilyRule[] = [
  {
    family: "SOFTWARE",
    subfamily: "software-engineering",
    titleKeywords: [
      "software engineer",
      "backend engineer",
      "frontend engineer",
      "full stack engineer",
      "application engineer",
      "mobile engineer",
      "ios engineer",
      "android engineer",
      "web engineer",
      "software developer",
    ],
    descriptionKeywords: [
      "typescript",
      "javascript",
      "java",
      "python",
      "react",
      "node",
      ".net",
      "distributed systems",
    ],
  },
  {
    family: "DATA",
    subfamily: "data-engineering",
    titleKeywords: [
      "data engineer",
      "analytics engineer",
      "etl engineer",
      "business intelligence engineer",
    ],
    descriptionKeywords: [
      "spark",
      "airflow",
      "dbt",
      "warehouse",
      "bigquery",
      "snowflake",
      "pipeline",
    ],
  },
  {
    family: "ANALYTICS",
    subfamily: "analytics",
    titleKeywords: [
      "data analyst",
      "business analyst",
      "business intelligence analyst",
      "analytics analyst",
      "insights analyst",
    ],
    descriptionKeywords: [
      "sql",
      "tableau",
      "power bi",
      "reporting",
      "forecasting",
      "experimentation",
    ],
  },
  {
    family: "AI_ML",
    subfamily: "machine-learning",
    titleKeywords: [
      "machine learning engineer",
      "ml engineer",
      "ai engineer",
      "research engineer",
      "research scientist",
      "applied scientist",
      "computer vision engineer",
      "nlp engineer",
    ],
    descriptionKeywords: [
      "machine learning",
      "deep learning",
      "pytorch",
      "tensorflow",
      "llm",
      "transformer",
      "computer vision",
      "nlp",
    ],
  },
  {
    family: "SECURITY",
    subfamily: "security",
    titleKeywords: [
      "security engineer",
      "application security engineer",
      "security analyst",
      "detection engineer",
      "threat researcher",
      "product security engineer",
    ],
    descriptionKeywords: [
      "siem",
      "soc",
      "threat detection",
      "incident response",
      "cloud security",
      "vulnerability",
    ],
  },
  {
    family: "DEVOPS",
    subfamily: "platform-infrastructure",
    titleKeywords: [
      "devops engineer",
      "site reliability engineer",
      "sre",
      "platform engineer",
      "infrastructure engineer",
      "cloud engineer",
      "systems engineer",
    ],
    descriptionKeywords: [
      "kubernetes",
      "terraform",
      "aws",
      "azure",
      "gcp",
      "observability",
      "ci/cd",
      "incident management",
    ],
  },
  {
    family: "ENGINEERING",
    subfamily: "core-engineering",
    titleKeywords: [
      "electrical engineer",
      "mechanical engineer",
      "civil engineer",
      "chemical engineer",
      "biomedical engineer",
      "industrial engineer",
      "manufacturing engineer",
      "firmware engineer",
      "hardware engineer",
      "robotics engineer",
      "controls engineer",
      "process engineer",
    ],
    descriptionKeywords: [
      "cad",
      "plc",
      "solidworks",
      "autocad",
      "embedded",
      "simulation",
      "validation",
      "lean manufacturing",
    ],
  },
  {
    family: "SCIENCE",
    subfamily: "science-research",
    titleKeywords: [
      "scientist",
      "research scientist",
      "research associate",
      "lab technician",
      "laboratory scientist",
      "clinical scientist",
      "bioinformatician",
      "biostatistician",
    ],
    descriptionKeywords: [
      "laboratory",
      "assay",
      "wet lab",
      "genomics",
      "clinical research",
      "experiments",
      "publication",
    ],
  },
  {
    family: "MATH",
    subfamily: "mathematics-statistics",
    titleKeywords: [
      "statistician",
      "mathematician",
      "mathematical modeler",
      "biostatistician",
    ],
    descriptionKeywords: [
      "probability",
      "stochastic",
      "optimization",
      "simulation",
      "modeling",
      "statistics",
    ],
  },
  {
    family: "QUANT",
    subfamily: "quantitative-finance",
    titleKeywords: [
      "quantitative researcher",
      "quantitative analyst",
      "quantitative developer",
      "quant researcher",
      "quant dev",
      "trading researcher",
    ],
    descriptionKeywords: [
      "alpha research",
      "market microstructure",
      "systematic trading",
      "factor modeling",
      "derivatives",
      "options",
      "signals",
    ],
  },
  {
    family: "ACTUARIAL",
    subfamily: "actuarial",
    titleKeywords: [
      "actuarial analyst",
      "actuary",
      "pricing analyst",
      "reserving analyst",
    ],
    descriptionKeywords: [
      "loss reserving",
      "pricing models",
      "ifrs 17",
      "p&c insurance",
      "life insurance",
      "soa",
      "cas",
    ],
  },
  {
    family: "OPERATIONS_RESEARCH",
    subfamily: "optimization",
    titleKeywords: [
      "operations research analyst",
      "optimization engineer",
      "decision scientist",
      "revenue management analyst",
    ],
    descriptionKeywords: [
      "linear programming",
      "integer programming",
      "supply chain optimization",
      "forecasting",
      "decision science",
      "scheduling",
    ],
  },
];

export const AGENCY_KEYWORDS = [
  "staffing",
  "recruiting",
  "recruitment",
  "talent solutions",
  "talent acquisition partner",
  "employment agency",
  "search firm",
  "headhunter",
] as const;

export const PUBLIC_SECTOR_KEYWORDS = [
  "government",
  "public service",
  "department of",
  "ministry of",
  "city of",
  "county of",
  "federal",
  "state of",
  "province of",
  "university",
  "hospital",
  "health authority",
] as const;

export const INTERNSHIP_KEYWORDS = [
  "intern",
  "internship",
  "co-op",
  "coop",
  "new grad",
  "new graduate",
] as const;

export function parseDelimitedList(raw: string | undefined): string[] {
  if (!raw) return [];

  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getNorthAmericaStemQueryPack(): string[] {
  const customQueries = parseDelimitedList(process.env.DEFAULT_JOB_SYNC_QUERY);
  return customQueries.length > 0
    ? customQueries
    : [...DEFAULT_NORTH_AMERICA_STEM_QUERY_PACK];
}

export function getNorthAmericaPoolLocations(): string[] {
  const customLocations = parseDelimitedList(process.env.DEFAULT_JOB_SYNC_LOCATIONS);
  return customLocations.length > 0
    ? customLocations
    : [...NORTH_AMERICA_POOL_LOCATIONS];
}
