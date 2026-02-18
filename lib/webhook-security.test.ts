import { describe, expect, test } from "bun:test";
import { validateWebhookUrl } from "./webhook-security";

function restoreAllowlist(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.XINT_WEBHOOK_ALLOWED_HOSTS;
  } else {
    process.env.XINT_WEBHOOK_ALLOWED_HOSTS = value;
  }
}

describe("validateWebhookUrl", () => {
  test("accepts https endpoints", () => {
    const prev = process.env.XINT_WEBHOOK_ALLOWED_HOSTS;
    delete process.env.XINT_WEBHOOK_ALLOWED_HOSTS;
    expect(validateWebhookUrl("https://hooks.example.com/ingest")).toBe("https://hooks.example.com/ingest");
    restoreAllowlist(prev);
  });

  test("allows http loopback", () => {
    const prev = process.env.XINT_WEBHOOK_ALLOWED_HOSTS;
    delete process.env.XINT_WEBHOOK_ALLOWED_HOSTS;
    expect(validateWebhookUrl("http://127.0.0.1:8080/webhook")).toBe("http://127.0.0.1:8080/webhook");
    restoreAllowlist(prev);
  });

  test("rejects non-https remote endpoints", () => {
    const prev = process.env.XINT_WEBHOOK_ALLOWED_HOSTS;
    delete process.env.XINT_WEBHOOK_ALLOWED_HOSTS;
    expect(() => validateWebhookUrl("http://example.com/webhook")).toThrow("Webhook URL must use https://");
    restoreAllowlist(prev);
  });

  test("enforces allowlist when configured", () => {
    const prev = process.env.XINT_WEBHOOK_ALLOWED_HOSTS;
    process.env.XINT_WEBHOOK_ALLOWED_HOSTS = "trusted.example.com,*.internal.example";
    expect(validateWebhookUrl("https://trusted.example.com/path")).toBe("https://trusted.example.com/path");
    expect(validateWebhookUrl("https://api.internal.example/hook")).toBe("https://api.internal.example/hook");
    expect(() => validateWebhookUrl("https://untrusted.example.com/hook")).toThrow("is not allowed");
    restoreAllowlist(prev);
  });
});
