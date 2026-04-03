/**
 * Greenhouse ATS form filler.
 *
 * Greenhouse application forms live at:
 *   boards.greenhouse.io/{company}/jobs/{id}  (the #app anchor scrolls to the form)
 *   or directly embedded in company career sites.
 *
 * Form structure (standard Greenhouse embedded form):
 *   - #first_name, #last_name, #email, #phone (standard inputs)
 *   - input[type="file"] for resume upload (within a .field container)
 *   - Optional cover letter textarea
 *   - Custom questions as fieldsets with various input types
 *   - Submit button: input[type="submit"] or button[type="submit"]
 */
import type { Page } from "playwright";
import type {
  ATSFiller,
  ATSFillerContext,
  ATSFillerResult,
  FilledField,
  UnfillableField,
  AutomationBlocker,
} from "../types";
import { buildFieldValueMap, matchLabelToConcept, type FieldConcept } from "../field-map";
import { navigateToForm, detectBlockers } from "../browser";
import { captureScreenshot } from "../screenshots";

// ─── Selector map ────────────────────────────────────────────────────────────

type GreenhouseFieldDef = {
  selector: string;
  concept: FieldConcept;
  inputType: "text" | "file" | "textarea" | "select";
  required: boolean;
};

const STANDARD_FIELDS: GreenhouseFieldDef[] = [
  { selector: "#first_name", concept: "first_name", inputType: "text", required: true },
  { selector: "#last_name", concept: "last_name", inputType: "text", required: true },
  { selector: "#email", concept: "email", inputType: "text", required: true },
  { selector: "#phone", concept: "phone", inputType: "text", required: false },
];

// ─── Filler implementation ──────────────────────────────────────────────────

