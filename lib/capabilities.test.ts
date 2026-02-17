import { describe, expect, test } from "bun:test";
import { getCapabilitiesManifest } from "./capabilities";

describe("capabilities manifest", () => {
  test("has required top-level contract fields", () => {
    const manifest = getCapabilitiesManifest();

    expect(manifest.schema_version).toBe("1.0.0");
    expect(manifest.service.name).toBe("xint");
    expect(manifest.discovery.command).toBe("xint capabilities --json");
    expect(manifest.constraints.x_api_only).toBe(true);
    expect(manifest.constraints.xai_grok_only).toBe(true);
    expect(manifest.constraints.graphql).toBe(false);
    expect(manifest.constraints.session_cookies).toBe(false);
  });

  test("contains telemetry fields expected by agents", () => {
    const fields = getCapabilitiesManifest().telemetry.fields;

    expect(fields).toContain("source");
    expect(fields).toContain("latency_ms");
    expect(fields).toContain("cached");
    expect(fields).toContain("confidence");
    expect(fields).toContain("api_endpoint");
    expect(fields).toContain("timestamp");
  });

  test("exports pricing operations and capability modes", () => {
    const manifest = getCapabilitiesManifest();

    expect(Object.keys(manifest.pricing.operations).length).toBeGreaterThan(10);
    expect(manifest.capability_modes.map((m) => m.mode)).toEqual([
      "read_only",
      "engagement",
      "moderation",
    ]);
  });
});
