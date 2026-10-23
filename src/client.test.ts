import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YandexDirectClient, methodRateLimit, parseUnits } from "./client.js";
import { OperationCancelledError, runOperation, timing } from "./operation.js";
import { AuthRequiredError, NOT_CONNECTED_MESSAGE, TokenStore } from "./auth.js";
import { writeCredentials } from "./credentials.js";
import {
  DIRECT_RATE_LIMITED_MARKER,
  DIRECT_UNAVAILABLE_MARKER,
  DirectRateLimitError,
  DirectUnavailableError,
  YandexDirectError,
} from "./types.js";

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
      /Live v4 "AccountManagement" вернул HTTP 502/,
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
        /нет поля "result"/.test(err.message) &&
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
    assert.match(result._truncatedNote ?? "", /остались ещё объекты/);
    // LimitedBy is the cursor AFTER the last merged page (page 2 → offset 2), not the stale
    // page-1 value copied from the first page's scalar (which was 1).
    assert.equal(result.LimitedBy, 2);
    assert.match(result._truncatedNote ?? "", /LimitedBy=2/);
  } finally {
    mock.restore();
  }
});

test("getAll stops at the byte cap and keeps a resume cursor", async () => {
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
    }>("campaigns", {}, 100, { maxBytes: 10 });
    // The first page already serializes past 10 bytes → stop before page 2.
    assert.equal(calls, 1);
    assert.equal(result.Campaigns.length, 1);
    assert.equal(result._truncated, true);
    assert.match(result._truncatedNote ?? "", /лимите объёма/);
    assert.equal(result.LimitedBy, 1); // cursor after the merged page, ready to resume
  } finally {
    mock.restore();
  }
});

test("getAll stops at the row cap with more pages remaining", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return new Response(
      JSON.stringify({ result: { Campaigns: [{ Id: calls * 2 - 1 }, { Id: calls * 2 }], LimitedBy: calls * 2 } }),
      { status: 200 },
    );
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    const result = await client.getAll<{
      Campaigns: unknown[];
      _truncated?: boolean;
    }>("campaigns", {}, 100, { maxRows: 2 });
    assert.equal(calls, 1);
    assert.equal(result.Campaigns.length, 2);
    assert.equal(result._truncated, true);
  } finally {
    mock.restore();
  }
});

test("getAll does NOT flag truncation when the dataset completes on the cap boundary", async () => {
  // The final page has no LimitedBy: everything was fetched, so even if the caps are
  // exceeded the result is complete — flagging it truncated would be a false alarm.
  const mock = mockFetch(
    () => new Response(JSON.stringify({ result: { Campaigns: [{ Id: 1 }, { Id: 2 }] } }), { status: 200 }),
  );
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    const result = await client.getAll<{ Campaigns: unknown[]; _truncated?: boolean }>(
      "campaigns",
      {},
      100,
      { maxRows: 1, maxBytes: 1 },
    );
    assert.equal(result.Campaigns.length, 2);
    assert.equal(result._truncated, undefined);
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
    await assert.rejects(() => client.call("campaigns", "get", {}), /превысил таймаут 10 мс/);
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
      /последний HTTP 503/,
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
      await assert.rejects(() => client.call(evil, "get", {}), /чужой origin/);
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

test("call() retries an HTTP 429 even for a write method (request not processed)", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    if (calls === 1) return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });
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

test("call() gives up after maxRetries on a persistent HTTP 429", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return new Response("slow down", { status: 429 });
  });
  try {
    const client = new YandexDirectClient({
      token: "T",
      lang: "ru",
      sandbox: true,
      retryBaseMs: 0,
      maxRetries: 2,
    });
    await assert.rejects(() => client.call("campaigns", "get", {}), /HTTP 429/);
    assert.equal(calls, 3); // initial + 2 retries
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

// --- Missing credentials (degraded start, in-chat login) ---

/**
 * Runs `fn` with XDG_CONFIG_HOME pointed at a fresh temp dir, so a client built
 * without a token resolves against an empty TokenStore — never the developer's
 * real ~/.config/mcp-yandex-direct/credentials.json.
 */
async function withTempConfig<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mcp-direct-client-"));
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
}

