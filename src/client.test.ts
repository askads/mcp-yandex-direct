import { test } from "node:test";
import assert from "node:assert/strict";
import { YandexDirectClient, parseUnits } from "./client.js";
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

test("callV4() targets Live v4, puts OAuth token in body, returns data", async () => {
  const mock = mockFetch(
    () => new Response(JSON.stringify({ data: { Accounts: [{ Amount: "15" }] } }), { status: 200 }),
  );
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: false });
    const result = await client.callV4("AccountManagement", { Action: "Get", SelectionCriteria: {} });

    assert.deepEqual(result, { Accounts: [{ Amount: "15" }] });
    assert.match(mock.calls[0].url, /api\.direct\.yandex\.ru\/live\/v4\/json/);

    const body = JSON.parse(mock.calls[0].init.body as string);
    assert.equal(body.method, "AccountManagement");
    assert.equal(body.token, "T");
    assert.equal(body.param.Action, "Get");
    // v4 auth is in the body, never the Authorization header.
    const headers = (mock.calls[0].init.headers ?? {}) as Record<string, string>;
    assert.equal(headers.Authorization, undefined);
  } finally {
    mock.restore();
  }
});

test("callV4() throws on a v4 error_code payload", async () => {
  const mock = mockFetch(
    () => new Response(JSON.stringify({ error_code: 53, error_str: "Invalid token" }), { status: 200 }),
  );
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: false });
    await assert.rejects(() => client.callV4("AccountManagement", {}), /\[53\].*Invalid token/);
  } finally {
    mock.restore();
  }
});

test("callV4() targets the sandbox v4 base in sandbox mode", async () => {
  const mock = mockFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }));
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    await client.callV4("AccountManagement", {});
    assert.match(mock.calls[0].url, /api-sandbox\.direct\.yandex\.ru\/live\/v4/);
  } finally {
    mock.restore();
  }
});

test("callV4() retries a 5xx for a Get action then returns data", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    if (calls === 1) return new Response("gateway", { status: 502 });
    return new Response(JSON.stringify({ data: { Accounts: [] } }), { status: 200 });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: false, retryBaseMs: 0 });
    const result = await client.callV4("AccountManagement", { Action: "Get", SelectionCriteria: {} });
    assert.deepEqual(result, { Accounts: [] });
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("callV4() does NOT retry a 5xx for a non-Get action (no duplicate write)", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return new Response("gateway", { status: 502 });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: false, retryBaseMs: 0 });
    await assert.rejects(
      () => client.callV4("AccountManagement", { Action: "Update" }),
      /Live v4 "AccountManagement" failed with HTTP 502/,
    );
    assert.equal(calls, 1);
  } finally {
    mock.restore();
  }
});

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

test("call() surfaces the raw response when there is neither result nor error", async () => {
  // Regression: accountmanagement returned a body with no `result`/`error`; we used to
  // return `undefined` (→ JSON.stringify(undefined) → invalid MCP content). Now we throw
  // a readable error carrying the raw body so the caller sees what the API actually said.
  const mock = mockFetch(() => new Response(JSON.stringify({ foo: "bar" }), { status: 400 }));
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: false });
    await assert.rejects(
      () => client.call("accountmanagement", "get", {}),
      (err: unknown) =>
        err instanceof Error &&
        /no "result" field/.test(err.message) &&
        /foo/.test(err.message),
    );
  } finally {
    mock.restore();
  }
});

test("parseUnits parses the spent/rest/limit header and rejects junk", () => {
  assert.deepEqual(parseUnits("10/4990/5000"), { spent: 10, rest: 4990, limit: 5000 });
  assert.equal(parseUnits(null), undefined);
  assert.equal(parseUnits("nope"), undefined);
});

test("call() captures the Units quota header", async () => {
  const mock = mockFetch(
    () =>
      new Response(JSON.stringify({ result: {} }), {
        status: 200,
        headers: { Units: "3/100/200" },
      }),
  );
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    await client.call("clients", "get", {});
    assert.deepEqual(client.units, { spent: 3, rest: 100, limit: 200 });
  } finally {
    mock.restore();
  }
});

