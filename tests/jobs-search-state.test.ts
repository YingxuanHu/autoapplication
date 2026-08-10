import assert from "node:assert/strict";
import test from "node:test";

import {
  hasJobsStateParamsRecord,
  mergeNaturalLanguageJobsSearch,
  normalizeJobsStateQuery,
} from "../src/lib/jobs/search-state";

test("jobs URL params are detected and normalized for restore", () => {
  assert.equal(hasJobsStateParamsRecord({ titleSearch: "backend" }), true);
  assert.equal(hasJobsStateParamsRecord({ hideApplied: "1" }), true);
  assert.equal(hasJobsStateParamsRecord({ status: "LIVE" }), false);
  assert.equal(hasJobsStateParamsRecord({ reset: "1" }), false);
  assert.equal(hasJobsStateParamsRecord({ searchScope: "title" }), false);
  assert.equal(hasJobsStateParamsRecord({ field: "company" }), false);

  assert.equal(
    normalizeJobsStateQuery(
      "q=backend&field=title&page=3&sort=best&function=software_engineering&datePosted=7d"
    ),
    "searchScope=title&titleSearch=backend&jobFunction=software_engineering&posted=7d&page=3"
  );
  assert.equal(normalizeJobsStateQuery("hideApplied=true"), "hideApplied=1");
  assert.equal(normalizeJobsStateQuery("status=LIVE"), "");
  assert.equal(normalizeJobsStateQuery("status=AGING"), "status=AGING");
});

test("legacy broad search state restores as title keyword search", () => {
  assert.equal(
    normalizeJobsStateQuery("search=thank%20you&searchScope=all&page=2"),
    "searchScope=title&titleSearch=thank+you&page=2"
  );
  assert.equal(
    normalizeJobsStateQuery("q=amazon&field=all"),
    "searchScope=title&titleSearch=amazon"
  );
});

test("in-app restored jobs state omits stale page numbers", () => {
  assert.equal(
    normalizeJobsStateQuery(
      "titleSearch=engineer&jobFunction=Software%20Engineering,AI%20%2F%20Machine%20Learning&industry=Finance%20%26%20Banking&page=7&sortBy=newest",
      { includePage: false }
    ),
    "searchScope=title&titleSearch=engineer&industry=Finance+%26+Banking&jobFunction=Software+Engineering%2CAI+%2F+Machine+Learning&sortBy=newest"
  );
});

test("empty or cleared jobs state normalizes to default", () => {
  assert.equal(normalizeJobsStateQuery("", { includePage: false }), "");
  assert.equal(normalizeJobsStateQuery("reset=1", { includePage: false }), "");
});

test("guided job search replaces only the filter groups it recognizes", () => {
  assert.equal(
    mergeNaturalLanguageJobsSearch(
      "titleSearch=analyst&companySearch=OpenAI&workMode=ONSITE&hideApplied=1&sortBy=newest&page=4",
      {
        jobFunction: "Software Engineering",
        searchScope: "title",
        titleSearch: "backend",
        workMode: "REMOTE",
      }
    ),
    "/jobs?searchScope=title&titleSearch=backend&companySearch=OpenAI&workMode=REMOTE&jobFunction=Software+Engineering&hideApplied=1&sortBy=newest"
  );
});

test("guided job search preserves unrelated saved filters", () => {
  assert.equal(
    mergeNaturalLanguageJobsSearch(
      "locationSearch=Toronto&careerStage=ENTRY_LEVEL&hideApplied=1",
      { posted: "7d" }
    ),
    "/jobs?searchScope=location&locationSearch=Toronto&hideApplied=1&careerStage=ENTRY_LEVEL&posted=7d"
  );
});

test("guided job search keeps both salary bounds when it replaces a salary filter", () => {
  assert.equal(
    mergeNaturalLanguageJobsSearch(
      "salaryMin=80000&salaryMax=110000&includeUnknownSalary=1",
      { salaryCurrency: "USD", salaryMin: "120000", salaryMax: "160000" }
    ),
    "/jobs?salaryMin=120000&salaryMax=160000&salaryCurrency=USD"
  );
});
