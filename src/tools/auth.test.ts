import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TokenStore } from "../auth.js";
import { readCredentials } from "../credentials.js";
import { clearPendingLogin, startLogin } from "../oauth.js";
import { registerAuthTools } from "./auth.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/**
 * Every test gets its own XDG_CONFIG_HOME, so the suite never reads or writes the
 * developer's real credentials file (same pattern as src/auth.test.ts).
 */
async function withTempConfig<T>(run: () => T | Promise<T>): Promise<T> {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mcp-direct-test-"));
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
}

/** Registers the auth tools against a fake server and a client whose `call` is scripted. */
function harness(call: (...args: unknown[]) => Promise<unknown>): Record<string, Handler> {
  const tools: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerAuthTools(server as never, { call } as never, new TokenStore(undefined));
  return tools;
}

test("finish_login: a failed verification call is a caveat, not a failed login", async () => {
  // The token is exchanged and SAVED before the live clients/get check; a network
  // hiccup in the check must not read as "the login failed" — that sends the user
  // to redo a login that worked. Expected: no isError, the text says the token is
  // saved, and no accountLogin is claimed (the check never got the login back).
  await withTempConfig(async () => {
    const savedFetch = globalThis.fetch;
    // The OAuth exchange succeeds (this is the token endpoint, not the Direct API)...
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ access_token: "tok", refresh_token: "rt", expires_in: 3600 }),
      }) as unknown as Response) as unknown as typeof fetch;
    try {
      startLogin();
      // ...and the verification call to the Direct API throws a network error.
      const tools = harness(async () => {
        throw new Error("fetch failed (причина: сеть недоступна)");
      });

      const res = await tools.finish_login({ code: "1234567" });

      assert.notEqual(res.isError, true, "a saved login must not be reported as an error");
      const text = res.content[0].text;
      assert.match(text, /сохранён/);
      assert.match(text, /Проверочный вызов к API не удался/);
      assert.match(text, /сеть недоступна/, "the check's own error must be relayed");
      assert.ok(!text.includes("accountLogin"), "no login was verified, so none may be claimed");
      assert.equal(readCredentials()?.access_token, "tok", "the token really is on disk");
    } finally {
      globalThis.fetch = savedFetch;
      clearPendingLogin();
    }
  });
});
