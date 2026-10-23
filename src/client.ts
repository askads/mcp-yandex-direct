import { AuthRequiredError, TokenStore } from "./auth.js";
import { currentClientLogin } from "./clientLogin.js";
import type { ApiError, YandexDirectConfig } from "./types.js";
import {
  ClientAccessError,
  DIRECT_RATE_LIMITED_MARKER,
  DirectRateLimitError,
  DirectUnavailableError,
  YandexDirectError,
} from "./types.js";
import { DEFAULT_PAGE_LIMIT, isReadMethod } from "./tools/util.js";
import { OperationCancelledError, currentOperation, throwIfCancelled, wait } from "./operation.js";

const PROD_BASE = "https://api.direct.yandex.com/json/v5/";
const SANDBOX_BASE = "https://api-sandbox.direct.yandex.com/json/v5/";

// Legacy Live v4 API — a DIFFERENT host/path and request shape than v5. Kept only for
// finance data: AccountManagement (the sole method exposing the shared-account balance)
// lives only here; v5 has no finance service.
const PROD_V4_BASE = "https://api.direct.yandex.ru/live/v4/json/";
const SANDBOX_V4_BASE = "https://api-sandbox.direct.yandex.ru/live/v4/json/";

export interface ReportOptions {
  processingMode?: "auto" | "online" | "offline";
  returnMoneyInMicros?: boolean;
  maxPolls?: number;
}

/** API error codes that are transient and worth retrying: 52 = try again later, 506 = request rate exceeded. */
const RETRYABLE_CODES = new Set([52, 506]);

/** API error code 53 = authorization error: the token itself is dead (expired, revoked, wrong). */
const AUTH_ERROR_CODE = 53;

/**
 * API error code 56 = per-method request rate exceeded. The request was NOT processed, and the
 * message states the limit in force ("не чаще чем 1 раз в 10 секунд"), which Yandex changes
 * without notice — so the wait is read from the message, never hardcoded.
 */
const METHOD_RATE_CODE = 56;
/** Consecutive code-56 answers tolerated per call before giving up. */
const METHOD_RATE_MAX_RETRIES = 3;
/** Total time one call may spend waiting out code 56. */
const METHOD_RATE_MAX_WAIT_MS = 60_000;
/** Window assumed when the code-56 message carries no parsable limit. */
const METHOD_RATE_FALLBACK_MS = 10_000;
/**
 * Up to +20% on each code-56 wait: concurrent callers that hit the limit together (askads
 * spawns a process per request) would otherwise all replay at the same instant and collide again.
 */
const METHOD_RATE_JITTER = 0.2;

/** End-to-end deadline of one call() — all of its waits, backoffs included, must fit. */
const CALL_DEADLINE_MS = 90_000;
/** End-to-end deadline of one report(), polls and waits included. */
const REPORT_DEADLINE_MS = 180_000;

/** Hard row cap for getAll so a runaway full-export can't exhaust memory/context. */
export const GETALL_MAX_ROWS = 100_000;
/** Hard byte cap (serialized merged entities) for getAll — ~1 MB. */
export const GETALL_MAX_BYTES = 1_000_000;

/** Optional caps for {@link YandexDirectClient.getAll}. */
export interface AutoPaginateCaps {
  maxRows?: number;
  maxBytes?: number;
}

/** Daily API points quota from the Units response header. */
export interface Units {
  spent: number;
  rest: number;
  limit: number;
}

export class YandexDirectClient {
  private readonly base: string;
  private readonly v4Base: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private latestUnits?: Units;
  /**
   * Spacing between Reports requests that Direct has demanded (learned from code 56, 0 until
   * then) and when the last one went out. Carried across report() calls so back-to-back
   * reports — clients_overview walks clients one by one — wait out the limit up front
   * instead of drawing a fresh code 56 each.
   */
  private reportPaceMs = 0;
  private lastReportAt = 0;

  private readonly tokens: TokenStore;

  constructor(
    private readonly config: YandexDirectConfig,
    tokens?: TokenStore,
  ) {
    this.base = config.sandbox ? SANDBOX_BASE : PROD_BASE;
    this.v4Base = config.sandbox ? SANDBOX_V4_BASE : PROD_V4_BASE;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseMs = config.retryBaseMs ?? 500;
    // Default store keeps the old contract for callers that pass a plain config
    // (tests, smoke): config.token wins, stored credentials are the fallback.
    this.tokens = tokens ?? new TokenStore(config.token);
  }