test("getAll merges pages by following LimitedBy and clears it when done", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ result: { Campaigns: [{ Id: 1 }], LimitedBy: 1 } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ result: { Campaigns: [{ Id: 2 }] } }), { status: 200 });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    const result = await client.getAll<{ Campaigns: { Id: number }[]; LimitedBy?: number }>(
      "campaigns",
      { SelectionCriteria: {} },
    );
    assert.deepEqual(result.Campaigns, [{ Id: 1 }, { Id: 2 }]);
    assert.equal(result.LimitedBy, undefined);
    assert.equal(calls, 2);
    const secondBody = JSON.parse(mock.calls[1].init.body as string);
    assert.equal(secondBody.params.Page.Offset, 1);
  } finally {
    mock.restore();
  }
});

test("getAll stops at maxPages and flags the truncation loudly", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return new Response(
      JSON.stringify({ result: { Campaigns: [{ Id: calls }], LimitedBy: calls } }),
      { status: 200 },
    );
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    const result = await client.getAll<{
      Campaigns: unknown[];
      LimitedBy?: number;
      _truncated?: boolean;
      _truncatedNote?: string;
    }>("campaigns", {}, 2);
    assert.equal(calls, 2);
    assert.equal(result.Campaigns.length, 2);
    // Hitting the cap is explicit, not a bare LimitedBy that the model may ignore.
    assert.equal(result._truncated, true);
    assert.match(result._truncatedNote ?? "", /more objects remain/);
    // LimitedBy is the cursor AFTER the last merged page (page 2 → offset 2), not the stale
    // page-1 value copied from the first page's scalar (which was 1).
    assert.equal(result.LimitedBy, 2);
    assert.match(result._truncatedNote ?? "", /LimitedBy=2/);
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
    // maxRetries:0 so the timeout surfaces immediately (a hung read is otherwise retried).
    const client = new YandexDirectClient({
      token: "T",
      lang: "ru",
      sandbox: true,
      timeoutMs: 10,
      maxRetries: 0,
    });
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

test("call() rejects a service path that resolves to a foreign origin and never fetches", async () => {
  // SSRF guard: an absolute/scheme-bearing service, or a backslash/protocol-relative one,
  // resolves to a foreign origin and would rebase the token-bearing request onto another
  // host — reject before fetching. (The backslash form slips past a naive `startsWith("/")`
  // string test, which is why the guard compares the resolved origin.)
  const mock = mockFetch(() => new Response(JSON.stringify({ result: {} }), { status: 200 }));
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    for (const evil of ["https://evil.example/steal", "http://evil.example/x", "\\\\evil.example/x"]) {
      await assert.rejects(() => client.call(evil, "get", {}), /foreign origin/);
    }
    assert.equal(mock.calls.length, 0);
    // A normal relative service still works.
    const result = await client.call("campaigns", "get", {});
    assert.deepEqual(result, {});
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("call() does NOT retry an HTTP 5xx for a write method (no duplicate write)", async () => {
  // A write (add/update/delete/set) may have committed before the gateway error, so a blind
  // retry could duplicate it. Only reads (get/has/check) are retried on 5xx.
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return new Response("bad gateway", { status: 502 });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true, retryBaseMs: 0 });
    await assert.rejects(() => client.call("campaigns", "add", {}), /HTTP 502/);
    assert.equal(calls, 1); // single attempt, no retry
  } finally {
    mock.restore();
  }
});

test("call() retries a rate-limit code even for a write method (request not processed)", async () => {
  // 506/52 mean the request was NOT processed (like 429), so retrying a write is safe.
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ error: { error_code: 506, error_string: "Too many requests" } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ result: { AddResults: [{ Id: 1 }] } }), { status: 200 });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true, retryBaseMs: 0 });
    const result = await client.call("campaigns", "add", {});
    assert.deepEqual(result, { AddResults: [{ Id: 1 }] });
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("call() retries a network error for a read method, then succeeds", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
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

test("call() does NOT retry a network error for a write method", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true, retryBaseMs: 0 });
    await assert.rejects(() => client.call("campaigns", "add", {}), /ECONNRESET/);
    assert.equal(calls, 1);
  } finally {
    mock.restore();
  }
});

test("YandexDirectError appends request_id to the message when present", () => {
  const err = new YandexDirectError({
    error_code: 54,
    error_string: "No units",
    request_id: "abc123",
  });
  assert.match(err.message, /\[54\] No units/);
  assert.match(err.message, /request_id: abc123/);
  assert.equal(err.requestId, "abc123");
});
