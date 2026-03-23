import { prisma } from "@/lib/prisma";
import type { ATSType } from "@/generated/prisma";

export interface CompanyEntry {
  name: string;
  domain: string;
  knownCareersUrl?: string;
  knownATS?: ATSType;
  knownBoardToken?: string;
}

export type CompanyCategory =
  | "FAANG_PLUS"
  | "TOP_TECH"
  | "UNICORNS"
  | "YC_COMPANIES"
  | "FINTECH"
  | "REMOTE_FIRST"
  | "CANADIAN_TECH"
  | "AI_ML"
  | "PUBLIC_TECH"
  | "US_SEMICONDUCTORS"
  | "QUANT_FINANCE"
  | "AEROSPACE_AUTONOMY"
  | "BIOPHARMA_HEALTH"
  | "CANADA_ENTERPRISE"
  | "CANADA_PUBLIC";

// ---------------------------------------------------------------------------
// Deduplicated company registry - each company defined once, referenced by key
// ---------------------------------------------------------------------------

const C = {
  // --- FAANG_PLUS ---
  google: { name: "Google", domain: "google.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://www.google.com/about/careers/applications/jobs/results/" },
  meta: { name: "Meta", domain: "meta.com", knownATS: "WORKDAY" as ATSType },
  apple: { name: "Apple", domain: "apple.com", knownATS: "WORKDAY" as ATSType },
  amazon: { name: "Amazon", domain: "amazon.com", knownATS: "WORKDAY" as ATSType },
  microsoft: { name: "Microsoft", domain: "microsoft.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://careers.microsoft.com/v2/global/en/home.html" },
  netflix: { name: "Netflix", domain: "netflix.com", knownATS: "LEVER" as ATSType, knownBoardToken: "netflix", knownCareersUrl: "https://explore.jobs.netflix.net/careers" },
  salesforce: { name: "Salesforce", domain: "salesforce.com", knownATS: "WORKDAY" as ATSType },
  oracle: { name: "Oracle", domain: "oracle.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://careers.oracle.com/jobs/" },
  adobe: { name: "Adobe", domain: "adobe.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://careers.adobe.com/us/en/search-results" },
  ibm: { name: "IBM", domain: "ibm.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://www.ibm.com/careers/search" },
  intel: { name: "Intel", domain: "intel.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://jobs.intel.com/en/search-jobs" },
  cisco: { name: "Cisco", domain: "cisco.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://jobs.cisco.com/" },
  vmware: { name: "VMware", domain: "vmware.com", knownATS: "WORKDAY" as ATSType },
  dell: { name: "Dell", domain: "dell.com", knownATS: "WORKDAY" as ATSType },
  hp: { name: "HP", domain: "hp.com", knownATS: "WORKDAY" as ATSType },
  nvidia: { name: "Nvidia", domain: "nvidia.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite" },
  amd: { name: "AMD", domain: "amd.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://careers.amd.com/careers-home/jobs" },
  qualcomm: { name: "Qualcomm", domain: "qualcomm.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://www.qualcomm.com/company/careers" },
  servicenow: { name: "ServiceNow", domain: "servicenow.com", knownATS: "WORKDAY" as ATSType },
  palantir: { name: "Palantir", domain: "palantir.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "palantir" },
  snowflake: { name: "Snowflake", domain: "snowflake.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "snowflakecomputing", knownCareersUrl: "https://careers.snowflake.com/us/en/search-results" },
  uber: { name: "Uber", domain: "uber.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "uber" },

  // --- TOP_TECH ---
  stripe: { name: "Stripe", domain: "stripe.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "stripe" },
  vercel: { name: "Vercel", domain: "vercel.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "vercel" },
  linear: { name: "Linear", domain: "linear.app", knownATS: "ASHBY" as ATSType, knownBoardToken: "linear" },
  notion: { name: "Notion", domain: "notion.so", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "notion" },
  figma: { name: "Figma", domain: "figma.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "figma" },
  shopify: { name: "Shopify", domain: "shopify.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "shopify", knownCareersUrl: "https://www.shopify.com/careers" },
  datadog: { name: "Datadog", domain: "datadoghq.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "datadog" },
  cloudflare: { name: "Cloudflare", domain: "cloudflare.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "cloudflare" },
  gitlab: { name: "GitLab", domain: "gitlab.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "gitlab" },
  postman: { name: "Postman", domain: "postman.com", knownATS: "LEVER" as ATSType, knownBoardToken: "postman" },
  twilio: { name: "Twilio", domain: "twilio.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "twilio" },
  mongodb: { name: "MongoDB", domain: "mongodb.com", knownATS: "LEVER" as ATSType, knownBoardToken: "mongodb" },
  elastic: { name: "Elastic", domain: "elastic.co", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "elastic" },
  hashicorp: { name: "HashiCorp", domain: "hashicorp.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "hashicorp", knownCareersUrl: "https://www.hashicorp.com/en/careers" },
  confluent: { name: "Confluent", domain: "confluent.io", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "confluent" },
  databricks: { name: "Databricks", domain: "databricks.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "databricks" },
  supabase: { name: "Supabase", domain: "supabase.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "supabase" },
  planetscale: { name: "PlanetScale", domain: "planetscale.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "planetscale" },
  neon: { name: "Neon", domain: "neon.tech", knownATS: "ASHBY" as ATSType, knownBoardToken: "neon" },
  railway: { name: "Railway", domain: "railway.app", knownATS: "ASHBY" as ATSType, knownBoardToken: "railway" },
  flyio: { name: "Fly.io", domain: "fly.io", knownATS: "LEVER" as ATSType, knownBoardToken: "fly" },
  render: { name: "Render", domain: "render.com", knownATS: "LEVER" as ATSType, knownBoardToken: "render" },
  digitalocean: { name: "DigitalOcean", domain: "digitalocean.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "digitalocean" },
  akamai: { name: "Akamai", domain: "akamai.com", knownATS: "WORKDAY" as ATSType },
  fastly: { name: "Fastly", domain: "fastly.com", knownATS: "LEVER" as ATSType, knownBoardToken: "fastly" },
  sentry: { name: "Sentry", domain: "sentry.io", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "sentry" },
  launchdarkly: { name: "LaunchDarkly", domain: "launchdarkly.com", knownATS: "LEVER" as ATSType, knownBoardToken: "launchdarkly" },
  splitio: { name: "Split.io", domain: "split.io", knownATS: "LEVER" as ATSType, knownBoardToken: "split" },
  segment: { name: "Segment", domain: "segment.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "segment" },
  amplitude: { name: "Amplitude", domain: "amplitude.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "amplitude" },
  grafana: { name: "Grafana Labs", domain: "grafana.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "grafanalabs" },
  hubspot: { name: "HubSpot", domain: "hubspot.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "hubspot" },

  // --- UNICORNS ---
  canva: { name: "Canva", domain: "canva.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "canva", knownCareersUrl: "https://www.canva.com/careers/" },
  miro: { name: "Miro", domain: "miro.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "miro" },
  airtable: { name: "Airtable", domain: "airtable.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "airtable" },
  retool: { name: "Retool", domain: "retool.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "retool" },
  webflow: { name: "Webflow", domain: "webflow.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "webflow" },
  loom: { name: "Loom", domain: "loom.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "loom" },
  calendly: { name: "Calendly", domain: "calendly.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "calendly" },
  grammarly: { name: "Grammarly", domain: "grammarly.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "grammarly" },
  plaid: { name: "Plaid", domain: "plaid.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "plaid" },
  brex: { name: "Brex", domain: "brex.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "brex" },
  ramp: { name: "Ramp", domain: "ramp.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "ramp" },
  mercury: { name: "Mercury", domain: "mercury.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "mercury" },
  chime: { name: "Chime", domain: "chime.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "chime" },
  rippling: { name: "Rippling", domain: "rippling.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "rippling" },
  deel: { name: "Deel", domain: "deel.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "deel" },
  remotecom: { name: "Remote.com", domain: "remote.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "remotecom" },
  gusto: { name: "Gusto", domain: "gusto.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "gusto" },
  lattice: { name: "Lattice", domain: "lattice.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "lattice" },
  cultureamp: { name: "Culture Amp", domain: "cultureamp.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "cultureamp" },
  gong: { name: "Gong", domain: "gong.io", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "gong" },
  outreach: { name: "Outreach", domain: "outreach.io", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "outreach" },
  salesloft: { name: "Salesloft", domain: "salesloft.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "salesloft" },
  highspot: { name: "Highspot", domain: "highspot.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "highspot" },
  seismic: { name: "Seismic", domain: "seismic.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "seismic" },
  zoominfo: { name: "ZoomInfo", domain: "zoominfo.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "zoominfo" },
  sixsense: { name: "6sense", domain: "6sense.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "6sense" },
  discord: { name: "Discord", domain: "discord.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "discord" },
  scaleai: { name: "Scale AI", domain: "scale.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "scaleai" },
  vanta: { name: "Vanta", domain: "vanta.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "vanta" },

  // --- YC_COMPANIES ---
  airbnb: { name: "Airbnb", domain: "airbnb.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "airbnb" },
  doordash: { name: "DoorDash", domain: "doordash.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "doordash" },
  instacart: { name: "Instacart", domain: "instacart.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "instacart" },
  coinbase: { name: "Coinbase", domain: "coinbase.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "coinbase" },
  dropbox: { name: "Dropbox", domain: "dropbox.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "dropbox" },
  reddit: { name: "Reddit", domain: "reddit.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "reddit" },
  twitch: { name: "Twitch", domain: "twitch.tv", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "twitch" },
  zapier: { name: "Zapier", domain: "zapier.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "zapier" },
  algolia: { name: "Algolia", domain: "algolia.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "algolia" },
  faire: { name: "Faire", domain: "faire.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "faire" },
  posthog: { name: "PostHog", domain: "posthog.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "posthog" },
  calcom: { name: "Cal.com", domain: "cal.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "cal" },
  mintlify: { name: "Mintlify", domain: "mintlify.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "mintlify" },
  resend: { name: "Resend", domain: "resend.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "resend" },
  coda: { name: "Coda", domain: "coda.io", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "coda" },
  replit: { name: "Replit", domain: "replit.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "replit" },
  razorpay: { name: "Razorpay", domain: "razorpay.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "razorpay" },

  // --- FINTECH ---
  square: { name: "Block (Square)", domain: "block.xyz", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "block" },
  robinhood: { name: "Robinhood", domain: "robinhood.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "robinhood", knownCareersUrl: "https://careers.robinhood.com/openings/" },
  sofi: { name: "SoFi", domain: "sofi.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "sofi" },
  affirm: { name: "Affirm", domain: "affirm.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "affirm" },
  klarna: { name: "Klarna", domain: "klarna.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "klarna" },
  wise: { name: "Wise", domain: "wise.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "wise" },
  marqeta: { name: "Marqeta", domain: "marqeta.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "marqeta" },
  toast: { name: "Toast", domain: "toasttab.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "toast" },
  billcom: { name: "Bill.com", domain: "bill.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "billcom" },
  adyen: { name: "Adyen", domain: "adyen.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "adyen" },
  checkoutcom: { name: "Checkout.com", domain: "checkout.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "checkout" },
  nuvei: { name: "Nuvei", domain: "nuvei.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "nuvei" },

  // --- REMOTE_FIRST ---
  automattic: { name: "Automattic", domain: "automattic.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "automattic" },
  buffer: { name: "Buffer", domain: "buffer.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "buffer" },
  doist: { name: "Doist", domain: "doist.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "doist" },
  close: { name: "Close", domain: "close.com", knownATS: "LEVER" as ATSType, knownBoardToken: "close.io" },
  helpscout: { name: "Help Scout", domain: "helpscout.com", knownATS: "LEVER" as ATSType, knownBoardToken: "helpscout" },
  hotjar: { name: "Hotjar", domain: "hotjar.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "hotjar" },
  invision: { name: "InVision", domain: "invisionapp.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "invision" },
  toptal: { name: "Toptal", domain: "toptal.com", knownATS: "LEVER" as ATSType, knownBoardToken: "toptal" },
  oyster: { name: "Oyster", domain: "oysterhr.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "oyster" },
  velocityglobal: { name: "Velocity Global", domain: "velocityglobal.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "velocityglobal" },
  onepassword: { name: "1Password", domain: "1password.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "1password" },

  // --- CANADIAN_TECH ---
  wealthsimple: { name: "Wealthsimple", domain: "wealthsimple.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "wealthsimple" },
  clio: { name: "Clio", domain: "clio.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "clio" },
  jobber: { name: "Jobber", domain: "getjobber.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "jobber" },
  benevity: { name: "Benevity", domain: "benevity.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "benevity" },
  hootsuite: { name: "Hootsuite", domain: "hootsuite.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "hootsuite" },
  vidyard: { name: "Vidyard", domain: "vidyard.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "vidyard" },
  applyboard: { name: "ApplyBoard", domain: "applyboard.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "applyboard" },
  clearco: { name: "Clearco", domain: "clear.co", knownATS: "LEVER" as ATSType, knownBoardToken: "clearco" },
  tophat: { name: "Top Hat", domain: "tophat.com", knownATS: "LEVER" as ATSType, knownBoardToken: "tophat" },
  coveo: { name: "Coveo", domain: "coveo.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "coveo" },
  lightspeed: { name: "Lightspeed", domain: "lightspeedhq.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "lightspeed" },
  dialogue: { name: "Dialogue", domain: "dialogue.co", knownATS: "LEVER" as ATSType, knownBoardToken: "dialogue" },
  cohere: { name: "Cohere", domain: "cohere.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "cohere" },
  ada: { name: "Ada", domain: "ada.cx", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "ada" },
  maropost: { name: "Maropost", domain: "maropost.com", knownATS: "LEVER" as ATSType, knownBoardToken: "maropost" },
  freshbooks: { name: "FreshBooks", domain: "freshbooks.com", knownATS: "LEVER" as ATSType, knownBoardToken: "freshbooks" },
  wave: { name: "Wave", domain: "waveapps.com", knownATS: "LEVER" as ATSType, knownBoardToken: "wave-financial" },
  touchbistro: { name: "TouchBistro", domain: "touchbistro.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "touchbistro" },
  d2l: { name: "D2L", domain: "d2l.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "d2l" },
  dapperlabs: { name: "Dapper Labs", domain: "dapperlabs.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "dapperlabs" },
  hopper: { name: "Hopper", domain: "hopper.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "hopper" },
  janeapp: { name: "Jane App", domain: "jane.app", knownATS: "LEVER" as ATSType, knownBoardToken: "janeapp" },
  koho: { name: "Koho", domain: "koho.ca", knownATS: "LEVER" as ATSType, knownBoardToken: "koho" },
  league: { name: "League", domain: "league.com", knownATS: "LEVER" as ATSType, knownBoardToken: "league" },
  magnetforensics: { name: "Magnet Forensics", domain: "magnetforensics.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "magnetforensics" },
  pointclickcare: { name: "PointClickCare", domain: "pointclickcare.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "pointclickcare" },
  thinkific: { name: "Thinkific", domain: "thinkific.com", knownATS: "LEVER" as ATSType, knownBoardToken: "thinkific" },
  wattpad: { name: "Wattpad", domain: "wattpad.com", knownATS: "LEVER" as ATSType, knownBoardToken: "wattpad" },

  // --- AI_ML ---
  openai: { name: "OpenAI", domain: "openai.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "openai", knownCareersUrl: "https://openai.com/careers/" },
  anthropic: { name: "Anthropic", domain: "anthropic.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "anthropic", knownCareersUrl: "https://www.anthropic.com/careers" },
  stabilityai: { name: "Stability AI", domain: "stability.ai", knownATS: "LEVER" as ATSType, knownBoardToken: "stability" },
  huggingface: { name: "Hugging Face", domain: "huggingface.co", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "huggingface" },
  wandb: { name: "Weights & Biases", domain: "wandb.ai", knownATS: "LEVER" as ATSType, knownBoardToken: "wandb" },
  labelbox: { name: "Labelbox", domain: "labelbox.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "labelbox" },
  snorkelai: { name: "Snorkel AI", domain: "snorkel.ai", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "snorkelai" },
  anyscale: { name: "Anyscale", domain: "anyscale.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "anyscale" },
  modal: { name: "Modal", domain: "modal.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "modal" },
  replicate: { name: "Replicate", domain: "replicate.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "replicate" },
  midjourney: { name: "Midjourney", domain: "midjourney.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "midjourney" },
  runway: { name: "Runway", domain: "runwayml.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "runwayml" },
  jasper: { name: "Jasper", domain: "jasper.ai", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "jasper" },
  copyai: { name: "Copy.ai", domain: "copy.ai", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "copy-ai" },
  writer: { name: "Writer", domain: "writer.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "writer" },
  glean: { name: "Glean", domain: "glean.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "glean" },
  pinecone: { name: "Pinecone", domain: "pinecone.io", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "pinecone" },
  weaviate: { name: "Weaviate", domain: "weaviate.io", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "weaviate" },
  qdrant: { name: "Qdrant", domain: "qdrant.tech", knownATS: "ASHBY" as ATSType, knownBoardToken: "qdrant" },
  chroma: { name: "Chroma", domain: "trychroma.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "chroma" },
  togetherai: { name: "Together AI", domain: "together.ai", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "togetherai" },
  mistralai: { name: "Mistral AI", domain: "mistral.ai", knownATS: "LEVER" as ATSType, knownBoardToken: "mistral" },
  perplexity: { name: "Perplexity", domain: "perplexity.ai", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "perplexityai" },
  elevenlabs: { name: "ElevenLabs", domain: "elevenlabs.io", knownATS: "ASHBY" as ATSType, knownBoardToken: "elevenlabs" },
  langchain: { name: "LangChain", domain: "langchain.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "langchain" },

  // --- PUBLIC_TECH (additional entries not already defined) ---
  atlassian: { name: "Atlassian", domain: "atlassian.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "atlassian", knownCareersUrl: "https://www.atlassian.com/company/careers/all-jobs" },
  asana: { name: "Asana", domain: "asana.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "asana" },
  box: { name: "Box", domain: "box.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "box" },
  crowdstrike: { name: "CrowdStrike", domain: "crowdstrike.com", knownATS: "WORKDAY" as ATSType },
  docusign: { name: "DocuSign", domain: "docusign.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "docusign" },
  etsy: { name: "Etsy", domain: "etsy.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "etsy" },
  github: { name: "GitHub", domain: "github.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "github" },
  mondaycom: { name: "Monday.com", domain: "monday.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "mondaydotcom" },
  newrelic: { name: "New Relic", domain: "newrelic.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "newrelic" },
  okta: { name: "Okta", domain: "okta.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "okta" },
  pagerduty: { name: "PagerDuty", domain: "pagerduty.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "pagerduty" },
  paloalto: { name: "Palo Alto Networks", domain: "paloaltonetworks.com", knownATS: "WORKDAY" as ATSType },
  samsara: { name: "Samsara", domain: "samsara.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "samsara" },
  splunk: { name: "Splunk", domain: "splunk.com", knownATS: "WORKDAY" as ATSType },
  wayfair: { name: "Wayfair", domain: "wayfair.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "wayfair" },
  workday: { name: "Workday", domain: "workday.com", knownATS: "WORKDAY" as ATSType },
  zoom: { name: "Zoom", domain: "zoom.us", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "zoom" },
  zscaler: { name: "Zscaler", domain: "zscaler.com", knownATS: "WORKDAY" as ATSType },
  verkada: { name: "Verkada", domain: "verkada.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "verkada" },
  sourcegraph: { name: "Sourcegraph", domain: "sourcegraph.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "sourcegraph" },
  docker: { name: "Docker", domain: "docker.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "docker" },
  openphone: { name: "OpenPhone", domain: "openphone.com", knownATS: "ASHBY" as ATSType, knownBoardToken: "openphone" },
  turing: { name: "Turing", domain: "turing.com", knownATS: "LEVER" as ATSType, knownBoardToken: "turing" },
  canonical: { name: "Canonical", domain: "canonical.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "canonical" },
  cockroachlabs: { name: "Cockroach Labs", domain: "cockroachlabs.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "cockroachlabs" },
  dbtlabs: { name: "dbt Labs", domain: "getdbt.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "dbtlabsinc" },

  // --- US_SEMICONDUCTORS ---
  broadcom: { name: "Broadcom", domain: "broadcom.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://www.broadcom.com/company/careers" },
  micron: { name: "Micron", domain: "micron.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://careers.micron.com/careers" },
  ti: { name: "Texas Instruments", domain: "ti.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://careers.ti.com/" },
  appliedmaterials: { name: "Applied Materials", domain: "appliedmaterials.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://careers.appliedmaterials.com/careers" },
  lamresearch: { name: "Lam Research", domain: "lamresearch.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://careers.lamresearch.com/" },
  kla: { name: "KLA", domain: "kla.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://kla.wd1.myworkdayjobs.com/EXTERNAL" },
  synopsys: { name: "Synopsys", domain: "synopsys.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://careers.synopsys.com/" },
  cadence: { name: "Cadence", domain: "cadence.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers" },
  arm: { name: "Arm", domain: "arm.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://careers.arm.com/" },
  globalfoundries: { name: "GlobalFoundries", domain: "gf.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://gf.wd1.myworkdayjobs.com/External" },
  nxp: { name: "NXP", domain: "nxp.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://nxp.wd3.myworkdayjobs.com/en-US/careers" },
  analogdevices: { name: "Analog Devices", domain: "analog.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://analogdevices.wd1.myworkdayjobs.com/External" },
  marvell: { name: "Marvell", domain: "marvell.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://marvell.wd1.myworkdayjobs.com/External" },
  seagate: { name: "Seagate", domain: "seagate.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://seagatecareers.com/" },
  westerndigital: { name: "Western Digital", domain: "westerndigital.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://jobs.westerndigital.com/" },
  keysight: { name: "Keysight", domain: "keysight.com", knownATS: "WORKDAY" as ATSType, knownCareersUrl: "https://jobs.keysight.com/" },

  // --- QUANT_FINANCE ---
  janestreet: { name: "Jane Street", domain: "janestreet.com", knownCareersUrl: "https://www.janestreet.com/join-jane-street/open-roles/" },
  twosigma: { name: "Two Sigma", domain: "twosigma.com", knownCareersUrl: "https://careers.twosigma.com/careers/" },
  hrt: { name: "Hudson River Trading", domain: "hudsonrivertrading.com", knownCareersUrl: "https://www.hudsonrivertrading.com/careers/" },
  citadel: { name: "Citadel", domain: "citadel.com", knownCareersUrl: "https://www.citadel.com/careers/open-opportunities/" },
  citadelsec: { name: "Citadel Securities", domain: "citadelsecurities.com", knownCareersUrl: "https://www.citadelsecurities.com/careers/open-opportunities/" },
  deshaw: { name: "D. E. Shaw", domain: "deshaw.com", knownCareersUrl: "https://www.deshaw.com/careers" },
  drw: { name: "DRW", domain: "drw.com", knownCareersUrl: "https://www.drw.com/work-at-drw/listings/" },
  jumptrading: { name: "Jump Trading", domain: "jumptrading.com", knownCareersUrl: "https://www.jumptrading.com/careers/" },
  imc: { name: "IMC", domain: "imc.com", knownCareersUrl: "https://www.imc.com/us/careers/jobs/" },
  optiver: { name: "Optiver", domain: "optiver.com", knownCareersUrl: "https://optiver.com/working-at-optiver/career-opportunities/" },
  susquehanna: { name: "Susquehanna", domain: "sig.com", knownCareersUrl: "https://careers.sig.com/" },
  akunacapital: { name: "Akuna Capital", domain: "akunacapital.com", knownCareersUrl: "https://akunacapital.com/careers" },
  cboe: { name: "Cboe", domain: "cboe.com", knownCareersUrl: "https://www.cboe.com/about/careers/" },
  cmegroup: { name: "CME Group", domain: "cmegroup.com", knownCareersUrl: "https://www.cmegroup.com/careers.html" },
  nasdaq: { name: "Nasdaq", domain: "nasdaq.com", knownCareersUrl: "https://www.nasdaq.com/about/careers" },
  bloomberg: { name: "Bloomberg", domain: "bloomberg.com", knownCareersUrl: "https://careers.bloomberg.com/job/search" },

  // --- AEROSPACE_AUTONOMY ---
  spacex: { name: "SpaceX", domain: "spacex.com", knownCareersUrl: "https://www.spacex.com/careers/" },
  blueorigin: { name: "Blue Origin", domain: "blueorigin.com", knownCareersUrl: "https://www.blueorigin.com/careers" },
  anduril: { name: "Anduril", domain: "anduril.com", knownATS: "GREENHOUSE" as ATSType, knownBoardToken: "andurilindustries", knownCareersUrl: "https://www.anduril.com/careers/" },
  waymo: { name: "Waymo", domain: "waymo.com", knownCareersUrl: "https://waymo.com/careers/" },
  zoox: { name: "Zoox", domain: "zoox.com", knownCareersUrl: "https://zoox.com/careers/" },
  aurora: { name: "Aurora", domain: "aurora.tech", knownCareersUrl: "https://aurora.tech/careers/" },
  cruise: { name: "Cruise", domain: "getcruise.com", knownCareersUrl: "https://getcruise.com/careers/" },
  shieldai: { name: "Shield AI", domain: "shield.ai", knownCareersUrl: "https://shield.ai/careers/" },
  joby: { name: "Joby Aviation", domain: "jobyaviation.com", knownCareersUrl: "https://www.jobyaviation.com/careers/" },
  archer: { name: "Archer", domain: "archer.com", knownCareersUrl: "https://www.archer.com/careers" },
  relativity: { name: "Relativity Space", domain: "relativityspace.com", knownCareersUrl: "https://www.relativityspace.com/careers" },
  rocketlab: { name: "Rocket Lab", domain: "rocketlabusa.com", knownCareersUrl: "https://www.rocketlabusa.com/careers/" },
  boeing: { name: "Boeing", domain: "boeing.com", knownCareersUrl: "https://jobs.boeing.com/" },
  northropgrumman: { name: "Northrop Grumman", domain: "northropgrumman.com", knownCareersUrl: "https://careers.northropgrumman.com/" },
  lockheed: { name: "Lockheed Martin", domain: "lockheedmartin.com", knownCareersUrl: "https://www.lockheedmartinjobs.com/" },
  rtx: { name: "RTX", domain: "rtx.com", knownCareersUrl: "https://careers.rtx.com/global/en" },
  generaldynamics: { name: "General Dynamics", domain: "gd.com", knownCareersUrl: "https://careers-gd.icims.com/jobs/intro" },
  l3harris: { name: "L3Harris", domain: "l3harris.com", knownCareersUrl: "https://careers.l3harris.com/" },

  // --- BIOPHARMA_HEALTH ---
  moderna: { name: "Moderna", domain: "modernatx.com", knownCareersUrl: "https://www.modernatx.com/careers/" },
  regeneron: { name: "Regeneron", domain: "regeneron.com", knownCareersUrl: "https://careers.regeneron.com/" },
  genentech: { name: "Genentech", domain: "gene.com", knownCareersUrl: "https://careers.gene.com/" },
  amgen: { name: "Amgen", domain: "amgen.com", knownCareersUrl: "https://careers.amgen.com/en" },
  gilead: { name: "Gilead", domain: "gilead.com", knownCareersUrl: "https://gilead.yello.co/jobs" },
  illumina: { name: "Illumina", domain: "illumina.com", knownCareersUrl: "https://www.illumina.com/company/careers.html" },
  thermofisher: { name: "Thermo Fisher Scientific", domain: "thermofisher.com", knownCareersUrl: "https://jobs.thermofisher.com/global/en" },
  danaher: { name: "Danaher", domain: "danaher.com", knownCareersUrl: "https://jobs.danaher.com/global/en" },
  pfizer: { name: "Pfizer", domain: "pfizer.com", knownCareersUrl: "https://www.pfizer.com/about/careers" },
  merck: { name: "Merck", domain: "merck.com", knownCareersUrl: "https://jobs.merck.com/us/en" },
  bms: { name: "Bristol Myers Squibb", domain: "bms.com", knownCareersUrl: "https://careers.bms.com/" },
  biogen: { name: "Biogen", domain: "biogen.com", knownCareersUrl: "https://careers.biogen.com/" },
  vertex: { name: "Vertex Pharmaceuticals", domain: "vrtx.com", knownCareersUrl: "https://vrtx.wd1.myworkdayjobs.com/vertex_pharmaceuticals_careers" },
  roche: { name: "Roche", domain: "roche.com", knownCareersUrl: "https://careers.roche.com/global/en" },
  abbvie: { name: "AbbVie", domain: "abbvie.com", knownCareersUrl: "https://careers.abbvie.com/en" },
  medtronic: { name: "Medtronic", domain: "medtronic.com", knownCareersUrl: "https://jobs.medtronic.com/" },
  bostonscientific: { name: "Boston Scientific", domain: "bostonscientific.com", knownCareersUrl: "https://jobs.bostonscientific.com/" },
  guardanthealth: { name: "Guardant Health", domain: "guardanthealth.com", knownCareersUrl: "https://guardanthealth.com/company/careers/" },
  tempus: { name: "Tempus", domain: "tempus.com", knownCareersUrl: "https://www.tempus.com/careers/" },

  // --- CANADA_ENTERPRISE ---
  rbc: { name: "RBC", domain: "rbc.com" },
  td: { name: "TD", domain: "td.com" },
  scotiabank: { name: "Scotiabank", domain: "scotiabank.com" },
  bmo: { name: "BMO", domain: "bmo.com" },
  cibc: { name: "CIBC", domain: "cibc.com" },
  nbc: { name: "National Bank of Canada", domain: "nbc.ca" },
  desjardins: { name: "Desjardins", domain: "desjardins.com" },
  manulife: { name: "Manulife", domain: "manulife.com" },
  sunlife: { name: "Sun Life", domain: "sunlife.com" },
  intactfinancial: { name: "Intact Financial", domain: "intactfc.com" },
  definity: { name: "Definity", domain: "definityfinancial.com" },
  brookfield: { name: "Brookfield", domain: "brookfield.com" },
  cgi: { name: "CGI", domain: "cgi.com" },
  opentext: { name: "OpenText", domain: "opentext.com" },
  kinaxis: { name: "Kinaxis", domain: "kinaxis.com" },
  constellation: { name: "Constellation Software", domain: "csisoftware.com" },
  telus: { name: "TELUS", domain: "telus.com" },
  bell: { name: "Bell", domain: "bell.ca" },
  rogers: { name: "Rogers", domain: "rogers.com" },
  cogeco: { name: "Cogeco", domain: "cogeco.com" },
  quebecor: { name: "Quebecor", domain: "quebecor.com" },
  aircanada: { name: "Air Canada", domain: "aircanada.com" },
  westjet: { name: "WestJet", domain: "westjet.com" },
  porter: { name: "Porter Airlines", domain: "flyporter.com" },
  cae: { name: "CAE", domain: "cae.com" },
  bombardier: { name: "Bombardier", domain: "bombardier.com" },
  cn: { name: "CN", domain: "cn.ca" },
  cpkc: { name: "CPKC", domain: "cpr.ca" },
  loblaw: { name: "Loblaw", domain: "loblaw.ca" },
  sobeys: { name: "Sobeys", domain: "sobeys.com" },
  metro: { name: "Metro", domain: "metro.ca" },
  canadiantire: { name: "Canadian Tire", domain: "corp.canadiantire.ca" },
  dollarama: { name: "Dollarama", domain: "dollarama.com" },
  enbridge: { name: "Enbridge", domain: "enbridge.com" },
  tcenergy: { name: "TC Energy", domain: "tcenergy.com" },
  suncor: { name: "Suncor", domain: "suncor.com" },
  nutrien: { name: "Nutrien", domain: "nutrien.com" },
  hydroone: { name: "Hydro One", domain: "hydroone.com" },
  opg: { name: "Ontario Power Generation", domain: "opg.com" },
  bce: { name: "BCE", domain: "bce.ca" },

  // --- CANADA_PUBLIC ---
  uoft: { name: "University of Toronto", domain: "utoronto.ca" },
  ubc: { name: "University of British Columbia", domain: "ubc.ca" },
  mcgill: { name: "McGill University", domain: "mcgill.ca" },
  uwaterloo: { name: "University of Waterloo", domain: "uwaterloo.ca" },
  mcmaster: { name: "McMaster University", domain: "mcmaster.ca" },
  ualberta: { name: "University of Alberta", domain: "ualberta.ca" },
  ucalgary: { name: "University of Calgary", domain: "ucalgary.ca" },
  western: { name: "Western University", domain: "uwo.ca" },
  queens: { name: "Queen's University", domain: "queensu.ca" },
  yorku: { name: "York University", domain: "yorku.ca" },
  sfu: { name: "Simon Fraser University", domain: "sfu.ca" },
  uottawa: { name: "University of Ottawa", domain: "uottawa.ca" },
  bcpublic: { name: "BC Public Service", domain: "gov.bc.ca" },
  ontariopublic: { name: "Ontario Public Service", domain: "ontario.ca" },
  govab: { name: "Government of Alberta", domain: "alberta.ca" },
  govsk: { name: "Government of Saskatchewan", domain: "saskatchewan.ca" },
  govmb: { name: "Government of Manitoba", domain: "gov.mb.ca" },
  govns: { name: "Government of Nova Scotia", domain: "novascotia.ca" },
  govnb: { name: "Government of New Brunswick", domain: "gnb.ca" },
  govnl: { name: "Government of Newfoundland and Labrador", domain: "gov.nl.ca" },
  govpei: { name: "Government of PEI", domain: "princeedwardisland.ca" },
  govyk: { name: "Government of Yukon", domain: "yukon.ca" },
  govnt: { name: "Government of Northwest Territories", domain: "gov.nt.ca" },
  govnu: { name: "Government of Nunavut", domain: "gov.nu.ca" },
  uhn: { name: "University Health Network", domain: "uhn.ca" },
  sickkids: { name: "SickKids", domain: "sickkids.ca" },
  sunnybrook: { name: "Sunnybrook", domain: "sunnybrook.ca" },
  ahs: { name: "Alberta Health Services", domain: "albertahealthservices.ca" },
  fraserhealth: { name: "Fraser Health", domain: "fraserhealth.ca" },
  vch: { name: "Vancouver Coastal Health", domain: "vch.ca" },
  providence: { name: "Providence Health Care", domain: "providencehealthcare.org" },
  ttc: { name: "Toronto Transit Commission", domain: "ttc.ca" },
  metrolinx: { name: "Metrolinx", domain: "metrolinx.com" },
} satisfies Record<string, CompanyEntry>;

// ---------------------------------------------------------------------------
// Category arrays - reference companies from the registry by key
// ---------------------------------------------------------------------------

const FAANG_PLUS: CompanyEntry[] = [
  C.google, C.meta, C.apple, C.amazon, C.microsoft, C.netflix,
  C.salesforce, C.oracle, C.adobe, C.ibm, C.intel, C.cisco,
  C.vmware, C.dell, C.hp, C.nvidia, C.amd, C.qualcomm,
  C.servicenow, C.palantir, C.snowflake, C.uber,
];

const TOP_TECH: CompanyEntry[] = [
  C.stripe, C.vercel, C.linear, C.notion, C.figma, C.shopify,
  C.datadog, C.cloudflare, C.gitlab, C.postman, C.twilio,
  C.mongodb, C.elastic, C.hashicorp, C.confluent, C.databricks,
  C.supabase, C.planetscale, C.neon, C.railway, C.flyio, C.render,
  C.digitalocean, C.akamai, C.fastly, C.sentry, C.launchdarkly,
  C.splitio, C.segment, C.amplitude, C.grafana, C.hubspot,
];

const UNICORNS: CompanyEntry[] = [
  C.canva, C.miro, C.airtable, C.retool, C.webflow, C.loom,
  C.calendly, C.grammarly, C.plaid, C.brex, C.ramp, C.mercury,
  C.chime, C.rippling, C.deel, C.remotecom, C.gusto, C.lattice,
  C.cultureamp, C.gong, C.outreach, C.salesloft, C.highspot,
  C.seismic, C.zoominfo, C.sixsense, C.discord, C.scaleai, C.vanta,
  C.stripe, C.databricks,
];

const YC_COMPANIES: CompanyEntry[] = [
  C.airbnb, C.doordash, C.instacart, C.coinbase, C.dropbox,
  C.reddit, C.stripe, C.twitch, C.gitlab, C.zapier, C.algolia,
  C.segment, C.faire, C.razorpay, C.coda, C.replit, C.railway,
  C.supabase, C.posthog, C.calcom, C.mintlify, C.resend,
  C.vercel, C.gusto, C.retool, C.webflow, C.linear, C.brex,
];

const FINTECH: CompanyEntry[] = [
  C.plaid, C.stripe, C.square, C.robinhood, C.chime, C.sofi,
  C.affirm, C.klarna, C.wise, C.brex, C.ramp, C.mercury,
  C.marqeta, C.toast, C.billcom, C.adyen, C.checkoutcom, C.nuvei,
  C.coinbase,
];

const REMOTE_FIRST: CompanyEntry[] = [
  C.gitlab, C.zapier, C.buffer, C.automattic, C.invision,
  C.toptal, C.doist, C.close, C.helpscout, C.hotjar, C.loom,
  C.notion, C.linear, C.posthog, C.calcom, C.remotecom, C.deel,
  C.oyster, C.velocityglobal, C.onepassword, C.shopify,
];

const CANADIAN_TECH: CompanyEntry[] = [
  C.shopify, C.wealthsimple, C.clio, C.jobber, C.benevity,
  C.hootsuite, C.vidyard, C.applyboard, C.clearco, C.tophat,
  C.coveo, C.lightspeed, C.nuvei, C.dialogue, C.cohere, C.ada,
  C.maropost, C.freshbooks, C.wave, C.touchbistro, C.d2l,
  C.dapperlabs, C.hopper, C.janeapp, C.koho, C.league,
  C.magnetforensics, C.pointclickcare, C.thinkific, C.wattpad,
];

const AI_ML: CompanyEntry[] = [
  C.openai, C.anthropic, C.cohere, C.stabilityai, C.huggingface,
  C.scaleai, C.wandb, C.labelbox, C.snorkelai, C.anyscale,
  C.modal, C.replicate, C.midjourney, C.runway, C.jasper,
  C.copyai, C.writer, C.glean, C.pinecone, C.weaviate, C.qdrant,
  C.chroma, C.togetherai, C.mistralai, C.perplexity, C.elevenlabs,
  C.langchain, C.databricks,
];

const PUBLIC_TECH: CompanyEntry[] = [
  C.atlassian, C.asana, C.box, C.confluent, C.crowdstrike,
  C.docusign, C.digitalocean, C.doordash, C.etsy, C.github,
  C.mondaycom, C.mongodb, C.newrelic, C.okta, C.pagerduty,
  C.paloalto, C.robinhood, C.samsara, C.servicenow, C.snowflake,
  C.sofi, C.splunk, C.wayfair, C.workday, C.zoom, C.zoominfo,
  C.zscaler, C.verkada, C.sourcegraph, C.docker, C.canonical,
  C.cockroachlabs, C.dbtlabs, C.openphone, C.turing,
];

const US_SEMICONDUCTORS: CompanyEntry[] = [
  C.amd, C.qualcomm, C.broadcom, C.micron, C.ti, C.appliedmaterials,
  C.lamresearch, C.kla, C.synopsys, C.cadence, C.arm,
  C.globalfoundries, C.nxp, C.analogdevices, C.marvell, C.seagate,
  C.westerndigital, C.keysight, C.nvidia, C.intel,
];

const QUANT_FINANCE: CompanyEntry[] = [
  C.janestreet, C.twosigma, C.hrt, C.citadel, C.citadelsec,
  C.deshaw, C.drw, C.jumptrading, C.imc, C.optiver,
  C.susquehanna, C.akunacapital, C.cboe, C.cmegroup, C.nasdaq,
  C.bloomberg,
];

const AEROSPACE_AUTONOMY: CompanyEntry[] = [
  C.spacex, C.blueorigin, C.anduril, C.waymo, C.zoox, C.aurora,
  C.cruise, C.shieldai, C.joby, C.archer, C.relativity,
  C.rocketlab, C.boeing, C.northropgrumman, C.lockheed, C.rtx,
  C.generaldynamics, C.l3harris,
];

const BIOPHARMA_HEALTH: CompanyEntry[] = [
  C.moderna, C.regeneron, C.genentech, C.amgen, C.gilead,
  C.illumina, C.thermofisher, C.danaher, C.pfizer, C.merck,
  C.bms, C.biogen, C.vertex, C.roche, C.abbvie, C.medtronic,
  C.bostonscientific, C.guardanthealth, C.tempus,
];

const CANADA_ENTERPRISE: CompanyEntry[] = [
  C.rbc, C.td, C.scotiabank, C.bmo, C.cibc, C.nbc, C.desjardins,
  C.manulife, C.sunlife, C.intactfinancial, C.definity,
  C.brookfield, C.cgi, C.opentext, C.kinaxis, C.constellation,
  C.telus, C.bell, C.rogers, C.cogeco, C.quebecor, C.aircanada,
  C.westjet, C.porter, C.cae, C.bombardier, C.cn, C.cpkc,
  C.loblaw, C.sobeys, C.metro, C.canadiantire, C.dollarama,
  C.enbridge, C.tcenergy, C.suncor, C.nutrien, C.hydroone,
  C.opg, C.bce,
];

const CANADA_PUBLIC: CompanyEntry[] = [
  C.uoft, C.ubc, C.mcgill, C.uwaterloo, C.mcmaster, C.ualberta,
  C.ucalgary, C.western, C.queens, C.yorku, C.sfu, C.uottawa,
  C.bcpublic, C.ontariopublic, C.govab, C.govsk, C.govmb,
  C.govns, C.govnb, C.govnl, C.govpei, C.govyk, C.govnt, C.govnu,
  C.uhn, C.sickkids, C.sunnybrook, C.ahs, C.fraserhealth, C.vch,
  C.providence, C.ttc, C.metrolinx,
];

// ---------------------------------------------------------------------------
// Category map
// ---------------------------------------------------------------------------

const CATEGORY_MAP: Record<CompanyCategory, CompanyEntry[]> = {
  FAANG_PLUS,
  TOP_TECH,
  UNICORNS,
  YC_COMPANIES,
  FINTECH,
  REMOTE_FIRST,
  CANADIAN_TECH,
  AI_ML,
  PUBLIC_TECH,
  US_SEMICONDUCTORS,
  QUANT_FINANCE,
  AEROSPACE_AUTONOMY,
  BIOPHARMA_HEALTH,
  CANADA_ENTERPRISE,
  CANADA_PUBLIC,
};

/**
 * Get the list of companies for a given category.
 */
export function getCompanyList(category: CompanyCategory): CompanyEntry[] {
  return CATEGORY_MAP[category] ?? [];
}

/**
 * Get all company entries across every category (deduplicated by domain).
 */
export function getAllCompanies(): CompanyEntry[] {
  const seen = new Set<string>();
  const result: CompanyEntry[] = [];

  for (const list of Object.values(CATEGORY_MAP)) {
    for (const entry of list) {
      if (!seen.has(entry.domain)) {
        seen.add(entry.domain);
        result.push(entry);
      }
    }
  }

  return result;
}

/**
 * Get all available category names.
 */
export function getCategories(): CompanyCategory[] {
  return Object.keys(CATEGORY_MAP) as CompanyCategory[];
}

/**
 * Seed a specific category of companies into the database.
 * Returns a summary of what was created vs skipped.
 */
export async function seedCategory(category: CompanyCategory): Promise<{
  created: number;
  skipped: number;
  sourcesCreated: number;
}> {
  const entries = getCompanyList(category);
  let created = 0;
  let skipped = 0;
  let sourcesCreated = 0;

  for (const entry of entries) {
    const existing = await prisma.company.findUnique({
      where: { domain: entry.domain },
    });

    if (existing) {
      skipped++;
      // Still try to add a source if we have ATS info and one doesn't exist yet
      sourcesCreated += await ensureSources(existing.id, entry);
      continue;
    }

    const company = await prisma.company.create({
      data: {
        name: entry.name,
        domain: entry.domain,
        detectedATS: entry.knownATS ?? null,
        crawlStatus: "PENDING",
        trustScore: entry.knownATS ? 0.7 : 0.5,
      },
    });
    created++;

    sourcesCreated += await ensureSources(company.id, entry);
  }

  return { created, skipped, sourcesCreated };
}

/**
 * Seed all categories into the database.
 */
export async function seedAllCategories(): Promise<{
  created: number;
  skipped: number;
  sourcesCreated: number;
}> {
  const totals = { created: 0, skipped: 0, sourcesCreated: 0 };

  for (const category of getCategories()) {
    const result = await seedCategory(category);
    totals.created += result.created;
    totals.skipped += result.skipped;
    totals.sourcesCreated += result.sourcesCreated;
  }

  return totals;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSourceUrl(atsType: ATSType, boardToken: string): string {
  switch (atsType) {
    case "GREENHOUSE":
      return `https://boards.greenhouse.io/${boardToken}`;
    case "LEVER":
      return `https://jobs.lever.co/${boardToken}`;
    case "ASHBY":
      return `https://jobs.ashbyhq.com/${boardToken}`;
    case "SMARTRECRUITERS":
      return `https://jobs.smartrecruiters.com/${boardToken}`;
    default:
      return `https://${boardToken}`;
  }
}

function getSeededCareersSource(url: string): {
  sourceType: "CAREER_PAGE" | "ATS_BOARD";
  atsType: ATSType;
  boardToken?: string;
} {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathSegments = parsed.pathname.split("/").filter(Boolean);

    if (hostname.endsWith("greenhouse.io")) {
      return {
        sourceType: "ATS_BOARD",
        atsType: "GREENHOUSE",
        boardToken: pathSegments[0],
      };
    }

    if (hostname.endsWith("lever.co")) {
      return {
        sourceType: "ATS_BOARD",
        atsType: "LEVER",
        boardToken: pathSegments[0],
      };
    }

    if (hostname.endsWith("ashbyhq.com")) {
      return {
        sourceType: "ATS_BOARD",
        atsType: "ASHBY",
        boardToken: pathSegments[0],
      };
    }

    if (hostname.endsWith("smartrecruiters.com")) {
      return {
        sourceType: "ATS_BOARD",
        atsType: "SMARTRECRUITERS",
        boardToken: pathSegments[0],
      };
    }

    if (hostname.endsWith("workable.com")) {
      return {
        sourceType: "ATS_BOARD",
        atsType: "WORKABLE",
        boardToken: pathSegments[0],
      };
    }

    if (hostname.includes("myworkdayjobs.com")) {
      return {
        sourceType: "ATS_BOARD",
        atsType: "WORKDAY",
      };
    }

    if (hostname.endsWith("teamtailor.com")) {
      const [subdomain] = hostname.split(".");
      return {
        sourceType: "ATS_BOARD",
        atsType: "TEAMTAILOR",
        boardToken: subdomain,
      };
    }

    if (hostname.endsWith("recruitee.com")) {
      const [subdomain] = hostname.split(".");
      return {
        sourceType: "ATS_BOARD",
        atsType: "RECRUITEE",
        boardToken: subdomain,
      };
    }
  } catch {
    // Fall through to generic company page handling.
  }

  return {
    sourceType: "CAREER_PAGE",
    atsType: "CUSTOM_SITE",
  };
}

async function ensureSources(
  companyId: string,
  entry: CompanyEntry,
): Promise<number> {
  let created = 0;

  if (entry.knownATS && entry.knownBoardToken) {
    const sourceUrl = getSourceUrl(entry.knownATS, entry.knownBoardToken);
    const existing = await prisma.companySource.findUnique({
      where: { companyId_sourceUrl: { companyId, sourceUrl } },
      select: { id: true },
    });

    await prisma.companySource.upsert({
      where: { companyId_sourceUrl: { companyId, sourceUrl } },
      update: {
        sourceType: "ATS_BOARD",
        atsType: entry.knownATS,
        boardToken: entry.knownBoardToken,
        isActive: true,
        priority: 2,
        metadata: {
          seededFromCatalog: true,
          verificationState: "UNVERIFIED",
        },
      },
      create: {
        companyId,
        sourceType: "ATS_BOARD",
        atsType: entry.knownATS,
        sourceUrl,
        boardToken: entry.knownBoardToken,
        isVerified: false,
        isActive: true,
        priority: 2,
        metadata: {
          seededFromCatalog: true,
          verificationState: "UNVERIFIED",
        },
      },
    });

    if (!existing) {
      created++;
    }
  }

  if (entry.knownCareersUrl) {
    const seededSource = getSeededCareersSource(entry.knownCareersUrl);
    const existing = await prisma.companySource.findUnique({
      where: {
        companyId_sourceUrl: {
          companyId,
          sourceUrl: entry.knownCareersUrl,
        },
      },
      select: { id: true },
    });

    await prisma.companySource.upsert({
      where: {
        companyId_sourceUrl: {
          companyId,
          sourceUrl: entry.knownCareersUrl,
        },
      },
      update: {
        sourceType: seededSource.sourceType,
        atsType: seededSource.atsType,
        boardToken: seededSource.boardToken,
        isActive: true,
        priority: 1,
        metadata: {
          seededFromCatalog: true,
          verificationState: "UNVERIFIED",
          sourceHint: "KNOWN_CAREERS_URL",
        },
      },
      create: {
        companyId,
        sourceType: seededSource.sourceType,
        atsType: seededSource.atsType,
        sourceUrl: entry.knownCareersUrl,
        boardToken: seededSource.boardToken,
        isVerified: false,
        isActive: true,
        priority: 1,
        metadata: {
          seededFromCatalog: true,
          verificationState: "UNVERIFIED",
          sourceHint: "KNOWN_CAREERS_URL",
        },
      },
    });

    if (!existing) {
      created++;
    }
  }

  return created;
}
