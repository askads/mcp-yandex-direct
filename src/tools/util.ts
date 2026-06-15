import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { YandexDirectError } from "../types.js";

export function ok(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

export function fail(err: unknown): CallToolResult {
  let message: string;
  if (err instanceof YandexDirectError || err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Converts an amount in account currency units to micros (1 unit = 1_000_000 micros). */
export function toMicros(amount: number): number {
  return Math.round(amount * 1_000_000);
}

/** Drops keys whose value is `undefined` so they are not sent to the API. */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T;
}
