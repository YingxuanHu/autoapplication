export type EnterpriseAtsHint =
  | "workday"
  | "successfactors"
  | "both"
  | "unknown";

export type EnterpriseCompanyRecord = {
  name: string;
  searchTerms?: string[];
  tenants: string[];
  domains?: string[];
  wdVariants?: string[];
  wdSites?: string[];
  sfHosts?: string[];
  sfPaths?: string[];
  seedPageUrls?: string[];
  ats: EnterpriseAtsHint;
  sectors: string[];
  canadaCities?: string[];
  canadaHq?: boolean;
  remoteCanadaLikely?: boolean;
};

export const ENTERPRISE_DISCOVERY_COMPANIES: EnterpriseCompanyRecord[] = [
  { name: "TD Bank", tenants: ["td", "tdbank"], domains: ["td.com"], seedPageUrls: ["https://careers.td.com/"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "RBC", tenants: ["rbc", "royalbank"], domains: ["rbc.com"], seedPageUrls: ["https://jobs.rbc.com/ca/en"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Toronto", "Montreal"], canadaHq: true },
  { name: "BMO", tenants: ["bmo"], domains: ["bmo.com"], seedPageUrls: ["https://jobs.bmo.com/ca/en"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Toronto", "Montreal"], canadaHq: true },
  { name: "CIBC", tenants: ["cibc"], domains: ["cibc.com"], seedPageUrls: ["https://careers.cibc.com/ca/en/"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "National Bank", searchTerms: ["National Bank of Canada"], tenants: ["nbc", "bnc", "nationalbank"], domains: ["banquenationale.ca", "bnc.ca"], seedPageUrls: ["https://emplois.bnc.ca/fr_CA/careers"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Montreal"], canadaHq: true },
  { name: "Desjardins", tenants: ["desjardins"], domains: ["desjardins.com"], seedPageUrls: ["https://www.desjardins.com/en/careers.html"], ats: "workday", sectors: ["finance", "insurance"], canadaCities: ["Montreal", "Quebec City"], canadaHq: true },
  { name: "Power Corp", tenants: ["powercorp", "powercorporation"], domains: ["powercorporation.com"], ats: "unknown", sectors: ["finance", "insurance"], canadaCities: ["Montreal"], canadaHq: true },
  { name: "Telus", tenants: ["telus"], domains: ["telus.com"], ats: "unknown", sectors: ["telecom", "tech"], canadaCities: ["Vancouver", "Toronto", "Calgary"], canadaHq: true, seedPageUrls: ["https://careers.telus.com/"] },
  { name: "Rogers", tenants: ["rogers"], domains: ["rogers.com"], ats: "unknown", sectors: ["telecom", "media"], canadaCities: ["Toronto"], canadaHq: true, seedPageUrls: ["https://jobs.rogers.com/"] },
  { name: "Bell", tenants: ["bell", "bce"], domains: ["bell.ca", "bce.ca"], ats: "both", sectors: ["telecom", "media"], canadaCities: ["Montreal", "Toronto"], canadaHq: true, sfHosts: ["jobs.bce.ca"] },
  { name: "Hydro One", tenants: ["hydroone"], ats: "successfactors", sectors: ["utilities", "energy"], canadaCities: ["Toronto"], canadaHq: true, sfHosts: ["jobs.hydroone.com"], seedPageUrls: ["https://jobs.hydroone.com/search/?createNewAlert=false&q=&locationsearch=&sortColumn=referencedate&sortDirection=desc"] },
  { name: "Aecon", tenants: ["aecon"], ats: "successfactors", sectors: ["infrastructure", "construction", "engineering"], canadaCities: ["Toronto", "Calgary", "Vancouver"], canadaHq: true, sfHosts: ["jobs.aecon.com"], seedPageUrls: ["https://jobs.aecon.com/search/?createNewAlert=false&q=&locationsearch=&sortColumn=referencedate&sortDirection=desc"] },
  { name: "Ontario Power Generation", tenants: ["opg"], ats: "successfactors", sectors: ["utilities", "energy"], canadaCities: ["Toronto", "Pickering"], canadaHq: true, sfHosts: ["jobs.opg.com"], seedPageUrls: ["https://jobs.opg.com/search/?createNewAlert=false&q=&locationsearch=&sortColumn=referencedate&sortDirection=desc"] },
  { name: "Ornge", tenants: ["ornge"], domains: ["ornge.ca"], seedPageUrls: ["https://jobs.jobvite.com/ornge/jobs", "https://www.ornge.ca/careers"], ats: "unknown", sectors: ["healthcare", "aviation", "emergency services"], canadaCities: ["Mississauga", "Sudbury", "Thunder Bay"], canadaHq: true },
  { name: "Triton Digital", tenants: ["triton-digital"], domains: ["tritondigital.com"], seedPageUrls: ["https://jobs.jobvite.com/triton-digital/jobs", "https://www.tritondigital.com/careers/"], ats: "unknown", sectors: ["software", "adtech", "media"], canadaCities: ["Montreal", "Toronto"], canadaHq: false, remoteCanadaLikely: true },
  { name: "NinjaOne", tenants: ["ninjaone"], domains: ["ninjaone.com"], seedPageUrls: ["https://jobs.jobvite.com/ninjaone/jobs", "https://www.ninjaone.com/company/careers/"], ats: "unknown", sectors: ["software", "it operations", "security"], remoteCanadaLikely: true },
  { name: "4C", searchTerms: ["4C Insights"], tenants: ["4ccareers"], domains: ["4cinsights.com"], seedPageUrls: ["https://jobs.jobvite.com/4ccareers/jobs"], ats: "unknown", sectors: ["software", "adtech", "marketing"], remoteCanadaLikely: true },
  { name: "Optimizely", tenants: ["optimizely"], domains: ["optimizely.com"], seedPageUrls: ["https://jobs.jobvite.com/optimizely/jobs", "https://www.optimizely.com/company/careers/"], ats: "unknown", sectors: ["software", "martech", "experimentation"], remoteCanadaLikely: true },
  { name: "Uplight", tenants: ["uplight"], domains: ["uplight.com"], seedPageUrls: ["https://jobs.jobvite.com/uplight/jobs", "https://uplight.com/company/careers/"], ats: "unknown", sectors: ["software", "energy", "climate tech"], remoteCanadaLikely: true },
  { name: "Wind River", tenants: ["windriver"], domains: ["windriver.com"], seedPageUrls: ["https://jobs.jobvite.com/windriver/jobs", "https://www.windriver.com/company/careers"], ats: "unknown", sectors: ["software", "embedded systems", "cloud infrastructure"], canadaCities: ["Kanata", "Ottawa"], remoteCanadaLikely: true },
  { name: "Venterra", tenants: ["venterra"], domains: ["venterraliving.com"], seedPageUrls: ["https://jobs.jobvite.com/venterra/jobs", "https://venterraliving.com/careers/"], ats: "unknown", sectors: ["real estate", "property operations", "proptech"], canadaCities: ["Richmond Hill"], remoteCanadaLikely: false },
  { name: "Point of Rental", tenants: ["pointofrental"], domains: ["pointofrental.com"], seedPageUrls: ["https://jobs.jobvite.com/pointofrental/jobs", "https://www.pointofrental.com/about/careers/"], ats: "unknown", sectors: ["software", "equipment rental", "vertical SaaS"], remoteCanadaLikely: false },
  { name: "Forescout", tenants: ["forescout"], domains: ["forescout.com"], seedPageUrls: ["https://jobs.jobvite.com/forescout/jobs", "https://www.forescout.com/company/careers/"], ats: "unknown", sectors: ["security", "networking", "software"], remoteCanadaLikely: true },
  { name: "Voices", tenants: ["voices"], domains: ["voices.com"], seedPageUrls: ["https://jobs.jobvite.com/voices/jobs"], ats: "unknown", sectors: ["software", "creator economy", "media"], canadaCities: ["Toronto", "London"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Security Finance", tenants: ["securityfinance"], domains: ["securityfinance.com"], seedPageUrls: ["https://jobs.jobvite.com/securityfinance/jobs"], ats: "unknown", sectors: ["finance", "consumer lending"], remoteCanadaLikely: false },
  { name: "Egnyte", tenants: ["egnyte"], domains: ["egnyte.com"], seedPageUrls: ["https://jobs.jobvite.com/egnyte/jobs"], ats: "unknown", sectors: ["software", "security", "cloud storage"], remoteCanadaLikely: true },
  { name: "Mattamy Homes", tenants: ["mattamyhomes"], domains: ["mattamyhomes.com"], seedPageUrls: ["https://jobs.jobvite.com/mattamyhomes/jobs", "https://www.mattamyhomes.com/careers"], ats: "unknown", sectors: ["real estate", "construction", "proptech"], canadaCities: ["Toronto", "Ottawa"], canadaHq: true, remoteCanadaLikely: false },
  { name: "Versa Networks", tenants: ["versa-networks"], domains: ["versa-networks.com"], seedPageUrls: ["https://jobs.jobvite.com/versa-networks/jobs", "https://versa-networks.com/company/careers/"], ats: "unknown", sectors: ["security", "networking", "software"], remoteCanadaLikely: true },
  { name: "Barcodes, Inc.", tenants: ["barcodesinc"], domains: ["barcodesinc.com"], seedPageUrls: ["https://jobs.jobvite.com/barcodesinc/jobs", "https://www.barcodesinc.com/about/careers.htm"], ats: "unknown", sectors: ["commerce", "hardware", "enterprise software"], canadaCities: ["Markham"], remoteCanadaLikely: false },
  { name: "Ziff Davis Consumer Tech", searchTerms: ["CNET Group", "Mashable", "Lifehacker"], tenants: ["consumer-tech"], domains: ["ziffdavis.com", "cnet.com"], seedPageUrls: ["https://jobs.jobvite.com/consumer-tech/jobs", "https://www.ziffdavis.com/careers"], ats: "unknown", sectors: ["media", "software", "consumer tech"], remoteCanadaLikely: true },
  { name: "Absolute Security", searchTerms: ["Absolute"], tenants: ["absolute"], domains: ["absolute.com"], seedPageUrls: ["https://jobs.jobvite.com/absolute/jobs", "https://www.absolute.com/company/careers/"], ats: "unknown", sectors: ["security", "endpoint", "software"], canadaCities: ["Vancouver"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Longo's", searchTerms: ["Longos"], tenants: ["longos"], domains: ["longos.com"], seedPageUrls: ["https://jobs.jobvite.com/longos/jobs", "https://www.longos.com/careers"], ats: "unknown", sectors: ["retail", "grocery"], canadaCities: ["Toronto", "Oakville", "Burlington"], canadaHq: true, remoteCanadaLikely: false },
  { name: "Pinnacle Live", tenants: ["pinnaclelive"], domains: ["pinnaclelive.com"], seedPageUrls: ["https://jobs.jobvite.com/pinnaclelive/jobs", "https://pinnaclelive.com/careers/"], ats: "unknown", sectors: ["event technology", "media", "field operations"], remoteCanadaLikely: false },
  { name: "Moneycorp", tenants: ["moneycorp"], domains: ["moneycorp.com"], seedPageUrls: ["https://jobs.jobvite.com/moneycorp/jobs", "https://www.moneycorp.com/en-us/careers/"], ats: "unknown", sectors: ["fintech", "payments", "foreign exchange"], canadaCities: ["Toronto"], remoteCanadaLikely: false },
  { name: "Open Lending", tenants: ["openlending"], domains: ["openlending.com"], seedPageUrls: ["https://jobs.jobvite.com/openlending/jobs", "https://www.openlending.com/careers/"], ats: "unknown", sectors: ["fintech", "lending", "software"], remoteCanadaLikely: false },
  { name: "EcoOnline", tenants: ["ecoonline"], domains: ["ecoonline.com"], seedPageUrls: ["https://ecoonline.teamtailor.com/jobs", "https://www.ecoonline.com/careers/"], ats: "unknown", sectors: ["software", "environmental health and safety", "compliance"], canadaCities: ["Toronto"], remoteCanadaLikely: true },
  { name: "Teamtailor", tenants: ["career"], domains: ["teamtailor.com"], seedPageUrls: ["https://career.teamtailor.com/jobs"], ats: "unknown", sectors: ["software", "recruiting tech"], remoteCanadaLikely: true },
  { name: "Planet", searchTerms: ["Planet Labs"], tenants: ["planet", "planetlabs"], domains: ["planet.com"], seedPageUrls: ["https://job-boards.greenhouse.io/planetlabs"], ats: "unknown", sectors: ["space", "data", "geospatial"], remoteCanadaLikely: true },
  { name: "Xplor Technologies", searchTerms: ["Xplor"], tenants: ["xplor"], seedPageUrls: ["https://careers.smartrecruiters.com/Xplor"], ats: "unknown", sectors: ["software", "payments", "vertical SaaS"], remoteCanadaLikely: true },
  { name: "CloudMoyo", tenants: ["cloudmoyo"], domains: ["cloudmoyo.com"], seedPageUrls: ["https://careers.smartrecruiters.com/CloudMoyo/cloudmoyo-north-america-careers"], ats: "unknown", sectors: ["software", "consulting", "cloud"], remoteCanadaLikely: true },
  { name: "Forsta", tenants: ["forsta"], domains: ["forsta.com"], seedPageUrls: ["https://careers.smartrecruiters.com/Forsta"], ats: "unknown", sectors: ["software", "market research", "experience management"], remoteCanadaLikely: true },
  { name: "Aptive Environmental", searchTerms: ["Aptive"], tenants: ["aptive"], seedPageUrls: ["https://careers.smartrecruiters.com/AptiveEnvironmental1"], ats: "unknown", sectors: ["home services", "field operations"], remoteCanadaLikely: false },
  { name: "Intercom", tenants: ["intercom"], domains: ["intercom.com"], seedPageUrls: ["https://www.intercom.com/careers"], ats: "unknown", sectors: ["software", "customer support", "saas"], remoteCanadaLikely: true },
  { name: "Mercury", tenants: ["mercury"], domains: ["mercury.com"], seedPageUrls: ["https://mercury.com/jobs"], ats: "unknown", sectors: ["fintech", "banking", "saas"], remoteCanadaLikely: true },
  { name: "Braze", tenants: ["braze"], domains: ["braze.com"], seedPageUrls: ["https://www.braze.com/company/careers"], ats: "unknown", sectors: ["software", "martech", "saas"], remoteCanadaLikely: true },
  { name: "Calendly", tenants: ["calendly"], domains: ["calendly.com"], seedPageUrls: ["https://calendly.com/careers"], ats: "unknown", sectors: ["software", "productivity", "saas"], remoteCanadaLikely: true },
  { name: "Airbnb", tenants: ["airbnb"], domains: ["airbnb.com"], seedPageUrls: ["https://careers.airbnb.com/"], ats: "unknown", sectors: ["travel", "marketplace", "software"], remoteCanadaLikely: true },
  { name: "Betterment", tenants: ["betterment"], domains: ["betterment.com"], seedPageUrls: ["https://www.betterment.com/careers"], ats: "unknown", sectors: ["fintech", "wealth management", "software"], remoteCanadaLikely: true },
  { name: "Shaw / Freedom", tenants: ["shaw", "freedom"], domains: ["shaw.ca", "freedommobile.ca"], seedPageUrls: ["https://www.freedommobile.ca/en-CA/careers"], ats: "workday", sectors: ["telecom"], canadaCities: ["Calgary", "Vancouver"], canadaHq: true },
  { name: "Shopify", tenants: ["shopify"], ats: "unknown", sectors: ["ecommerce", "tech"], canadaCities: ["Toronto", "Ottawa"], canadaHq: true, remoteCanadaLikely: true, seedPageUrls: ["https://www.shopify.com/careers"] },
  { name: "OpenText", tenants: ["opentext"], ats: "unknown", sectors: ["enterprise software"], canadaCities: ["Waterloo", "Toronto"], canadaHq: true, seedPageUrls: ["https://careers.opentext.com/"] },
  { name: "BlackBerry", tenants: ["bb", "blackberry"], domains: ["blackberry.com"], ats: "workday", sectors: ["security", "iot"], canadaCities: ["Waterloo", "Ottawa"], canadaHq: true },
  { name: "CGI", tenants: ["cgi"], ats: "unknown", sectors: ["consulting", "it services"], canadaCities: ["Montreal", "Toronto", "Ottawa"], canadaHq: true, seedPageUrls: ["https://www.cgi.com/en/careers"] },
  { name: "Manulife", tenants: ["manulife"], domains: ["manulife.com"], ats: "workday", sectors: ["insurance", "finance"], canadaCities: ["Toronto", "Montreal", "Waterloo"], canadaHq: true },
  { name: "Sun Life", searchTerms: ["Sun Life Financial"], tenants: ["sunlife"], domains: ["sunlife.com"], ats: "workday", sectors: ["insurance", "finance"], canadaCities: ["Toronto", "Waterloo", "Montreal"], canadaHq: true },
  { name: "Intact Financial", tenants: ["intact"], domains: ["intactfc.com"], ats: "workday", sectors: ["insurance", "finance"], canadaCities: ["Toronto", "Montreal", "Calgary"], canadaHq: true },
  { name: "Great-West Lifeco", searchTerms: ["Canada Life"], tenants: ["greatwestlifeco", "gwl", "canadalifeassurance"], domains: ["greatwestlifeco.com", "canadalife.com"], ats: "workday", sectors: ["insurance", "finance"], canadaCities: ["Winnipeg", "Toronto"], canadaHq: true },
  { name: "Thomson Reuters", tenants: ["thomsonreuters"], domains: ["thomsonreuters.com"], ats: "workday", sectors: ["data", "legal tech", "finance"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Brookfield", tenants: ["brookfield"], domains: ["brookfield.com"], ats: "workday", sectors: ["finance", "infrastructure"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "OMERS", tenants: ["omers"], domains: ["omers.com"], ats: "workday", sectors: ["finance", "pension"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "CPP Investments", tenants: ["cppinvestments", "cppib"], domains: ["cppinvestments.com"], ats: "workday", sectors: ["finance", "pension"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Ontario Teachers", tenants: ["otppb", "otpp"], domains: ["otpp.com"], ats: "workday", sectors: ["finance", "pension"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Kinaxis", tenants: ["kinaxis"], domains: ["kinaxis.com"], ats: "workday", sectors: ["supply chain", "enterprise software"], canadaCities: ["Ottawa", "Toronto"], canadaHq: true },
  { name: "Descartes Systems", tenants: ["descartes"], domains: ["descartes.com"], ats: "workday", sectors: ["logistics", "enterprise software"], canadaCities: ["Waterloo"], canadaHq: true },
  { name: "Lightspeed", tenants: ["lightspeed", "lightspeedcommerce"], domains: ["lightspeedhq.com"], ats: "workday", sectors: ["commerce", "fintech"], canadaCities: ["Montreal"], canadaHq: true },
  { name: "Nuvei", tenants: ["nuvei"], domains: ["nuvei.com"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: ["Montreal"], canadaHq: true },
  { name: "Constellation Software", tenants: ["csisoftware", "constellation"], domains: ["csisoftware.com"], ats: "workday", sectors: ["enterprise software"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Clio", tenants: ["clio", "themis"], domains: ["clio.com"], ats: "workday", sectors: ["legal tech"], canadaCities: ["Vancouver", "Toronto", "Calgary"], canadaHq: true, remoteCanadaLikely: true },
  { name: "PointClickCare", tenants: ["pointclickcare"], domains: ["pointclickcare.com"], ats: "workday", sectors: ["healthtech", "enterprise software"], canadaCities: ["Toronto", "Waterloo"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Interac", tenants: ["interac"], domains: ["interac.ca"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "TMX Group", searchTerms: ["TMX"], tenants: ["tmxgroup", "tmx"], ats: "unknown", sectors: ["finance", "markets", "data"], canadaCities: ["Toronto"], canadaHq: true, seedPageUrls: ["https://careers.tmx.com/"] },
  { name: "Questrade", tenants: ["questrade"], ats: "unknown", sectors: ["fintech", "brokerage"], canadaCities: ["Toronto"], canadaHq: true, seedPageUrls: ["https://www.questrade.com/about-questrade/careers"] },
  { name: "Bank of Canada", searchTerms: ["Banque du Canada"], tenants: ["bankofcanada", "banqueducanada"], domains: ["bankofcanada.ca"], ats: "workday", sectors: ["finance", "research"], canadaCities: ["Ottawa"], canadaHq: true },
  { name: "BDC", tenants: ["bdc"], domains: ["bdc.ca"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Montreal", "Toronto"], canadaHq: true },
  { name: "Export Development Canada", searchTerms: ["EDC"], tenants: ["edc"], ats: "unknown", sectors: ["finance", "trade"], canadaCities: ["Ottawa", "Toronto"], canadaHq: true, seedPageUrls: ["https://www.edc.ca/en/about-us/careers.html"] },
  { name: "iA Financial Group", searchTerms: ["iA", "Industrial Alliance"], tenants: ["iafinancial", "ia"], ats: "unknown", sectors: ["insurance", "finance"], canadaCities: ["Quebec City", "Toronto"], canadaHq: true, seedPageUrls: ["https://www.ia.ca/careers"] },
  { name: "Toronto Hydro", tenants: ["torontohydro"], ats: "unknown", sectors: ["utilities", "energy"], canadaCities: ["Toronto"], canadaHq: true, seedPageUrls: ["https://www.torontohydro.com/about-us/careers"] },
  { name: "FortisBC", tenants: ["fortisbc"], ats: "unknown", sectors: ["utilities", "energy"], canadaCities: ["Vancouver"], canadaHq: true, seedPageUrls: ["https://www.fortisbc.com/about-us/careers"] },
  { name: "Cameco", tenants: ["cameco"], ats: "unknown", sectors: ["energy", "materials"], canadaCities: ["Saskatoon"], canadaHq: true, seedPageUrls: ["https://www.cameco.com/careers"] },
  { name: "TC Energy", tenants: ["tcenergy"], domains: ["tcenergy.com"], ats: "workday", sectors: ["energy", "infrastructure"], canadaCities: ["Calgary"], canadaHq: true },
  { name: "Enbridge", tenants: ["enbridge"], domains: ["enbridge.com"], ats: "workday", sectors: ["energy", "infrastructure"], canadaCities: ["Calgary", "Toronto"], canadaHq: true },
  { name: "Suncor", tenants: ["suncor"], domains: ["suncor.com"], ats: "workday", sectors: ["energy", "materials"], canadaCities: ["Calgary"], canadaHq: true },
  { name: "CPKC (CP Rail)", searchTerms: ["CP Rail", "Canadian Pacific Kansas City"], tenants: ["cpkc", "cpr"], ats: "unknown", sectors: ["transportation", "logistics"], canadaCities: ["Calgary", "Vancouver"], canadaHq: true, seedPageUrls: ["https://www.cpkcr.com/en/careers"] },
  { name: "CN Rail", searchTerms: ["Canadian National Railway", "CN"], tenants: ["cn", "cnr"], ats: "unknown", sectors: ["transportation", "logistics"], canadaCities: ["Montreal", "Toronto"], canadaHq: true, seedPageUrls: ["https://www.cn.ca/en/careers/"] },
  { name: "Stantec", tenants: ["stantec"], ats: "workday", sectors: ["engineering", "consulting"], canadaCities: ["Edmonton", "Toronto", "Vancouver", "Ottawa"], canadaHq: true, seedPageUrls: ["https://careers.stantec.com/"] },
  { name: "AtkinsRéalis", tenants: ["slihrms", "atkinsrealis", "snclavalin"], ats: "workday", sectors: ["engineering", "infrastructure", "consulting"], canadaCities: ["Montreal", "Toronto"], canadaHq: true, seedPageUrls: ["https://www.atkinsrealis.com/en/careers"] },
  { name: "WSP", tenants: ["wsp"], ats: "workday", sectors: ["engineering", "consulting"], canadaCities: ["Montreal", "Toronto", "Vancouver"], canadaHq: true, seedPageUrls: ["https://www.wsp.com/en-ca/careers"] },
  { name: "Air Canada", tenants: ["aircanada"], ats: "unknown", sectors: ["travel", "transportation"], canadaCities: ["Montreal", "Toronto", "Vancouver"], canadaHq: true, seedPageUrls: ["https://careers.aircanada.com/"] },
  { name: "Canadian Tire", tenants: ["canadiantirecorporation", "canadiantire"], domains: ["canadiantire.ca", "corp.canadiantire.ca"], ats: "workday", sectors: ["retail", "ecommerce"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Loblaw", tenants: ["loblaw", "myview"], ats: "workday", sectors: ["retail", "ecommerce"], canadaCities: ["Toronto"], canadaHq: true, seedPageUrls: ["https://www.loblaw.ca/en/careers"] },
  { name: "Sobeys", tenants: ["sobeys", "empireco"], ats: "workday", sectors: ["retail"], canadaCities: ["Stellarton", "Toronto"], canadaHq: true, seedPageUrls: ["https://careers.sobeys.com/"] },
  { name: "Nutrien", tenants: ["nutrien"], ats: "unknown", sectors: ["agtech", "materials"], canadaCities: ["Saskatoon", "Calgary"], canadaHq: true, seedPageUrls: ["https://www.nutrien.com/careers"] },
  { name: "Teck", tenants: ["teck"], ats: "unknown", sectors: ["materials", "mining"], canadaCities: ["Vancouver"], canadaHq: true, seedPageUrls: ["https://careers.teck.com/"] },
  { name: "Microsoft", tenants: ["microsoft"], ats: "unknown", sectors: ["tech", "cloud"], canadaCities: ["Vancouver", "Toronto"], remoteCanadaLikely: true, seedPageUrls: ["https://careers.microsoft.com/v2/global/en/home"] },
  { name: "Amazon", tenants: ["amazon"], ats: "unknown", sectors: ["tech", "cloud", "ecommerce"], canadaCities: ["Vancouver", "Toronto"], seedPageUrls: ["https://www.amazon.jobs/en/"] },
  { name: "Google", tenants: ["google"], ats: "unknown", sectors: ["tech", "cloud", "ai"], canadaCities: ["Waterloo", "Toronto", "Montreal"], seedPageUrls: ["https://careers.google.com/"] },
  { name: "Meta", tenants: ["meta"], ats: "unknown", sectors: ["tech", "social"], canadaCities: ["Toronto"], seedPageUrls: ["https://www.metacareers.com/"] },
  { name: "Apple", tenants: ["apple"], ats: "unknown", sectors: ["tech", "hardware"], canadaCities: ["Vancouver", "Toronto"], seedPageUrls: ["https://jobs.apple.com/en-ca/search"] },
  { name: "Intel", tenants: ["intel"], ats: "workday", sectors: ["semiconductors", "hardware"], canadaCities: ["Toronto"] },
  { name: "AMD", tenants: ["amd"], ats: "workday", sectors: ["semiconductors"], canadaCities: ["Toronto", "Markham"] },
  { name: "Nvidia", tenants: ["nvidia"], ats: "workday", sectors: ["semiconductors", "ai"], canadaCities: ["Toronto"] },
  { name: "Qualcomm", tenants: ["qualcomm"], ats: "workday", sectors: ["semiconductors", "wireless"], canadaCities: [] },
  { name: "IBM", tenants: ["ibm"], domains: ["ibm.com"], seedPageUrls: ["https://www.ibm.com/careers"], ats: "workday", sectors: ["tech", "enterprise", "consulting"], canadaCities: ["Toronto", "Ottawa", "Markham"] },
  { name: "Uber", tenants: ["uber"], ats: "unknown", sectors: ["tech", "transportation"], canadaCities: ["Toronto"], seedPageUrls: ["https://www.uber.com/us/en/careers/"] },
  { name: "Lyft", tenants: ["lyft"], ats: "workday", sectors: ["tech", "transportation"], canadaCities: ["Toronto"] },
  { name: "Salesforce", tenants: ["salesforce"], domains: ["salesforce.com"], seedPageUrls: ["https://careers.salesforce.com/en/"], ats: "workday", sectors: ["enterprise software", "cloud"], canadaCities: ["Toronto", "Vancouver"] },
  { name: "ServiceNow", tenants: ["servicenow"], ats: "workday", sectors: ["enterprise software", "cloud"], canadaCities: [] },
  { name: "Adobe", tenants: ["adobe"], ats: "workday", sectors: ["software", "creative"], canadaCities: ["Toronto", "Ottawa"] },
  { name: "VMware", tenants: ["vmware"], ats: "workday", sectors: ["cloud", "virtualization"], canadaCities: [] },
  { name: "Palo Alto Networks", tenants: ["paloaltonetworks"], ats: "workday", sectors: ["security", "networking"], canadaCities: [] },
  { name: "CrowdStrike", tenants: ["crowdstrike"], ats: "workday", sectors: ["security"], canadaCities: [] },
  { name: "Fortinet", tenants: ["fortinet"], ats: "workday", sectors: ["security", "networking"], canadaCities: ["Ottawa"] },
  { name: "Zscaler", tenants: ["zscaler"], ats: "workday", sectors: ["security", "cloud"], canadaCities: [] },
  { name: "Splunk", tenants: ["splunk"], ats: "workday", sectors: ["security", "data"], canadaCities: [] },
  { name: "Twilio", tenants: ["twilio"], ats: "workday", sectors: ["communications", "cloud"], canadaCities: [] },
  { name: "Snowflake", tenants: ["snowflake"], ats: "workday", sectors: ["data", "cloud"], canadaCities: [] },
  { name: "Databricks", tenants: ["databricks"], domains: ["databricks.com"], seedPageUrls: ["https://www.databricks.com/company/careers/open-positions"], ats: "workday", sectors: ["data", "ai", "cloud"], canadaCities: ["Toronto"] },
  { name: "Palantir", tenants: ["palantir"], ats: "workday", sectors: ["data", "government", "ai"], canadaCities: [] },
  { name: "DocuSign", tenants: ["docusign"], ats: "workday", sectors: ["enterprise software"], canadaCities: [] },
  { name: "Okta", tenants: ["okta"], domains: ["okta.com"], seedPageUrls: ["https://www.okta.com/company/careers/"], ats: "workday", sectors: ["security", "identity"], canadaCities: ["Toronto"] },
  { name: "HubSpot", tenants: ["hubspot"], ats: "workday", sectors: ["marketing", "crm"], canadaCities: ["Toronto"] },
  { name: "Atlassian", tenants: ["atlassian"], ats: "workday", sectors: ["devtools", "enterprise software"], canadaCities: [] },
  { name: "Zoom", tenants: ["zoom"], ats: "workday", sectors: ["communications"], canadaCities: [] },
  { name: "Block / Square", tenants: ["block", "squareup"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: [] },
  { name: "Stripe", tenants: ["stripe"], domains: ["stripe.com"], seedPageUrls: ["https://stripe.com/jobs/search"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: ["Toronto"] },
  { name: "Plaid", tenants: ["plaid"], ats: "workday", sectors: ["fintech"], canadaCities: [] },
  { name: "Toast", tenants: ["toast"], ats: "workday", sectors: ["fintech", "restaurant tech"], canadaCities: [] },
  { name: "Instacart", tenants: ["instacart"], ats: "workday", sectors: ["tech", "ecommerce"], canadaCities: ["Toronto"] },
  { name: "DoorDash", tenants: ["doordash"], ats: "workday", sectors: ["tech", "delivery"], canadaCities: [] },
  { name: "Elastic", tenants: ["elastic"], ats: "workday", sectors: ["search", "data"], canadaCities: [] },
  { name: "MongoDB", tenants: ["mongodb"], ats: "workday", sectors: ["database", "cloud"], canadaCities: ["Toronto"] },
  { name: "Confluent", tenants: ["confluent"], ats: "workday", sectors: ["data", "streaming"], canadaCities: [] },
  { name: "Fiserv", tenants: ["fiserv"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: [] },
  { name: "FIS", tenants: ["fis"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: [] },
  { name: "Jack Henry", tenants: ["jackhenry"], ats: "workday", sectors: ["fintech", "banking software"], canadaCities: [] },
  { name: "S&P Global", tenants: ["spglobal"], ats: "workday", sectors: ["finance", "data"], canadaCities: ["Toronto"] },
  { name: "Moody's", tenants: ["moodys"], ats: "workday", sectors: ["finance", "data", "research"], canadaCities: [] },
  { name: "MSCI", tenants: ["msci"], ats: "workday", sectors: ["finance", "data"], canadaCities: [] },
  { name: "Prudential", tenants: ["prudential"], ats: "workday", sectors: ["insurance", "finance"], canadaCities: [] },
  { name: "MetLife", tenants: ["metlife"], ats: "workday", sectors: ["insurance", "finance"], canadaCities: [] },
  { name: "Allstate", tenants: ["allstate"], ats: "workday", sectors: ["insurance"], canadaCities: [] },
  { name: "Hartford", tenants: ["thehartford", "hartford"], ats: "workday", sectors: ["insurance", "finance"], canadaCities: [] },
  { name: "Capital One", tenants: ["capitalone"], ats: "workday", sectors: ["finance", "banking", "tech"], canadaCities: ["Toronto"] },
  { name: "American Express", tenants: ["americanexpress", "aexp"], domains: ["americanexpress.com"], seedPageUrls: ["https://www.americanexpress.com/en-us/careers/"], ats: "workday", sectors: ["finance", "payments"], canadaCities: ["Toronto"] },
  { name: "Mastercard", tenants: ["mastercard"], domains: ["mastercard.com"], seedPageUrls: ["https://careers.mastercard.com/us/en"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: ["Toronto"] },
  { name: "SAP", tenants: ["sap"], ats: "successfactors", sectors: ["enterprise software"], canadaCities: ["Montreal", "Toronto", "Vancouver"], sfHosts: ["jobs.sap.com"], sfPaths: ["en"], seedPageUrls: ["https://jobs.sap.com/search/?createNewAlert=false&q=&locationsearch=&optionsFacetsDD_department=&optionsFacetsDD_customfield5=&optionsFacetsDD_country=&optionsFacetsDD_city=&optionsFacetsDD_customfield3="] },
  { name: "Scotiabank", tenants: ["scotiabank"], ats: "successfactors", sectors: ["finance", "banking"], canadaCities: ["Toronto"], canadaHq: true, sfHosts: ["jobs.scotiabank.com"], seedPageUrls: ["https://jobs.scotiabank.com/search/?createNewAlert=false&q=&locationsearch=&optionsFacetsDD_customfield3=&optionsFacetsDD_country=&optionsFacetsDD_department=&optionsFacetsDD_shifttype=&optionsFacetsDD_location="] },
  { name: "Bell Canada", tenants: ["bce"], ats: "successfactors", sectors: ["telecom"], canadaCities: ["Montreal", "Toronto"], canadaHq: true, sfHosts: ["jobs.bce.ca"], seedPageUrls: ["https://jobs.bce.ca/search/?createNewAlert=false&q=&locationsearch=&optionsFacetsDD_customfield3=&optionsFacetsDD_customfield1=&optionsFacetsDD_location="] },
  { name: "Siemens", tenants: ["siemens"], ats: "successfactors", sectors: ["industrial", "tech"], canadaCities: ["Toronto"], sfHosts: ["jobs.siemens.com"], seedPageUrls: ["https://jobs.siemens.com/search/?createNewAlert=false&q=&locationsearch=&optionsFacetsDD_customfield3=&optionsFacetsDD_country=&optionsFacetsDD_department="] },
  { name: "Bosch", tenants: ["bosch"], ats: "successfactors", sectors: ["industrial", "iot"], canadaCities: [], sfHosts: ["jobs.bosch-group.com"] },
  { name: "Ericsson", tenants: ["ericsson"], ats: "successfactors", sectors: ["telecom", "5g"], canadaCities: ["Ottawa", "Montreal"], sfHosts: ["jobs.ericsson.com"], seedPageUrls: ["https://jobs.ericsson.com/search/?createNewAlert=false&q=&locationsearch=&optionsFacetsDD_country=&optionsFacetsDD_customfield3="] },
  { name: "Nokia", tenants: ["nokia"], ats: "successfactors", sectors: ["telecom", "networking"], canadaCities: ["Ottawa"], sfHosts: ["careers.nokia.com"], seedPageUrls: ["https://careers.nokia.com/search/?createNewAlert=false&q=&locationsearch=&optionsFacetsDD_customfield3=&optionsFacetsDD_country="] },
  { name: "Philips", tenants: ["philips"], ats: "successfactors", sectors: ["healthtech", "electronics"], canadaCities: [], sfHosts: ["jobs.philips.com"], seedPageUrls: ["https://jobs.philips.com/search/?createNewAlert=false&q=&locationsearch=&optionsFacetsDD_country=&optionsFacetsDD_customfield3="] },
  { name: "Accenture", tenants: ["accenture"], ats: "successfactors", sectors: ["consulting", "tech"], canadaCities: ["Toronto", "Montreal"], sfHosts: ["www.accenture.com"] },
  { name: "Cerner (Oracle Health)", tenants: ["cerner", "oraclehealth"], ats: "workday", sectors: ["healthtech"], canadaCities: ["Toronto"] },
  { name: "Epic Systems", tenants: ["epic"], ats: "workday", sectors: ["healthtech"], canadaCities: [] },
  { name: "Veeva Systems", tenants: ["veeva"], ats: "workday", sectors: ["healthtech", "life sciences", "cloud"], canadaCities: [], remoteCanadaLikely: true },
  { name: "GE HealthCare", tenants: ["gehealthcare"], ats: "workday", sectors: ["healthtech", "medical devices"], canadaCities: [] },
  { name: "Deloitte", tenants: ["deloitte"], domains: ["deloitte.com"], seedPageUrls: ["https://www2.deloitte.com/ca/en/careers.html"], ats: "workday", sectors: ["consulting", "finance"], canadaCities: ["Toronto", "Montreal", "Calgary", "Vancouver"] },
  { name: "PwC", tenants: ["pwc"], domains: ["pwc.com"], seedPageUrls: ["https://www.pwc.com/ca/en/careers.html"], ats: "workday", sectors: ["consulting", "finance"], canadaCities: ["Toronto", "Montreal"] },
  { name: "EY", tenants: ["ey"], domains: ["ey.com"], seedPageUrls: ["https://www.ey.com/en_ca/careers"], ats: "workday", sectors: ["consulting", "finance"], canadaCities: ["Toronto", "Montreal"] },
  { name: "KPMG", tenants: ["kpmg"], domains: ["kpmg.com"], seedPageUrls: ["https://kpmg.com/ca/en/home/careers.html"], ats: "workday", sectors: ["consulting", "finance"], canadaCities: ["Toronto", "Montreal", "Calgary"] },
  { name: "McKinsey", tenants: ["mckinsey"], domains: ["mckinsey.com"], seedPageUrls: ["https://www.mckinsey.com/careers"], ats: "workday", sectors: ["consulting"], canadaCities: ["Toronto", "Montreal"] },
  { name: "BCG", tenants: ["bcg"], ats: "workday", sectors: ["consulting"], canadaCities: ["Toronto"] },
  { name: "Bain", tenants: ["bain"], ats: "workday", sectors: ["consulting"], canadaCities: ["Toronto"] },
  { name: "PSP Investments", searchTerms: ["PSP"], tenants: ["investpsp"], domains: ["investpsp.com"], ats: "workday", sectors: ["finance", "pension"], canadaCities: ["Montreal", "Toronto"], canadaHq: true },
  { name: "NAV CANADA", tenants: ["navcanada"], domains: ["navcanada.ca"], ats: "workday", sectors: ["transportation", "government"], canadaCities: ["Ottawa"], canadaHq: true },
  { name: "CAE", tenants: ["cae"], domains: ["cae.com"], ats: "workday", sectors: ["aerospace", "defense", "simulation"], canadaCities: ["Montreal", "Toronto"], canadaHq: true },
  { name: "ENMAX", tenants: ["enmax"], domains: ["enmax.com"], ats: "workday", sectors: ["utilities", "energy"], canadaCities: ["Calgary"], canadaHq: true },
  { name: "Capital Power", tenants: ["capitalpower"], domains: ["capitalpower.com"], ats: "workday", sectors: ["utilities", "energy"], canadaCities: ["Edmonton"], canadaHq: true },
  { name: "Northland Power", tenants: ["northlandpower"], domains: ["northlandpower.com"], ats: "workday", sectors: ["utilities", "energy"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Bruce Power", tenants: ["brucepower"], domains: ["brucepower.com"], ats: "workday", sectors: ["utilities", "energy", "nuclear"], canadaCities: ["Tiverton"], canadaHq: true },
  { name: "Viterra", tenants: ["viterra"], domains: ["viterra.ca"], ats: "workday", sectors: ["agtech", "commodities"], canadaCities: ["Regina", "Calgary"], canadaHq: true },
  { name: "Stelco", tenants: ["stelco"], domains: ["stelco.com"], ats: "workday", sectors: ["materials", "steel"], canadaCities: ["Hamilton"], canadaHq: true },
  { name: "BDO Canada", searchTerms: ["BDO"], tenants: ["bdo"], domains: ["bdo.ca"], ats: "workday", sectors: ["consulting", "finance"], canadaCities: ["Toronto", "Vancouver", "Montreal"], canadaHq: true },
  { name: "Telus International", searchTerms: ["TELUS International", "TELUS Digital"], tenants: ["telusinternational"], domains: ["telusinternational.com", "telusdigital.com"], seedPageUrls: ["https://www.telusdigital.com/careers"], ats: "workday", sectors: ["tech", "digital services"], canadaCities: ["Vancouver", "Toronto"], canadaHq: true },
  { name: "Lifeworks / TELUS Health", searchTerms: ["LifeWorks", "TELUS Health"], tenants: ["lifeworks"], domains: ["telushealth.com", "lifeworks.com"], seedPageUrls: ["https://www.telushealth.com/careers"], ats: "workday", sectors: ["healthtech", "hr tech"], canadaCities: ["Toronto", "Montreal"], canadaHq: true },
  { name: "1Password", tenants: ["1password"], domains: ["1password.com"], seedPageUrls: ["https://1password.com/jobs"], ats: "unknown", sectors: ["security", "identity", "devtools"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Wealthsimple", tenants: ["wealthsimple"], domains: ["wealthsimple.com"], seedPageUrls: ["https://www.wealthsimple.com/en-ca/careers"], ats: "unknown", sectors: ["fintech", "brokerage", "payments"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Hootsuite", tenants: ["hootsuite"], domains: ["hootsuite.com"], seedPageUrls: ["https://www.hootsuite.com/about/careers"], ats: "unknown", sectors: ["marketing", "social", "enterprise software"], canadaCities: ["Vancouver", "Toronto"], canadaHq: true },
  { name: "Benevity", tenants: ["benevity"], domains: ["benevity.com"], seedPageUrls: ["https://benevity.com/careers"], ats: "unknown", sectors: ["enterprise software", "hr tech", "fintech"], canadaCities: ["Calgary", "Toronto", "Vancouver"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Jobber", tenants: ["jobber"], domains: ["getjobber.com"], seedPageUrls: ["https://getjobber.com/careers/"], ats: "unknown", sectors: ["enterprise software", "smb", "fintech"], canadaCities: ["Edmonton", "Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "ApplyBoard", tenants: ["applyboard"], domains: ["applyboard.com"], seedPageUrls: ["https://applyboard.com/careers"], ats: "unknown", sectors: ["edtech", "marketplace"], canadaCities: ["Kitchener", "Toronto"], canadaHq: true },
  { name: "FreshBooks", tenants: ["freshbooks"], domains: ["freshbooks.com"], seedPageUrls: ["https://www.freshbooks.com/careers"], ats: "unknown", sectors: ["fintech", "accounting software"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Jane App", searchTerms: ["Jane"], tenants: ["jane"], domains: ["jane.app"], seedPageUrls: ["https://jane.app/careers"], ats: "unknown", sectors: ["healthtech", "smb software"], canadaCities: ["Vancouver"], canadaHq: true, remoteCanadaLikely: true },
  { name: "League", tenants: ["league"], domains: ["league.com"], seedPageUrls: ["https://league.com/careers"], ats: "unknown", sectors: ["healthtech", "enterprise software"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "AlayaCare", tenants: ["alayacare"], domains: ["alayacare.com"], seedPageUrls: ["https://www.alayacare.com/careers/"], ats: "unknown", sectors: ["healthtech", "enterprise software"], canadaCities: ["Montreal", "Toronto"], canadaHq: true },
  { name: "Neo Financial", tenants: ["neo", "neofinancial"], domains: ["neofinancial.com"], seedPageUrls: ["https://www.neofinancial.com/careers"], ats: "unknown", sectors: ["fintech", "payments"], canadaCities: ["Calgary", "Toronto", "Winnipeg"], canadaHq: true },
  { name: "KOHO", tenants: ["koho"], domains: ["koho.ca"], seedPageUrls: ["https://www.koho.ca/careers"], ats: "unknown", sectors: ["fintech", "banking"], canadaCities: ["Toronto", "Vancouver"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Float Financial", searchTerms: ["Float"], tenants: ["float"], domains: ["floatfinancial.com"], seedPageUrls: ["https://floatfinancial.com/careers"], ats: "unknown", sectors: ["fintech", "payments"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Relay Financial", searchTerms: ["Relay"], tenants: ["relayfi"], domains: ["relayfi.com"], seedPageUrls: ["https://relayfi.com/careers"], ats: "unknown", sectors: ["fintech", "banking software"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "MDA Space", tenants: ["mda"], domains: ["mda.space"], seedPageUrls: ["https://mda.space/careers/"], ats: "unknown", sectors: ["aerospace", "space", "defense"], canadaCities: ["Brampton", "Montreal"], canadaHq: true },
  { name: "Telesat", tenants: ["telesat"], domains: ["telesat.com"], seedPageUrls: ["https://www.telesat.com/careers/"], ats: "unknown", sectors: ["telecom", "space", "networking"], canadaCities: ["Ottawa", "Montreal"], canadaHq: true },
  { name: "Softchoice", tenants: ["softchoice"], domains: ["softchoice.com"], seedPageUrls: ["https://www.softchoice.com/careers"], ats: "unknown", sectors: ["cloud", "consulting", "it services"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Definity Financial", searchTerms: ["Definity"], tenants: ["definity"], domains: ["definityfinancial.com"], seedPageUrls: ["https://www.definityfinancial.com/careers"], ats: "unknown", sectors: ["insurance", "finance"], canadaCities: ["Waterloo", "Toronto"], canadaHq: true },
  { name: "Sagen", tenants: ["sagen"], domains: ["sagen.ca"], seedPageUrls: ["https://www.sagen.ca/about-us/careers/"], ats: "unknown", sectors: ["insurance", "mortgage", "finance"], canadaCities: ["Oakville", "Toronto"], canadaHq: true },
  { name: "Coveo", tenants: ["coveo"], domains: ["coveo.com"], seedPageUrls: ["https://www.coveo.com/en/company/careers"], ats: "unknown", sectors: ["search", "ai", "enterprise software"], canadaCities: ["Montreal", "Toronto"], canadaHq: true },
  { name: "Arista Networks", tenants: ["aristanetworks", "arista"], domains: ["arista.com"], seedPageUrls: ["https://www.arista.com/en/company/careers"], ats: "unknown", sectors: ["networking", "cloud", "security"], canadaCities: ["Vancouver", "Toronto"], remoteCanadaLikely: true },
  { name: "Riskfuel", tenants: ["riskfuel"], domains: ["riskfuel.com"], seedPageUrls: ["https://www.riskfuel.com/careers"], ats: "unknown", sectors: ["fintech", "ai", "risk"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Vention", tenants: ["vention"], domains: ["vention.io"], seedPageUrls: ["https://vention.io/careers"], ats: "unknown", sectors: ["manufacturing", "industrial", "software"], canadaCities: ["Montreal", "Toronto"], canadaHq: true },
  { name: "Geotab", tenants: ["geotab"], domains: ["geotab.com"], seedPageUrls: ["https://www.geotab.com/careers/"], ats: "unknown", sectors: ["iot", "telematics", "enterprise software"], canadaCities: ["Oakville", "Toronto"], canadaHq: true },
  { name: "Plusgrade", tenants: ["plusgrade"], domains: ["plusgrade.com"], seedPageUrls: ["https://www.plusgrade.com/careers"], ats: "unknown", sectors: ["travel", "fintech", "enterprise software"], canadaCities: ["Montreal", "Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "TouchBistro", tenants: ["touchbistro"], domains: ["touchbistro.com"], seedPageUrls: ["https://www.touchbistro.com/careers/"], ats: "unknown", sectors: ["fintech", "restaurant tech", "enterprise software"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "D2L", tenants: ["d2l"], domains: ["d2l.com"], seedPageUrls: ["https://www.d2l.com/company/careers/"], ats: "unknown", sectors: ["edtech", "enterprise software"], canadaCities: ["Kitchener", "Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Q4", tenants: ["q4", "q4inc"], domains: ["q4inc.com"], seedPageUrls: ["https://www.q4inc.com/careers/"], ats: "unknown", sectors: ["fintech", "investor relations", "enterprise software"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Caseware", tenants: ["caseware"], domains: ["caseware.com"], seedPageUrls: ["https://www.caseware.com/about/careers/"], ats: "unknown", sectors: ["fintech", "accounting software", "enterprise software"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Top Hat", tenants: ["tophat"], domains: ["tophat.com"], seedPageUrls: ["https://tophat.com/company/careers/"], ats: "unknown", sectors: ["edtech", "enterprise software"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Dialogue", tenants: ["dialogue"], domains: ["dialogue.co"], seedPageUrls: ["https://www.dialogue.co/en/careers"], ats: "unknown", sectors: ["healthtech", "telehealth"], canadaCities: ["Montreal", "Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "StackAdapt", tenants: ["stackadapt"], domains: ["stackadapt.com"], seedPageUrls: ["https://www.stackadapt.com/careers"], ats: "unknown", sectors: ["adtech", "ai", "enterprise software"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Ada", tenants: ["ada"], domains: ["ada.cx"], seedPageUrls: ["https://www.ada.cx/careers"], ats: "unknown", sectors: ["ai", "customer support", "enterprise software"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Hopper", tenants: ["hopper"], domains: ["hopper.com"], seedPageUrls: ["https://hopper.com/careers"], ats: "unknown", sectors: ["travel", "marketplace", "fintech"], canadaCities: ["Montreal", "Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Clutch", tenants: ["clutch"], domains: ["clutch.ca"], seedPageUrls: ["https://www.clutch.ca/careers"], ats: "unknown", sectors: ["fintech", "automotive", "marketplace"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "ContactMonkey", tenants: ["contactmonkey"], domains: ["contactmonkey.com"], seedPageUrls: ["https://www.contactmonkey.com/careers/"], ats: "unknown", sectors: ["saas", "productivity", "enterprise software"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Experian", tenants: ["experian"], domains: ["experian.com"], seedPageUrls: ["https://jobs.smartrecruiters.com/Experian"], ats: "unknown", sectors: ["data", "finance", "credit", "software"], canadaCities: ["Toronto"], remoteCanadaLikely: true },
  { name: "Mattel", tenants: ["mattelinc", "mattel"], domains: ["mattel.com"], seedPageUrls: ["https://jobs.smartrecruiters.com/MattelInc"], ats: "unknown", sectors: ["consumer", "manufacturing", "commerce"], remoteCanadaLikely: false },
  { name: "Medfar", tenants: ["medfar"], domains: ["medfar.com"], seedPageUrls: ["https://jobs.smartrecruiters.com/Medfar"], ats: "unknown", sectors: ["healthtech", "software"], canadaCities: ["Montreal"], canadaHq: true, remoteCanadaLikely: true },
  { name: "University Health Network", tenants: ["universityhealthnetwork", "uhn"], domains: ["uhn.ca"], seedPageUrls: ["https://jobs.smartrecruiters.com/UniversityHealthNetwork"], ats: "unknown", sectors: ["healthcare", "research"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Ample Insight Inc.", tenants: ["ampleinsightinc", "ampleinsight"], domains: ["ampleinsight.com"], seedPageUrls: ["https://jobs.smartrecruiters.com/AmpleInsightInc"], ats: "unknown", sectors: ["ai", "consulting", "software"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Canadian Bank Note Company", tenants: ["canadianbanknotecompany", "cbn"], domains: ["cbnco.com"], seedPageUrls: ["https://jobs.smartrecruiters.com/CanadianBankNoteCompany"], ats: "unknown", sectors: ["security", "fintech", "software"], canadaCities: ["Ottawa"], canadaHq: true },
  { name: "WildBrain", tenants: ["wildbrain"], domains: ["wildbrain.com"], seedPageUrls: ["https://jobs.smartrecruiters.com/WildBrain"], ats: "unknown", sectors: ["media", "software"], canadaCities: ["Toronto", "Halifax"], canadaHq: true },
  { name: "House of Commons Canada", searchTerms: ["Chambre des communes", "House of Commons (Canada)"], tenants: ["houseofcommonscanadachambredescommunescanada"], domains: ["ourcommons.ca"], seedPageUrls: ["https://jobs.smartrecruiters.com/HouseOfCommonsCanadaChambreDesCommunesCanada"], ats: "unknown", sectors: ["government", "public sector", "security"], canadaCities: ["Ottawa"], canadaHq: true },
  { name: "Peraton", tenants: ["careers-peraton", "peraton"], domains: ["peraton.com"], seedPageUrls: ["https://careers-peraton.icims.com/jobs/search"], ats: "unknown", sectors: ["defense", "government", "technology"], remoteCanadaLikely: false },
  { name: "Vancouver Coastal Health", tenants: ["careers-vch", "vch"], domains: ["vch.ca"], seedPageUrls: ["https://careers-vch.icims.com/jobs/search"], ats: "unknown", sectors: ["healthcare"], canadaCities: ["Vancouver"], canadaHq: true },
  { name: "TekSynap", tenants: ["careers-teksynap", "teksynap"], domains: ["teksynap.com"], seedPageUrls: ["https://careers-teksynap.icims.com/jobs/search"], ats: "unknown", sectors: ["government", "cybersecurity", "it services"], remoteCanadaLikely: false },
  { name: "Logistics Management Institute", searchTerms: ["LMI"], tenants: ["careers-lmi", "lmi"], domains: ["lmi.org"], seedPageUrls: ["https://careers-lmi.icims.com/jobs/search"], ats: "unknown", sectors: ["consulting", "defense", "data"], remoteCanadaLikely: false },
  { name: "Susquehanna International Group", searchTerms: ["SIG"], tenants: ["careers-sig", "sig"], domains: ["sig.com"], seedPageUrls: ["https://careers-sig.icims.com/jobs/search"], ats: "unknown", sectors: ["finance", "trading"], remoteCanadaLikely: false },
  { name: "Envoy Air", tenants: ["careers-envoyair", "us-envoyair", "envoyair"], domains: ["envoyair.com"], seedPageUrls: ["https://us-envoyair.icims.com/jobs/search"], ats: "unknown", sectors: ["aviation", "transportation"], remoteCanadaLikely: false },
  { name: "Audacy", tenants: ["careers-audacy", "audacy"], domains: ["audacy.com"], seedPageUrls: ["https://careers-audacy.icims.com/jobs/search"], ats: "unknown", sectors: ["media", "audio", "advertising"], remoteCanadaLikely: false },
  { name: "CarePartners", tenants: ["careers-carepartners", "carepartners"], domains: ["carepartners.ca"], seedPageUrls: ["https://careers-carepartners.icims.com/jobs/search"], ats: "unknown", sectors: ["healthcare"], canadaCities: ["Kitchener", "Toronto"], canadaHq: true },
  { name: "AmTrust Financial Services", tenants: ["careers-amtrustgroup", "amtrustgroup"], domains: ["amtrustfinancial.com"], seedPageUrls: ["https://careers-amtrustgroup.icims.com/jobs/search"], ats: "unknown", sectors: ["insurance", "finance"], remoteCanadaLikely: false },
  { name: "Providence Healthcare", tenants: ["careers-phc", "phc"], domains: ["providencehealthcare.org", "providencehealthcare.com"], seedPageUrls: ["https://careers-phc.icims.com/jobs/search"], ats: "unknown", sectors: ["healthcare"], canadaCities: ["Vancouver"], remoteCanadaLikely: false },
  { name: "Cotiviti", tenants: ["careers-cotiviti", "cotiviti"], domains: ["cotiviti.com"], seedPageUrls: ["https://careers-cotiviti.icims.com/jobs/search"], ats: "unknown", sectors: ["healthtech", "analytics", "software"], remoteCanadaLikely: true },
  { name: "Trustmark Bank", tenants: ["jobs-trustmark", "trustmark"], domains: ["trustmark.com"], seedPageUrls: ["https://jobs-trustmark.icims.com/jobs/search"], ats: "unknown", sectors: ["finance", "banking"], remoteCanadaLikely: false },
  { name: "Hayward Industries", tenants: ["careers-hayward", "hayward"], domains: ["hayward.com"], seedPageUrls: ["https://careers-hayward.icims.com/jobs/search"], ats: "unknown", sectors: ["industrial", "manufacturing"], remoteCanadaLikely: false },
  { name: "CAPREIT", tenants: ["careers-capreit", "capreit"], domains: ["capreit.ca"], seedPageUrls: ["https://careers-capreit.icims.com/jobs/search"], ats: "unknown", sectors: ["real estate", "property operations"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Quest Software", tenants: ["careers-quest", "quest"], domains: ["quest.com"], seedPageUrls: ["https://careers-quest.icims.com/jobs/search"], ats: "unknown", sectors: ["software", "security", "data"], remoteCanadaLikely: true },
  { name: "Applied Systems", searchTerms: ["Applied Systems, Inc."], tenants: ["careers-appliedsystems", "appliedsystems"], domains: ["appliedsystems.com"], seedPageUrls: ["https://careers-appliedsystems.icims.com/jobs/search"], ats: "unknown", sectors: ["insurance", "software", "fintech"], canadaCities: ["Toronto"], remoteCanadaLikely: true },
  { name: "Regional Municipality of Peel", searchTerms: ["Peel Region"], tenants: ["careers-peelregion", "peelregion"], domains: ["peelregion.ca"], seedPageUrls: ["https://careers-peelregion.icims.com/jobs/search"], ats: "unknown", sectors: ["government", "public sector"], canadaCities: ["Mississauga", "Brampton"], canadaHq: true },

  // ─── Major US banks & financial services ─────────────────────────────────
  { name: "JPMorgan Chase", tenants: ["jpmc", "jpmorganchase", "jpmorgan"], domains: ["jpmorganchase.com"], seedPageUrls: ["https://careers.jpmorgan.com/us/en/home"], ats: "workday", sectors: ["finance", "banking", "tech"], canadaCities: ["Toronto"] },
  { name: "Goldman Sachs", tenants: ["goldmansachs"], domains: ["goldmansachs.com"], seedPageUrls: ["https://www.goldmansachs.com/careers/"], ats: "workday", sectors: ["finance", "banking", "investment"], canadaCities: ["Toronto"] },
  { name: "Morgan Stanley", tenants: ["morganstanley"], domains: ["morganstanley.com"], seedPageUrls: ["https://www.morganstanley.com/people-opportunities/students-graduates"], ats: "workday", sectors: ["finance", "banking", "investment"], canadaCities: ["Toronto"] },
  { name: "Bank of America", tenants: ["bankofamerica", "bofa"], domains: ["bankofamerica.com"], seedPageUrls: ["https://careers.bankofamerica.com/en-us"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Toronto"] },
  { name: "Citigroup", tenants: ["citi", "citigroup", "citibank"], domains: ["citigroup.com"], seedPageUrls: ["https://jobs.citi.com/"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Toronto"] },
  { name: "Wells Fargo", tenants: ["wellsfargo"], domains: ["wellsfargo.com"], seedPageUrls: ["https://www.wellsfargo.com/about/careers/"], ats: "workday", sectors: ["finance", "banking"], canadaCities: [] },
  { name: "BlackRock", tenants: ["blackrock"], domains: ["blackrock.com"], seedPageUrls: ["https://careers.blackrock.com/"], ats: "workday", sectors: ["finance", "investment", "data"], canadaCities: ["Toronto"] },
  { name: "Fidelity Investments", tenants: ["fidelity"], domains: ["fidelity.com"], seedPageUrls: ["https://jobs.fidelity.com/"], ats: "workday", sectors: ["finance", "investment", "brokerage"], canadaCities: [] },
  { name: "Charles Schwab", tenants: ["schwab", "charlesschwab"], domains: ["schwab.com"], seedPageUrls: ["https://careers.schwab.com/"], ats: "workday", sectors: ["finance", "brokerage"], canadaCities: [] },
  { name: "Visa", tenants: ["visa"], domains: ["visa.com"], seedPageUrls: ["https://usa.visa.com/en_us/jobs.html"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: ["Toronto"] },
  { name: "PayPal", tenants: ["paypal"], domains: ["paypal.com"], seedPageUrls: ["https://careers.pypl.com/home/"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: ["Toronto"] },
  { name: "T. Rowe Price", tenants: ["troweprice"], domains: ["troweprice.com"], seedPageUrls: ["https://careers.troweprice.com/global/en"], ats: "workday", sectors: ["finance", "investment"], canadaCities: [] },
  { name: "State Street", tenants: ["statestreet"], domains: ["statestreet.com"], seedPageUrls: ["https://careers.statestreet.com/global/en"], ats: "workday", sectors: ["finance", "custody", "data"], canadaCities: ["Toronto"] },
  { name: "Northern Trust", tenants: ["northerntrust"], domains: ["northerntrust.com"], seedPageUrls: ["https://careers.northerntrust.com/global/en"], ats: "workday", sectors: ["finance", "custody", "wealth"], canadaCities: ["Toronto"] },
  { name: "Vanguard", tenants: ["vanguard"], domains: ["vanguard.com"], seedPageUrls: ["https://www.vanguardjobs.com/"], ats: "workday", sectors: ["finance", "investment"], canadaCities: [] },
  { name: "Robinhood", tenants: ["robinhood"], domains: ["robinhood.com"], seedPageUrls: ["https://careers.robinhood.com/"], ats: "workday", sectors: ["fintech", "brokerage"], canadaCities: [] },
  { name: "Coinbase", tenants: ["coinbase"], domains: ["coinbase.com"], seedPageUrls: ["https://www.coinbase.com/en-ca/careers/positions"], ats: "workday", sectors: ["fintech", "crypto"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Affirm", tenants: ["affirm"], domains: ["affirm.com"], seedPageUrls: ["https://www.affirm.com/careers"], ats: "workday", sectors: ["fintech", "lending"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Brex", tenants: ["brex"], domains: ["brex.com"], seedPageUrls: ["https://www.brex.com/careers/"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Marqeta", tenants: ["marqeta"], domains: ["marqeta.com"], seedPageUrls: ["https://www.marqeta.com/company/careers/all-jobs"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: [] },
  { name: "Klarna", tenants: ["klarna"], domains: ["klarna.com"], seedPageUrls: ["https://jobs.lever.co/klarna"], ats: "unknown", sectors: ["fintech", "payments"], canadaCities: [] },
  { name: "Adyen", tenants: ["adyen"], domains: ["adyen.com"], seedPageUrls: ["https://careers.adyen.com/vacancies"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: ["Toronto"] },
  { name: "SS&C Technologies", tenants: ["ssctech", "ssc"], domains: ["ssctech.com"], seedPageUrls: ["https://www.ssctech.com/company/careers"], ats: "workday", sectors: ["fintech", "enterprise software"], canadaCities: ["Toronto"] },
  { name: "Broadridge Financial", tenants: ["broadridge"], domains: ["broadridge.com"], seedPageUrls: ["https://careers.broadridge.com/"], ats: "workday", sectors: ["fintech", "banking software"], canadaCities: ["Toronto"] },
  { name: "Raymond James", tenants: ["raymondjames"], domains: ["raymondjames.com"], seedPageUrls: ["https://careers.raymondjames.com/en/home"], ats: "workday", sectors: ["finance", "wealth"], canadaCities: [] },
  { name: "Interactive Brokers", tenants: ["ibkr", "interactivebrokers"], domains: ["interactivebrokers.com"], seedPageUrls: ["https://www.interactivebrokers.com/en/trading/careers.php"], ats: "unknown", sectors: ["fintech", "brokerage"], canadaCities: ["Toronto"] },
  { name: "Citadel", tenants: ["citadel"], domains: ["citadel.com"], seedPageUrls: ["https://www.citadel.com/careers/open-positions/"], ats: "workday", sectors: ["finance", "quant", "hedge fund"], canadaCities: [] },
  { name: "Two Sigma", tenants: ["twosigma"], domains: ["twosigma.com"], seedPageUrls: ["https://www.twosigma.com/careers/"], ats: "unknown", sectors: ["finance", "quant", "tech"], canadaCities: [] },
  { name: "Jane Street", tenants: ["janestreet"], domains: ["janestreet.com"], seedPageUrls: ["https://www.janestreet.com/join-jane-street/"], ats: "unknown", sectors: ["finance", "quant", "trading"], canadaCities: [] },
  { name: "Point72", tenants: ["point72"], domains: ["point72.com"], seedPageUrls: ["https://point72.com/careers/"], ats: "unknown", sectors: ["finance", "quant", "hedge fund"], canadaCities: [] },
  { name: "Virtu Financial", tenants: ["virtu"], domains: ["virtu.com"], seedPageUrls: ["https://www.virtu.com/careers/"], ats: "unknown", sectors: ["finance", "trading", "fintech"], canadaCities: [] },
  { name: "D.E. Shaw", tenants: ["deshaw"], domains: ["deshaw.com"], seedPageUrls: ["https://www.deshaw.com/careers/"], ats: "unknown", sectors: ["finance", "quant", "tech"], canadaCities: [] },
  { name: "Bridgewater Associates", tenants: ["bridgewater"], domains: ["bridgewater.com"], seedPageUrls: ["https://www.bridgewater.com/careers/"], ats: "workday", sectors: ["finance", "hedge fund"], canadaCities: [] },
  { name: "AQR Capital", tenants: ["aqr"], domains: ["aqr.com"], seedPageUrls: ["https://www.aqr.com/About-Us/Careers"], ats: "unknown", sectors: ["finance", "quant", "investment"], canadaCities: [] },

  // ─── Major US tech companies ──────────────────────────────────────────────
  { name: "Cisco", tenants: ["cisco"], domains: ["cisco.com"], seedPageUrls: ["https://jobs.cisco.com/"], ats: "workday", sectors: ["networking", "security", "cloud"], canadaCities: ["Toronto", "Ottawa", "Vancouver"] },
  { name: "Dell Technologies", tenants: ["dell", "delltechnologies"], domains: ["dell.com"], seedPageUrls: ["https://jobs.dell.com/"], ats: "successfactors", sectors: ["tech", "hardware", "cloud"], canadaCities: [], sfHosts: ["jobs.dell.com"] },
  { name: "HP Inc", tenants: ["hp"], domains: ["hp.com"], seedPageUrls: ["https://jobs.hp.com/en-us/search"], ats: "workday", sectors: ["tech", "hardware"], canadaCities: [] },
  { name: "HPE", tenants: ["hpe", "hewlettpackardenterprise"], domains: ["hpe.com"], seedPageUrls: ["https://careers.hpe.com/us/en"], ats: "workday", sectors: ["tech", "cloud", "networking"], canadaCities: [] },
  { name: "Oracle", tenants: ["oracle"], domains: ["oracle.com"], seedPageUrls: ["https://careers.oracle.com/jobs/"], ats: "workday", sectors: ["enterprise software", "cloud", "database"], canadaCities: ["Toronto", "Vancouver"] },
  { name: "Box", tenants: ["box"], domains: ["box.com"], seedPageUrls: ["https://careers.box.com/us/en"], ats: "workday", sectors: ["cloud", "enterprise software"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Dropbox", tenants: ["dropbox"], domains: ["dropbox.com"], seedPageUrls: ["https://jobs.dropbox.com/"], ats: "workday", sectors: ["cloud", "productivity"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Akamai", tenants: ["akamai"], domains: ["akamai.com"], seedPageUrls: ["https://careers.akamai.com/careers"], ats: "workday", sectors: ["cdn", "cloud", "security"], canadaCities: [] },
  { name: "Cloudflare", tenants: ["cloudflare"], domains: ["cloudflare.com"], seedPageUrls: ["https://www.cloudflare.com/careers/jobs/"], ats: "workday", sectors: ["cloud", "security", "networking"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Datadog", tenants: ["datadog"], domains: ["datadoghq.com"], seedPageUrls: ["https://careers.datadoghq.com/"], ats: "workday", sectors: ["monitoring", "cloud", "devops"], canadaCities: ["Toronto", "Vancouver"] },
  { name: "HashiCorp", tenants: ["hashicorp"], domains: ["hashicorp.com"], seedPageUrls: ["https://www.hashicorp.com/careers"], ats: "workday", sectors: ["devops", "cloud", "security"], canadaCities: [], remoteCanadaLikely: true },
  { name: "GitLab", tenants: ["gitlab"], domains: ["gitlab.com"], seedPageUrls: ["https://about.gitlab.com/jobs/"], ats: "workday", sectors: ["devtools", "devops", "cloud"], canadaCities: [], remoteCanadaLikely: true },
  { name: "New Relic", tenants: ["newrelic"], domains: ["newrelic.com"], seedPageUrls: ["https://newrelic.com/about/careers"], ats: "workday", sectors: ["monitoring", "cloud", "devops"], canadaCities: [], remoteCanadaLikely: true },
  { name: "PagerDuty", tenants: ["pagerduty"], domains: ["pagerduty.com"], seedPageUrls: ["https://www.pagerduty.com/careers/"], ats: "workday", sectors: ["devops", "monitoring", "cloud"], canadaCities: ["Toronto", "Vancouver"], remoteCanadaLikely: true },
  { name: "Zendesk", tenants: ["zendesk"], domains: ["zendesk.com"], seedPageUrls: ["https://www.zendesk.com/jobs/"], ats: "workday", sectors: ["enterprise software", "crm"], canadaCities: ["Toronto"] },
  { name: "Asana", tenants: ["asana"], domains: ["asana.com"], seedPageUrls: ["https://asana.com/jobs"], ats: "workday", sectors: ["saas", "productivity", "enterprise software"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Notion", tenants: ["notion"], domains: ["notion.so"], seedPageUrls: ["https://www.notion.so/careers"], ats: "unknown", sectors: ["saas", "productivity"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Figma", tenants: ["figma"], domains: ["figma.com"], seedPageUrls: ["https://www.figma.com/careers/"], ats: "workday", sectors: ["design", "saas", "devtools"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Miro", tenants: ["miro"], domains: ["miro.com"], seedPageUrls: ["https://miro.com/careers/"], ats: "workday", sectors: ["saas", "productivity", "enterprise software"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Slack (Salesforce)", tenants: ["slack"], domains: ["slack.com"], seedPageUrls: ["https://slack.com/intl/en-ca/careers"], ats: "workday", sectors: ["enterprise software", "communications"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Workday", tenants: ["workday"], domains: ["workday.com"], seedPageUrls: ["https://www.workday.com/en-us/company/careers/open-positions.html"], ats: "workday", sectors: ["enterprise software", "hr tech", "cloud"], canadaCities: ["Vancouver", "Toronto"] },
  { name: "Verint Systems", tenants: ["verint"], domains: ["verint.com"], seedPageUrls: ["https://www.verint.com/company/careers/"], ats: "workday", sectors: ["analytics", "ai", "enterprise software"], canadaCities: [] },
  { name: "NICE Systems", tenants: ["nice"], domains: ["nice.com"], seedPageUrls: ["https://www.nice.com/about/nice-careers"], ats: "workday", sectors: ["analytics", "crm", "enterprise software"], canadaCities: [] },
  { name: "Medallia", tenants: ["medallia"], domains: ["medallia.com"], seedPageUrls: ["https://www.medallia.com/company/careers/"], ats: "workday", sectors: ["crm", "analytics", "enterprise software"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Qualtrics", tenants: ["qualtrics"], domains: ["qualtrics.com"], seedPageUrls: ["https://www.qualtrics.com/careers/"], ats: "workday", sectors: ["analytics", "crm", "enterprise software"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Coupa Software", tenants: ["coupa"], domains: ["coupa.com"], seedPageUrls: ["https://www.coupa.com/company/careers"], ats: "workday", sectors: ["enterprise software", "procurement"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Sprinklr", tenants: ["sprinklr"], domains: ["sprinklr.com"], seedPageUrls: ["https://www.sprinklr.com/careers/"], ats: "workday", sectors: ["crm", "marketing", "enterprise software"], canadaCities: [] },
  { name: "Amplitude", tenants: ["amplitude"], domains: ["amplitude.com"], seedPageUrls: ["https://amplitude.com/careers"], ats: "workday", sectors: ["analytics", "saas"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Mixpanel", tenants: ["mixpanel"], domains: ["mixpanel.com"], seedPageUrls: ["https://mixpanel.com/jobs/"], ats: "unknown", sectors: ["analytics", "saas"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Segment (Twilio)", tenants: ["segment"], domains: ["segment.com"], seedPageUrls: ["https://www.twilio.com/en-us/company/jobs"], ats: "workday", sectors: ["data", "analytics", "saas"], canadaCities: [], remoteCanadaLikely: true },
  { name: "mParticle", tenants: ["mparticle"], domains: ["mparticle.com"], seedPageUrls: ["https://www.mparticle.com/careers/"], ats: "unknown", sectors: ["data", "analytics", "saas"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Looker (Google)", tenants: ["looker"], domains: ["looker.com"], seedPageUrls: ["https://careers.google.com/"], ats: "unknown", sectors: ["data", "analytics", "bi"], canadaCities: [] },
  { name: "Tableau (Salesforce)", tenants: ["tableau"], domains: ["tableau.com"], seedPageUrls: ["https://www.tableau.com/about/careers"], ats: "workday", sectors: ["data", "analytics", "bi"], canadaCities: [] },
  { name: "Alteryx", tenants: ["alteryx"], domains: ["alteryx.com"], seedPageUrls: ["https://www.alteryx.com/careers"], ats: "workday", sectors: ["data", "analytics", "ai"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Anthropic", tenants: ["anthropic"], domains: ["anthropic.com"], seedPageUrls: ["https://www.anthropic.com/careers"], ats: "unknown", sectors: ["ai", "research"], canadaCities: [], remoteCanadaLikely: true },
  { name: "OpenAI", tenants: ["openai"], domains: ["openai.com"], seedPageUrls: ["https://openai.com/careers/"], ats: "unknown", sectors: ["ai", "research", "cloud"], canadaCities: [] },
  { name: "Cohere", tenants: ["cohere"], domains: ["cohere.com"], seedPageUrls: ["https://cohere.com/careers"], ats: "unknown", sectors: ["ai", "nlp", "enterprise software"], canadaCities: ["Toronto"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Scale AI", tenants: ["scaleai", "scale"], domains: ["scale.com"], seedPageUrls: ["https://scale.com/careers"], ats: "workday", sectors: ["ai", "data", "ml ops"], canadaCities: [] },
  { name: "Hugging Face", tenants: ["huggingface"], domains: ["huggingface.co"], seedPageUrls: ["https://apply.workable.com/huggingface/"], ats: "unknown", sectors: ["ai", "ml", "open source"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Stability AI", tenants: ["stabilityai"], domains: ["stability.ai"], seedPageUrls: ["https://stability.ai/careers"], ats: "unknown", sectors: ["ai", "generative ai"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Mistral AI", tenants: ["mistral"], domains: ["mistral.ai"], seedPageUrls: ["https://mistral.ai/en/careers/"], ats: "unknown", sectors: ["ai", "nlp", "research"], canadaCities: [] },
  { name: "Weights & Biases", tenants: ["wandb", "weightsandbiases"], domains: ["wandb.ai"], seedPageUrls: ["https://wandb.ai/site/careers"], ats: "unknown", sectors: ["ai", "ml ops", "devtools"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Groq", tenants: ["groq"], domains: ["groq.com"], seedPageUrls: ["https://groq.com/careers/"], ats: "unknown", sectors: ["ai", "semiconductors", "cloud"], canadaCities: [] },
  { name: "Cerebras Systems", tenants: ["cerebras"], domains: ["cerebras.net"], seedPageUrls: ["https://www.cerebras.net/careers/"], ats: "unknown", sectors: ["ai", "semiconductors"], canadaCities: [] },
  { name: "Applied Materials", tenants: ["appliedmaterials", "amat"], domains: ["appliedmaterials.com"], seedPageUrls: ["https://careers.appliedmaterials.com/careers"], ats: "workday", sectors: ["semiconductors", "manufacturing"], canadaCities: [] },
  { name: "Lam Research", tenants: ["lamresearch", "lam"], domains: ["lamresearch.com"], seedPageUrls: ["https://careers.lamresearch.com/careers"], ats: "workday", sectors: ["semiconductors", "manufacturing"], canadaCities: [] },
  { name: "Texas Instruments", tenants: ["texasinstruments", "ti"], domains: ["ti.com"], seedPageUrls: ["https://careers.ti.com/"], ats: "workday", sectors: ["semiconductors", "embedded"], canadaCities: [] },
  { name: "Micron Technology", tenants: ["micron"], domains: ["micron.com"], seedPageUrls: ["https://careers.micron.com/careers"], ats: "workday", sectors: ["semiconductors", "memory"], canadaCities: [] },
  { name: "Western Digital", tenants: ["westerndigital", "wd"], domains: ["westerndigital.com"], seedPageUrls: ["https://jobs.westerndigital.com/en_US/careers"], ats: "workday", sectors: ["semiconductors", "storage"], canadaCities: [] },
  { name: "Seagate Technology", tenants: ["seagate"], domains: ["seagate.com"], seedPageUrls: ["https://careers.seagate.com/jobs"], ats: "successfactors", sectors: ["hardware", "storage", "cloud"], canadaCities: [], sfHosts: ["careers.seagate.com"] },
  { name: "NetApp", tenants: ["netapp"], domains: ["netapp.com"], seedPageUrls: ["https://careers.netapp.com/careers"], ats: "workday", sectors: ["cloud", "storage", "data"], canadaCities: [] },
  { name: "Pure Storage", tenants: ["purestorage"], domains: ["purestorage.com"], seedPageUrls: ["https://boards.greenhouse.io/purestorage"], ats: "unknown", sectors: ["cloud", "storage"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Nutanix", tenants: ["nutanix"], domains: ["nutanix.com"], seedPageUrls: ["https://www.nutanix.com/company/careers"], ats: "workday", sectors: ["cloud", "virtualization"], canadaCities: [] },
  { name: "Rubrik", tenants: ["rubrik"], domains: ["rubrik.com"], seedPageUrls: ["https://www.rubrik.com/company/careers/openings"], ats: "workday", sectors: ["cloud", "security", "data"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Cohesity", tenants: ["cohesity"], domains: ["cohesity.com"], seedPageUrls: ["https://www.cohesity.com/careers/open-positions/"], ats: "unknown", sectors: ["cloud", "data", "security"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Commvault", tenants: ["commvault"], domains: ["commvault.com"], seedPageUrls: ["https://www.commvault.com/careers/jobs"], ats: "workday", sectors: ["cloud", "data", "backup"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Veeam Software", tenants: ["veeam"], domains: ["veeam.com"], seedPageUrls: ["https://careers.veeam.com/vacancies"], ats: "workday", sectors: ["cloud", "backup", "enterprise software"], canadaCities: [], remoteCanadaLikely: true },
  { name: "SentinelOne", tenants: ["sentinelone"], domains: ["sentinelone.com"], seedPageUrls: ["https://www.sentinelone.com/jobs/"], ats: "workday", sectors: ["security", "ai", "cloud"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Rapid7", tenants: ["rapid7"], domains: ["rapid7.com"], seedPageUrls: ["https://www.rapid7.com/company/careers/open-positions/"], ats: "workday", sectors: ["security"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Tenable", tenants: ["tenable"], domains: ["tenable.com"], seedPageUrls: ["https://careers.tenable.com/jobs"], ats: "workday", sectors: ["security", "vulnerability management"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Qualys", tenants: ["qualys"], domains: ["qualys.com"], seedPageUrls: ["https://www.qualys.com/company/careers/"], ats: "workday", sectors: ["security", "cloud"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Varonis", tenants: ["varonis"], domains: ["varonis.com"], seedPageUrls: ["https://info.varonis.com/careers"], ats: "workday", sectors: ["security", "data"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Illumio", tenants: ["illumio"], domains: ["illumio.com"], seedPageUrls: ["https://www.illumio.com/company/careers"], ats: "unknown", sectors: ["security", "networking"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Cybereason", tenants: ["cybereason"], domains: ["cybereason.com"], seedPageUrls: ["https://www.cybereason.com/company/careers"], ats: "unknown", sectors: ["security"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Darktrace", tenants: ["darktrace"], domains: ["darktrace.com"], seedPageUrls: ["https://www.darktrace.com/en/company/careers/current-vacancies/"], ats: "workday", sectors: ["security", "ai"], canadaCities: [] },
  { name: "Lacework", tenants: ["lacework"], domains: ["lacework.com"], seedPageUrls: ["https://www.lacework.com/careers/"], ats: "unknown", sectors: ["security", "cloud"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Wiz", tenants: ["wiz"], domains: ["wiz.io"], seedPageUrls: ["https://www.wiz.io/careers"], ats: "unknown", sectors: ["security", "cloud"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Orca Security", tenants: ["orcasecurity"], domains: ["orca.security"], seedPageUrls: ["https://orca.security/about/careers/"], ats: "unknown", sectors: ["security", "cloud"], canadaCities: [], remoteCanadaLikely: true },

  // ─── US tech — mid-cap growth & SaaS ──────────────────────────────────────
  { name: "Veritiv", tenants: ["veritiv"], domains: ["veritivcorp.com"], seedPageUrls: ["https://careers.veritivcorp.com/careers"], ats: "workday", sectors: ["distribution", "logistics"], canadaCities: [] },
  { name: "Procore Technologies", tenants: ["procore"], domains: ["procore.com"], seedPageUrls: ["https://careers.procore.com/jobs"], ats: "workday", sectors: ["construction tech", "enterprise software"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Trimble", tenants: ["trimble"], domains: ["trimble.com"], seedPageUrls: ["https://careers.trimble.com/careers"], ats: "workday", sectors: ["construction tech", "gis", "enterprise software"], canadaCities: [] },
  { name: "RealPage", tenants: ["realpage"], domains: ["realpage.com"], seedPageUrls: ["https://www.realpage.com/company/careers/"], ats: "workday", sectors: ["proptech", "enterprise software"], canadaCities: [] },
  { name: "CoStar Group", tenants: ["costar"], domains: ["costargroup.com"], seedPageUrls: ["https://www.costar.com/about/careers"], ats: "workday", sectors: ["proptech", "data", "marketplace"], canadaCities: ["Toronto"] },
  { name: "Medidata Solutions", tenants: ["medidata"], domains: ["medidata.com"], seedPageUrls: ["https://careers.medidata.com/careers"], ats: "workday", sectors: ["healthtech", "clinical trials"], canadaCities: [] },
  { name: "HealthStream", tenants: ["healthstream"], domains: ["healthstream.com"], seedPageUrls: ["https://www.healthstream.com/about/careers"], ats: "unknown", sectors: ["healthtech", "hr tech"], canadaCities: [] },
  { name: "athenahealth", tenants: ["athenahealth"], domains: ["athenahealth.com"], seedPageUrls: ["https://www.athenahealth.com/about/careers"], ats: "workday", sectors: ["healthtech", "enterprise software"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Evolent Health", tenants: ["evolenthealth"], domains: ["evolenthealth.com"], seedPageUrls: ["https://www.evolenthealth.com/about/careers"], ats: "workday", sectors: ["healthtech"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Netsmart", tenants: ["netsmart"], domains: ["ntst.com"], seedPageUrls: ["https://www.ntst.com/About-Us/Careers"], ats: "workday", sectors: ["healthtech", "enterprise software"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Surescripts", tenants: ["surescripts"], domains: ["surescripts.com"], seedPageUrls: ["https://surescripts.com/about-surescripts/careers/"], ats: "workday", sectors: ["healthtech", "data"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Waymo", tenants: ["waymo"], domains: ["waymo.com"], seedPageUrls: ["https://waymo.com/careers/"], ats: "workday", sectors: ["autonomous vehicles", "ai"], canadaCities: [] },
  { name: "Rivian", tenants: ["rivian"], domains: ["rivian.com"], seedPageUrls: ["https://rivian.com/careers"], ats: "workday", sectors: ["ev", "automotive", "hardware"], canadaCities: [] },
  { name: "Lucid Motors", tenants: ["lucidmotors"], domains: ["lucidmotors.com"], seedPageUrls: ["https://jobs.lucidmotors.com/"], ats: "workday", sectors: ["ev", "automotive"], canadaCities: [] },
  { name: "Aurora Innovation", tenants: ["aurora"], domains: ["aurora.tech"], seedPageUrls: ["https://aurora.tech/careers"], ats: "workday", sectors: ["autonomous vehicles", "ai"], canadaCities: [] },
  { name: "Joby Aviation", tenants: ["joby"], domains: ["jobyaviation.com"], seedPageUrls: ["https://boards.greenhouse.io/jobyaviation"], ats: "unknown", sectors: ["aerospace", "ev", "autonomous"], canadaCities: [] },
  { name: "SpaceX", tenants: ["spacex"], domains: ["spacex.com"], seedPageUrls: ["https://www.spacex.com/careers/"], ats: "unknown", sectors: ["aerospace", "defense", "hardware"], canadaCities: [] },
  { name: "Anduril Industries", tenants: ["anduril"], domains: ["anduril.com"], seedPageUrls: ["https://boards.greenhouse.io/andurilindustries"], ats: "unknown", sectors: ["defense", "ai", "hardware"], canadaCities: [] },
  { name: "Socure", tenants: ["socure"], domains: ["socure.com"], seedPageUrls: ["https://www.socure.com/careers"], ats: "unknown", sectors: ["identity", "security", "fintech"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Jumio", tenants: ["jumio"], domains: ["jumio.com"], seedPageUrls: ["https://www.jumio.com/careers/"], ats: "unknown", sectors: ["identity", "security", "fintech"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Pendo", tenants: ["pendo"], domains: ["pendo.io"], seedPageUrls: ["https://www.pendo.io/careers/"], ats: "unknown", sectors: ["saas", "analytics", "product tools"], canadaCities: [], remoteCanadaLikely: true },
  { name: "FullStory", tenants: ["fullstory"], domains: ["fullstory.com"], seedPageUrls: ["https://www.fullstory.com/careers/"], ats: "workday", sectors: ["analytics", "saas", "devtools"], canadaCities: [], remoteCanadaLikely: true },
  { name: "LogRocket", tenants: ["logrocket"], domains: ["logrocket.com"], seedPageUrls: ["https://logrocket.com/careers/"], ats: "unknown", sectors: ["analytics", "saas", "devtools"], canadaCities: [], remoteCanadaLikely: true },
  { name: "LaunchDarkly", tenants: ["launchdarkly"], domains: ["launchdarkly.com"], seedPageUrls: ["https://launchdarkly.com/careers/"], ats: "unknown", sectors: ["devtools", "saas", "cloud"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Split.io", tenants: ["splitio", "split"], domains: ["split.io"], seedPageUrls: ["https://www.split.io/company/careers/"], ats: "unknown", sectors: ["devtools", "saas"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Contentful", tenants: ["contentful"], domains: ["contentful.com"], seedPageUrls: ["https://www.contentful.com/careers/"], ats: "workday", sectors: ["cms", "saas", "enterprise software"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Sanity", tenants: ["sanity"], domains: ["sanity.io"], seedPageUrls: ["https://www.sanity.io/careers"], ats: "unknown", sectors: ["cms", "saas", "devtools"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Vercel", tenants: ["vercel"], domains: ["vercel.com"], seedPageUrls: ["https://vercel.com/careers"], ats: "unknown", sectors: ["devtools", "cloud", "saas"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Netlify", tenants: ["netlify"], domains: ["netlify.com"], seedPageUrls: ["https://www.netlify.com/careers/"], ats: "unknown", sectors: ["devtools", "cloud", "saas"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Fastly", tenants: ["fastly"], domains: ["fastly.com"], seedPageUrls: ["https://www.fastly.com/about/careers"], ats: "workday", sectors: ["cdn", "cloud", "security"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Fly.io", tenants: ["flyio"], domains: ["fly.io"], seedPageUrls: ["https://fly.io/jobs"], ats: "unknown", sectors: ["cloud", "devops"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Kong", tenants: ["konghq", "kong"], domains: ["konghq.com"], seedPageUrls: ["https://konghq.com/careers"], ats: "unknown", sectors: ["cloud", "api", "devops"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Temporal Technologies", tenants: ["temporal"], domains: ["temporal.io"], seedPageUrls: ["https://temporal.io/careers"], ats: "unknown", sectors: ["devtools", "cloud"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Pulumi", tenants: ["pulumi"], domains: ["pulumi.com"], seedPageUrls: ["https://www.pulumi.com/careers/"], ats: "unknown", sectors: ["devops", "cloud", "iac"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Harness", tenants: ["harness"], domains: ["harness.io"], seedPageUrls: ["https://harness.io/company/careers"], ats: "unknown", sectors: ["devops", "cloud", "mlops"], canadaCities: [], remoteCanadaLikely: true },
  { name: "CircleCI", tenants: ["circleci"], domains: ["circleci.com"], seedPageUrls: ["https://circleci.com/careers/"], ats: "workday", sectors: ["devops", "devtools"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Snyk", tenants: ["snyk"], domains: ["snyk.io"], seedPageUrls: ["https://snyk.io/company/careers/"], ats: "workday", sectors: ["security", "devtools", "open source"], canadaCities: [], remoteCanadaLikely: true },
  { name: "JFrog", tenants: ["jfrog"], domains: ["jfrog.com"], seedPageUrls: ["https://jfrog.com/careers/"], ats: "workday", sectors: ["devops", "devtools"], canadaCities: [], remoteCanadaLikely: true },
  { name: "Sonatype", tenants: ["sonatype"], domains: ["sonatype.com"], seedPageUrls: ["https://www.sonatype.com/company/careers"], ats: "unknown", sectors: ["devops", "security", "devtools"], canadaCities: [], remoteCanadaLikely: true },

  // ─── US consulting & professional services ────────────────────────────────
  { name: "Booz Allen Hamilton", tenants: ["boozallen"], domains: ["boozallen.com"], seedPageUrls: ["https://careers.boozallen.com/careers"], ats: "workday", sectors: ["consulting", "defense", "tech"], canadaCities: [] },
  { name: "Leidos", tenants: ["leidos"], domains: ["leidos.com"], seedPageUrls: ["https://careers.leidos.com/jobs"], ats: "workday", sectors: ["defense", "consulting", "tech"], canadaCities: [] },
  { name: "SAIC", tenants: ["saic"], domains: ["saic.com"], seedPageUrls: ["https://careers.saic.com/careers"], ats: "workday", sectors: ["defense", "consulting", "tech"], canadaCities: [] },
  { name: "ManTech International", tenants: ["mantech"], domains: ["mantech.com"], seedPageUrls: ["https://careers.mantech.com/jobs"], ats: "workday", sectors: ["defense", "consulting", "tech"], canadaCities: [] },
  { name: "Gartner", tenants: ["gartner"], domains: ["gartner.com"], seedPageUrls: ["https://jobs.gartner.com/jobs"], ats: "workday", sectors: ["consulting", "research", "data"], canadaCities: ["Toronto"] },
  { name: "Cognizant", tenants: ["cognizant"], domains: ["cognizant.com"], seedPageUrls: ["https://careers.cognizant.com/us/en"], ats: "workday", sectors: ["consulting", "it services", "tech"], canadaCities: ["Toronto"] },
  { name: "Infosys", tenants: ["infosys"], domains: ["infosys.com"], seedPageUrls: ["https://www.infosys.com/careers/"], ats: "workday", sectors: ["consulting", "it services"], canadaCities: ["Toronto", "Montreal"] },
  { name: "Wipro", tenants: ["wipro"], domains: ["wipro.com"], seedPageUrls: ["https://careers.wipro.com/careers-home/"], ats: "workday", sectors: ["consulting", "it services"], canadaCities: ["Toronto"] },
  { name: "Tata Consultancy Services", searchTerms: ["TCS"], tenants: ["tcs", "tataconsultancy"], domains: ["tcs.com"], seedPageUrls: ["https://www.tcs.com/careers"], ats: "workday", sectors: ["consulting", "it services"], canadaCities: ["Toronto", "Montreal"] },
  { name: "HCLTech", tenants: ["hcltech", "hcl"], domains: ["hcltech.com"], seedPageUrls: ["https://www.hcltech.com/careers"], ats: "workday", sectors: ["consulting", "it services", "cloud"], canadaCities: ["Toronto"] },
  { name: "Capgemini", tenants: ["capgemini"], domains: ["capgemini.com"], seedPageUrls: ["https://www.capgemini.com/us-en/careers/"], ats: "workday", sectors: ["consulting", "tech", "cloud"], canadaCities: ["Toronto", "Montreal"] },
  { name: "Conduent", tenants: ["conduent"], domains: ["conduent.com"], seedPageUrls: ["https://careers.conduent.com/"], ats: "workday", sectors: ["bpo", "consulting", "fintech"], canadaCities: [] },
  { name: "EPAM Systems", tenants: ["epam"], domains: ["epam.com"], seedPageUrls: ["https://www.epam.com/careers"], ats: "workday", sectors: ["consulting", "engineering", "tech"], canadaCities: ["Toronto"], remoteCanadaLikely: true },
  { name: "Thoughtworks", tenants: ["thoughtworks"], domains: ["thoughtworks.com"], seedPageUrls: ["https://www.thoughtworks.com/en-ca/careers"], ats: "workday", sectors: ["consulting", "engineering", "tech"], canadaCities: ["Toronto", "Calgary"], remoteCanadaLikely: true },
  { name: "Slalom Consulting", tenants: ["slalom"], domains: ["slalom.com"], seedPageUrls: ["https://www.slalom.com/us/en/careers"], ats: "workday", sectors: ["consulting", "tech", "cloud"], canadaCities: ["Toronto", "Vancouver", "Calgary"], remoteCanadaLikely: true },
];

function buildCompanyScore(
  company: EnterpriseCompanyRecord,
  canadaWeighted: boolean
) {
  let score = 0;

  if (canadaWeighted) {
    if (company.canadaHq) score += 8;
    const canadaCityCount = company.canadaCities?.length ?? 0;
    if (canadaCityCount >= 3) score += 5;
    else if (canadaCityCount === 2) score += 3;
    else if (canadaCityCount === 1) score += 1.5;
    if (company.remoteCanadaLikely) score += 2.5;
  }

  if (
    company.sectors.some((sector) =>
      /(finance|bank|insurance|payments|telecom|enterprise|cloud|infra|security|data|health|consulting)/i.test(
        sector
      )
    )
  ) {
    score += 3;
  }

  if ((company.seedPageUrls?.length ?? 0) > 0) score += 2.5;
  if ((company.domains?.length ?? 0) > 0) score += 1.25;
  if (company.ats === "unknown") score += 0.75;

  if (company.ats === "both") score += 2;
  if (company.ats === "successfactors") score += 1.5;

  return score;
}

export function selectEnterpriseCompanies(options?: {
  companies?: string[];
  families?: Array<"workday" | "successfactors">;
  canadaWeighted?: boolean;
  limit?: number;
}) {
  const companyFilter = new Set(
    (options?.companies ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean)
  );
  const families = new Set(options?.families ?? ["workday", "successfactors"]);
  const canadaWeighted = options?.canadaWeighted ?? true;

  const selected = ENTERPRISE_DISCOVERY_COMPANIES.filter((company) => {
    if (companyFilter.size > 0) {
      const normalizedName = company.name.trim().toLowerCase();
      const normalizedTenants = company.tenants.map((tenant) => tenant.toLowerCase());
      const normalizedSfHosts = company.sfHosts?.map((host) => host.toLowerCase()) ?? [];
      if (
        !companyFilter.has(normalizedName) &&
        !normalizedTenants.some((tenant) => companyFilter.has(tenant)) &&
        !normalizedSfHosts.some((host) => companyFilter.has(host))
      ) {
        return false;
      }
    }

    if (families.has("workday") && (company.ats === "workday" || company.ats === "both" || company.ats === "unknown")) {
      return true;
    }

    if (families.has("successfactors") && (company.ats === "successfactors" || company.ats === "both")) {
      return true;
    }

    return false;
  }).sort((left, right) => {
    const leftScore = buildCompanyScore(left, canadaWeighted);
    const rightScore = buildCompanyScore(right, canadaWeighted);
    if (rightScore !== leftScore) return rightScore - leftScore;
    return left.name.localeCompare(right.name);
  });

  return typeof options?.limit === "number" ? selected.slice(0, options.limit) : selected;
}