async function fillGreenhouseForm(ctx: ATSFillerContext): Promise<ATSFillerResult> {
  const start = Date.now();
  const { page, mode, screenshotDir } = ctx;
  const filledFields: FilledField[] = [];
  const unfillableFields: UnfillableField[] = [];
  const blockers: AutomationBlocker[] = [];
  const screenshots: string[] = [];

  const values = buildFieldValueMap(ctx.profile, ctx.resume, ctx.applicationPackage);

  // ─── Navigate ──────────────────────────────────────────────────────
  const nav = await navigateToForm(page, ctx.applyUrl);
  if (!nav.ok) {
    screenshots.push(await captureScreenshot(page, screenshotDir, "01_navigation_failed"));
    const blockerType = nav.statusHint === "position_closed" ? "position_closed" as const : "timeout" as const;
    return makeResult("failed", filledFields, unfillableFields, [
      { type: blockerType, detail: nav.statusHint },
    ], screenshots, start);
  }

  // Scroll to application form (Greenhouse uses #app or #application anchors)
  await scrollToForm(page);
  screenshots.push(await captureScreenshot(page, screenshotDir, "01_form_loaded"));

  // ─── Check blockers ────────────────────────────────────────────────
  const detectedBlockers = await detectBlockers(page);
  if (detectedBlockers.length > 0) {
    for (const b of detectedBlockers) {
      blockers.push({ type: b.type as AutomationBlocker["type"], detail: b.detail });
    }
    return makeResult("blocked", filledFields, unfillableFields, blockers, screenshots, start);
  }

  // ─── Detect if the form is present ─────────────────────────────────
  const formPresent = await page.locator("#first_name, #application_form, form#application").count();
  if (formPresent === 0) {
    // Try scrolling down and waiting more
    await page.waitForTimeout(2000);
    const retryForm = await page.locator("#first_name, input[name*='first_name']").count();
    if (retryForm === 0) {
      screenshots.push(await captureScreenshot(page, screenshotDir, "02_no_form_found"));
      return makeResult("failed", filledFields, unfillableFields, [
        { type: "form_changed", detail: "Could not locate the application form on the page" },
      ], screenshots, start);
    }
  }

  if (mode === "dry_run") {
    // In dry run, just identify fields without filling
    const detected = await detectAllFields(page, values);
    screenshots.push(await captureScreenshot(page, screenshotDir, "02_dry_run_analysis"));
    return makeResult("filled", detected.filled, detected.unfillable, blockers, screenshots, start,
      "Dry run complete. Fields identified but not filled.");
  }

  // ─── Fill standard fields ──────────────────────────────────────────
  for (const field of STANDARD_FIELDS) {
    const value = values[field.concept];
    const exists = await page.locator(field.selector).count();
    if (exists === 0) {
      if (field.required) {
        unfillableFields.push({ label: field.concept, reason: "Selector not found", required: true });
      }
      continue;
    }
    if (!value) {
      unfillableFields.push({ label: field.concept, reason: "No value in profile", required: field.required });
      continue;
    }
    await page.locator(field.selector).fill(value);
    filledFields.push({ label: field.concept, selector: field.selector, value });
  }

  // ─── Resume upload ─────────────────────────────────────────────────
  const resumeUploaded = await uploadResume(page, ctx.resume.filePath);
  if (resumeUploaded) {
    filledFields.push({ label: "resume_file", selector: "input[type=file]", value: ctx.resume.label });
  } else {
    unfillableFields.push({ label: "resume_file", reason: "No file to upload or upload failed", required: true });
  }

  // ─── Cover letter (if textarea exists) ─────────────────────────────
  if (values.cover_letter) {
    const coverSelectors = [
      '#cover_letter',
      'textarea[name*="cover_letter"]',
      'textarea[id*="cover_letter"]',
    ];
    for (const sel of coverSelectors) {
      const exists = await page.locator(sel).count();
      if (exists > 0) {
        await page.locator(sel).fill(values.cover_letter);
        filledFields.push({ label: "cover_letter", selector: sel, value: "(cover letter text)" });
        break;
      }
    }
  }

  // ─── LinkedIn / Website URLs ───────────────────────────────────────
  await fillUrlFields(page, values, filledFields, unfillableFields);

  // ─── Custom questions (heuristic) ──────────────────────────────────
  await fillCustomQuestions(page, values, ctx.applicationPackage.savedAnswers, filledFields, unfillableFields);

  screenshots.push(await captureScreenshot(page, screenshotDir, "03_form_filled"));

  // ─── Check for unfillable required fields → block submission ───────
  const hasRequiredGaps = unfillableFields.some((f) => f.required);
  if (hasRequiredGaps && mode === "fill_and_submit") {
    blockers.push({
      type: "required_field_unknown",
      detail: `Required fields could not be filled: ${unfillableFields.filter((f) => f.required).map((f) => f.label).join(", ")}`,
    });
    return makeResult("blocked", filledFields, unfillableFields, blockers, screenshots, start,
      "Form filled but submission blocked due to missing required fields.");
  }

  // ─── Submit ────────────────────────────────────────────────────────
  if (mode === "fill_and_submit") {
    screenshots.push(await captureScreenshot(page, screenshotDir, "04_pre_submit"));

    const submitted = await clickSubmit(page);
    if (!submitted) {
      return makeResult("failed", filledFields, unfillableFields, [
        { type: "form_changed", detail: "Could not find or click the submit button" },
      ], screenshots, start);
    }

    // Wait for post-submit state
    await page.waitForTimeout(3000);
    screenshots.push(await captureScreenshot(page, screenshotDir, "05_post_submit"));

    // Verify submission succeeded (look for confirmation signals)
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const confirmed = /thank you|application.*received|submitted|successfully/i.test(bodyText);

    return makeResult(
      confirmed ? "submitted" : "submitted",
      filledFields, unfillableFields, blockers, screenshots, start,
      confirmed ? "Application submitted and confirmation detected." : "Submit clicked but could not confirm success.",
      confirmed ? new Date() : new Date()
    );
  }

  // fill_only — done
  return makeResult("filled", filledFields, unfillableFields, blockers, screenshots, start,
    "Form filled. Ready for human review before submission.");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function scrollToForm(page: Page) {
  // Greenhouse often has the form below the job description
  // Try scrolling to the application section
  const anchors = ["#app", "#application", "#application_form", "#grnhse_app"];
  for (const anchor of anchors) {
    const found = await page.locator(anchor).count();
    if (found > 0) {
      await page.locator(anchor).scrollIntoViewIfNeeded().catch(() => {});
      return;
    }
  }
  // Fallback: scroll to #first_name
  const firstName = await page.locator("#first_name").count();
  if (firstName > 0) {
    await page.locator("#first_name").scrollIntoViewIfNeeded().catch(() => {});
  }
}

async function uploadResume(page: Page, filePath: string | null): Promise<boolean> {
  if (!filePath) return false;

  // Greenhouse uses various selectors for file upload
  const uploadSelectors = [
    '#resume input[type="file"]',
    'input[type="file"][name*="resume"]',
    'input[type="file"][id*="resume"]',
    '.field input[type="file"]',
    'input[type="file"]', // last resort — first file input
  ];

  for (const selector of uploadSelectors) {
    const count = await page.locator(selector).count();
    if (count > 0) {
      try {
        await page.locator(selector).first().setInputFiles(filePath);
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

async function fillUrlFields(
  page: Page,
  values: Record<string, string | null>,
  filledFields: FilledField[],
  unfillableFields: UnfillableField[]
) {
  const urlFieldPatterns: Array<{
    labelPattern: RegExp;
    concept: FieldConcept;
  }> = [
    { labelPattern: /linkedin/i, concept: "linkedin_url" },
    { labelPattern: /github/i, concept: "github_url" },
    { labelPattern: /portfolio|website|personal.*url/i, concept: "website_url" },
  ];

  for (const { labelPattern, concept } of urlFieldPatterns) {
    const value = values[concept];
    if (!value) continue;

    // Look for input fields with matching labels
    const inputs = page.locator("input[type='text'], input[type='url'], input:not([type])");
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      const label = await getFieldLabel(page, input);
      if (label && labelPattern.test(label)) {
        await input.fill(value);
        filledFields.push({ label: concept, selector: `input#${await input.getAttribute("id") ?? i}`, value });
        break;
      }
    }
  }
}

async function fillCustomQuestions(
  page: Page,
  values: Record<string, string | null>,
  savedAnswers: Record<string, string>,
  filledFields: FilledField[],
  unfillableFields: UnfillableField[]
) {
  // Look for custom question containers (Greenhouse uses .field or fieldset)
  const fieldContainers = page.locator(".field, fieldset, .application-field");
  const count = await fieldContainers.count();

  for (let i = 0; i < Math.min(count, 30); i++) {
    const container = fieldContainers.nth(i);
    const labelEl = container.locator("label").first();
    const labelText = await labelEl.innerText().catch(() => "");
    if (!labelText || labelText.length < 2) continue;

    // Skip if already filled (standard fields handled above)
    const inputId = await container.locator("input, textarea, select").first().getAttribute("id").catch(() => null);
    if (inputId && ["first_name", "last_name", "email", "phone"].includes(inputId)) continue;

    // Check if we have a saved answer
    const savedKey = Object.keys(savedAnswers).find((k) =>
      labelText.toLowerCase().includes(k.toLowerCase()) ||
      k.toLowerCase().includes(labelText.toLowerCase().slice(0, 20))
    );

    if (savedKey) {
      const input = container.locator("input[type='text'], textarea, input:not([type])").first();
      const inputCount = await input.count();
      if (inputCount > 0) {
        await input.fill(savedAnswers[savedKey]).catch(() => {});
        filledFields.push({ label: labelText.slice(0, 60), selector: `custom:${i}`, value: savedAnswers[savedKey].slice(0, 50) });
        continue;
      }
    }

    // Try heuristic matching for well-known questions
    const concept = matchLabelToConcept(labelText);
    if (concept && values[concept]) {
      const input = container.locator("input[type='text'], textarea, input[type='url'], input:not([type]), select").first();
      const inputCount = await input.count();
      if (inputCount > 0) {
        const tagName = await input.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
        if (tagName === "select") {
          await fillSelectByBestMatch(input, values[concept]!).catch(() => {});
        } else {
          await input.fill(values[concept]!).catch(() => {});
        }
        filledFields.push({ label: labelText.slice(0, 60), selector: `custom:${i}`, value: (values[concept] ?? "").slice(0, 50) });
        continue;
      }
    }

    // Check if the question is required but we couldn't fill it
    const isRequired =
      (await container.locator(".required, [aria-required='true'], .asterisk").count()) > 0 ||
      labelText.includes("*");

    if (isRequired) {
      unfillableFields.push({
        label: labelText.slice(0, 80),
        reason: "No matching answer available",
        required: true,
      });
    }
  }
}

async function fillSelectByBestMatch(
  selectLocator: ReturnType<Page["locator"]>,
  value: string
) {
  // Get all options and pick the best match
  const options = await selectLocator.locator("option").allInnerTexts();
  const lower = value.toLowerCase();
  const match = options.find((opt) => opt.toLowerCase().includes(lower)) ??
    options.find((opt) => lower.includes(opt.toLowerCase()));
  if (match) {
    await selectLocator.selectOption({ label: match });
  }
}

async function getFieldLabel(
  page: Page,
  input: ReturnType<Page["locator"]>
): Promise<string | null> {
  // Try aria-label first
  const ariaLabel = await input.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  // Try associated label via id
  const id = await input.getAttribute("id");
  if (id) {
    const label = page.locator(`label[for="${id}"]`);
    if ((await label.count()) > 0) {
      return label.innerText().catch(() => null);
    }
  }

  // Try placeholder
  const placeholder = await input.getAttribute("placeholder");
  if (placeholder) return placeholder;

  // Try parent label
  const parentLabel = input.locator("xpath=ancestor::label");
  if ((await parentLabel.count()) > 0) {
    return parentLabel.innerText().catch(() => null);
  }

  return null;
}

async function clickSubmit(page: Page): Promise<boolean> {
  const submitSelectors = [
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Apply")',
    '#submit_app',
  ];

  for (const selector of submitSelectors) {
    const count = await page.locator(selector).count();
    if (count > 0) {
      await page.locator(selector).first().click();
      return true;
    }
  }
  return false;
}

async function detectAllFields(
  page: Page,
  values: Record<string, string | null>
): Promise<{ filled: FilledField[]; unfillable: UnfillableField[] }> {
  const filled: FilledField[] = [];
  const unfillable: UnfillableField[] = [];

  for (const field of STANDARD_FIELDS) {
    const exists = await page.locator(field.selector).count();
    const value = values[field.concept];
    if (exists > 0 && value) {
      filled.push({ label: field.concept, selector: field.selector, value });
    } else if (exists > 0 && !value) {
      unfillable.push({ label: field.concept, reason: "No value in profile", required: field.required });
    } else if (field.required) {
      unfillable.push({ label: field.concept, reason: "Selector not found", required: true });
    }
  }

  return { filled, unfillable };
}

function makeResult(
  status: ATSFillerResult["status"],
  filledFields: FilledField[],
  unfillableFields: UnfillableField[],
  blockers: AutomationBlocker[],
  screenshots: string[],
  startTime: number,
  notes = "",
  submittedAt: Date | null = null
): ATSFillerResult {
  return {
    status,
    atsName: "Greenhouse",
    filledFields,
    unfillableFields,
    blockers,
    screenshots,
    submittedAt,
    notes,
    durationMs: Date.now() - startTime,
  };
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const greenhouseFiller: ATSFiller = {
  atsName: "Greenhouse",
  urlPattern: /greenhouse\.io|boards\.greenhouse/i,
  fill: fillGreenhouseForm,
};
