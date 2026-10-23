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

/** A client mock for clients_overview: AgencyClients list, per-login campaigns, v4 balances. */
function overviewHarness(opts: {
  agency?: unknown;
  campaigns?: Record<string, { State: string; Status: string }[] | Error>;
  balances?: unknown;
  configured?: string[];
}) {
  const tools: Record<string, Handler> = {};
  const seen = { campaignLogins: [] as (string | null | undefined)[], v4: [] as any[], inFlight: 0, maxInFlight: 0 };
  const client = {
    configuredClients: opts.configured ?? [],
    call: async () => {
      if (opts.agency instanceof Error) throw opts.agency;
      return opts.agency ?? AGENCY;
    },
    getAll: async (service: string) => {
      assert.equal(service, "campaigns");
      const login = currentClientLogin();
      seen.campaignLogins.push(login);
      seen.inFlight++;
      seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      seen.inFlight--;
      const result = opts.campaigns?.[String(login)] ?? [];
      if (result instanceof Error) throw result;
      return { Campaigns: result };
    },
    callV4: async (_method: string, param: any) => {
      seen.v4.push(param);
      if (opts.balances instanceof Error) throw opts.balances;
      return opts.balances ?? { Accounts: [] };
    },
  };
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerClientTools(server as never, client as never);
  return { tools, seen };
}

test("clients_overview: counts campaigns per client under that client's Client-Login, with balances", async () => {
  const { tools, seen } = overviewHarness({
    campaigns: {
      "shop-msk": [
        { State: "ON", Status: "ACCEPTED" },
        { State: "SUSPENDED", Status: "ACCEPTED" },
        { State: "OFF", Status: "REJECTED" },
      ],
      "shop-spb": [{ State: "ON", Status: "MODERATION" }],
    },
    balances: {
      Accounts: [{ Login: "shop-msk", Amount: "1500.50", Currency: "RUB" }],
      ActionsResult: [{ Login: "shop-spb", Errors: [{ FaultString: "Общий счёт не подключён" }] }],
    },
  });
  const body = JSON.parse((await tools.clients_overview({})).content[0].text);

  assert.equal(body.accountType, "agency");
  assert.deepEqual(seen.campaignLogins, ["shop-msk", "shop-spb"]);
  assert.deepEqual(seen.v4[0].SelectionCriteria, { Logins: ["shop-msk", "shop-spb"] });
  const [msk, spb] = body.clients;
  assert.deepEqual(msk.balance, { amount: 1500.5, currency: "RUB" });
  assert.deepEqual(msk.campaigns, { total: 3, on: 1, suspended: 1, off: 1, ended: 0, moderation: 0, rejected: 1, draft: 0 });
  assert.equal(spb.balanceError, "Общий счёт не подключён");
  assert.equal(spb.campaigns.moderation, 1);
  assert.equal(body.failed, undefined);
});

test("clients_overview: one client's failure stays in its row, the rest are summarised", async () => {
  const { tools } = overviewHarness({
    campaigns: { "shop-msk": new Error("[8800] Клиент не найден"), "shop-spb": [{ State: "ON", Status: "ACCEPTED" }] },
    balances: new Error("Live v4 недоступен"),
  });
  const res = await tools.clients_overview({});
  assert.notEqual(res.isError, true);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.failed, 1);
  assert.match(body.clients[0].error, /8800/);
  assert.equal(body.clients[1].campaigns.on, 1);
  assert.equal(body.clients[1].balanceError, "Live v4 недоступен");
});

test("clients_overview: explicit logins skip AgencyClients; limit caps and flags truncation", async () => {
  const { tools, seen } = overviewHarness({ agency: new Error("must not be called") });
  const body = JSON.parse((await tools.clients_overview({ logins: ["a", "b", "c"], limit: 2 })).content[0].text);
  assert.deepEqual(seen.campaignLogins, ["a", "b"]);
  assert.equal(body.total, 3);
  assert.equal(body._truncated, true);
});

test("clients_overview: balances go 50 logins per v4 request; at most 4 clients in flight", async () => {
  const logins = Array.from({ length: 120 }, (_, i) => `c${i}`);
  const { tools, seen } = overviewHarness({});
  await tools.clients_overview({ logins, limit: 120 });
  assert.deepEqual(seen.v4.map((p) => p.SelectionCriteria.Logins.length), [50, 50, 20]);
  assert.equal(seen.maxInFlight, 4);
});

test("clients_overview: a plain account without YANDEX_DIRECT_CLIENTS explains how to set it", async () => {
  const { tools } = overviewHarness({ agency: new YandexDirectError({ error_code: 54, error_string: "Нет прав" }) });
  const body = JSON.parse((await tools.clients_overview({})).content[0].text);
  assert.equal(body.accountType, "advertiser");
  assert.equal(body.total, 0);
  assert.match(body.note, /YANDEX_DIRECT_CLIENTS/);
});
