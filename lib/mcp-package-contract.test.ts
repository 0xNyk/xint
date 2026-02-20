import { afterEach, describe, expect, test } from "bun:test";
import { MCPServer } from "./mcp";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("mcp package api contract", () => {
  afterEach(() => {
    delete process.env.XINT_PACKAGE_API_BASE_URL;
    delete process.env.XINT_PACKAGE_API_KEY;
    delete process.env.XINT_WORKSPACE_ID;
    delete process.env.XINT_BILLING_UPGRADE_URL;
  });

  test("sends expected package create contract request", async () => {
    const previousBase = process.env.XINT_PACKAGE_API_BASE_URL;
    const previousKey = process.env.XINT_PACKAGE_API_KEY;
    const previousWorkspace = process.env.XINT_WORKSPACE_ID;

    let receivedPath = "";
    let receivedAuth = "";
    let receivedWorkspace = "";
    let receivedBody: Record<string, unknown> = {};

    const server = Bun.serve({
      port: 0,
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        receivedPath = `${req.method} ${url.pathname}`;
        receivedAuth = req.headers.get("authorization") || "";
        receivedWorkspace = req.headers.get("x-workspace-id") || "";
        receivedBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        return new Response(JSON.stringify({ package_id: "pkg_123", status: "queued" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      },
    });

    process.env.XINT_PACKAGE_API_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
    process.env.XINT_PACKAGE_API_KEY = "xck_test";
    process.env.XINT_WORKSPACE_ID = "ws_contract";

    const mcp = new MCPServer({ policyMode: "read_only", enforceBudget: false });
    const response = await mcp.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "xint_package_create",
          arguments: {
            name: "Contract package",
            topicQuery: "ai agents",
            sources: ["x_api_v2"],
            timeWindow: {
              from: "2026-01-01T00:00:00.000Z",
              to: "2026-01-02T00:00:00.000Z",
            },
            policy: "private",
            analysisProfile: "summary",
          },
        },
      }),
    );
    server.stop(true);

    expect(receivedPath).toBe("POST /v1/packages");
    expect(receivedAuth).toBe("Bearer xck_test");
    expect(receivedWorkspace).toBe("ws_contract");
    expect(receivedBody.name).toBe("Contract package");
    expect(receivedBody.topic_query).toBe("ai agents");
    expect(receivedBody.analysis_profile).toBe("summary");

    const parsed = JSON.parse(String(response || "{}")) as {
      result: { content: Array<{ text: string }> };
    };
    const payload = JSON.parse(parsed.result.content[0].text) as {
      type: string;
      message: string;
      data: { package_id: string };
    };
    expect(payload.type).toBe("success");
    expect(payload.data.package_id).toBe("pkg_123");

    restoreEnv("XINT_PACKAGE_API_BASE_URL", previousBase);
    restoreEnv("XINT_PACKAGE_API_KEY", previousKey);
    restoreEnv("XINT_WORKSPACE_ID", previousWorkspace);
  });

  test("returns upgrade hint on quota contract errors", async () => {
    process.env.XINT_BILLING_UPGRADE_URL = "https://xint.dev/pricing?src=contract-test";

    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            code: "QUOTA_EXCEEDED",
            error: "Package limit reached for current plan.",
          }),
          {
            status: 402,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    process.env.XINT_PACKAGE_API_BASE_URL = `http://127.0.0.1:${server.port}/v1`;

    const mcp = new MCPServer({ policyMode: "read_only", enforceBudget: false });
    const response = await mcp.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "xint_package_query",
          arguments: {
            query: "what changed?",
            packageIds: ["pkg_123"],
          },
        },
      }),
    );
    server.stop(true);

    const parsed = JSON.parse(String(response || "{}")) as { error: { message: string } };
    expect(parsed.error.message).toContain("QUOTA_EXCEEDED");
    expect(parsed.error.message).toContain("Upgrade: https://xint.dev/pricing?src=contract-test");
  });

  test("enforces citations for package query when required", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            answer: "No citations",
            claims: [{ claim_id: "claim_1", text: "example" }],
            citations: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    process.env.XINT_PACKAGE_API_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
    const mcp = new MCPServer({ policyMode: "read_only", enforceBudget: false });
    const response = await mcp.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "xint_package_query",
          arguments: {
            query: "what changed?",
            packageIds: ["pkg_123"],
            requireCitations: true,
          },
        },
      }),
    );
    server.stop(true);

    const parsed = JSON.parse(String(response || "{}")) as { error: { message: string } };
    expect(parsed.error.message).toContain("missing citations");
  });
});
