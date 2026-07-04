import { stderr } from "process";

export interface Spinner {
  update(message: string): void;
  done(message?: string): void;
  fail(message?: string): void;
}

function enabled(): boolean {
  return Boolean(stderr.isTTY) && process.env.NO_COLOR !== "1";
}

export function createSpinner(message: string): Spinner {
  let last = message;
  if (enabled()) stderr.write(`${message}\n`);

  return {
    update(next: string) {
      last = next;
      if (enabled()) stderr.write(`${next}\n`);
    },
    done(next?: string) {
      if (enabled()) stderr.write(`${next || last}\n`);
    },
    fail(next?: string) {
      stderr.write(`${next || last}\n`);
    },
  };
}
