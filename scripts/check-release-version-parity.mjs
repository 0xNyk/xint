#!/usr/bin/env node

import { readFileSync } from "fs";

function fail(message) {
  console.error(`[release-parity] ${message}`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    fail(`Failed to parse JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readCargoVersion(path) {
  try {
    const raw = readFileSync(path, "utf-8");
    const pkgBlock = raw.match(/\[package\][\s\S]*?(?:\n\[|$)/);
    const block = pkgBlock ? pkgBlock[0] : raw;
    const m = block.match(/^\s*version\s*=\s*"([^"]+)"/m);
    return m?.[1] || null;
  } catch (err) {
    fail(`Failed to read Cargo.toml at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function normalizeVersion(version) {
  return String(version || "")
    .trim()
    .replace(/-/g, ".");
}

const [tsPkgPath, rsCargoPath, tsManifestPath, rsManifestPath] = process.argv.slice(2);
if (!tsPkgPath || !rsCargoPath || !tsManifestPath || !rsManifestPath) {
  fail(
    "Usage: node scripts/check-release-version-parity.mjs <xint/package.json> <xint-rs/Cargo.toml> <xint-ts-capabilities.json> <xint-rs-capabilities.json>"
  );
}

const tsPkg = readJson(tsPkgPath);
const rsCargoVersion = readCargoVersion(rsCargoPath);
const tsManifest = readJson(tsManifestPath);
const rsManifest = readJson(rsManifestPath);

const tsPkgVersion = String(tsPkg.version || "").trim();
const rsPkgVersion = String(rsCargoVersion || "").trim();
const tsManifestVersion = String(tsManifest?.service?.version || "").trim();
const rsManifestVersion = String(rsManifest?.service?.version || "").trim();

if (!tsPkgVersion) fail("xint package.json version is missing");
if (!rsPkgVersion) fail("xint-rs Cargo.toml version is missing");
if (!tsManifestVersion) fail("xint capabilities manifest service.version is missing");
if (!rsManifestVersion) fail("xint-rs capabilities manifest service.version is missing");

if (tsPkgVersion !== tsManifestVersion) {
  fail(`xint package/version mismatch (${tsPkgVersion} vs manifest ${tsManifestVersion})`);
}
if (rsPkgVersion !== rsManifestVersion) {
  fail(`xint-rs package/version mismatch (${rsPkgVersion} vs manifest ${rsManifestVersion})`);
}

const tsNormalized = normalizeVersion(tsPkgVersion);
const rsNormalized = normalizeVersion(rsPkgVersion);
if (tsNormalized !== rsNormalized) {
  fail(
    `release version mismatch after normalization (${tsPkgVersion} -> ${tsNormalized} vs ${rsPkgVersion} -> ${rsNormalized})`
  );
}

console.log(
  `[release-parity] OK xint=${tsPkgVersion} xint-rs=${rsPkgVersion} normalized=${tsNormalized}`
);
