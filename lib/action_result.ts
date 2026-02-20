import type { ActionResultType } from "./actions";

export type ActionExecutionKind = Extract<ActionResultType, "success" | "error" | "info">;

export type ActionExecutionResult<T = unknown> = {
  type: ActionExecutionKind;
  message: string;
  data?: T;
  fallbackUsed: boolean;
};

export function actionSuccess<T>(message: string, data?: T, fallbackUsed = false): ActionExecutionResult<T> {
  return { type: "success", message, data, fallbackUsed };
}

export function actionInfo<T>(message: string, data?: T, fallbackUsed = false): ActionExecutionResult<T> {
  return { type: "info", message, data, fallbackUsed };
}

export function actionError(message: string): ActionExecutionResult<never> {
  return { type: "error", message, fallbackUsed: false };
}
