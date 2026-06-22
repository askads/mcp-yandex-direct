import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { YandexDirectError } from "../types.js";

/** A date in YYYY-MM-DD form, validated before the request reaches the API. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format");

export function ok(data: unknown): CallToolResult {
  // Compact JSON (no indent): the consumer is an LLM, pretty-printing only burns tokens.
  // `JSON.stringify(undefined)` is `undefined` (not a string) — guard it so we never emit
  // `{type:"text", text: undefined}`, which the MCP SDK rejects as invalid content.
  const text = typeof data === "string" ? data : JSON.stringify(data) ?? "null";
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
  const body = typeof result === "string" ? result : JSON.stringify(result) ?? "null";
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

/** Converts micros back to account currency units (1_000_000 micros = 1 unit). */
export function fromMicros(micros: number): number {
  return micros / 1_000_000;
}

/**
 * Money fields the JSON services always return in micros. The Reports service
 * (statistics) already returns currency units, and inputs are taken in units,
 * so list_* output is normalized here to keep money consistent across tools.
 */
const MONEY_FIELDS = new Set(["Bid", "ContextBid", "Amount"]);

/** Recursively converts known money fields from micros to currency units, in place. */
export function normalizeMoney<T>(value: T, fields: Set<string> = MONEY_FIELDS): T {
  if (Array.isArray(value)) {
    for (const item of value) normalizeMoney(item, fields);
  } else if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (fields.has(key) && typeof val === "number") {
        (value as Record<string, unknown>)[key] = fromMicros(val);
      } else {
        normalizeMoney(val, fields);
      }
    }
  }
  return value;
}

/** Largest page size the get services accept; used as the default per-page limit. */
export const DEFAULT_PAGE_LIMIT = 10000;

/**
 * Cap on the `limit` a list_* tool exposes to the caller. The API allows up to
 * 10000/page, but a single 10k-row result blows up the LLM context, so the tools
 * advertise a much smaller ceiling. autoPaginate (multi-page) is bounded
 * separately by getAll's maxPages.
 */
export const MAX_TOOL_LIMIT = 1000;

/**
 * Builds a Page object for a get request. The API requires Limit whenever Page
 * is present, so Limit defaults to DEFAULT_PAGE_LIMIT when only an offset is given.
 * Returns undefined when neither limit nor offset is requested.
 */
export function buildPage(
  limit?: number,
  offset?: number,
): { Limit: number; Offset: number } | undefined {
  if (limit === undefined && offset === undefined) return undefined;
  return { Limit: limit ?? DEFAULT_PAGE_LIMIT, Offset: offset ?? 0 };
}

/** Drops keys whose value is `undefined` so they are not sent to the API. */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T;
}
