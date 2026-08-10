import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchFormattedJobDescriptionFromUrl,
  formatJobDescriptionText,
  getCleanJobDescriptionDisplayBlocks,
  getJobDescriptionSummaryBlocks,
  isJobDescriptionSummaryUsable,
  isLowQualityJobDescription,
  selectDescriptionSource,
} from "../src/lib/job-description-format";
import type { FetchGuardDeps } from "../src/lib/ingestion/net/ssrf-guard";

test("cleans source chrome and preserves useful job sections", () => {
  const raw = `
    Skip to main content
    Search
    Saved

    Job Description
    About the role:
    We are looking for a Network Engineer to design, operate, and improve resilient network infrastructure across offices and cloud environments.

    Responsibilities:
    • Own routing, switching, firewall, and wireless changes through planning, implementation, and validation.
    • Partner with security and infrastructure teams to troubleshoot incidents and reduce repeat operational issues.
    • Maintain clear network diagrams and runbooks for support handoffs.

    Similar jobs
    Create alert
  `;

  const blocks = getCleanJobDescriptionDisplayBlocks(raw);
  const rendered = JSON.stringify(blocks);

  assert.equal(isLowQualityJobDescription(raw), false);
  assert.equal(isJobDescriptionSummaryUsable(raw), true);
  assert.match(rendered, /About the role/);
  assert.match(rendered, /Network Engineer/);
  assert.match(rendered, /routing, switching/);
  assert.doesNotMatch(rendered, /Skip to main content/);
  assert.doesNotMatch(rendered, /Similar jobs/);
});

test("marks short aggregator snippets as unusable instead of rendering them as descriptions", () => {
  const raw =
    "Company Description Mindlance is a national recruiting company which partners with many of the leading employers in the Life Sciences, IT, and Financial Services sectors, feel free to check us out at Job Description J";

  assert.equal(isLowQualityJobDescription(raw), true);
  assert.equal(isJobDescriptionSummaryUsable(raw), false);
});

test("deduplicates repeated bullets and caps noisy lists", () => {
  const raw = `
    Responsibilities:
    - Build reliable application services used by internal operations teams.
    - Build reliable application services used by internal operations teams.
    - Partner with product managers to clarify scope and reduce delivery risk.
    - Improve observability with useful logs, metrics, and alerts.
    - Review code and help maintain practical engineering standards.
    - Document operational decisions for future support.
    - Coordinate releases with QA and customer support teams.
    - Remove stale processes that slow down delivery.
  `;

  const listBlock = getCleanJobDescriptionDisplayBlocks(raw).find(
    (block) => block.kind === "list"
  );

  assert.ok(listBlock);
  assert.equal(listBlock.items.length <= 6, true);
  assert.equal(listBlock.items.length >= 3, true);
  assert.equal(
    listBlock.items.filter((item) =>
      item.includes("Build reliable application services")
    ).length,
    1
  );
});

test("prioritizes detailed responsibilities and qualifications over early company copy", () => {
  const raw = `
    About us
    Acme builds workplace software for organizations around the world.

    About the role
    Join the platform team as a Software Engineer and help deliver reliable systems for customers and internal teams.

    Responsibilities
    - Design and ship TypeScript services used by customer-facing product workflows.
    - Build well-tested APIs and background jobs that handle high-volume operational data.
    - Partner with product and design to turn ambiguous requirements into maintainable features.
    - Improve observability with actionable logs, metrics, and alerts for on-call engineers.
    - Review code and help establish practical engineering standards across the team.
    - Document technical decisions and operational runbooks for reliable support handoffs.

    Required qualifications
    - Professional experience building production web applications with TypeScript or JavaScript.
    - Strong understanding of API design, relational data modeling, and automated testing.
    - Ability to collaborate with product, design, and infrastructure partners on delivery tradeoffs.
    - Clear written communication when documenting technical decisions and operational risks.

    Preferred qualifications
    - Experience with cloud infrastructure, background processing, or observability tooling.
    - Familiarity with PostgreSQL performance tuning and modern continuous delivery practices.
  `;

  const summary = JSON.stringify(getJobDescriptionSummaryBlocks(raw, 4));

  assert.match(summary, /Join the platform team as a Software Engineer/);
  assert.match(summary, /Design and ship TypeScript services/);
  assert.match(summary, /Document technical decisions and operational runbooks/);
  assert.match(summary, /Professional experience building production web applications/);
  assert.match(summary, /Clear written communication when documenting technical decisions/);
  assert.doesNotMatch(summary, /Acme builds workplace software/);
});

test("rejects metadata-only descriptions", () => {
  const raw = "Team: Security Department: Technical Infrastructure";

  assert.equal(isLowQualityJobDescription(raw), true);
  assert.equal(isJobDescriptionSummaryUsable(raw), false);
  assert.deepEqual(getCleanJobDescriptionDisplayBlocks(raw), []);
});

