import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { YandexDirectError } from "../types.js";

export function ok(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

interface ObjectError {
  Code?: number;
  Message?: string;
  Details?: string;
}

/**
 * Scans a write response for per-object failures. The Yandex Direct JSON API
 * returns HTTP 200 with the outcome of each object in an `*Results` array
 * (AddResults, UpdateResults, DeleteResults, ActionResults, SetResults, ...);
 * a failed object carries a non-empty `Errors` array while the request as a
 * whole still "succeeds".
 */
function collectObjectErrors(result: unknown): { failed: number; total: number; messages: string[] } {
  const out = { failed: 0, total: 0, messages: [] as string[] };
  if (!result || typeof result !== "object") return out;
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (!key.endsWith("Results") || !Array.isArray(value)) continue;
    for (const item of value) {
      out.total++;
      const errors = (item as { Errors?: unknown })?.Errors;
      if (Array.isArray(errors) && errors.length > 0) {
        out.failed++;
        for (const err of errors as ObjectError[]) {
          const code = err?.Code !== undefined ? `[${err.Code}] ` : "";
          const message = err?.Message ?? "Unknown error";
          const details = err?.Details ? `: ${err.Details}` : "";
          out.messages.push(`${code}${message}${details}`);
        }
      }
    }
  }
  return out;
}

/**
 * Like {@link ok}, but inspects per-object `*Results` arrays and flags the
 * response as an error when any object failed — so partial failures are not
 * silently reported as success.
 */
export function okOrPartial(result: unknown): CallToolResult {
  const { failed, total, messages } = collectObjectErrors(result);
  const body = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (failed === 0) return { content: [{ type: "text", text: body }] };
  const header =
    failed === total
      ? `All ${total} object(s) failed:`
      : `${failed} of ${total} object(s) failed:`;
  const text = `${header}\n${messages.map((m) => `- ${m}`).join("\n")}\n\n${body}`;
  return { content: [{ type: "text", text }], isError: true };
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