/** Asserts the rejection is an AuthRequiredError pinned to the exact product text. */
function isAuthRequiredError(err: unknown): boolean {
  assert.ok(err instanceof AuthRequiredError, "must be an AuthRequiredError");
  assert.equal((err as Error).name, "AuthRequiredError");
  // The message IS the product — it is the only text the model can relay, so a
  // reworded version must not slip through: it has to name both fixes.
  assert.equal((err as Error).message, NOT_CONNECTED_MESSAGE);
  assert.match((err as Error).message, /start_login/, "the in-chat fix must be named");
  assert.match((err as Error).message, /YANDEX_DIRECT_TOKEN/, "and the env fix too");
  return true;
}

test("call() without a token throws AuthRequiredError; fetch is never called", async () => {
  await withTempConfig(async () => {
    const mock = mockFetch(() => new Response("{}", { status: 200 }));
    try {
      // maxRetries is deliberately high: if the auth error were treated as a
      // transport failure this would sit in backoff for seconds before answering.
      const client = new YandexDirectClient({ lang: "ru", sandbox: false, maxRetries: 5, retryBaseMs: 1000 });
      const started = Date.now();
      await assert.rejects(() => client.call("campaigns", "get", {}), isAuthRequiredError);
      assert.ok(Date.now() - started < 500, "the answer must be immediate, not backed off");
      // Not transport trouble: the retry/backoff branch — and fetch itself —
      // must never run for a configuration problem.
      assert.equal(mock.calls.length, 0, "fetch must not be called without credentials");
    } finally {
      mock.restore();
    }
  });
});

test("callV4() without a token throws AuthRequiredError; fetch is never called", async () => {
  await withTempConfig(async () => {
    const mock = mockFetch(() => new Response("{}", { status: 200 }));
    try {
      const client = new YandexDirectClient({ lang: "ru", sandbox: false });
      await assert.rejects(
        () => client.callV4("AccountManagement", { Action: "Get" }),
        isAuthRequiredError,
      );
      assert.equal(mock.calls.length, 0, "fetch must not be called without credentials");
    } finally {
      mock.restore();
    }
  });
});

test("report() without a token throws AuthRequiredError; fetch is never called", async () => {
  await withTempConfig(async () => {
    const mock = mockFetch(() => new Response("{}", { status: 200 }));
    try {
      const client = new YandexDirectClient({ lang: "ru", sandbox: false });
      await assert.rejects(
        () => client.report({ ReportType: "ACCOUNT_PERFORMANCE_REPORT" }),
        isAuthRequiredError,
      );
      assert.equal(mock.calls.length, 0, "fetch must not be called without credentials");
    } finally {
      mock.restore();
    }
  });
});

test("a login mid-session takes effect on the very next call — no new client, no restart", async () => {
  // The property the whole in-chat flow depends on: the token is resolved through
  // the TokenStore per request, never cached on the client instance.
  await withTempConfig(async () => {
    const mock = mockFetch(() => new Response(JSON.stringify({ result: { Campaigns: [] } }), { status: 200 }));
    try {
      const client = new YandexDirectClient({ lang: "ru", sandbox: false });
      await assert.rejects(() => client.call("campaigns", "get", {}), AuthRequiredError);
      assert.equal(mock.calls.length, 0);

      // What finish_login does: write the credentials file. Same process, same client.
      writeCredentials({ access_token: "fresh-token", obtained_at: Date.now() });

      const result = await client.call("campaigns", "get", {});
      assert.deepEqual(result, { Campaigns: [] });
      const headers = mock.calls[0].init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer fresh-token");
    } finally {
      mock.restore();
    }
  });
});

test("call() re-mints a revoked stored token on error 53 and replays once", async () => {
  await withTempConfig(async () => {
    writeCredentials({ access_token: "dead", refresh_token: "rt", obtained_at: Date.now() });
    let calls = 0;
    const mock = mockFetch((url) => {
      calls++;
      if (url.includes("oauth.yandex.ru")) {
        return new Response(JSON.stringify({ access_token: "reborn", refresh_token: "rt2" }), { status: 200 });
      }
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: { error_code: 53, error_string: "Authorization error" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ result: { Campaigns: [] } }), { status: 200 });
    });
    try {
      const client = new YandexDirectClient({ lang: "ru", sandbox: false, retryBaseMs: 0 });
      const result = await client.call("campaigns", "get", {});
      assert.deepEqual(result, { Campaigns: [] });
      // API (53) → oauth refresh → API replay with the fresh token.
      assert.equal(mock.calls.length, 3);
      const replayHeaders = mock.calls[2].init.headers as Record<string, string>;
      assert.equal(replayHeaders.Authorization, "Bearer reborn");
    } finally {
      mock.restore();
    }
  });
});

