/**
 * lib/reliability.ts — command reliability metrics for CLI and MCP.
 *
 * Tracks per-invocation success/failure, latency, and fallback usage.
 * Data is stored locally in data/reliability-metrics.json.
 */

import { join } from "path";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";

export type ReliabilityMode = "cli" | "mcp";

export interface ReliabilityEntry {
  timestamp: string;
  command: string;
  mode: ReliabilityMode;
  success: boolean;
  latency_ms: number;
  fallback: boolean;
}

interface ReliabilityData {
  entries: ReliabilityEntry[];
}

export interface ReliabilityCommandStats {
  calls: number;
  success_rate: number;
  error_rate: number;
  fallback_rate: number;
  p95_latency_ms: number;
}

export interface ReliabilityReport {
  generated_at: string;
  window_days: number;
  total_calls: number;
  success_rate: number;
  by_command: Record<string, ReliabilityCommandStats>;
}

const SKILL_DIR = import.meta.dir;
const DEFAULT_DATA_FILE = join(SKILL_DIR, "..", "data", "reliability-metrics.json");
const RETENTION_DAYS = 30;
const MAX_ENTRIES = 5000;
const fallbackMarks = new Set<string>();

function dataFilePath(): string {
  return process.env.XINT_RELIABILITY_DATA_FILE || DEFAULT_DATA_FILE;
}

function round(value: number, places: number): number {
  const p = 10 ** places;
  return Math.round(value * p) / p;
}

function defaultData(): ReliabilityData {
  return { entries: [] };
}

function loadData(): ReliabilityData {
  const path = dataFilePath();
  if (!existsSync(path)) return defaultData();
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ReliabilityData;
    if (!parsed.entries || !Array.isArray(parsed.entries)) return defaultData();
    return parsed;
  } catch {
    console.error("[reliability] Failed to parse metrics, starting fresh");
    return defaultData();
  }
}

function saveData(data: ReliabilityData): void {
  const path = dataFilePath();
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  chmodSync(tmp, 0o660);
  renameSync(tmp, path);
}

function retentionCutoffIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - RETENTION_DAYS);
  return d.toISOString();
}

function prune(data: ReliabilityData): void {
  const cutoff = retentionCutoffIso();
  data.entries = data.entries.filter((entry) => entry.timestamp >= cutoff);
  if (data.entries.length > MAX_ENTRIES) {
    data.entries = data.entries.slice(data.entries.length - MAX_ENTRIES);
  }
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)] || 0;
}

export function markCommandFallback(command: string): void {
  if (!command) return;
  fallbackMarks.add(command);
}

export function consumeCommandFallback(command: string): boolean {
  if (!command) return false;
  const had = fallbackMarks.has(command);
  if (had) fallbackMarks.delete(command);
  return had;
}

export function recordCommandResult(
  command: string,
  success: boolean,
  latencyMs: number,
  options: { mode?: ReliabilityMode; fallback?: boolean } = {},
): ReliabilityEntry {
  const entry: ReliabilityEntry = {
    timestamp: new Date().toISOString(),
    command,
    mode: options.mode || "cli",
    success,
    latency_ms: Math.max(0, Math.round(latencyMs)),
    fallback: options.fallback || false,
  };

  const data = loadData();
  data.entries.push(entry);
  prune(data);
  saveData(data);
  return entry;
}

export function getReliabilityReport(windowDays: number = 7): ReliabilityReport {
  const normalizedWindow = Math.max(1, Math.min(30, Math.floor(windowDays) || 7));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - normalizedWindow);
  const cutoffIso = cutoff.toISOString();

  const data = loadData();
  const recent = data.entries.filter((entry) => entry.timestamp >= cutoffIso);

  const byCommand: Record<string, ReliabilityEntry[]> = {};
  for (const entry of recent) {
    byCommand[entry.command] ??= [];
    byCommand[entry.command].push(entry);
  }

  const byCommandStats: Record<string, ReliabilityCommandStats> = {};
  for (const [command, entries] of Object.entries(byCommand)) {
    const calls = entries.length;
    const successes = entries.filter((entry) => entry.success).length;
    const fallbacks = entries.filter((entry) => entry.fallback).length;
    const latencies = entries.map((entry) => entry.latency_ms);

    byCommandStats[command] = {
      calls,
      success_rate: round(calls > 0 ? successes / calls : 0, 4),
      error_rate: round(calls > 0 ? (calls - successes) / calls : 0, 4),
      fallback_rate: round(calls > 0 ? fallbacks / calls : 0, 4),
      p95_latency_ms: round(p95(latencies), 2),
    };
  }

  const totalCalls = recent.length;
  const totalSuccesses = recent.filter((entry) => entry.success).length;

  return {
    generated_at: new Date().toISOString(),
    window_days: normalizedWindow,
    total_calls: totalCalls,
    success_rate: round(totalCalls > 0 ? totalSuccesses / totalCalls : 1, 4),
    by_command: byCommandStats,
  };
}
