import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * The advertiser one tool call works on, sent as the Client-Login header. Lives in
 * AsyncLocalStorage for the same reason as Operation: the client is a singleton shared by
 * concurrent tool calls, and two calls for two different clients must not mix.
 *
 * `null` means "no Client-Login at all, even if YANDEX_DIRECT_LOGIN is set" — the agency's
 * own requests (AgencyClients.get) need that.
 */
const storage = new AsyncLocalStorage<string | null>();

/**
 * The Client-Login of the current call: a string, `null` for "explicitly none", or
 * `undefined` when the call did not choose — then the configured YANDEX_DIRECT_LOGIN applies.
 */
export function currentClientLogin(): string | null | undefined {
  return storage.getStore();
}

/** Runs `fn` with `login` as the Client-Login of every request it makes. */
export function withClientLogin<T>(login: string | null, fn: () => T): T {
  return storage.run(login, fn);
}

/**
 * Tools that must not get the `client_login` parameter: the login flow works on the token,
 * not on an advertiser, and the multi-client tools pick their clients themselves.
 */
const ACCOUNT_LEVEL_TOOLS = new Set([
  "auth_status",
  "start_login",
  "finish_login",
  "logout",
  "list_clients",
  "clients_overview",
]);

/** Yandex logins: letters, digits, dots, hyphens; PDD logins carry a domain after "@". */
export const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/;

/** A fresh schema per tool — a shared zod object would be deduped into a `$ref` (see isoDate). */
const clientLoginSchema = () =>
  z
    .string()
    .trim()
    .regex(LOGIN_PATTERN, "Логин клиента: латиница, цифры, точка, дефис")
    .optional()
    .describe(
      "Логин клиента агентства или кабинета в управлении (из list_clients). Если не указан — " +
        "YANDEX_DIRECT_LOGIN из конфигурации, а без него собственный аккаунт токена.",
    );

interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

/**
 * Names the client in a result the caller addressed explicitly, so a call that went to the
 * wrong advertiser is visible in its own answer. A JSON object gets a `_client` key; any
 * other result (TSV, error text) gets one more text block.
 */
export function labelResult(result: ToolResult, login: string): ToolResult {
  if (!result || !Array.isArray(result.content)) return result;
  const [first, ...rest] = result.content;
  if (!result.isError && first?.type === "text" && first.text?.startsWith("{")) {
    try {
      const data = JSON.parse(first.text) as unknown;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const text = JSON.stringify({ _client: login, ...(data as Record<string, unknown>) });
        return { ...result, content: [{ ...first, text }, ...rest] };
      }
    } catch {
      // Not JSON after all — falls through to the extra block.
    }
  }
  return { ...result, content: [...result.content, { type: "text", text: `Кабинет клиента: ${login}` }] };
}

/**
 * Gives every tool registered after this call (except the account-level ones) an optional
 * `client_login` parameter: the call runs with that Client-Login, overriding
 * YANDEX_DIRECT_LOGIN, and its result names the client.
 *
 * A parameter rather than a "current client" switch: each call says which advertiser it
 * touches, so nothing hidden survives a context compaction, and calls for different
 * clients can run side by side.
 */
export function instrumentClientLogin(server: McpServer): void {
  const original = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: { inputSchema?: Record<string, unknown> }, callback: unknown) => {
    if (ACCOUNT_LEVEL_TOOLS.has(name)) return original(name, config as never, callback as never);
    const hadSchema = config.inputSchema !== undefined;
    const inputSchema = { ...(config.inputSchema ?? {}), client_login: clientLoginSchema() };
    return original(
      name,
      { ...config, inputSchema } as never,
      (async (args: Record<string, unknown>, extra: unknown) => {
        const { client_login: login, ...rest } = args ?? {};
        const cb = callback as (...a: unknown[]) => Promise<ToolResult>;
        // A tool registered without a schema takes `extra` alone — keep its signature.
        const run = () => (hadSchema ? cb(rest, extra) : cb(extra));
        if (typeof login !== "string" || !login) return run();
        return labelResult(await withClientLogin(login, run), login);
      }) as never,
    );
  }) as typeof server.registerTool;
}
