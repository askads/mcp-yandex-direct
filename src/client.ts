import type { ApiError, YandexDirectConfig } from "./types.js";
import { YandexDirectError } from "./types.js";

const PROD_BASE = "https://api.direct.yandex.com/json/v5/";
const SANDBOX_BASE = "https://api-sandbox.direct.yandex.com/json/v5/";

export interface ReportOptions {
  processingMode?: "auto" | "online" | "offline";
  returnMoneyInMicros?: boolean;
  maxPolls?: number;
}

export class YandexDirectClient {
  private readonly base: string;

  constructor(private readonly config: YandexDirectConfig) {
    this.base = config.sandbox ? SANDBOX_BASE : PROD_BASE;
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
    const res = await fetch(this.base + service, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ method, params }),
    });

    const text = await res.text();
    let data: { result?: T; error?: ApiError };
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `Invalid JSON response from "${service}" (HTTP ${res.status}): ${text.slice(0, 500)}`,
      );
    }

    if (data.error) throw new YandexDirectError(data.error);
    return data.result as T;
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

    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ params }),
      });

      if (res.status === 200) return res.text();

      if (res.status === 201 || res.status === 202) {
        const retryIn = Number(res.headers.get("retryIn") ?? 5);
        const waitMs = Math.min(Number.isFinite(retryIn) ? retryIn : 5, 10) * 1000;
        await delay(waitMs);
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

    throw new Error(`Report was not ready after ${maxPolls} polls`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
