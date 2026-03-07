import type { ActionResultType } from "./actions";
import type { XintError } from "./errors";

export type ActionExecutionKind = Extract<ActionResultType, "success" | "error" | "info">;

export type Pagination = {
  total: number;
  returned: number;
  has_more: boolean;
};

export type ActionExecutionResult<T = unknown> = {
  type: ActionExecutionKind;
  message: string;
  data?: T;
  fallbackUsed: boolean;
  error?: XintError;
  cached?: boolean;
  cost?: number;
  pagination?: Pagination;
};

export function actionSuccess<T>(message: string, data?: T, fallbackUsed = false): ActionExecutionResult<T> {
  return { type: "success", message, data, fallbackUsed };
}

export function actionInfo<T>(message: string, data?: T, fallbackUsed = false): ActionExecutionResult<T> {
  return { type: "info", message, data, fallbackUsed };
}

export function actionError(message: string, error?: XintError): ActionExecutionResult<never> {
  return { type: "error", message, fallbackUsed: false, error };
}