test("rejects short location or authorization notes as full descriptions", () => {
  const raw =
    "Job Description À noter : Quiconque pose sa candidature doit disposer d’une autorisation de travail au Canada. On-site expectation.";

  assert.equal(isLowQualityJobDescription(raw), true);
  assert.equal(isJobDescriptionSummaryUsable(raw), false);
});

test("prefers JobPosting schema description over leaked page title bullets", () => {
  const raw = `
    • Software Engineer @ Kong
    •
    {"@context":"https://schema.org/","@type":"JobPosting","title":"Software Engineer","description":" Are you ready to unlock intelligence?\\n\\nAbout the role\\nKong is looking for a Software Engineer to build reliable developer-facing systems.\\n\\nResponsibilities\\n- Build APIs and distributed services used by engineering teams.\\n- Partner with product and infrastructure teams to improve reliability.\\n\\nRequirements\\n- Experience with TypeScript, Go, or distributed systems. "}
  `;

  const formatted = formatJobDescriptionText(raw);

  assert.match(formatted, /^Are you ready to unlock intelligence\?/);
  assert.match(formatted, /About the role/);
  assert.match(formatted, /Build APIs and distributed services/);
  assert.doesNotMatch(formatted, /Software Engineer @ Kong/);
  assert.doesNotMatch(formatted, /"@context"/);
  assert.equal(isJobDescriptionSummaryUsable(formatted), true);
});

test("extracts JobPosting schema description from HTML script content", () => {
  const html = `
    <html>
      <head>
        <title>Software Engineer @ Kong</title>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Software Engineer",
            "description": "<p>About the role</p><p>Kong is looking for a Software Engineer to build reliable platform features for customers.</p><ul><li>Own backend services and APIs.</li><li>Improve observability and deployment safety.</li></ul><p>Requirements include TypeScript, Go, and distributed systems experience.</p>"
          }
        </script>
      </head>
      <body>
        <h1>Software Engineer @ Kong</h1>
      </body>
    </html>
  `;

  const formatted = formatJobDescriptionText(html);

  assert.match(formatted, /^About the role/);
  assert.match(formatted, /Own backend services and APIs/);
  assert.doesNotMatch(formatted, /application\/ld\+json/);
  assert.doesNotMatch(formatted, /"@type"/);
  assert.equal(isJobDescriptionSummaryUsable(formatted), true);
});

const SUBSTANTIAL_SINGLE_PARAGRAPH =
  "We are looking for a Senior Platform Engineer to join our infrastructure team and help us build reliable, scalable developer-facing systems that thousands of engineers depend on every single day. You will design and operate core services, improve deployment safety, and reduce operational toil through thoughtful automation and clear observability across the whole stack. The ideal candidate has strong experience with distributed systems, cloud infrastructure, and modern continuous delivery practices, and genuinely enjoys mentoring other engineers. You will collaborate closely with product and security teams to ship features that are correct, safe, and easy to support in production over the long term.";

test("accepts a complete single-paragraph posting (the exact-original-just-reorganized case)", () => {
  assert.equal(SUBSTANTIAL_SINGLE_PARAGRAPH.length >= 600, true);
  assert.equal(isLowQualityJobDescription(SUBSTANTIAL_SINGLE_PARAGRAPH), false);
  assert.equal(isJobDescriptionSummaryUsable(SUBSTANTIAL_SINGLE_PARAGRAPH), true);
});

test("acceptance of a complete posting does not depend on paragraph breaks", () => {
  const midpoint = SUBSTANTIAL_SINGLE_PARAGRAPH.indexOf(". ") + 2;
  const withBreak =
    SUBSTANTIAL_SINGLE_PARAGRAPH.slice(0, midpoint) +
    "\n\n" +
    SUBSTANTIAL_SINGLE_PARAGRAPH.slice(midpoint);
  assert.equal(
    isLowQualityJobDescription(SUBSTANTIAL_SINGLE_PARAGRAPH),
    isLowQualityJobDescription(withBreak)
  );
  assert.equal(isLowQualityJobDescription(withBreak), false);
});

test("still rejects a short single-paragraph blob under the substantial threshold", () => {
  const shortBlob =
    "We need a coordinator to help with scheduling and some light administrative work in the office a few days a week.";
  assert.equal(shortBlob.length < 600, true);
  assert.equal(isLowQualityJobDescription(shortBlob), true);
});

test("rejects a substantial single-paragraph blob that is not a job posting", () => {
  const marketing =
    "Acme Corporation is a leading global provider of innovative cloud solutions that empower businesses of every size to achieve more. Founded in 2005, Acme has grown into a trusted partner for thousands of customers worldwide, delivering cutting-edge technology and world-class service. Our mission is to make work simpler, more pleasant, and more productive for everyone. We are proud of our vibrant culture, our commitment to sustainability, and our long track record of continual innovation across the industry. Today, Acme serves organizations on six continents and is widely regarded as one of the most admired names in enterprise software, with a reputation built on reliability, integrity, and a relentless focus on customer happiness.";
  assert.equal(marketing.length >= 600, true);
  assert.equal(isLowQualityJobDescription(marketing), true);
});

