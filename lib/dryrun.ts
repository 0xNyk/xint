/**
 * lib/dryrun.ts — cost preview for --dry-run.
 *
 * Every cost-bearing command can opt in by calling `previewAndExit()` early
 * in its handler. The preview reads cost rates from costs.ts so the numbers
 * stay in sync with actual billing — there's one source of truth.
 *
 * Output goes to stdout (not stderr) so agents can capture and parse it.
 */

import { COST_RATES } from "./costs";

export interface DryRunEstimate {
  command: string;
  endpoint: string;
  // Estimated number of paid units (tweets for per_tweet ops, calls for per_call ops).
  units: number;
  unitLabel: "tweets" | "calls" | "users";
  // Estimated USD cost. Computed from COST_RATES; matches what trackCost would log.
  costUsd: number;
  // Optional cache-hit prediction. When true, real cost is $0.
  cachePredictedHit?: boolean;
  cacheTtlMinutes?: number;
  // Free-form notes the caller wants surfaced (e.g. "uses OAuth", "archive 2x").
  notes?: string[];
}

function fmtUsd(n: number): string {
  if (n < 0.0001) return "<$0.0001";
  if (n < 0.01) return "~$" + n.toFixed(4);
  return "~$" + n.toFixed(2);
}

/** Estimate cost for an operation+unit count using the same rates as trackCost. */
export function estimateCost(operation: string, units: number, perCallUnits: number = 1): number {
  const rates = COST_RATES[operation];
  if (!rates) return 0;
  return rates.per_call * perCallUnits + rates.per_tweet * units;
}

/** Print a structured preview and exit 0 — agents can capture stdout. */
export function previewAndExit(estimate: DryRunEstimate): never {
  console.log(`\n=== DRY RUN ===`);
  console.log(`Command:       ${estimate.command}`);
  console.log(`Endpoint:      ${estimate.endpoint}`);
  console.log(`Estimated:     ${estimate.units} ${estimate.unitLabel}`);
  console.log(`Estimated cost: ${fmtUsd(estimate.costUsd)}`);
  if (estimate.cachePredictedHit !== undefined) {
    const ttl = estimate.cacheTtlMinutes;
    if (estimate.cachePredictedHit) {
      console.log(`Cache:         likely HIT (${ttl}m TTL) — actual cost may be $0`);
    } else {
      console.log(`Cache:         miss expected (${ttl}m TTL)`);
    }
  }
  if (estimate.notes && estimate.notes.length > 0) {
    console.log(`Notes:`);
    for (const n of estimate.notes) {
      console.log(`  • ${n}`);
    }
  }
  console.log(`\nRe-run without --dry-run to execute.\n`);
  process.exit(0);
}

/** Convenience: extract --dry-run from an arg list. Returns true if present. */
export function hasDryRun(args: string[]): boolean {
  return args.includes("--dry-run");
}