test("call() does not try to refresh an env token on error 53", async () => {
  await withTempConfig(async () => {
    // An explicitly configured token is not ours to rotate: error 53 must surface.
    const mock = mockFetch(
      () =>
        new Response(
          JSON.stringify({ error: { error_code: 53, error_string: "Authorization error" } }),
          { status: 200 },
        ),
    );
    try {
      const client = new YandexDirectClient({ token: "env-token", lang: "ru", sandbox: false });
      await assert.rejects(() => client.call("campaigns", "get", {}), /\[53\]/);
      assert.equal(mock.calls.length, 1, "no refresh, no replay for an env token");
    } finally {
      mock.restore();
    }
  });
});

test("an injected TokenStore is shared: the client sees what finish_login saved", async () => {
  await withTempConfig(async () => {
    const mock = mockFetch(() => new Response(JSON.stringify({ result: {} }), { status: 200 }));
    try {
      // index.ts wires one TokenStore into both the auth tools and the client.
      const tokens = new TokenStore(undefined);
      const client = new YandexDirectClient({ lang: "ru", sandbox: false }, tokens);
      await assert.rejects(() => client.call("clients", "get", {}), AuthRequiredError);

      tokens.save({ access_token: "saved-by-finish-login" });

      await client.call("clients", "get", {});
      const headers = mock.calls[0].init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer saved-by-finish-login");
    } finally {
      mock.restore();
    }
  });
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

test("call() retries an empty HTTP 204 for a read, then throws DirectUnavailableError", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return new Response(null, { status: 204 });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true, retryBaseMs: 0, maxRetries: 2 });
    await assert.rejects(
      () => client.call("campaigns", "get", {}),
      (err: unknown) =>
        err instanceof DirectUnavailableError &&
        err.message.startsWith(DIRECT_UNAVAILABLE_MARKER) &&
        /"campaigns"/.test(err.message) &&
        /HTTP 204/.test(err.message),
    );
    assert.equal(calls, 3);
  } finally {
    mock.restore();
  }
});

test("call() recovers when an empty HTTP 204 is followed by a result", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    if (calls === 1) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true, retryBaseMs: 0 });
    assert.deepEqual(await client.call("campaigns", "get", {}), { ok: true });
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("call() does NOT retry an empty HTTP 204 for a write method", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return new Response(null, { status: 204 });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true, retryBaseMs: 0 });
    await assert.rejects(() => client.call("campaigns", "add", {}), DirectUnavailableError);
    assert.equal(calls, 1);
  } finally {
    mock.restore();
  }
});

test("callV4() maps an empty HTTP 204 to DirectUnavailableError", async () => {
  const mock = mockFetch(() => new Response(null, { status: 204 }));
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: false, retryBaseMs: 0, maxRetries: 0 });
    await assert.rejects(
      () => client.callV4("AccountManagement", { Action: "Get" }),
      (err: unknown) => err instanceof DirectUnavailableError && /Live v4 "AccountManagement"/.test(err.message),
    );
  } finally {
    mock.restore();
  }
});

test("report() throws DirectUnavailableError on a persistent HTTP 204", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return new Response(null, { status: 204, headers: { retryIn: "0" } });
  });
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    await assert.rejects(
      () => client.report({ ReportType: "ACCOUNT_PERFORMANCE_REPORT" }, { maxPolls: 3 }),
      (err: unknown) => err instanceof DirectUnavailableError && /"reports"/.test(err.message),
    );
    assert.equal(calls, 3);
  } finally {
    mock.restore();
  }
});

const LIMIT_1_PER_10 = "Данный метод можно запрашивать не чаще чем 1 раз в 10 секунд";

