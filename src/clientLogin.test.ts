import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { YandexDirectClient } from "./client.js";
import { currentClientLogin, instrumentClientLogin, labelResult, withClientLogin } from "./clientLogin.js";

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<Result>;

/** A fake McpServer whose registerTool records what the instrumented wrapper passes on. */
function instrumented() {
  const registered: Record<string, { config: { inputSchema?: Record<string, unknown> }; handler: Handler }> = {};
  const server = {
    registerTool(name: string, config: { inputSchema?: Record<string, unknown> }, handler: Handler) {
      registered[name] = { config, handler };
    },
  };
  instrumentClientLogin(server as never);
  return { server: server as unknown as { registerTool: (...a: unknown[]) => void }, registered };
}

function mockFetch() {
  const original = globalThis.fetch;
  const headers: Record<string, string>[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    headers.push(init.headers as Record<string, string>);
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as typeof fetch;
  return { headers, restore: () => (globalThis.fetch = original) };
}

test("data tools get an optional client_login; account-level tools do not", () => {
  const { server, registered } = instrumented();
  server.registerTool("list_campaigns", { inputSchema: { ids: z.array(z.number()).optional() } }, async () => ({ content: [] }));
  server.registerTool("get_quota", { inputSchema: {} }, async () => ({ content: [] }));
  for (const name of ["auth_status", "start_login", "finish_login", "logout", "list_clients", "clients_overview"]) {
    server.registerTool(name, { inputSchema: {} }, async () => ({ content: [] }));
  }

  assert.ok(registered.list_campaigns.config.inputSchema?.ids, "the tool's own params survive");
  assert.ok(registered.list_campaigns.config.inputSchema?.client_login);
  assert.ok(registered.get_quota.config.inputSchema?.client_login);
  for (const name of ["auth_status", "start_login", "finish_login", "logout", "list_clients", "clients_overview"]) {
    assert.equal(registered[name].config.inputSchema?.client_login, undefined, name);
  }
});

test("client_login scopes the call and is stripped from the tool's own args", async () => {
  const { server, registered } = instrumented();
  let seen: { args?: Record<string, unknown>; login?: string | null } = {};
  server.registerTool("list_campaigns", { inputSchema: {} }, async (args: Record<string, unknown>) => {
    seen = { args, login: currentClientLogin() };
    return { content: [{ type: "text", text: '{"Campaigns":[]}' }] };
  });

  const res = await registered.list_campaigns.handler({ client_login: "client-a", ids: [1] }, {});
  assert.deepEqual(seen.args, { ids: [1] });
  assert.equal(seen.login, "client-a");
  // The answer names the client it came from, ahead of the data.
  assert.equal(res.content[0].text, '{"_client":"client-a","Campaigns":[]}');
  assert.equal(res.content.length, 1);
});

test("without client_login the result is untouched (askads parses it as one JSON)", async () => {
  const { server, registered } = instrumented();
  let login: string | null | undefined = "sentinel";
  server.registerTool("list_campaigns", { inputSchema: {} }, async () => {
    login = currentClientLogin();
    return { content: [{ type: "text", text: '{"Campaigns":[]}' }] };
  });

  const res = await registered.list_campaigns.handler({}, {});
  assert.equal(login, undefined, "no scope: the configured YANDEX_DIRECT_LOGIN applies");
  assert.deepEqual(res.content, [{ type: "text", text: '{"Campaigns":[]}' }]);
});

test("labelResult: TSV and errors get a separate block instead of a rewritten body", () => {
  const tsv = labelResult({ content: [{ type: "text", text: "Date\tCost\n" }] }, "c");
  assert.equal(tsv.content?.[0].text, "Date\tCost\n");
  assert.equal(tsv.content?.[1].text, "Кабинет клиента: c");

  const err = labelResult({ content: [{ type: "text", text: "Ошибка: [8800] нет клиента" }], isError: true }, "c");
  assert.equal(err.isError, true);
  assert.equal(err.content?.[1].text, "Кабинет клиента: c");
});

test("Client-Login header: per-call login wins over YANDEX_DIRECT_LOGIN, null sends none", async () => {
  const mock = mockFetch();
  try {
    const client = new YandexDirectClient({ token: "T", login: "env-client", lang: "ru", sandbox: false });
    await client.call("campaigns", "get", {});
    await withClientLogin("chat-client", () => client.call("campaigns", "get", {}));
    await withClientLogin(null, () => client.call("agencyclients", "get", {}));

    assert.equal(mock.headers[0]["Client-Login"], "env-client");
    assert.equal(mock.headers[1]["Client-Login"], "chat-client");
    assert.equal(mock.headers[2]["Client-Login"], undefined);
  } finally {
    mock.restore();
  }
});

test("concurrent calls for different clients do not mix their Client-Login", async () => {
  const mock = mockFetch();
  try {
    const client = new YandexDirectClient({ token: "T", lang: "ru", sandbox: false });
    await Promise.all(
      ["a", "b", "c"].map((login) => withClientLogin(login, () => client.call("campaigns", "get", { login }))),
    );
    assert.deepEqual(mock.headers.map((h) => h["Client-Login"]).sort(), ["a", "b", "c"]);
  } finally {
    mock.restore();
  }
});
