/**
 * Lever ATS form filler.
 *
 * Lever application forms live at:
 *   jobs.lever.co/{company}/{postingId}/apply
 *
 * Form structure:
 *   - input[name="name"] — full name
 *   - input[name="email"] — email
 *   - input[name="phone"] — phone
 *   - input[name="org"] — current company (optional)
 *   - input[name="urls[LinkedIn]"] — LinkedIn
 *   - input[name="urls[GitHub]"] — GitHub
 *   - input[name="urls[Portfolio]"] — Portfolio/Website
 *   - input[name="urls[Other]"] — Other URL
 *   - input[type="file"] for resume (within .application-file-input)
 *   - textarea[name="comments"] — additional info / cover letter
 *   - Custom questions in .application-question containers
 *   - Submit button: button.postings-btn-submit or button[type="submit"]
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
import { buildFieldValueMap, matchLabelToConcept } from "../field-map";
import { navigateToForm, detectBlockers } from "../browser";
import { captureScreenshot } from "../screenshots";

// ─── Filler implementation ──────────────────────────────────────────────────

async function fillLeverForm(ctx: ATSFillerContext): Promise<ATSFillerResult> {
  const start = Date.now();
  const { page, mode, screenshotDir } = ctx;
  const filledFields: FilledField[] = [];
  const unfillableFields: UnfillableField[] = [];
  const blockers: AutomationBlocker[] = [];
  const screenshots: string[] = [];

  const values = buildFieldValueMap(ctx.profile, ctx.resume, ctx.applicationPackage);

  // ─── Ensure URL points to /apply ───────────────────────────────────
  let applyUrl = ctx.applyUrl;
  if (!applyUrl.endsWith("/apply") && !applyUrl.includes("/apply?")) {
    applyUrl = applyUrl.replace(/\/?$/, "/apply");
  }

  // ─── Navigate ──────────────────────────────────────────────────────
  const nav = await navigateToForm(page, applyUrl);
  if (!nav.ok) {
    screenshots.push(await captureScreenshot(page, screenshotDir, "01_navigation_failed"));
    const blockerType = nav.statusHint === "position_closed" ? "position_closed" as const : "timeout" as const;
    return makeResult("failed", filledFields, unfillableFields, [
      { type: blockerType, detail: nav.statusHint },
    ], screenshots, start);
  }

  screenshots.push(await captureScreenshot(page, screenshotDir, "01_form_loaded"));

  // ─── Check blockers ────────────────────────────────────────────────
  const detectedBlockers = await detectBlockers(page);
  if (detectedBlockers.length > 0) {
    for (const b of detectedBlockers) {
      blockers.push({ type: b.type as AutomationBlocker["type"], detail: b.detail });
    }
    return makeResult("blocked", filledFields, unfillableFields, blockers, screenshots, start);
  }

  // ─── Detect form ───────────────────────────────────────────────────
  const formPresent = await page.locator('input[name="name"], .application-form, form.application-form').count();
  if (formPresent === 0) {
    screenshots.push(await captureScreenshot(page, screenshotDir, "02_no_form_found"));
    return makeResult("failed", filledFields, unfillableFields, [
      { type: "form_changed", detail: "Could not locate the Lever application form" },
    ], screenshots, start);
  }

  if (mode === "dry_run") {
    screenshots.push(await captureScreenshot(page, screenshotDir, "02_dry_run_analysis"));
    return makeResult("filled", [], [], blockers, screenshots, start,
      "Dry run: Lever form detected. Standard fields available.");
  }

  // ─── Fill standard Lever fields ────────────────────────────────────
  const standardFields: Array<{
    selector: string;
    concept: keyof typeof values;
    label: string;
    required: boolean;
  }> = [
    { selector: 'input[name="name"]', concept: "full_name", label: "Full name", required: true },
    { selector: 'input[name="email"]', concept: "email", label: "Email", required: true },
    { selector: 'input[name="phone"]', concept: "phone", label: "Phone", required: false },
    { selector: 'input[name="urls[LinkedIn]"]', concept: "linkedin_url", label: "LinkedIn", required: false },
    { selector: 'input[name="urls[GitHub]"]', concept: "github_url", label: "GitHub", required: false },
    { selector: 'input[name="urls[Portfolio]"]', concept: "portfolio_url", label: "Portfolio", required: false },
  ];

  for (const field of standardFields) {
    const value = values[field.concept as keyof typeof values];
    const exists = await page.locator(field.selector).count();
    if (exists === 0) {
      if (field.required) {
        unfillableFields.push({ label: field.label, reason: "Selector not found", required: true });
      }
      continue;
    }
    if (!value) {
      if (field.required) {
        unfillableFields.push({ label: field.label, reason: "No value in profile", required: true });
      }
      continue;
    }
    await page.locator(field.selector).fill(value);
    filledFields.push({ label: field.label, selector: field.selector, value });
  }

  // ─── Resume upload ─────────────────────────────────────────────────
  if (ctx.resume.filePath) {
    const uploadSelectors = [
      '.application-file-input input[type="file"]',
      'input[type="file"][name*="resume"]',
      'input[type="file"]',
    ];

    let uploaded = false;
    for (const selector of uploadSelectors) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        try {
          await page.locator(selector).first().setInputFiles(ctx.resume.filePath);
          uploaded = true;
          filledFields.push({ label: "Resume", selector, value: ctx.resume.label });
          break;
        } catch {
          continue;
        }
      }
    }
    if (!uploaded) {
      unfillableFields.push({ label: "Resume", reason: "File upload failed", required: true });
    }
  } else {
    unfillableFields.push({ label: "Resume", reason: "No resume file available", required: true });
  }

  // ─── Cover letter / additional info ────────────────────────────────
  const coverValue = values.cover_letter;
  if (coverValue) {
    const commentSelectors = [
      'textarea[name="comments"]',
      'textarea[name="additionalInfo"]',
      "textarea.application-answer-text",
    ];
    for (const sel of commentSelectors) {
      const exists = await page.locator(sel).count();
      if (exists > 0) {
        await page.locator(sel).fill(coverValue);
        filledFields.push({ label: "Cover letter / Additional info", selector: sel, value: "(text)" });
        break;
      }
    }
  }

  // ─── Custom questions ──────────────────────────────────────────────
  await fillLeverCustomQuestions(page, values, ctx.applicationPackage.savedAnswers, filledFields, unfillableFields);

  screenshots.push(await captureScreenshot(page, screenshotDir, "03_form_filled"));

  // ─── Required gaps check ───────────────────────────────────────────
  const hasRequiredGaps = unfillableFields.some((f) => f.required);
  if (hasRequiredGaps && mode === "fill_and_submit") {
    blockers.push({
      type: "required_field_unknown",
      detail: `Required fields missing: ${unfillableFields.filter((f) => f.required).map((f) => f.label).join(", ")}`,
    });
    return makeResult("blocked", filledFields, unfillableFields, blockers, screenshots, start,
      "Form filled but blocked due to missing required fields.");
  }

  // ─── Submit ────────────────────────────────────────────────────────
  if (mode === "fill_and_submit") {
    screenshots.push(await captureScreenshot(page, screenshotDir, "04_pre_submit"));

    const submitSelectors = [
      "button.postings-btn-submit",
      'button[type="submit"]',
      'button:has-text("Submit application")',
      'button:has-text("Submit")',
      'input[type="submit"]',
    ];

    let clicked = false;
    for (const selector of submitSelectors) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        await page.locator(selector).first().click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      return makeResult("failed", filledFields, unfillableFields, [
        { type: "form_changed", detail: "Could not find submit button" },
      ], screenshots, start);
    }

    await page.waitForTimeout(3000);
    screenshots.push(await captureScreenshot(page, screenshotDir, "05_post_submit"));

    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const confirmed = /thank you|application.*received|submitted|successfully/i.test(bodyText);

    return makeResult(
      "submitted",
      filledFields, unfillableFields, blockers, screenshots, start,
      confirmed ? "Application submitted. Confirmation detected." : "Submit clicked. Confirmation not clearly detected.",
      new Date()
    );
  }

  return makeResult("filled", filledFields, unfillableFields, blockers, screenshots, start,
    "Lever form filled. Ready for human review.");
}

// ─── Custom questions ────────────────────────────────────────────────────────

async function fillLeverCustomQuestions(
  page: Page,
  values: Record<string, string | null>,
  savedAnswers: Record<string, string>,
  filledFields: FilledField[],
  unfillableFields: UnfillableField[]
) {
  // Lever custom questions appear in .application-question containers
  const questionContainers = page.locator(".application-question, .custom-question");
  const count = await questionContainers.count();

  for (let i = 0; i < Math.min(count, 25); i++) {
    const container = questionContainers.nth(i);
    const labelEl = container.locator("label, .application-label, .question-label").first();
    const labelText = await labelEl.innerText().catch(() => "");
    if (!labelText || labelText.length < 2) continue;

    // Try saved answers first
    const savedKey = Object.keys(savedAnswers).find((k) =>
      labelText.toLowerCase().includes(k.toLowerCase())
    );

    const input = container.locator("input[type='text'], textarea, input:not([type])").first();
    const select = container.locator("select").first();
    const inputCount = await input.count();
    const selectCount = await select.count();

    if (savedKey && inputCount > 0) {
      await input.fill(savedAnswers[savedKey]).catch(() => {});
      filledFields.push({ label: labelText.slice(0, 60), selector: `lever-q:${i}`, value: savedAnswers[savedKey].slice(0, 50) });
      continue;
    }

    // Heuristic match
    const concept = matchLabelToConcept(labelText);
    if (concept && values[concept]) {
      if (selectCount > 0) {
        // Try to match a select option
        const options = await select.locator("option").allInnerTexts();
        const lower = values[concept]!.toLowerCase();
        const match = options.find((o) => o.toLowerCase().includes(lower));
        if (match) {
          await select.selectOption({ label: match }).catch(() => {});
          filledFields.push({ label: labelText.slice(0, 60), selector: `lever-q:${i}`, value: match });
          continue;
        }
      } else if (inputCount > 0) {
        await input.fill(values[concept]!).catch(() => {});
        filledFields.push({ label: labelText.slice(0, 60), selector: `lever-q:${i}`, value: values[concept]!.slice(0, 50) });
        continue;
      }
    }

    // Detect required but unfillable
    const isRequired =
      (await container.locator('[aria-required="true"], .required').count()) > 0 ||
      labelText.includes("*");
    if (isRequired) {
      unfillableFields.push({ label: labelText.slice(0, 80), reason: "No matching answer", required: true });
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    atsName: "Lever",
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

export const leverFiller: ATSFiller = {
  atsName: "Lever",
  urlPattern: /lever\.co/i,
  fill: fillLeverForm,
};
