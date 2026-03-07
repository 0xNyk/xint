/**
 * Structured error types for agent-consumable error responses.
 */

export type XintErrorCode =
  | "RATE_LIMITED"
  | "AUTH_FAILED"
  | "NOT_FOUND"
  | "BUDGET_DENIED"
  | "POLICY_DENIED"
  | "VALIDATION_ERROR"
  | "TIMEOUT"
  | "API_ERROR";

export interface XintError {
  code: XintErrorCode;
  message: string;
  retryable: boolean;
  retry_after_ms?: number;
  suggestion?: string;
  failing_input?: string;
}

export function rateLimited(waitMs: number): XintError {
  return {
    code: "RATE_LIMITED",
    message: `Rate limited. Retry after ${waitMs}ms.`,
    retryable: true,
    retry_after_ms: waitMs,
    suggestion: `Wait ${waitMs}ms before retrying.`,
  };
}

export function authFailed(detail?: string): XintError {
  return {
    code: "AUTH_FAILED",
    message: detail || "Authentication failed.",
    retryable: false,
    suggestion: "Set X_BEARER_TOKEN env var or run 'xint auth setup'.",
  };
}

export function notFound(resource?: string): XintError {
  return {
    code: "NOT_FOUND",
    message: resource ? `Not found: ${resource}` : "Resource not found.",
    retryable: false,
    suggestion: "The tweet or user may have been deleted.",
    failing_input: resource,
  };
}

export function budgetDenied(spent: number, limit: number, remaining: number): XintError {
  return {
    code: "BUDGET_DENIED",
    message: `Daily budget exceeded ($${spent.toFixed(2)} / $${limit.toFixed(2)}).`,
    retryable: false,
    suggestion: "Use 'xint costs budget set N' to increase the daily limit.",
  };
}

export function policyDenied(tool: string, current: string, required: string): XintError {
  return {
    code: "POLICY_DENIED",
    message: `Tool '${tool}' requires '${required}' policy mode (current: '${current}').`,
    retryable: false,
    suggestion: `Start MCP with --policy=${required}.`,
    failing_input: tool,
  };
}

export function validationError(param: string, reason: string): XintError {
  return {
    code: "VALIDATION_ERROR",
    message: `Parameter '${param}': ${reason}`,
    retryable: false,
    suggestion: `Fix parameter '${param}': ${reason}`,
    failing_input: param,
  };
}

export function timeout(detail?: string): XintError {
  return {
    code: "TIMEOUT",
    message: detail || "Request timed out.",
    retryable: true,
    retry_after_ms: 5000,
    suggestion: "Retry in 5s.",
  };
}

export function apiError(status: number, detail?: string): XintError {
  return {
    code: "API_ERROR",
    message: detail || `X API error (HTTP ${status}).`,
    retryable: status >= 500,
    retry_after_ms: status >= 500 ? 30000 : undefined,
    suggestion: status >= 500 ? "X API issues. Retry in 30s." : undefined,
  };
}

/**
 * Classify an error from API calls into a structured XintError.
 * Parses error message patterns to detect HTTP status codes.
 */
export function classifyError(err: unknown): XintError {
  const msg = err instanceof Error ? err.message : String(err);

  // Rate limited (429)
  const rateMatch = msg.match(/Rate limited.*?(\d+)s/i);
  if (rateMatch || msg.includes("429")) {
    const waitSec = rateMatch ? parseInt(rateMatch[1]) : 60;
    return rateLimited(waitSec * 1000);
  }

  // Auth failed (401)
  if (msg.includes("401") || msg.includes("OAuth token rejected") || msg.includes("X_BEARER_TOKEN not found")) {
    return authFailed(msg);
  }

  // Not found (404)
  if (msg.includes("404") || msg.includes("not found")) {
    return notFound();
  }

  // Budget denied
  if (msg.includes("BUDGET_DENIED") || msg.includes("budget exceeded")) {
    try {
      const parsed = JSON.parse(msg);
      return budgetDenied(parsed.spent_usd || 0, parsed.limit_usd || 0, parsed.remaining_usd || 0);
    } catch {
      return budgetDenied(0, 0, 0);
    }
  }

  // Policy denied
  if (msg.includes("POLICY_DENIED")) {
    try {
      const parsed = JSON.parse(msg);
      return policyDenied(parsed.message || "", parsed.policy_mode || "", parsed.required_mode || "");
    } catch {
      return policyDenied("unknown", "unknown", "unknown");
    }
  }

  // Timeout
  if (msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("timed out")) {
    return timeout(msg);
  }

  // Generic API error — try to extract status
  const statusMatch = msg.match(/X API (\d{3})/);
  if (statusMatch) {
    return apiError(parseInt(statusMatch[1]), msg);
  }

  // Fallback
  return apiError(0, msg);
}
