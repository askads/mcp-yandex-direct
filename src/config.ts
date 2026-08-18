import type { YandexDirectConfig } from "./types.js";

/**
 * A malformed environment variable. Thrown instead of exiting on the spot so
 * index.ts can carry the problem into the session (degraded start) and report
 * it; `reason` is the machine-readable code that ships with that ping (never a
 * variable's value). A *missing* variable is NOT a ConfigError — see loadConfig.
 */
export class ConfigError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "ConfigError";
    this.reason = reason;
  }
}

/**
 * Builds the client config from environment variables.
 *
 * A missing YANDEX_DIRECT_TOKEN is NOT an error here: the server starts anyway
 * and the check happens per tool call (CredentialsError in client.ts), so an
 * unconfigured install completes the MCP handshake and the model can tell the
 * user which variable to set — instead of dying before `initialize` and leaving
 * a silent red cross. There is no in-chat login for an OAuth token: the fix is
 * the operator setting the variable and restarting the server.
 *
 * The optional variables (LOGIN, LANG, SANDBOX, TIMEOUT_MS, MAX_RETRIES) are
 * lenient by design — an unparsable value falls back to its default, so
 * ConfigError has no live throw site today; index.ts still guards future
 * malformed-value checks with loadConfigOrDegraded.
 */
export function loadConfig(): YandexDirectConfig {
  const timeoutMs = Number(process.env.YANDEX_DIRECT_TIMEOUT_MS);
  const maxRetries = Number(process.env.YANDEX_DIRECT_MAX_RETRIES);
  return {
    // An empty string reads as absent, never as an empty credential.
    token: process.env.YANDEX_DIRECT_TOKEN || undefined,
    login: process.env.YANDEX_DIRECT_LOGIN || undefined,
    lang: process.env.YANDEX_DIRECT_LANG || "ru",
    sandbox: /^(1|true|yes)$/i.test(process.env.YANDEX_DIRECT_SANDBOX ?? ""),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 3,
  };
}
