import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AuthRequiredError, NOT_CONNECTED_MESSAGE, TokenStore } from "./auth.js";
import { credentialsPath, readCredentials, writeCredentials } from "./credentials.js";

/**
 * Every test gets its own XDG_CONFIG_HOME, so the suite never reads or writes the
 * developer's real credentials file. Awaits `run` — a synchronous finally would
 * restore the real config dir at the callback's first await, and the rest of the
 * test would then quietly read the developer's own credentials.
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

test("with nothing configured, getToken explains how to connect", async () => {
  await withTempConfig(async () => {
    const store = new TokenStore(undefined);
    assert.equal(store.hasToken(), false);
    await assert.rejects(() => store.getToken(), AuthRequiredError);
    // The message is the user-facing product here — pinned verbatim: it must name
    // BOTH fixes (the in-chat login and the env variable), because it is the only
    // text the model can relay to the user.
    await assert.rejects(() => store.getToken(), (err: Error) => {
      assert.equal(
        err.message,
        "Яндекс Директ не подключён: нет токена доступа. " +
          "Это не сбой сети — повторный вызов не поможет, нужно подключение. " +
          "Вызовите инструмент start_login, покажите пользователю ссылку, попросите войти " +
          "под аккаунтом с доступом к нужному рекламному кабинету и прислать код подтверждения, " +
          "затем передайте этот код в finish_login. " +
          "Альтернатива без диалога — задать переменную окружения YANDEX_DIRECT_TOKEN " +
          "в конфигурации MCP-клиента и перезапустить сервер.",
      );
      assert.equal(err.message, NOT_CONNECTED_MESSAGE);
      return true;
    });
  });
});

test("an env token wins and is never refreshed", async () => {
  await withTempConfig(async () => {
    writeCredentials({ access_token: "stored", refresh_token: "r", obtained_at: Date.now() });
    const store = new TokenStore("from-env");
    assert.equal(await store.getToken(), "from-env");
    assert.equal(store.canRefresh(), false, "an explicitly configured token is not ours to rotate");
    assert.equal(store.status().source, "env");
  });
});

test("a stored token is used when no env token is set", async () => {
  await withTempConfig(async () => {
    writeCredentials({ access_token: "stored", obtained_at: Date.now() });
    const store = new TokenStore(undefined);
    assert.equal(await store.getToken(), "stored");
    assert.equal(store.status().source, "stored");
  });
});

test("the credentials file is owner-only", async () => {
  await withTempConfig(() => {
    const file = writeCredentials({ access_token: "s3cret", obtained_at: Date.now() });
    if (process.platform === "win32") return; // POSIX modes are not meaningful here
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

test("saving leaves no temp files next to credentials.json, even when overwriting", async () => {
  // The write goes through a sibling temp file + rename (atomic replace); a temp
  // file surviving the save would be a second copy of the token on disk.
  await withTempConfig(() => {
    writeCredentials({ access_token: "first", obtained_at: Date.now() });
    const file = writeCredentials({ access_token: "second", obtained_at: Date.now() });
    assert.deepEqual(readdirSync(dirname(file)), ["credentials.json"]);
    assert.equal(readCredentials()?.access_token, "second");
  });
});

test("a truncated credentials file reads as 'not connected', not as an empty token", async () => {
  await withTempConfig(() => {
    writeCredentials({ access_token: "x", obtained_at: Date.now() });
    writeFileSync(credentialsPath(), "{ oops");
    assert.equal(readCredentials(), undefined);
    assert.equal(new TokenStore(undefined).hasToken(), false);
  });
});

test("an expired token is refreshed transparently and the new one is stored", async () => {
  await withTempConfig(async () => {
    writeCredentials({
      access_token: "old",
      refresh_token: "rt",
      expires_at: Date.now() - 1000,
      obtained_at: Date.now() - 100_000,
    });
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: "new", refresh_token: "rt2", expires_in: 3600 }),
      }) as unknown as Response) as unknown as typeof fetch;

    const store = new TokenStore(undefined, fetchImpl);
    assert.equal(await store.getToken(), "new");
    assert.equal(readCredentials()?.access_token, "new");
    assert.equal(readCredentials()?.refresh_token, "rt2", "the rotated refresh token must persist");
  });
});

test("a refresh response without a refresh_token keeps the stored one", async () => {
  // Yandex does not always rotate the refresh token; storing `undefined` over the
  // old one would make the very next expiry unrecoverable without a new login.
  await withTempConfig(async () => {
    writeCredentials({
      access_token: "old",
      refresh_token: "keep-me",
      expires_at: Date.now() - 1000,
      obtained_at: Date.now() - 100_000,
    });
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: "new", expires_in: 3600 }),
      }) as unknown as Response) as unknown as typeof fetch;

    const store = new TokenStore(undefined, fetchImpl);
    assert.equal(await store.getToken(), "new");
    assert.equal(readCredentials()?.refresh_token, "keep-me", "the old refresh token must survive");
  });
});

test("an expired token with nothing to refresh from asks for a new login", async () => {
  await withTempConfig(async () => {
    writeCredentials({ access_token: "old", expires_at: Date.now() - 1000, obtained_at: 1 });
    await assert.rejects(() => new TokenStore(undefined).getToken(), /start_login/);
  });
});

test("logout removes the stored token and reports whether there was one", async () => {
  await withTempConfig(() => {
    const store = new TokenStore(undefined);
    assert.equal(store.logout(), false, "nothing stored yet");
    writeCredentials({ access_token: "s", obtained_at: Date.now() });
    assert.equal(store.logout(), true);
    assert.equal(store.hasToken(), false);
  });
});

test("status never carries the token itself", async () => {
  await withTempConfig(() => {
    writeCredentials({ access_token: "super-secret", refresh_token: "r", obtained_at: Date.now() });
    const status = JSON.stringify(new TokenStore(undefined).status());
    assert.ok(!status.includes("super-secret"), "auth_status output must be safe to print");
    assert.ok(status.includes("credentials.json"), "but it must say where the file lives");
  });
});
