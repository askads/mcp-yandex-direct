import type { ApiError, YandexDirectConfig } from "./types.js";
import { YandexDirectError } from "./types.js";

const PROD_BASE = "https://api.direct.yandex.com/json/v5/";
const SANDBOX_BASE = "https://api-sandbox.direct.yandex.com/json/v5/";

export interface ReportOptions {
  processingMode?: "auto" | "online" | "offline";
  returnMoneyInMicros?: boolean;
  maxPolls?: number;
}

/** API error codes that are transient and worth retrying: 52 = try again later, 506 = request rate exceeded. */
const RETRYABLE_CODES = new Set([52, 506]);

export class YandexDirectClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(private readonly config: YandexDirectConfig) {
    this.base = config.sandbox ? SANDBOX_BASE : PROD_BASE;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseMs = config.retryBaseMs ?? 500;
  }

  /** Backoff before a retry: honors Retry-After when present, else exponential (capped at 30s). */
  private backoffMs(attempt: number, res?: Response): number {
    const retryAfter = res ? Number(res.headers.get("Retry-After")) : NaN;
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 30) * 1000;
    return Math.min(this.retryBaseMs * 2 ** attempt, 30_000);
  }

  /** fetch with an AbortController timeout so a hung connection can't hang the tool forever. */
  private async fetchWithTimeout(url: string, init: RequestInit, service: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Request to "${service}" timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      "Accept-Language": this.config.lang,
      "Content-Type": "application/json; charset=utf-8",
    };
    if (this.config.login) headers["Client-Login"] = this.config.login;
    return { ...headers, ...extra };
  }

  /** Calls a JSON service (campaigns, ads, keywords, ...) and returns its `result` object. */
  async call<T = unknown>(
    service: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchWithTimeout(
        this.base + service,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ method, params }),
        },
        service,
      );

      const text = await res.text();

      // Gateway/server errors are transient — back off and retry.
      if (res.status >= 500 && res.status < 600) {
        if (attempt < this.maxRetries) {
          await delay(this.backoffMs(attempt, res));
          continue;
        }
        throw new Error(
          `"${service}" failed with HTTP ${res.status} after ${attempt + 1} attempts: ${text.slice(0, 300)}`,
        );
      }

      let data: { result?: T; error?: ApiError };
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `Invalid JSON response from "${service}" (HTTP ${res.status}): ${text.slice(0, 500)}`,
        );
      }

      if (data.error) {
        if (RETRYABLE_CODES.has(data.error.error_code) && attempt < this.maxRetries) {
          await delay(this.backoffMs(attempt, res));
          continue;
        }
        throw new YandexDirectError(data.error);
      }
      return data.result as T;
    }
  }

  /** Requests a TSV statistics report, polling while Yandex generates it. */
  async report(params: Record<string, unknown>, opts: ReportOptions = {}): Promise<string> {
    const url = this.base + "reports";
    const headers = this.headers({
      processingMode: opts.processingMode ?? "auto",
      returnMoneyInMicros: String(opts.returnMoneyInMicros ?? false),
      skipReportHeader: "true",
      skipReportSummary: "true",
    });
    const maxPolls = opts.maxPolls ?? 10;
    let lastStatus = 0;

    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const res = await this.fetchWithTimeout(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ params }),
        },
        "reports",
      );
      lastStatus = res.status;

      if (res.status === 200) return res.text();

      // 201/202: report still generating. 5xx: transient server error during
      // generation — the docs recommend retrying after retryIn rather than
      // treating it as fatal. Both are retried within the poll budget.
      if (res.status === 201 || res.status === 202 || (res.status >= 500 && res.status < 600)) {
        if (attempt === maxPolls - 1) break;
        await delay(pollDelayMs(res));
        continue;
      }

      const errText = await res.text();
      try {
        const parsed = JSON.parse(errText) as { error?: ApiError };
        if (parsed.error) throw new YandexDirectError(parsed.error);
      } catch (e) {
        if (e instanceof YandexDirectError) throw e;
      }
      throw new Error(`Report request failed (HTTP ${res.status}): ${errText.slice(0, 500)}`);
    }

    throw new Error(`Report was not ready after ${maxPolls} polls (last HTTP ${lastStatus})`);
  }
}

/** Seconds to wait before re-polling a report, from the retryIn header (capped). */
function pollDelayMs(res: Response): number {
  const retryIn = Number(res.headers.get("retryIn") ?? 5);
  return Math.min(Number.isFinite(retryIn) ? retryIn : 5, 10) * 1000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
