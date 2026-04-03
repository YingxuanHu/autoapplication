/**
 * Auto-apply CLI — run automation against eligible jobs.
 *
 * Usage:
 *   npx tsx -r dotenv/config scripts/auto-apply.ts [options]
 *
 * Options:
 *   --job=<id>         Run against a single job ID
 *   --mode=<mode>      Override mode: dry_run | fill_only | fill_and_submit
 *   --max=<n>          Max jobs to process (default 10)
 *   --ats=<name>       Only process jobs from this ATS (greenhouse, lever, ashby)
 *   --delay=<ms>       Delay between jobs in ms (default 15000)
 *
 * Examples:
 *   # Dry run a single job
 *   npx tsx -r dotenv/config scripts/auto-apply.ts --job=clxyz123 --mode=dry_run
 *
 *   # Fill (but don't submit) up to 5 Greenhouse jobs
 *   npx tsx -r dotenv/config scripts/auto-apply.ts --max=5 --ats=greenhouse --mode=fill_only
 *
 *   # Full auto-apply for all eligible jobs
 *   npx tsx -r dotenv/config scripts/auto-apply.ts --max=10
 */
import { runAutoApply } from "../src/lib/automation/engine";
import type { AutomationRunMode } from "../src/lib/automation/types";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("═══════════════════════════════════════════════════════");
  console.log("  AutoApply Engine");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Mode:    ${args.mode ?? "auto (based on eligibility + user settings)"}`);
  console.log(`  Job:     ${args.jobId ?? "batch (eligible candidates)"}`);
  console.log(`  Max:     ${args.max}`);
  console.log(`  ATS:     ${args.ats ?? "all"}`);
  console.log(`  Delay:   ${args.delay}ms`);
  console.log("═══════════════════════════════════════════════════════\n");

  const results = await runAutoApply({
    jobId: args.jobId,
    mode: args.mode,
    maxPerRun: args.max,
    delayBetweenMs: args.delay,
    atsFilter: args.ats ? [args.ats] : undefined,
    log: console.log,
  });

  // Print detailed summary
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Results");
  console.log("═══════════════════════════════════════════════════════");

  for (const result of results) {
    const r = result.fillerResult;
    if (!r) {
      console.log(`  ${result.jobId}: ERROR — ${result.error}`);
      continue;
    }

    const fieldSummary = `${r.filledFields.length} filled, ${r.unfillableFields.length} unfillable`;
    const screenshotSummary = r.screenshots.length > 0
      ? `\n    Screenshots: ${r.screenshots.join("\n                 ")}`
      : "";

    console.log(`  ${result.jobId}: ${r.status.toUpperCase()} (${r.atsName}) — ${fieldSummary}${screenshotSummary}`);

    if (r.blockers.length > 0) {
      for (const b of r.blockers) {
        console.log(`    BLOCKER: [${b.type}] ${b.detail}`);
      }
    }

    if (r.unfillableFields.length > 0) {
      console.log(`    Unfillable: ${r.unfillableFields.map((f) => `${f.label}${f.required ? " (REQUIRED)" : ""}`).join(", ")}`);
    }
  }

  console.log("═══════════════════════════════════════════════════════\n");

  process.exit(0);
}

function parseArgs(argv: string[]) {
  const args: {
    jobId?: string;
    mode?: AutomationRunMode;
    max: number;
    ats?: string;
    delay: number;
  } = {
    max: 10,
    delay: 15_000,
  };

  for (const arg of argv) {
    if (arg.startsWith("--job=")) {
      args.jobId = arg.slice(6);
    } else if (arg.startsWith("--mode=")) {
      const mode = arg.slice(7);
      if (mode === "dry_run" || mode === "fill_only" || mode === "fill_and_submit") {
        args.mode = mode;
      } else {
        console.error(`Invalid mode: ${mode}. Use dry_run, fill_only, or fill_and_submit.`);
        process.exit(1);
      }
    } else if (arg.startsWith("--max=")) {
      args.max = parseInt(arg.slice(6), 10) || 10;
    } else if (arg.startsWith("--ats=")) {
      args.ats = arg.slice(6).toLowerCase();
    } else if (arg.startsWith("--delay=")) {
      args.delay = parseInt(arg.slice(8), 10) || 15_000;
    }
  }

  return args;
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
