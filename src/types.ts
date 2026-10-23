export interface YandexDirectConfig {
  /** OAuth token; absent on a degraded (unconfigured) start — see loadConfig in config.ts. */
  token?: string;
  /** Default Client-Login (YANDEX_DIRECT_LOGIN); a tool call's `client_login` overrides it. */
  login?: string;
  /**
   * Logins of the accounts this token manages (YANDEX_DIRECT_CLIENTS). The only source of the
   * list for a non-agency token — the API has no method that enumerates them.
   */
  clients?: string[];
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
 * Stable prefix of a {@link DirectRateLimitError} message and of the note on a result that was
 * slowed down by code 56. Consumers (the askads backend) match on it to tell the user that the
 * delay or failure comes from Yandex's rate limit, not from a hung server.
 */
export const DIRECT_RATE_LIMITED_MARKER = "Яндекс Директ ограничивает частоту запросов";

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

/**
 * Code 56 (per-method rate limit) kept coming after the retry budget ran out. Still a
 * {@link YandexDirectError} with code 56, but the message tells the user what happened and
 * what to do instead of the bare API text.
 */
export class DirectRateLimitError extends YandexDirectError {
  constructor(err: ApiError, service: string, retries: number, waitedMs: number, limit?: string) {
    super(err);
    this.name = "DirectRateLimitError";
    const stated = limit ? ` (${limit})` : "";
    const reqId = err.request_id ? ` (request_id: ${err.request_id})` : "";
    this.message =
      `${DIRECT_RATE_LIMITED_MARKER}${stated}: запрос к "${service}" не выполнен — ` +
      `после ${retries} повторов и ${Math.round(waitedMs / 1000)} с ожидания Яндекс всё ещё отвечает [56]. ` +
      "Не запускайте такие запросы параллельно; повторите один запрос через минуту." +
      reqId;
  }
}

/**
 * Code 53 on a request that carried Client-Login. Direct answers "this token may not act for
 * that login" with the same 53 as a dead token (an unknown login gets 8800 instead), so the
 * message names both causes and the cheap way to tell them apart — never the failure of a
 * token refresh that was beside the point.
 */
export class ClientAccessError extends YandexDirectError {
  readonly login: string;

  constructor(err: ApiError, login: string) {
    super(err);
    this.name = "ClientAccessError";
    this.login = login;
    const reqId = err.request_id ? ` (request_id: ${err.request_id})` : "";
    this.message =
      `[${err.error_code}] ${err.error_string}: у токена нет доступа к кабинету «${login}» через Client-Login ` +
      "— этот логин не подключён к аккаунту токена как клиент агентства или кабинет в управлении. " +
      "Проверить: тот же инструмент без client_login работает — значит, дело в доступе к этому кабинету, а не в токене." +
      reqId;
  }
}
