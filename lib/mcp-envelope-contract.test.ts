import { describe, expect, test } from "bun:test";
import { MCPServer } from "./mcp";

type MpcEnvelope = {
  type: string;
  message: string;
  data?: unknown;
};

async function callTool(name: string, argumentsValue: Record<string, unknown> = {}): Promise<MpcEnvelope> {
  const mcp = new MCPServer({ policyMode: "read_only", enforceBudget: false });
  const response = await mcp.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: argumentsValue },
    }),
  );

  const parsed = JSON.parse(String(response || "{}")) as {
    result: { content: Array<{ text: string }> };
  };
  return JSON.parse(parsed.result.content[0].text) as MpcEnvelope;
}

describe("mcp envelope contract", () => {
  test("xint_costs returns standard envelope", async () => {
    const payload = await callTool("xint_costs", { period: "today" });
    expect(payload.type).toBe("success");
    expect(typeof payload.message).toBe("string");
    expect(payload.data).toBeDefined();
  });

  test("xint_cache_clear returns standard envelope", async () => {
    const payload = await callTool("xint_cache_clear");
    expect(payload.type).toBe("success");
    expect(payload.message).toContain("Cache");
    expect(payload.data).toBeDefined();
  });
});