function rateError(detail = LIMIT_1_PER_10): Response {
  return new Response(
    JSON.stringify({
      // Reports sends error_code as a string — exactly as the live API does.
      error: { error_code: "56", error_string: "Превышен лимит запросов метода", error_detail: detail, request_id: "R1" },
    }),
    { status: 400 },
  );
}

/** Replaces the real sleep with an instant one that records each requested wait. */
function fakeSleep() {
  const original = timing.sleep;
  const waits: number[] = [];
  timing.sleep = async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new OperationCancelledError();
    waits.push(ms);
  };
  return {
    waits,
    restore() {
      timing.sleep = original;
    },
  };
}

test("methodRateLimit reads the stated limit and falls back to a 10 s window", () => {
  const err = (error_detail: string) => ({ error_code: 56, error_string: "x", error_detail });
  assert.deepEqual(methodRateLimit(err(LIMIT_1_PER_10)), {
    intervalMs: 10_000,
    windowMs: 10_000,
    text: "не чаще 1 раз в 10 с",
  });
  assert.equal(methodRateLimit(err("не чаще чем 5 раз в 10 секунд")).intervalMs, 2_000);
  assert.equal(methodRateLimit(err("не чаще чем 20 раз в 10 секунд")).windowMs, 10_000);
  assert.equal(methodRateLimit(err("no more than 1 time per 10 seconds")).intervalMs, 10_000);
  assert.deepEqual(methodRateLimit(err("не чаще чем 1 раз в 0 секунд")), { intervalMs: 10_000, windowMs: 10_000 });
  assert.deepEqual(methodRateLimit(err("что-то новое")), { intervalMs: 10_000, windowMs: 10_000 });
});

test("report() waits out a code 56 with progress and replays without spending the poll budget", async () => {
  const tsv = "Date\tClicks\n2026-01-01\t1\n";
  let calls = 0;
  const mock = mockFetch(() => (++calls === 1 ? rateError() : new Response(tsv, { status: 200 })));
  const sleep = fakeSleep();
  const notes: string[] = [];
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    const out = await runOperation({ progress: (m: string) => notes.push(m) }, () =>
      client.report({ ReportType: "ACCOUNT_PERFORMANCE_REPORT" }, { maxPolls: 1 }),
    );
    assert.equal(out, tsv);
    assert.equal(calls, 2);
    // A 10 s window plus up to 20% jitter, never less than the window (slept in ≤10 s steps).
    const total = sleep.waits.reduce((a, b) => a + b, 0);
    assert.ok(total >= 10_000 && total <= 12_000);
    assert.ok(sleep.waits.every((ms) => ms <= 10_000));
    assert.match(notes[0], new RegExp(`^${DIRECT_RATE_LIMITED_MARKER} \\(не чаще 1 раз в 10 с\\) — повтор через \\d+ с \\(1/3\\)`));
  } finally {
    sleep.restore();
    mock.restore();
  }
});

test("report() paces polls to the stated limit after a code 56 between offline polls", async () => {
  const tsv = "Date\tClicks\n2026-01-01\t1\n";
  const answers = [
    () => new Response("", { status: 201, headers: { retryIn: "1" } }),
    () => rateError(),
    () => new Response("", { status: 202, headers: { retryIn: "1" } }),
    () => new Response(tsv, { status: 200 }),
  ];
  let calls = 0;
  const mock = mockFetch(() => answers[calls++]());
  const sleep = fakeSleep();
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    const out = await client.report({ ReportType: "ACCOUNT_PERFORMANCE_REPORT" });
    assert.equal(out, tsv);
    assert.equal(calls, answers.length);
    // retryIn before the code 56, the jittered 10 s window for it, then polls no faster than 10 s.
    assert.equal(sleep.waits[0], 1_000);
    assert.equal(sleep.waits[sleep.waits.length - 1], 10_000);
    const window = sleep.waits.slice(1, -1).reduce((a, b) => a + b, 0);
    assert.ok(window >= 10_000 && window <= 12_000);
  } finally {
    sleep.restore();
    mock.restore();
  }
});