  /** Managed-account logins from YANDEX_DIRECT_CLIENTS (empty when unset). */
  get configuredClients(): string[] {
    return this.config.clients ?? [];
  }

  /** The most recent API points quota seen in a Units response header, if any. */
  get units(): Units | undefined {
    return this.latestUnits;
  }

  /**
   * Refreshes the stored token after an authorization error. When the refresh
   * itself fails (revoked in Yandex ID, network down), the actionable message
   * surfaces instead of the original error 53.
   */
  private async refreshOrExplain(): Promise<void> {
    try {
      await this.tokens.refresh();
    } catch (err) {
      if (err instanceof AuthRequiredError) throw err;
      throw new AuthRequiredError(
        `Не удалось обновить токен Директа: ${err instanceof Error ? err.message : String(err)}. ` +
          "Вызовите start_login и подключитесь заново.",
      );
    }
  }

  /**
   * Handles a code 53 from v5/Reports: returns when the request should be replayed with a
   * refreshed token, throws otherwise. With a Client-Login on the request, 53 most often
   * means "no access to that client", not a dead token — so a failed refresh (or a replay
   * that still gets 53) surfaces as {@link ClientAccessError}, not as the refresh's error.
   */
  private async afterAuthError(error: ApiError, refreshed: boolean): Promise<void> {
    const login = this.clientLogin();
    if (!refreshed && this.tokens.canRefresh()) {
      try {
        await this.refreshOrExplain();
        return;
      } catch (err) {
        if (login) throw new ClientAccessError(error, login);
        throw err;
      }
    }
    if (login) throw new ClientAccessError(error, login);
    throw new YandexDirectError(error);
  }

