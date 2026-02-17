#!/usr/bin/env node

import { readFileSync } from "fs";

function fail(message) {
  console.error(`[capability-contract] ${message}`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    fail(`Failed to parse JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sorted(arr) {
  return [...arr].sort();
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const [tsPath, rsPath] = process.argv.slice(2);
if (!tsPath || !rsPath) {
  fail("Usage: node scripts/check-capability-contract.mjs <ts.json> <rust.json>");
}

const ts = readJson(tsPath);
const rs = readJson(rsPath);

const requiredTop = [
  "schema_version",
  "service",
  "discovery",
  "constraints",
  "capability_modes",
  "telemetry",
  "pricing",
  "policy",
  "capabilities",
];

for (const key of requiredTop) {
  if (!(key in ts)) fail(`TypeScript manifest missing '${key}'`);
  if (!(key in rs)) fail(`Rust manifest missing '${key}'`);
}

if (ts.schema_version !== rs.schema_version) {
  fail(`schema_version mismatch (${ts.schema_version} vs ${rs.schema_version})`);
}

for (const key of ["x_api_only", "xai_grok_only", "graphql", "session_cookies"]) {
  if (ts.constraints[key] !== rs.constraints[key]) {
    fail(`constraints.${key} mismatch (${ts.constraints[key]} vs ${rs.constraints[key]})`);
  }
}

const tsModeSet = sorted(ts.capability_modes.map((m) => m.mode));
const rsModeSet = sorted(rs.capability_modes.map((m) => m.mode));
if (!sameSet(tsModeSet, rsModeSet)) {
  fail(`capability_modes mismatch (${tsModeSet.join(",")} vs ${rsModeSet.join(",")})`);
}

const tsTelemetry = sorted(ts.telemetry.fields || []);
const rsTelemetry = sorted(rs.telemetry.fields || []);
if (!sameSet(tsTelemetry, rsTelemetry)) {
  fail(`telemetry.fields mismatch`);
}

const tsPricingOps = sorted(Object.keys(ts.pricing.operations || {}));
const rsPricingOps = sorted(Object.keys(rs.pricing.operations || {}));
if (!sameSet(tsPricingOps, rsPricingOps)) {
  fail(`pricing.operations mismatch`);
}

const tsCapabilities = sorted(ts.capabilities.map((c) => c.id));
const rsCapabilities = sorted(rs.capabilities.map((c) => c.id));
if (!sameSet(tsCapabilities, rsCapabilities)) {
  fail(`capability ids mismatch`);
}

console.log("[capability-contract] OK");
