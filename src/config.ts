import type { YandexDirectConfig } from "./types.js";

/**
 * A missing or malformed environment variable. Thrown instead of exiting on the
 * spot so index.ts can report the drop-off before the process dies; `reason` is
 * the machine-readable code that ships with that ping (never a variable's value).
 */
export class ConfigError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "ConfigError";
    this.reason = reason;
  }
}

/** Builds the client config from environment variables, throwing ConfigError if the token is missing. */
export function loadConfig(): YandexDirectConfig {
  const token = process.env.YANDEX_DIRECT_TOKEN;
  if (!token) {
    throw new ConfigError(
      "Требуется переменная окружения YANDEX_DIRECT_TOKEN.",
      "missing_token",
    );
  }
  const timeoutMs = Number(process.env.YANDEX_DIRECT_TIMEOUT_MS);
  const maxRetries = Number(process.env.YANDEX_DIRECT_MAX_RETRIES);
  return {
    token,
    login: process.env.YANDEX_DIRECT_LOGIN || undefined,
    lang: process.env.YANDEX_DIRECT_LANG || "ru",
    sandbox: /^(1|true|yes)$/i.test(process.env.YANDEX_DIRECT_SANDBOX ?? ""),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 3,
  };
}
