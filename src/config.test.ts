import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "./config.js";

function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    run();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * A missing token used to throw ConfigError, which killed the process before
 * the MCP handshake and left the user with a silent red cross. It is now a
 * survivable state: the server starts, answers initialize/tools/list, and the
 * client raises CredentialsError at call time (pinned in client.test.ts).
 * Pinned here because reverting it would restore that dead end.
 */
test("a missing token does not throw — the server must start degraded", () => {
  withEnv(
    { YANDEX_DIRECT_TOKEN: undefined, YANDEX_DIRECT_LANG: undefined, YANDEX_DIRECT_SANDBOX: undefined },
    () => {
      const config = loadConfig();
      assert.equal(config.token, undefined);
      // Defaults stay intact for a degraded start.
      assert.equal(config.lang, "ru");
      assert.equal(config.sandbox, false);
    },
  );
});

test("an empty value is treated as absent, not as an empty credential", () => {
  withEnv({ YANDEX_DIRECT_TOKEN: "" }, () => {
    assert.equal(loadConfig().token, undefined);
  });
});

test("the optional variables stay lenient: junk falls back to the default, never throws", () => {
  // These are NOT credentials — an unparsable value must not become a ConfigError
  // (their semantics predate the degraded start and are pinned here).
  withEnv(
    { YANDEX_DIRECT_TOKEN: "t0ken", YANDEX_DIRECT_SANDBOX: "banana", YANDEX_DIRECT_TIMEOUT_MS: "nope" },
    () => {
      const config = loadConfig();
      assert.equal(config.sandbox, false);
      assert.equal(config.timeoutMs, 60_000);
    },
  );
});

test("a configured server loads without throwing", () => {
  withEnv({ YANDEX_DIRECT_TOKEN: "t0ken" }, () => {
    assert.equal(loadConfig().token, "t0ken");
  });
});
