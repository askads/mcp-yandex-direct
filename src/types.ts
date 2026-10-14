export interface YandexDirectConfig {
  /** OAuth token; absent on a degraded (unconfigured) start — see loadConfig in config.ts. */
  token?: string;
  login?: string;
  lang: string;
  sandbox: boolean;
  /** Per-request timeout in milliseconds. Defaults to 60_000. */
  timeoutMs?: number;
  /** Max retries for transient errors (rate limits, 5xx). Defaults to 3. */
  maxRetries?: number;
  /** Base backoff in milliseconds, doubled each retry. Defaults to 500. */
  retryBaseMs?: number;
}

export interface ApiError {
  error_code: number;
  error_string: string;
  error_detail?: string;
  request_id?: string;
}

/**
 * Stable prefix of every {@link DirectUnavailableError} message. Consumers (the askads
 * backend, remote-MCP clients) match on it to tell a Yandex outage from a client bug.
 */
export const DIRECT_UNAVAILABLE_MARKER = "API Яндекс Директа недоступен";

/**
 * The API answered a 2xx with no body (since 2026-10-11 every Direct service, v5/v501/v4,
 * returns HTTP 204 during an outage): the request was NOT processed on Yandex's side.
 * Not a client error and not a malformed response — "retry later".
 */
export class DirectUnavailableError extends Error {
  readonly status: number;
  readonly attempts: number;

  constructor(request: string, status: number, attempts: number) {
    super(
      `${DIRECT_UNAVAILABLE_MARKER}: на запрос ${request} сервер ответил HTTP ${status} без данных ` +
        `(сбой на стороне Яндекса, запрос не обработан; попыток: ${attempts}). Повторите позже.`,
    );
    this.name = "DirectUnavailableError";
    this.status = status;
    this.attempts = attempts;
  }
}

export class YandexDirectError extends Error {
  readonly code: number;
  readonly detail?: string;
  readonly requestId?: string;

  constructor(err: ApiError) {
    const detail = err.error_detail ? `: ${err.error_detail}` : "";
    // request_id is what Yandex support asks for when triaging a failed call — surface it
    // in the message so it reaches the user/logs instead of being buried on the object.
    const reqId = err.request_id ? ` (request_id: ${err.request_id})` : "";
    super(`[${err.error_code}] ${err.error_string}${detail}${reqId}`);
    this.name = "YandexDirectError";
    this.code = err.error_code;
    this.detail = err.error_detail;
    this.requestId = err.request_id;
  }
}
