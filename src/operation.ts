import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DIRECT_RATE_LIMITED_MARKER } from "./types.js";

/**
 * Per-tool-call state. Lives in AsyncLocalStorage rather than on the client: the client is a
 * singleton shared by concurrent tool calls, and their signals/progress must not mix.
 */
export interface Operation {
  /** Aborted when the MCP client cancels the call or gives up on it. */
  signal?: AbortSignal;
  /** Sends a human-readable progress note to the client (no-op when it asked for none). */
  progress(message: string): void;
  /** Total time this call spent waiting out code 56. */
  rateWaitedMs: number;
  /** The limit Direct last stated, e.g. "не чаще чем 1 раз в 10 секунд". */
  rateLimit?: string;
}

const storage = new AsyncLocalStorage<Operation>();

const DETACHED: Operation = {
  progress() {},
  rateWaitedMs: 0,
};

/** The current tool call's operation; a detached stub outside of one (tests, smoke). */
export function currentOperation(): Operation {
  return storage.getStore() ?? DETACHED;
}

/** Runs `fn` as its own operation — for callers outside the MCP server (tests, scripts). */
export function runOperation<T>(op: Partial<Operation>, fn: () => T): T {
  return storage.run({ progress() {}, rateWaitedMs: 0, ...op }, fn);
}

/** Error raised when the MCP client cancelled the call mid-wait: nothing more is sent. */
export class OperationCancelledError extends Error {
  constructor() {
    super("Вызов отменён клиентом — повторных запросов к API не будет");
    this.name = "OperationCancelledError";
  }
}

/** Throws if the current call has been cancelled. */
export function throwIfCancelled(op: Operation = currentOperation()): void {
  if (op.signal?.aborted) throw new OperationCancelledError();
}

/** Longest silent stretch of a wait: progress clients reset their timeout on each note. */
const HEARTBEAT_MS = 10_000;

/** Overridable sleep, so tests can run the timing logic without real delays. */
export const timing = {
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new OperationCancelledError());
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new OperationCancelledError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

/**
 * Waits `ms`, abortable by the call's signal. With a `message`, reports progress before the
 * wait and every {@link HEARTBEAT_MS} during it, so a client that resets its timeout on
 * progress never sees a silent stretch long enough to give up.
 */
export async function wait(ms: number, message?: (leftSec: number) => string): Promise<void> {
  const op = currentOperation();
  let left = ms;
  while (left > 0) {
    if (message) op.progress(message(Math.ceil(left / 1000)));
    const step = Math.min(left, HEARTBEAT_MS);
    await timing.sleep(step, op.signal);
    left -= step;
  }
  throwIfCancelled(op);
}

interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

interface RequestExtra {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
}

/** Builds the operation of one tool call from the SDK's request extra. */
function operationFrom(extra: RequestExtra | undefined): Operation {
  const token = extra?._meta?.progressToken;
  let step = 0;
  return {
    signal: extra?.signal,
    progress(message) {
      if (token === undefined || !extra?.sendNotification) return;
      step++;
      // Best effort: a failed notification must never fail the call itself.
      extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: step, message },
        })
        .catch(() => {});
    },
    rateWaitedMs: 0,
  };
}

/** The note appended to a successful result that waited out code 56. */
export function rateLimitNote(op: Operation): string {
  const limit = op.rateLimit ? ` (${op.rateLimit})` : "";
  return (
    `${DIRECT_RATE_LIMITED_MARKER}${limit}: ответ задержан на ${Math.round(op.rateWaitedMs / 1000)} с. ` +
    "Это ограничение на стороне Яндекса, а не сбой. Запрашивайте отчёты по одному, не параллельно."
  );
}

/**
 * Wraps every tool registered after this call so it runs inside its own {@link Operation}:
 * cancellation and progress reach the HTTP client, and a result slowed by code 56 carries
 * an explicit note instead of an unexplained delay.
 */
export function instrumentOperations(server: McpServer): void {
  const original = server.registerTool.bind(server);
  // Same runtime-shape wrapping as instrumentToolCalls: the SDK passes `extra` last,
  // after `args` for tools with an input schema and alone for tools without one.
  server.registerTool = ((name: string, config: unknown, callback: unknown) =>
    original(
      name,
      config as never,
      (async (...args: unknown[]) => {
        const op = operationFrom(args[args.length - 1] as RequestExtra | undefined);
        const result = (await storage.run(op, () =>
          (callback as (...a: unknown[]) => unknown)(...args),
        )) as ToolResult;
        if (op.rateWaitedMs > 0 && result && Array.isArray(result.content) && !result.isError) {
          return { ...result, content: [...result.content, { type: "text", text: rateLimitNote(op) }] };
        }
        return result;
      }) as never,
    )) as typeof server.registerTool;
}