  /** Backoff before a retry: honors Retry-After when present, else exponential (capped at 30s). */
  private backoffMs(attempt: number, res?: Response): number {
    const retryAfter = res ? Number(res.headers.get("Retry-After")) : NaN;
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 30) * 1000;
    return Math.min(this.retryBaseMs * 2 ** attempt, 30_000);
  }

  /**
   * fetch with an AbortController timeout so a hung connection can't hang the tool
   * forever. Reads the body INSIDE the guarded zone (the timer is cleared only after
   * `res.text()` resolves), so a slow/drip-feed body is covered by the same timeout
   * as the headers — not left to hang on the default body timeout.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    service: string,
    budget?: MethodRateBudget,
  ): Promise<{ res: Response; text: string }> {
    // A cancelled tool call aborts the request too, so a client that gave up never leaves
    // a live request (or the retry after it) behind.
    const cancel = currentOperation().signal;
    throwIfCancelled();
    // Each attempt gets only what is left of the call's deadline.
    const timeoutMs = budget ? Math.min(this.timeoutMs, budget.remainingMs) : this.timeoutMs;
    if (timeoutMs <= 0) {
      throw new Error(
        `Запрос к "${service}" не уложился в ${Math.round(budget!.deadlineMs / 1000)} с — повторите позже`,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onCancel = () => controller.abort();
    cancel?.addEventListener("abort", onCancel, { once: true });
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      return { res, text };
    } catch (err) {
      if (cancel?.aborted) throw new OperationCancelledError();
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Запрос к "${service}" превысил таймаут ${timeoutMs} мс`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      cancel?.removeEventListener("abort", onCancel);
    }
  }

  /**
   * Resolved through the TokenStore per request, never cached on the instance:
   * `finish_login` writes a new token to disk mid-session and the very next call
   * has to pick it up. A missing token raises AuthRequiredError here — BEFORE
   * the request is built, retried or sent: a missing credential is a
   * configuration problem, not transport trouble, so it must never enter a
   * retry/backoff branch and fetch never fires without auth (pinned in
   * client.test.ts).
   */
  private async headers(extra?: Record<string, string>): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.tokens.getToken()}`,
      "Accept-Language": this.config.lang,
      "Content-Type": "application/json; charset=utf-8",
    };
    const login = this.clientLogin();
    if (login) headers["Client-Login"] = login;
    return { ...headers, ...extra };
  }

  /**
   * The advertiser of the current request: the tool call's `client_login` when it chose one
   * (`null` = deliberately none), else YANDEX_DIRECT_LOGIN.
   */
  clientLogin(): string | undefined {
    const scoped = currentClientLogin();
    return scoped === undefined ? this.config.login : scoped ?? undefined;
  }

  /** Calls a JSON service (campaigns, ads, keywords, ...) and returns its `result` object. */
  async call<T = unknown>(
    service: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    // SSRF guard (matches the sibling MCP servers): resolve `service` against the API
    // base and reject anything that lands on a FOREIGN origin — an absolute URL
    // ("https://evil/x", "http://evil/x") or a protocol-relative/backslash form
    // ("\\evil/x") would otherwise rebase the token-bearing request onto another host.
    // Comparing the resolved origin (not a brittle string test) stays correct regardless
    // of how the URL is built below.
    const target = new URL(service.replace(/^\//, ""), this.base);
    if (target.origin !== new URL(this.base).origin) {
      throw new Error(
        `service должен быть относительным путём API (получился чужой origin ${target.origin})`,
      );
    }
    // Only read methods (get/has/check) are safe to auto-retry on a network failure or
    // 5xx: a write (add/update/delete/set) may have committed before the gateway error,
    // so a blind retry could duplicate it. Rate-limit codes (429/506/52/56) mean the request
    // was NOT processed and are retried for any method (handled below).
    const idempotent = isReadMethod(method);
    // A stored token can be revoked (or die early) long before its stated expiry,
    // and only the API knows: one silent re-mint + replay per request, then give up.
    let refreshed = false;
    const rate = new MethodRateBudget(service, CALL_DEADLINE_MS);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      let text: string;
      try {
        ({ res, text } = await this.fetchWithTimeout(
          target.toString(),
          {
            method: "POST",
            headers: await this.headers(),
            body: JSON.stringify({ method, params }),
          },
          service,
          rate,
        ));
      } catch (err) {
        // "Not connected" is raised while building the auth header, inside this
        // try — but it is not transport trouble: retrying burns the full backoff
        // (seconds) before the user sees the one message that would help them.
        if (err instanceof AuthRequiredError || err instanceof OperationCancelledError) throw err;
        // Network error or timeout: retry idempotent reads within budget, else rethrow.
        if (idempotent && attempt < this.maxRetries && rate.fits(this.backoffMs(attempt))) {
          await delay(this.backoffMs(attempt));
          continue;
        }
        throw err;
      }

      const units = parseUnits(res.headers.get("Units"));
      if (units) this.latestUnits = units;

      // HTTP 429 means the request was NOT processed, so (like error codes 506/52)
      // it is safe to retry for ANY method, writes included.
      if (res.status === 429) {
        if (attempt < this.maxRetries && rate.fits(this.backoffMs(attempt, res))) {
          await delay(this.backoffMs(attempt, res));
          continue;
        }
        throw new Error(
          `"${service}" вернул HTTP 429 — превышена частота запросов (попыток: ${attempt + 1}): ${text.slice(0, 300)}`,
        );
      }

      // Gateway/server errors are transient — back off and retry, but only for
      // idempotent reads (a write may already have taken effect on the backend).
      if (res.status >= 500 && res.status < 600) {
        if (idempotent && attempt < this.maxRetries && rate.fits(this.backoffMs(attempt, res))) {
          await delay(this.backoffMs(attempt, res));
          continue;
        }
        throw new Error(
          `"${service}" вернул HTTP ${res.status} (попыток: ${attempt + 1}): ${text.slice(0, 300)}`,
        );
      }

      // An empty 2xx (HTTP 204 during a Yandex outage) means the request was NOT processed:
      // same retry rule as a 5xx — reads within budget, writes never — then a dedicated
      // error instead of the misleading "no result field".
      if (isEmptySuccess(res, text)) {
        if (idempotent && attempt < this.maxRetries && rate.fits(this.backoffMs(attempt, res))) {
          await delay(this.backoffMs(attempt, res));
          continue;
        }
        throw new DirectUnavailableError(`"${service}"`, res.status, attempt + 1);
      }

      let data: { result?: T; error?: ApiError };
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `Некорректный JSON в ответе "${service}" (HTTP ${res.status}): ${text.slice(0, 500)}`,
        );
      }

      if (data.error) {
        // Numeric in the JSON API today; normalized anyway, as Reports already sends strings.
        data.error.error_code = Number(data.error.error_code);
        // Code 56 has its own budget: the wait comes from the stated limit, not the backoff.
        if (data.error.error_code === METHOD_RATE_CODE) {
          await rate.waitOut(data.error);
          attempt--;
          continue;
        }
        rate.reset();
        if (
          RETRYABLE_CODES.has(data.error.error_code) &&
          attempt < this.maxRetries &&
          rate.fits(this.backoffMs(attempt, res))
        ) {
          await delay(this.backoffMs(attempt, res));
          continue;
        }
        // The API answers a dead stored token with code 53 (authorization error).
        // Re-mint once and replay; the retry budget above is for transport trouble
        // and must not be spent here.
        if (data.error.error_code === AUTH_ERROR_CODE) {
          await this.afterAuthError(data.error, refreshed);
          refreshed = true;
          attempt--;
          continue;
        }
        throw new YandexDirectError(data.error);
      }
      if (data.result === undefined) {
        // Neither `result` nor `error`: surface the raw response so the caller sees what the
        // API actually returned, instead of returning `undefined` (which `JSON.stringify`s to
        // `undefined` downstream → invalid MCP content / a silent, cryptic failure).
        throw new Error(
          `Неожиданный ответ "${service}" (HTTP ${res.status}) — нет поля "result": ${text.slice(0, 500)}`,
        );
      }
      return data.result as T;
    }
  }

  /**
   * Calls the legacy Live v4 API (different base URL AND request shape than v5): the
   * OAuth token goes in the JSON body, not the Authorization header, and the result is
   * under `data` (errors under `error_code`/`error_str`). Used only for finance reads
   * (AccountManagement) that v5 does not expose. Money in v4 is already in currency units
   * (not micros) — callers must NOT run normalizeMoney on it.
   */
  async callV4<T = unknown>(method: string, param: Record<string, unknown>): Promise<T> {
    // v4 multiplexes read and write behind one method (AccountManagement) via `Action`,
    // so idempotency keys off Action=Get. Only reads are retried on a transient network
    // error or 5xx; a write action (Deposit/Update/…) must never be blindly re-sent.
    const idempotent = String(param.Action ?? "").toLowerCase() === "get";
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      let text: string;
      try {
        // Resolved per attempt, inside the guarded zone: a missing token raises
        // AuthRequiredError before fetch, and a re-minted token is picked up on replay.
        const token = await this.tokens.getToken();
        ({ res, text } = await this.fetchWithTimeout(
          this.v4Base,
          {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ method, token, locale: this.config.lang, param }),
          },
          method,
        ));
      } catch (err) {
        // Not transport trouble — rethrow before the retry/backoff branch.
        if (err instanceof AuthRequiredError || err instanceof OperationCancelledError) throw err;
        if (idempotent && attempt < this.maxRetries) {
          await delay(this.backoffMs(attempt));
          continue;
        }
        throw err;
      }

      if (res.status >= 500 && res.status < 600) {
        if (idempotent && attempt < this.maxRetries) {
          await delay(this.backoffMs(attempt, res));
          continue;
        }
        throw new Error(
          `Live v4 "${method}" вернул HTTP ${res.status} (попыток: ${attempt + 1}): ${text.slice(0, 300)}`,
        );
      }

      if (isEmptySuccess(res, text)) {
        if (idempotent && attempt < this.maxRetries) {
          await delay(this.backoffMs(attempt, res));
          continue;
        }
        throw new DirectUnavailableError(`Live v4 "${method}"`, res.status, attempt + 1);
      }

      let data: { data?: T; error_code?: number; error_str?: string; error_detail?: string };
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `Некорректный JSON от Live v4 "${method}" (HTTP ${res.status}): ${text.slice(0, 500)}`,
        );
      }

      if (data.error_code !== undefined) {
        // v4 answers a dead token with the same code 53 — one re-mint + replay,
        // same as call(); the fresh token is re-resolved at the top of the loop.
        if (data.error_code === AUTH_ERROR_CODE && !refreshed && this.tokens.canRefresh()) {
          refreshed = true;
          await this.refreshOrExplain();
          attempt--;
          continue;
        }
        const detail = data.error_detail ? `: ${data.error_detail}` : "";
        throw new Error(`Ошибка Live v4 "${method}": [${data.error_code}] ${data.error_str ?? ""}${detail}`);
      }
      if (data.data === undefined) {
        throw new Error(
          `Неожиданный ответ Live v4 для "${method}" (HTTP ${res.status}) — нет поля "data": ${text.slice(0, 500)}`,
        );
      }
      return data.data as T;
    }
  }

  /**
   * Runs a `get` request, following the LimitedBy cursor to fetch every page
   * and merging the entity array, so large accounts are not silently truncated.
   * Pages at DEFAULT_PAGE_LIMIT (10k) regardless of the per-tool `limit` clamp
   * (which governs single-page calls only), so capacity is deterministic — not
   * path-dependent. Bounded by maxPages (runaway-loop stop) AND by hard row/byte
   * caps (GETALL_MAX_ROWS / GETALL_MAX_BYTES), because nothing downstream limits
   * the result size and an unbounded full-export would flood the LLM context.
   * Hitting any cap flags the merged result with `_truncated`/`_truncatedNote`
   * and keeps LimitedBy as a resume cursor, so a truncated full-export is
   * explicit and never silent data loss.
   */
  async getAll<T = unknown>(
    service: string,
    params: Record<string, unknown>,
    maxPages = 100,
    caps: AutoPaginateCaps = {},
  ): Promise<T> {
    const basePage = (params.Page as Record<string, unknown> | undefined) ?? {};
    // autoPaginate ("fetch all") ALWAYS pages at the API max, independent of the
    // per-tool `limit` clamp (which governs single-page calls only). This keeps
    // capacity deterministic instead of path-dependent (a caller passing
    // limit:1000 alongside autoPaginate must not silently shrink the export ceiling).
    const limit = DEFAULT_PAGE_LIMIT;
    const maxRows = caps.maxRows ?? GETALL_MAX_ROWS;
    const maxBytes = caps.maxBytes ?? GETALL_MAX_BYTES;
    let offset = Number(basePage.Offset ?? 0);
    let merged: Record<string, unknown> | undefined;
    let entityKey: string | undefined;
    let bytes = 0;
    let capNote: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const pageParams = { ...params, Page: { Limit: limit, Offset: offset } };
      const result = await this.call<Record<string, unknown>>(service, "get", pageParams);

      if (!merged) {
        merged = result;
        entityKey = Object.keys(result).find((key) => Array.isArray(result[key]));
      } else if (entityKey && Array.isArray(result[entityKey])) {
        (merged[entityKey] as unknown[]).push(...(result[entityKey] as unknown[]));
      }
      const batch = entityKey && Array.isArray(result[entityKey]) ? (result[entityKey] as unknown[]) : [];
      if (batch.length) bytes += JSON.stringify(batch).length;
      const rows = entityKey ? (merged[entityKey] as unknown[]).length : 0;

      // Checked BEFORE the caps: a dataset that completes exactly on a cap boundary
      // is complete, not truncated (nothing left to fetch → no "narrow the filter" advice).
      const limitedBy = result.LimitedBy;
      if (typeof limitedBy !== "number") {
        delete merged.LimitedBy;
        return merged as T;
      }
      offset = limitedBy;

      // Hard caps: more pages remain, but stop before a runaway export exhausts
      // memory or the downstream context.
      if (rows >= maxRows || bytes >= maxBytes) {
        capNote =
          `Остановлено на лимите объёма autoPaginate (объектов: ${rows}, байт: ~${bytes}); ` +
          `остались ещё объекты (LimitedBy=${offset}). ` +
          "Сузить фильтр или пройти страницы вручную с offset, чтобы получить остальные.";
        break;
      }
    }
    // Stopped on a cap (pages or rows/bytes) with LimitedBy still set → more objects
    // remain. Make this LOUD: a bare LimitedBy number is easy for an LLM consumer to miss,
    // and a silently truncated full-export is legitimate-data loss.
    if (merged && typeof (merged as Record<string, unknown>).LimitedBy === "number") {
      const m = merged as Record<string, unknown>;
      // The scalar LimitedBy was copied from the FIRST page and is now stale (it points
      // just past page 1, not past the merged set). Overwrite it with `offset`, the cursor
      // after the last merged page, so "paginate with offset from LimitedBy" resumes at the
      // right place instead of re-fetching from the start.
      m.LimitedBy = offset;
      m._truncated = true;
      m._truncatedNote =
        capNote ??
        `Остановлено на лимите страниц (${maxPages}); остались ещё объекты (LimitedBy=${m.LimitedBy}). ` +
          "Сузить фильтр или пройти страницы вручную с offset, чтобы получить остальные.";
    }
    return merged as T;
  }

  /** Requests a TSV statistics report, polling while Yandex generates it. */
  async report(params: Record<string, unknown>, opts: ReportOptions = {}): Promise<string> {
    const url = this.base + "reports";
    const extraHeaders = {
      processingMode: opts.processingMode ?? "auto",
      returnMoneyInMicros: String(opts.returnMoneyInMicros ?? false),
      skipReportHeader: "true",
      skipReportSummary: "true",
    };
    const maxPolls = opts.maxPolls ?? 10;
    let lastStatus = 0;
    let refreshed = false;
    let polls = 0;
    const rate = new MethodRateBudget("reports", REPORT_DEADLINE_MS);
    const paceLeft = this.lastReportAt + this.reportPaceMs - Date.now();
    if (paceLeft > 0) {
      await wait(paceLeft, (left) => `Пауза перед отчётом по лимиту частоты Яндекса: ${left} с`);
    }

    for (let attempt = 0; attempt < maxPolls; attempt++) {
      polls++;
      this.lastReportAt = Date.now();
      // Headers are rebuilt per poll so the token is resolved through the
      // TokenStore each time: a missing token raises AuthRequiredError before
      // the first fetch, and a re-minted token is picked up on replay.
      const { res, text } = await this.fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: await this.headers(extraHeaders),
          body: JSON.stringify({ params }),
        },
        "reports",
        rate,
      );
      lastStatus = res.status;

      if (res.status === 200) return text;

      // 201/202: report still generating. 5xx: transient server error during
      // generation — the docs recommend retrying after retryIn rather than
      // treating it as fatal. Both are retried within the poll budget.
      if (
        res.status === 201 ||
        res.status === 202 ||
        res.status === 204 ||
        (res.status >= 500 && res.status < 600)
      ) {
        if (attempt === maxPolls - 1) break;
        rate.reset();
        // Once the API has stated a rate limit, polls never come faster than it allows,
        // or every retryIn-paced poll would draw another code 56.
        const pause = Math.max(pollDelayMs(res), rate.intervalMs);
        if (!rate.fits(pause)) break;
        const poll = attempt + 1;
        await wait(
          pause,
          (left) => `Отчёт формируется в Яндекс Директе — опрос ${poll}/${maxPolls}, следующий через ${left} с`,
        );
        continue;
      }

      let parsed: { error?: ApiError } | undefined;
      try {
        parsed = JSON.parse(text) as { error?: ApiError };
        // Reports, unlike the JSON API, sends error_code as a string ("53", "56"):
        // normalize, or every code comparison below silently never matches.
        if (parsed?.error) parsed.error.error_code = Number(parsed.error.error_code);
      } catch {
        // Not JSON — falls through to the generic error below.
      }
      if (parsed?.error) {
        // Code 56: the request was not processed — wait out the stated limit and replay,
        // without spending the poll budget on it.
        if (parsed.error.error_code === METHOD_RATE_CODE) {
          await rate.waitOut(parsed.error);
          this.reportPaceMs = Math.max(this.reportPaceMs, rate.intervalMs);
          attempt--;
          continue;
        }
        rate.reset();
        // Reports answers a dead stored token with the same code 53 — one silent
        // re-mint + replay, without spending the poll budget on it.
        if (parsed.error.error_code === AUTH_ERROR_CODE) {
          await this.afterAuthError(parsed.error, refreshed);
          refreshed = true;
          attempt--;
          continue;
        }
        throw new YandexDirectError(parsed.error);
      }
      throw new Error(`Запрос отчёта завершился ошибкой (HTTP ${res.status}): ${text.slice(0, 500)}`);
    }

    if (lastStatus === 204) throw new DirectUnavailableError('"reports"', lastStatus, polls);
    throw new Error(
      `Отчёт не был готов за ${Math.round(rate.elapsedMs / 1000)} с; опросов: ${polls}, ` +
        `последний HTTP ${lastStatus}. Отчёт продолжает формироваться у Яндекса — ` +
        "повторите запрос через минуту.",
    );
  }
}

/** The limit a code-56 message states. */
export interface MethodRateLimit {
  /** Even spacing the limit allows between calls: M/N seconds. */
  intervalMs: number;
  /** The whole window, M seconds: the safe wait once the limit is exhausted. */
  windowMs: number;
  /** Human-readable form, e.g. "не чаще 1 раз в 10 с"; absent when unparsed. */
  text?: string;
}

/**
 * Reads the limit from a code-56 message: "N раз в M секунд" (or the English "N time(s) per
 * M seconds"). Unknown wording falls back to a 10 s window.
 */
export function methodRateLimit(error: ApiError): MethodRateLimit {
  const text = `${error.error_detail ?? ""} ${error.error_string ?? ""}`;
  const m = text.match(/(\d+)\s*(?:раза?|times?)\D{0,20}?(\d+)\s*(?:сек|sec)/i);
  if (m) {
    const times = Number(m[1]);
    const seconds = Number(m[2]);
    if (times > 0 && seconds > 0) {
      return {
        intervalMs: Math.ceil((seconds * 1000) / times),
        windowMs: seconds * 1000,
        text: `не чаще ${times} раз в ${seconds} с`,
      };
    }
  }
  return { intervalMs: METHOD_RATE_FALLBACK_MS, windowMs: METHOD_RATE_FALLBACK_MS };
}

/**
 * Time budget of one call: the end-to-end deadline plus the code-56 retry allowance
 * (consecutive answers and total time waited).
 */
class MethodRateBudget {
  private consecutive = 0;
  private waitedMs = 0;
  private readonly startedAt = Date.now();
  /** Spacing the API has demanded during this call (0 until the first code 56). */
  intervalMs = 0;

  constructor(
    private readonly service: string,
    readonly deadlineMs: number,
  ) {}

  /** Time left before the deadline (≤ 0 once it has passed). */
  get remainingMs(): number {
    return this.deadlineMs - this.elapsedMs;
  }

  /** Whether a wait of `ms` still fits the call's deadline. */
  fits(ms: number): boolean {
    return Date.now() - this.startedAt + ms <= this.deadlineMs;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /**
   * Waits out a code-56 answer before the replay, reporting progress. Throws
   * {@link DirectRateLimitError} once the retry allowance or the deadline is spent.
   */
  async waitOut(error: ApiError): Promise<void> {
    const limit = methodRateLimit(error);
    const op = currentOperation();
    if (limit.text) op.rateLimit = limit.text;
    const ms = Math.ceil(limit.windowMs * (1 + Math.random() * METHOD_RATE_JITTER));
    if (
      this.consecutive >= METHOD_RATE_MAX_RETRIES ||
      this.waitedMs + ms > METHOD_RATE_MAX_WAIT_MS ||
      !this.fits(ms)
    ) {
      throw new DirectRateLimitError(error, this.service, this.consecutive, this.waitedMs, limit.text);
    }
    this.consecutive++;
    this.waitedMs += ms;
    op.rateWaitedMs += ms;
    this.intervalMs = Math.max(this.intervalMs, limit.intervalMs);
    const stated = limit.text ? ` (${limit.text})` : "";
    const n = this.consecutive;
    await wait(
      ms,
      (left) =>
        `${DIRECT_RATE_LIMITED_MARKER}${stated} — повтор через ${left} с (${n}/${METHOD_RATE_MAX_RETRIES})`,
    );
  }

  /** Any answer other than code 56 resets the consecutive count. */
  reset(): void {
    this.consecutive = 0;
  }
}

/** A 2xx with no body: Direct answers HTTP 204 to everything during an outage. */
function isEmptySuccess(res: Response, text: string): boolean {
  return res.status >= 200 && res.status < 300 && text.trim() === "";
}

/** Seconds to wait before re-polling a report, from the retryIn header (capped). */
function pollDelayMs(res: Response): number {
  const retryIn = Number(res.headers.get("retryIn") ?? 5);
  return Math.min(Number.isFinite(retryIn) ? retryIn : 5, 10) * 1000;
}

/** Parses the "spent/rest/limit" Units header into structured quota numbers. */
export function parseUnits(header: string | null): Units | undefined {
  if (!header) return undefined;
  const parts = header.split("/").map((n) => Number(n.trim()));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return undefined;
  const [spent, rest, limit] = parts;
  return { spent, rest, limit };
}

/** A silent backoff, abortable by the current call's cancellation. */
function delay(ms: number): Promise<void> {
  return wait(ms);
}