test("a structured posting whose last line ends with an ellipsis is still accepted", () => {
  const structured = `About the role
We are hiring a Backend Engineer to build reliable, scalable services that support our engineering organization and customers around the world.

Responsibilities
- Own backend APIs and improve deployment safety across the whole platform every day.
- Partner closely with product and security teams to define scope and reduce operational risk.
- Improve observability with useful logs, metrics, and alerts so that on-call rotations stay calm…`;
  assert.equal(structured.length >= 360, true);
  assert.equal(isLowQualityJobDescription(structured), false);
});

test("an unstructured blob ending with an ellipsis is rejected as truncated", () => {
  const teaser = SUBSTANTIAL_SINGLE_PARAGRAPH + " Apply now to learn more about this exciting opportunity and…";
  assert.equal(isLowQualityJobDescription(teaser), true);
});

test("uses the first JobPosting in document order across multiple ld+json blocks", () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Target","description":"<p>About the target role</p><p>This is the full and complete description of the target job with responsibilities, requirements, and enough detail for a real posting on this page.</p>"}</script>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Similar","description":"A short similar-jobs teaser that is at least eighty characters long so it also registers as a JobPosting candidate here."}</script>
  </head><body></body></html>`;

  const formatted = formatJobDescriptionText(html);
  assert.match(formatted, /About the target role/);
  assert.doesNotMatch(formatted, /similar-jobs teaser/);
});

const JSONLD_COMPLETE_PAGE = `<html><head>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Engineer","description":"<p>About the role</p><p>You will own backend APIs, improve deployment safety, and design resilient distributed systems that support engineering teams across the company every single day of the week.</p><ul><li>Own backend services and APIs used across the organization.</li><li>Partner with product and security to define scope and reduce risk.</li><li>Improve observability with useful logs, metrics, and alerts.</li></ul><p>Requirements include strong experience with TypeScript, Go, and distributed systems, plus a track record of shipping reliable software.</p>"}</script>
  </head><body>
    <div class="job-description"><div><p>truncated fragment only</p></div><div><p>should not become the source</p></div></div>
  </body></html>`;

test("selectDescriptionSource prefers the complete JSON-LD posting over the DOM container", () => {
  const formatted = formatJobDescriptionText(selectDescriptionSource(JSONLD_COMPLETE_PAGE));
  assert.match(formatted, /Own backend services and APIs/);
  assert.doesNotMatch(formatted, /truncated fragment only/);
});

test("selectDescriptionSource falls back to the DOM container when no JSON-LD exists", () => {
  const html = `<html><body><div class="job-description"><p>We are hiring a Data Engineer to build robust data pipelines and improve data quality across the analytics platform for internal teams every single day.</p><ul><li>Design and own ETL workflows.</li><li>Own data quality checks and alerting.</li></ul></div></body></html>`;
  const formatted = formatJobDescriptionText(selectDescriptionSource(html));
  assert.match(formatted, /Data Engineer/);
  assert.match(formatted, /Design and own ETL workflows/);
});

const PUBLIC_RESOLVE = async () => [{ address: "93.184.216.34", family: 4 }];

test("fetch retries with a fallback User-Agent when the first attempt is blocked", async () => {
  const seenUserAgents: string[] = [];
  const deps: FetchGuardDeps = {
    resolve: PUBLIC_RESOLVE,
    fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
      const ua = String(
        (init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? ""
      );
      seenUserAgents.push(ua);
      if (ua.includes("Chrome")) {
        return new Response("blocked", { status: 403 });
      }
      return new Response(JSONLD_COMPLETE_PAGE, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch,
  };

  const result = await fetchFormattedJobDescriptionFromUrl(
    "https://jobs.example.com/engineer",
    deps
  );

  assert.ok(result);
  assert.match(result as string, /Own backend services and APIs/);
  assert.equal(seenUserAgents.length, 2);
  assert.notEqual(seenUserAgents[0], seenUserAgents[1]);
});

test("fetch keeps a JS-rendered page that still ships JobPosting JSON-LD", async () => {
  const html = JSONLD_COMPLETE_PAGE.replace(
    "<body>",
    "<body><noscript>You need to enable JavaScript to run this app.</noscript><div id=\"root\"></div>"
  );
  const deps: FetchGuardDeps = {
    resolve: PUBLIC_RESOLVE,
    fetchImpl: (async () =>
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch,
  };

  const result = await fetchFormattedJobDescriptionFromUrl(
    "https://jobs.example.com/spa",
    deps
  );

  assert.ok(result);
  assert.match(result as string, /Own backend services and APIs/);
});

test("fetch returns null for a non-HTML (binary) response", async () => {
  const deps: FetchGuardDeps = {
    resolve: PUBLIC_RESOLVE,
    fetchImpl: (async () =>
      new Response("%PDF-1.7 binary bytes", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })) as typeof fetch,
  };

  const result = await fetchFormattedJobDescriptionFromUrl(
    "https://example.com/job.pdf",
    deps
  );

  assert.equal(result, null);
});
