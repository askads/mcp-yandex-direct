export interface YandexDirectConfig {
  token: string;
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

export class YandexDirectError extends Error {
  readonly code: number;
  readonly detail?: string;
  readonly requestId?: string;

  constructor(err: ApiError) {
    const detail = err.error_detail ? `: ${err.error_detail}` : "";
    super(`[${err.error_code}] ${err.error_string}${detail}`);
    this.name = "YandexDirectError";
    this.code = err.error_code;
    this.detail = err.error_detail;
    this.requestId = err.request_id;
  }
}
