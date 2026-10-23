import { test } from "node:test";
import assert from "node:assert/strict";

import { currentClientLogin } from "../clientLogin.js";
import { YandexDirectError } from "../types.js";
import { registerClientTools } from "./clients.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function harness(call: (service: string, method: string, params: any) => Promise<unknown>, configured: string[] = []) {
  const tools: Record<string, Handler> = {};
  const calls: { service: string; params: any; login: string | null | undefined }[] = [];
  const client = {
    configuredClients: configured,
    call: async (service: string, method: string, params: any) => {
      calls.push({ service, params, login: currentClientLogin() });
      return call(service, method, params);
    },
  };
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerClientTools(server as never, client as never);
  return { tools, calls };
}

const AGENCY = {
  Clients: [
    { Login: "shop-msk", ClientInfo: "Магазин Москва", Currency: "RUB", Archived: "NO" },
    { Login: "shop-spb", ClientInfo: "Магазин Питер", Currency: "RUB", Archived: "NO" },
  ],
};

test("list_clients: an agency gets AgencyClients.get sent WITHOUT Client-Login, active only", async () => {
  const { tools, calls } = harness(async () => AGENCY);
  const res = await tools.list_clients({});
  const body = JSON.parse(res.content[0].text);

  assert.equal(calls[0].service, "agencyclients");
  assert.equal(calls[0].login, null, "even a configured YANDEX_DIRECT_LOGIN must not ride along");
  assert.deepEqual(calls[0].params.SelectionCriteria, { Archived: "NO" });
  assert.equal(body.accountType, "agency");
  assert.equal(body.total, 2);
  assert.deepEqual(body.clients[0], { login: "shop-msk", name: "Магазин Москва", currency: "RUB", source: "agency" });
});

test("list_clients: includeArchived drops the Archived filter", async () => {
  const { tools, calls } = harness(async () => AGENCY);
  await tools.list_clients({ includeArchived: true });
  assert.deepEqual(calls[0].params.SelectionCriteria, {});
});

test("list_clients: configured logins the API did not list are added, duplicates are not", async () => {
  const { tools } = harness(async () => AGENCY, ["SHOP-MSK", "extra"]);
  const body = JSON.parse((await tools.list_clients({})).content[0].text);
  assert.deepEqual(
    body.clients.map((c: { login: string; source: string }) => `${c.login}:${c.source}`),
    ["shop-msk:agency", "shop-spb:agency", "extra:config"],
  );
});

test("list_clients: code 54 means a plain account — the configured list, or how to get one", async () => {
  const denied = async () => {
    throw new YandexDirectError({ error_code: 54, error_string: "Нет прав" });
  };
  const withList = JSON.parse((await harness(denied, ["managed-a"]).tools.list_clients({})).content[0].text);
  assert.equal(withList.accountType, "advertiser");
  assert.deepEqual(withList.clients, [{ login: "managed-a", source: "config" }]);
  assert.equal(withList.note, undefined);

  const empty = await harness(denied).tools.list_clients({});
  assert.notEqual(empty.isError, true, "not an agency is an answer, not a failure");
  assert.match(JSON.parse(empty.content[0].text).note, /YANDEX_DIRECT_CLIENTS/);
});

test("list_clients: other API errors surface as errors", async () => {
  const { tools } = harness(async () => {
    throw new YandexDirectError({ error_code: 53, error_string: "Ошибка авторизации" });
  });
  const res = await tools.list_clients({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /\[53\]/);
});

test("list_clients: search filters by login or name, limit caps and flags truncation", async () => {
  const { tools } = harness(async () => AGENCY);
  const byName = JSON.parse((await tools.list_clients({ search: "питер" })).content[0].text);
  assert.deepEqual(byName.clients.map((c: { login: string }) => c.login), ["shop-spb"]);

  const capped = JSON.parse((await tools.list_clients({ limit: 1 })).content[0].text);
  assert.equal(capped.total, 2);
  assert.equal(capped.clients.length, 1);
  assert.equal(capped._truncated, true);
});
