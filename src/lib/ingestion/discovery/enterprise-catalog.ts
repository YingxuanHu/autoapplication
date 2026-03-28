export type EnterpriseAtsHint =
  | "workday"
  | "successfactors"
  | "both"
  | "unknown";

export type EnterpriseCompanyRecord = {
  name: string;
  searchTerms?: string[];
  tenants: string[];
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
  { name: "TD Bank", tenants: ["td", "tdbank"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "RBC", tenants: ["rbc", "royalbank"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Toronto", "Montreal"], canadaHq: true },
  { name: "BMO", tenants: ["bmo"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Toronto", "Montreal"], canadaHq: true },
  { name: "CIBC", tenants: ["cibc"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "National Bank", searchTerms: ["National Bank of Canada"], tenants: ["nbc", "bnc", "nationalbank"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Montreal"], canadaHq: true },
  { name: "Desjardins", tenants: ["desjardins"], ats: "workday", sectors: ["finance", "insurance"], canadaCities: ["Montreal", "Quebec City"], canadaHq: true },
  { name: "Power Corp", tenants: ["powercorp", "powercorporation"], ats: "unknown", sectors: ["finance", "insurance"], canadaCities: ["Montreal"], canadaHq: true },
  { name: "Telus", tenants: ["telus"], ats: "unknown", sectors: ["telecom", "tech"], canadaCities: ["Vancouver", "Toronto", "Calgary"], canadaHq: true, seedPageUrls: ["https://careers.telus.com/"] },
  { name: "Rogers", tenants: ["rogers"], ats: "unknown", sectors: ["telecom", "media"], canadaCities: ["Toronto"], canadaHq: true, seedPageUrls: ["https://jobs.rogers.com/"] },
  { name: "Bell", tenants: ["bell", "bce"], ats: "both", sectors: ["telecom", "media"], canadaCities: ["Montreal", "Toronto"], canadaHq: true, sfHosts: ["jobs.bce.ca"] },
  { name: "Hydro One", tenants: ["hydroone"], ats: "successfactors", sectors: ["utilities", "energy"], canadaCities: ["Toronto"], canadaHq: true, sfHosts: ["jobs.hydroone.com"], seedPageUrls: ["https://jobs.hydroone.com/search/?createNewAlert=false&q=&locationsearch=&sortColumn=referencedate&sortDirection=desc"] },
  { name: "Aecon", tenants: ["aecon"], ats: "successfactors", sectors: ["infrastructure", "construction", "engineering"], canadaCities: ["Toronto", "Calgary", "Vancouver"], canadaHq: true, sfHosts: ["jobs.aecon.com"], seedPageUrls: ["https://jobs.aecon.com/search/?createNewAlert=false&q=&locationsearch=&sortColumn=referencedate&sortDirection=desc"] },
  { name: "Ontario Power Generation", tenants: ["opg"], ats: "successfactors", sectors: ["utilities", "energy"], canadaCities: ["Toronto", "Pickering"], canadaHq: true, sfHosts: ["jobs.opg.com"], seedPageUrls: ["https://jobs.opg.com/search/?createNewAlert=false&q=&locationsearch=&sortColumn=referencedate&sortDirection=desc"] },
  { name: "Shaw / Freedom", tenants: ["shaw", "freedom"], ats: "workday", sectors: ["telecom"], canadaCities: ["Calgary", "Vancouver"], canadaHq: true },
  { name: "Shopify", tenants: ["shopify"], ats: "unknown", sectors: ["ecommerce", "tech"], canadaCities: ["Toronto", "Ottawa"], canadaHq: true, remoteCanadaLikely: true, seedPageUrls: ["https://www.shopify.com/careers"] },
  { name: "OpenText", tenants: ["opentext"], ats: "unknown", sectors: ["enterprise software"], canadaCities: ["Waterloo", "Toronto"], canadaHq: true, seedPageUrls: ["https://careers.opentext.com/"] },
  { name: "BlackBerry", tenants: ["bb", "blackberry"], ats: "workday", sectors: ["security", "iot"], canadaCities: ["Waterloo", "Ottawa"], canadaHq: true },
  { name: "CGI", tenants: ["cgi"], ats: "unknown", sectors: ["consulting", "it services"], canadaCities: ["Montreal", "Toronto", "Ottawa"], canadaHq: true, seedPageUrls: ["https://www.cgi.com/en/careers"] },
  { name: "Manulife", tenants: ["manulife"], ats: "workday", sectors: ["insurance", "finance"], canadaCities: ["Toronto", "Montreal", "Waterloo"], canadaHq: true },
  { name: "Sun Life", searchTerms: ["Sun Life Financial"], tenants: ["sunlife"], ats: "workday", sectors: ["insurance", "finance"], canadaCities: ["Toronto", "Waterloo", "Montreal"], canadaHq: true },
  { name: "Intact Financial", tenants: ["intact"], ats: "workday", sectors: ["insurance", "finance"], canadaCities: ["Toronto", "Montreal", "Calgary"], canadaHq: true },
  { name: "Great-West Lifeco", searchTerms: ["Canada Life"], tenants: ["greatwestlifeco", "gwl", "canadalifeassurance"], ats: "workday", sectors: ["insurance", "finance"], canadaCities: ["Winnipeg", "Toronto"], canadaHq: true },
  { name: "Thomson Reuters", tenants: ["thomsonreuters"], ats: "workday", sectors: ["data", "legal tech", "finance"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Brookfield", tenants: ["brookfield"], ats: "workday", sectors: ["finance", "infrastructure"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "OMERS", tenants: ["omers"], ats: "workday", sectors: ["finance", "pension"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "CPP Investments", tenants: ["cppinvestments", "cppib"], ats: "workday", sectors: ["finance", "pension"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Ontario Teachers", tenants: ["otppb", "otpp"], ats: "workday", sectors: ["finance", "pension"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Kinaxis", tenants: ["kinaxis"], ats: "workday", sectors: ["supply chain", "enterprise software"], canadaCities: ["Ottawa", "Toronto"], canadaHq: true },
  { name: "Descartes Systems", tenants: ["descartes"], ats: "workday", sectors: ["logistics", "enterprise software"], canadaCities: ["Waterloo"], canadaHq: true },
  { name: "Lightspeed", tenants: ["lightspeed", "lightspeedcommerce"], ats: "workday", sectors: ["commerce", "fintech"], canadaCities: ["Montreal"], canadaHq: true },
  { name: "Nuvei", tenants: ["nuvei"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: ["Montreal"], canadaHq: true },
  { name: "Constellation Software", tenants: ["csisoftware", "constellation"], ats: "workday", sectors: ["enterprise software"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Clio", tenants: ["clio", "themis"], ats: "workday", sectors: ["legal tech"], canadaCities: ["Vancouver", "Toronto", "Calgary"], canadaHq: true, remoteCanadaLikely: true },
  { name: "PointClickCare", tenants: ["pointclickcare"], ats: "workday", sectors: ["healthtech", "enterprise software"], canadaCities: ["Toronto", "Waterloo"], canadaHq: true, remoteCanadaLikely: true },
  { name: "Interac", tenants: ["interac"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "TMX Group", searchTerms: ["TMX"], tenants: ["tmxgroup", "tmx"], ats: "unknown", sectors: ["finance", "markets", "data"], canadaCities: ["Toronto"], canadaHq: true, seedPageUrls: ["https://careers.tmx.com/"] },
  { name: "Questrade", tenants: ["questrade"], ats: "unknown", sectors: ["fintech", "brokerage"], canadaCities: ["Toronto"], canadaHq: true, seedPageUrls: ["https://www.questrade.com/about-questrade/careers"] },
  { name: "Bank of Canada", searchTerms: ["Banque du Canada"], tenants: ["bankofcanada", "banqueducanada"], ats: "workday", sectors: ["finance", "research"], canadaCities: ["Ottawa"], canadaHq: true },
  { name: "BDC", tenants: ["bdc"], ats: "workday", sectors: ["finance", "banking"], canadaCities: ["Montreal", "Toronto"], canadaHq: true },
  { name: "Export Development Canada", searchTerms: ["EDC"], tenants: ["edc"], ats: "unknown", sectors: ["finance", "trade"], canadaCities: ["Ottawa", "Toronto"], canadaHq: true, seedPageUrls: ["https://www.edc.ca/en/about-us/careers.html"] },
  { name: "iA Financial Group", searchTerms: ["iA", "Industrial Alliance"], tenants: ["iafinancial", "ia"], ats: "unknown", sectors: ["insurance", "finance"], canadaCities: ["Quebec City", "Toronto"], canadaHq: true, seedPageUrls: ["https://www.ia.ca/careers"] },
  { name: "Toronto Hydro", tenants: ["torontohydro"], ats: "unknown", sectors: ["utilities", "energy"], canadaCities: ["Toronto"], canadaHq: true, seedPageUrls: ["https://www.torontohydro.com/about-us/careers"] },
  { name: "FortisBC", tenants: ["fortisbc"], ats: "unknown", sectors: ["utilities", "energy"], canadaCities: ["Vancouver"], canadaHq: true, seedPageUrls: ["https://www.fortisbc.com/about-us/careers"] },
  { name: "Cameco", tenants: ["cameco"], ats: "unknown", sectors: ["energy", "materials"], canadaCities: ["Saskatoon"], canadaHq: true, seedPageUrls: ["https://www.cameco.com/careers"] },
  { name: "TC Energy", tenants: ["tcenergy"], ats: "workday", sectors: ["energy", "infrastructure"], canadaCities: ["Calgary"], canadaHq: true },
  { name: "Enbridge", tenants: ["enbridge"], ats: "workday", sectors: ["energy", "infrastructure"], canadaCities: ["Calgary", "Toronto"], canadaHq: true },
  { name: "Suncor", tenants: ["suncor"], ats: "workday", sectors: ["energy", "materials"], canadaCities: ["Calgary"], canadaHq: true },
  { name: "CPKC (CP Rail)", searchTerms: ["CP Rail", "Canadian Pacific Kansas City"], tenants: ["cpkc", "cpr"], ats: "unknown", sectors: ["transportation", "logistics"], canadaCities: ["Calgary", "Vancouver"], canadaHq: true, seedPageUrls: ["https://www.cpkcr.com/en/careers"] },
  { name: "CN Rail", searchTerms: ["Canadian National Railway", "CN"], tenants: ["cn", "cnr"], ats: "unknown", sectors: ["transportation", "logistics"], canadaCities: ["Montreal", "Toronto"], canadaHq: true, seedPageUrls: ["https://www.cn.ca/en/careers/"] },
  { name: "Stantec", tenants: ["stantec"], ats: "workday", sectors: ["engineering", "consulting"], canadaCities: ["Edmonton", "Toronto", "Vancouver", "Ottawa"], canadaHq: true, seedPageUrls: ["https://careers.stantec.com/"] },
  { name: "AtkinsRéalis", tenants: ["slihrms", "atkinsrealis", "snclavalin"], ats: "workday", sectors: ["engineering", "infrastructure", "consulting"], canadaCities: ["Montreal", "Toronto"], canadaHq: true, seedPageUrls: ["https://www.atkinsrealis.com/en/careers"] },
  { name: "WSP", tenants: ["wsp"], ats: "workday", sectors: ["engineering", "consulting"], canadaCities: ["Montreal", "Toronto", "Vancouver"], canadaHq: true, seedPageUrls: ["https://www.wsp.com/en-ca/careers"] },
  { name: "Air Canada", tenants: ["aircanada"], ats: "unknown", sectors: ["travel", "transportation"], canadaCities: ["Montreal", "Toronto", "Vancouver"], canadaHq: true, seedPageUrls: ["https://careers.aircanada.com/"] },
  { name: "Canadian Tire", tenants: ["canadiantirecorporation", "canadiantire"], ats: "workday", sectors: ["retail", "ecommerce"], canadaCities: ["Toronto"], canadaHq: true },
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
  { name: "IBM", tenants: ["ibm"], ats: "workday", sectors: ["tech", "enterprise", "consulting"], canadaCities: ["Toronto", "Ottawa", "Markham"] },
  { name: "Uber", tenants: ["uber"], ats: "unknown", sectors: ["tech", "transportation"], canadaCities: ["Toronto"], seedPageUrls: ["https://www.uber.com/us/en/careers/"] },
  { name: "Lyft", tenants: ["lyft"], ats: "workday", sectors: ["tech", "transportation"], canadaCities: ["Toronto"] },
  { name: "Salesforce", tenants: ["salesforce"], ats: "workday", sectors: ["enterprise software", "cloud"], canadaCities: ["Toronto", "Vancouver"] },
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
  { name: "Databricks", tenants: ["databricks"], ats: "workday", sectors: ["data", "ai", "cloud"], canadaCities: ["Toronto"] },
  { name: "Palantir", tenants: ["palantir"], ats: "workday", sectors: ["data", "government"], canadaCities: [] },
  { name: "DocuSign", tenants: ["docusign"], ats: "workday", sectors: ["enterprise software"], canadaCities: [] },
  { name: "Okta", tenants: ["okta"], ats: "workday", sectors: ["security", "identity"], canadaCities: ["Toronto"] },
  { name: "HubSpot", tenants: ["hubspot"], ats: "workday", sectors: ["marketing", "crm"], canadaCities: ["Toronto"] },
  { name: "Atlassian", tenants: ["atlassian"], ats: "workday", sectors: ["devtools", "enterprise software"], canadaCities: [] },
  { name: "Zoom", tenants: ["zoom"], ats: "workday", sectors: ["communications"], canadaCities: [] },
  { name: "Block / Square", tenants: ["block", "squareup"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: [] },
  { name: "Stripe", tenants: ["stripe"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: ["Toronto"] },
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
  { name: "American Express", tenants: ["americanexpress", "aexp"], ats: "workday", sectors: ["finance", "payments"], canadaCities: ["Toronto"] },
  { name: "Mastercard", tenants: ["mastercard"], ats: "workday", sectors: ["fintech", "payments"], canadaCities: ["Toronto"] },
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
  { name: "Veeva Systems", tenants: ["veeva"], ats: "workday", sectors: ["healthtech", "cloud"], canadaCities: [] },
  { name: "GE HealthCare", tenants: ["gehealthcare"], ats: "workday", sectors: ["healthtech", "medical devices"], canadaCities: [] },
  { name: "Deloitte", tenants: ["deloitte"], ats: "workday", sectors: ["consulting", "finance"], canadaCities: ["Toronto", "Montreal", "Calgary", "Vancouver"] },
  { name: "PwC", tenants: ["pwc"], ats: "workday", sectors: ["consulting", "finance"], canadaCities: ["Toronto", "Montreal"] },
  { name: "EY", tenants: ["ey"], ats: "workday", sectors: ["consulting", "finance"], canadaCities: ["Toronto", "Montreal"] },
  { name: "KPMG", tenants: ["kpmg"], ats: "workday", sectors: ["consulting", "finance"], canadaCities: ["Toronto", "Montreal", "Calgary"] },
  { name: "McKinsey", tenants: ["mckinsey"], ats: "workday", sectors: ["consulting"], canadaCities: ["Toronto", "Montreal"] },
  { name: "BCG", tenants: ["bcg"], ats: "workday", sectors: ["consulting"], canadaCities: ["Toronto"] },
  { name: "Bain", tenants: ["bain"], ats: "workday", sectors: ["consulting"], canadaCities: ["Toronto"] },
  { name: "PSP Investments", searchTerms: ["PSP"], tenants: ["investpsp"], ats: "workday", sectors: ["finance", "pension"], canadaCities: ["Montreal", "Toronto"], canadaHq: true },
  { name: "NAV CANADA", tenants: ["navcanada"], ats: "workday", sectors: ["transportation", "government"], canadaCities: ["Ottawa"], canadaHq: true },
  { name: "CAE", tenants: ["cae"], ats: "workday", sectors: ["aerospace", "defense", "simulation"], canadaCities: ["Montreal", "Toronto"], canadaHq: true },
  { name: "ENMAX", tenants: ["enmax"], ats: "workday", sectors: ["utilities", "energy"], canadaCities: ["Calgary"], canadaHq: true },
  { name: "Capital Power", tenants: ["capitalpower"], ats: "workday", sectors: ["utilities", "energy"], canadaCities: ["Edmonton"], canadaHq: true },
  { name: "Northland Power", tenants: ["northlandpower"], ats: "workday", sectors: ["utilities", "energy"], canadaCities: ["Toronto"], canadaHq: true },
  { name: "Bruce Power", tenants: ["brucepower"], ats: "workday", sectors: ["utilities", "energy", "nuclear"], canadaCities: ["Tiverton"], canadaHq: true },
  { name: "Viterra", tenants: ["viterra"], ats: "workday", sectors: ["agtech", "commodities"], canadaCities: ["Regina", "Calgary"], canadaHq: true },
  { name: "Stelco", tenants: ["stelco"], ats: "workday", sectors: ["materials", "steel"], canadaCities: ["Hamilton"], canadaHq: true },
  { name: "BDO Canada", searchTerms: ["BDO"], tenants: ["bdo"], ats: "workday", sectors: ["consulting", "finance"], canadaCities: ["Toronto", "Vancouver", "Montreal"], canadaHq: true },
  { name: "Telus International", searchTerms: ["TELUS International"], tenants: ["telusinternational"], ats: "workday", sectors: ["tech", "digital services"], canadaCities: ["Vancouver", "Toronto"], canadaHq: true },
  { name: "Lifeworks / TELUS Health", searchTerms: ["LifeWorks", "TELUS Health"], tenants: ["lifeworks"], ats: "workday", sectors: ["healthtech", "hr tech"], canadaCities: ["Toronto", "Montreal"], canadaHq: true },
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
