import { test } from "node:test";
import assert from "node:assert/strict";
import { YandexDirectClient } from "./client.js";
import { YandexDirectError } from "./types.js";

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const u = String(url);
    const i = (init ?? {}) as RequestInit;
    calls.push({ url: u, init: i });
    return handler(u, i);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("call() targets sandbox, sends bearer token and parses result", async () => {
  const mock = mockFetch(
    () => new Response(JSON.stringify({ result: { Campaigns: [] } }), { status: 200 }),
  );
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    const result = await client.call("campaigns", "get", { FieldNames: ["Id"] });

    assert.deepEqual(result, { Campaigns: [] });
    assert.match(mock.calls[0].url, /api-sandbox\.direct\.yandex\.com/);

    const headers = mock.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer T");
    assert.equal(headers["Accept-Language"], "ru");

    const body = JSON.parse(mock.calls[0].init.body as string);
    assert.equal(body.method, "get");
    assert.deepEqual(body.params.FieldNames, ["Id"]);
  } finally {
    mock.restore();
  }
});

test("call() sends Client-Login only when login is configured", async () => {
  const mock = mockFetch(() => new Response(JSON.stringify({ result: {} }), { status: 200 }));
  try {
    const client = new YandexDirectClient({ token: "T", login: "agency", lang: "en", sandbox: false });
    await client.call("clients", "get", {});

    assert.match(mock.calls[0].url, /api\.direct\.yandex\.com/);
    const headers = mock.calls[0].init.headers as Record<string, string>;
    assert.equal(headers["Client-Login"], "agency");
  } finally {
    mock.restore();
  }
});

test("call() throws YandexDirectError on API error payload", async () => {
  const mock = mockFetch(
    () =>
      new Response(
        JSON.stringify({ error: { error_code: 53, error_string: "Authorization error" } }),
        { status: 200 },
      ),
  );
  try {
    const client = new YandexDirectClient({ token: "bad", lang: "ru", sandbox: false });
    await assert.rejects(
      () => client.call("clients", "get", {}),
      (err: unknown) => err instanceof YandexDirectError && err.code === 53,
    );
  } finally {
    mock.restore();
  }
});

test("report() returns TSV body on HTTP 200", async () => {
  const tsv = "Date\tClicks\n2026-01-01\t10\n";
  const mock = mockFetch(() => new Response(tsv, { status: 200 }));
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    const out = await client.report({ ReportType: "CAMPAIGN_PERFORMANCE_REPORT" });

    assert.equal(out, tsv);
    const headers = mock.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.returnMoneyInMicros, "false");
    assert.equal(headers.processingMode, "auto");
  } finally {
    mock.restore();
  }
});

test("call() retries a 506 rate-limit error then returns the result", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ error: { error_code: 506, error_string: "Too many requests" } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ result: { Campaigns: [] } }), { status: 200 });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true, retryBaseMs: 0 });
    const result = await client.call("campaigns", "get", {});
    assert.deepEqual(result, { Campaigns: [] });
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("call() retries an HTTP 5xx then returns the result", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    if (calls === 1) return new Response("bad gateway", { status: 502 });
    return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true, retryBaseMs: 0 });
    const result = await client.call("campaigns", "get", {});
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("call() does not retry a non-retryable error code", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return new Response(
      JSON.stringify({ error: { error_code: 53, error_string: "Authorization error" } }),
      { status: 200 },
    );
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true, retryBaseMs: 0 });
    await assert.rejects(() => client.call("clients", "get", {}), /\[53\]/);
    assert.equal(calls, 1);
  } finally {
    mock.restore();
  }
});

test("call() gives up after maxRetries on a persistent rate limit", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return new Response(
      JSON.stringify({ error: { error_code: 506, error_string: "Too many requests" } }),
      { status: 200 },
    );
  });
  try {
    const client = new YandexDirectClient({
      token: "T",
      lang: "ru",
      sandbox: true,
      retryBaseMs: 0,
      maxRetries: 2,
    });
    await assert.rejects(() => client.call("campaigns", "get", {}), /\[506\]/);
    assert.equal(calls, 3); // initial + 2 retries
  } finally {
    mock.restore();
  }
});

test("call() aborts and reports a timeout when the request hangs", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init: unknown) =>
    new Promise((_resolve, reject) => {
      const signal = (init as RequestInit).signal as AbortSignal;
      signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    })) as typeof fetch;
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true, timeoutMs: 10 });
    await assert.rejects(() => client.call("campaigns", "get", {}), /timed out after 10ms/);
  } finally {
    globalThis.fetch = original;
  }
});

test("report() retries a transient 5xx and then returns the body", async () => {
  const tsv = "Date\tClicks\n2026-01-01\t1\n";
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    if (calls === 1) {
      return new Response("upstream error", { status: 500, headers: { retryIn: "0" } });
    }
    return new Response(tsv, { status: 200 });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    const out = await client.report({ ReportType: "ACCOUNT_PERFORMANCE_REPORT" });
    assert.equal(out, tsv);
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("report() gives up on a persistent 5xx after maxPolls", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return new Response("err", { status: 503, headers: { retryIn: "0" } });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    await assert.rejects(
      () => client.report({ ReportType: "ACCOUNT_PERFORMANCE_REPORT" }, { maxPolls: 3 }),
      /last HTTP 503/,
    );
    assert.equal(calls, 3);
  } finally {
    mock.restore();
  }
});
