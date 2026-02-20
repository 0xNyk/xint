import { actionError, actionSuccess, type ActionExecutionResult } from "./action_result";

export type TuiExecutionPlan = {
  command: string;
  args: string[];
};

function normalizeSearchQuery(value: string): string {
  return value
    .replace(/\s*&\s*/g, " AND ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildTuiExecutionPlan(
  actionKey: string,
  value?: string,
): ActionExecutionResult<TuiExecutionPlan> {
  const normalized = (value || "").trim();

  switch (actionKey) {
    case "1":
      if (!normalized) return actionError("Query is required.");
      const searchQuery = normalizeSearchQuery(normalized);
      return actionSuccess("Search plan ready.", {
        command: `xint search ${searchQuery}`,
        args: ["search", searchQuery],
      });
    case "2":
      if (!normalized) {
        return actionSuccess("Trends plan ready.", {
          command: "xint trends",
          args: ["trends"],
        });
      }
      return actionSuccess("Trends plan ready.", {
        command: `xint trends ${normalized}`,
        args: ["trends", normalized],
      });
    case "3": {
      const username = normalized.replace(/^@/, "");
      if (!username) return actionError("Username is required.");
      return actionSuccess("Profile plan ready.", {
        command: `xint profile ${username}`,
        args: ["profile", username],
      });
    }
    case "4":
      if (!normalized) return actionError("Tweet ID/URL is required.");
      return actionSuccess("Thread plan ready.", {
        command: `xint thread ${normalized}`,
        args: ["thread", normalized],
      });
    case "5":
      if (!normalized) return actionError("Article URL is required.");
      return actionSuccess("Article plan ready.", {
        command: `xint article ${normalized}`,
        args: ["article", normalized],
      });
    case "6":
      return actionSuccess("Help plan ready.", {
        command: "xint --help",
        args: ["--help"],
      });
    default:
      return actionError(`Unsupported action key: ${actionKey}`);
  }
}