test("report() carries a learned code-56 pace to the next report instead of drawing another 56", async () => {
  const tsv = "Impressions\tClicks\tCost\n10\t1\t5\n";
  const answers = [() => rateError(), () => new Response(tsv, { status: 200 }), () => new Response(tsv, { status: 200 })];
  let calls = 0;
  const mock = mockFetch(() => answers[calls++]());
  const sleep = fakeSleep();
  const notes: string[] = [];
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    await client.report({ ReportType: "ACCOUNT_PERFORMANCE_REPORT" });
    const before = sleep.waits.length;
    await runOperation({ progress: (m: string) => notes.push(m) }, () =>
      client.report({ ReportType: "ACCOUNT_PERFORMANCE_REPORT" }),
    );
    // Only three requests: the second report waited up front and was not refused.
    assert.equal(calls, 3);
    const paused = sleep.waits.slice(before).reduce((a, b) => a + b, 0);
    assert.ok(paused > 9_000 && paused <= 10_000, `paused ${paused} ms`);
    assert.match(notes[0], /Пауза перед отчётом/);
  } finally {
    sleep.restore();
    mock.restore();
  }
});

test("report() does not pause before the first report or without a code 56", async () => {
  const mock = mockFetch(() => new Response("Clicks\n1\n", { status: 200 }));
  const sleep = fakeSleep();
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    await client.report({ ReportType: "ACCOUNT_PERFORMANCE_REPORT" });
    await client.report({ ReportType: "ACCOUNT_PERFORMANCE_REPORT" });
    assert.deepEqual(sleep.waits, []);
  } finally {
    sleep.restore();
    mock.restore();
  }
});

test("report() gives up after three code 56 answers with an explanatory error", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return rateError();
  });
  const sleep = fakeSleep();
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    await assert.rejects(
      () => client.report({ ReportType: "ACCOUNT_PERFORMANCE_REPORT" }),
      (err: unknown) =>
        err instanceof DirectRateLimitError &&
        err instanceof YandexDirectError &&
        err.code === 56 &&
        err.message.startsWith(`${DIRECT_RATE_LIMITED_MARKER} (не чаще 1 раз в 10 с)`) &&
        /после 3 повторов/.test(err.message) &&
        /\[56\]/.test(err.message) &&
        /повторите один запрос через минуту/.test(err.message) &&
        /request_id: R1/.test(err.message),
    );
    assert.equal(calls, 4);
  } finally {
    sleep.restore();
    mock.restore();
  }
});

test("call() waits out a code 56 for a write too, without spending maxRetries", async () => {
  let calls = 0;
  const mock = mockFetch(() =>
    ++calls === 1
      ? rateError()
      : new Response(JSON.stringify({ result: { UpdateResults: [] } }), { status: 200 }),
  );
  const sleep = fakeSleep();
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true, maxRetries: 0 });
    const result = await client.call("campaigns", "update", {});
    assert.deepEqual(result, { UpdateResults: [] });
    assert.equal(calls, 2);
  } finally {
    sleep.restore();
    mock.restore();
  }
});

test("a cancelled call stops waiting and never replays the request", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return rateError();
  });
  const controller = new AbortController();
  const original = timing.sleep;
  // The client gives up while the server waits out the code 56.
  timing.sleep = async () => {
    controller.abort();
    throw new OperationCancelledError();
  };
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    await assert.rejects(
      () => runOperation({ signal: controller.signal }, () => client.call("campaigns", "update", {})),
      OperationCancelledError,
    );
    assert.equal(calls, 1);
  } finally {
    timing.sleep = original;
    mock.restore();
  }
});

test("an already cancelled call sends nothing", async () => {
  const mock = mockFetch(() => new Response(JSON.stringify({ result: {} }), { status: 200 }));
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => runOperation({ signal: controller.signal }, () => client.call("campaigns", "get", {})),
      OperationCancelledError,
    );
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("call() stops retrying once the next backoff would overrun the deadline", async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  let calls = 0;
  // Each 5xx answer takes 40 s: the third retry would end past the 90 s deadline.
  const mock = mockFetch(() => {
    calls++;
    clock += 40_000;
    return new Response("err", { status: 503 });
  });
  const sleep = fakeSleep();
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: true, maxRetries: 10, retryBaseMs: 1 });
    await assert.rejects(() => client.call("campaigns", "get", {}), /HTTP 503/);
    assert.equal(calls, 3);
  } finally {
    Date.now = realNow;
    sleep.restore();
    mock.restore();
  }
});
