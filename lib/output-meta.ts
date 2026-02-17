import { checkBudget } from "./costs";

export interface OutputMeta {
  source: string;
  latency_ms: number;
  cached: boolean;
  confidence: number;
  api_endpoint: string;
  timestamp: string;
  estimated_cost_usd: number;
  budget_remaining_usd: number;
}

interface MetaOpts {
  source: string;
  startedAtMs: number;
  cached: boolean;
  confidence: number;
  apiEndpoint: string;
  estimatedCostUsd: number;
}

function round(n: number, places: number): number {
  const p = Math.pow(10, places);
  return Math.round(n * p) / p;
}

export function buildOutputMeta(opts: MetaOpts): OutputMeta {
  const budget = checkBudget();
  return {
    source: opts.source,
    latency_ms: Math.max(0, Date.now() - opts.startedAtMs),
    cached: opts.cached,
    confidence: round(opts.confidence, 3),
    api_endpoint: opts.apiEndpoint,
    timestamp: new Date().toISOString(),
    estimated_cost_usd: round(opts.estimatedCostUsd, 6),
    budget_remaining_usd: round(budget.remaining, 4),
  };
}

export function printJsonWithMeta(meta: OutputMeta, data: unknown): void {
  console.log(JSON.stringify({ meta, data }, null, 2));
}

export function printJsonlWithMeta(meta: OutputMeta, items: unknown[], key: string): void {
  for (const item of items) {
    console.log(
      JSON.stringify({
        ...meta,
        [key]: item,
      })
    );
  }
}
