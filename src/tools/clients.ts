import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { withClientLogin } from "../clientLogin.js";
import { currentOperation, throwIfCancelled } from "../operation.js";
import { YandexDirectError } from "../types.js";
import { fail, MAX_TOOL_LIMIT, ok, READ_ONLY } from "./util.js";

/** An agency token's request without Client-Login: "specify the client". */
export const AGENCY_NEEDS_CLIENT_CODE = 8000;

/** AgencyClients.get answers a non-agency token with code 54 (no rights). */
export const NOT_AGENCY_CODE = 54;

/** One client in the list_clients answer. */
export interface ClientEntry {
  login: string;
  name?: string;
  currency?: string;
  archived?: boolean;
  /** "agency" — from AgencyClients.get; "config" — from YANDEX_DIRECT_CLIENTS. */
  source: "agency" | "config";
}

interface AgencyClient {
  Login?: string;
  ClientInfo?: string;
  Currency?: string;
  Archived?: "YES" | "NO";
}

/** The token's clients plus what kind of account the token belongs to. */
export interface ClientList {
  accountType: "agency" | "advertiser";
  clients: ClientEntry[];
  /** True when AgencyClients.get returned a LimitedBy cursor (more than one page). */
  incomplete?: boolean;
}

/**
 * Lists the clients the token can work on. An agency gets AgencyClients.get (sent WITHOUT
 * Client-Login, or the API rejects it) merged with YANDEX_DIRECT_CLIENTS — the API list is
 * not always complete. Any other token gets only YANDEX_DIRECT_CLIENTS: Direct has no method
 * that enumerates the accounts a representative manages.
 */
export async function fetchClients(
  client: YandexDirectClient,
  includeArchived = false,
): Promise<ClientList> {
  const configured: ClientEntry[] = client.configuredClients.map((login) => ({ login, source: "config" }));
  let result: { Clients?: AgencyClient[]; LimitedBy?: number };
  try {
    result = await withClientLogin(null, () =>
      client.call("agencyclients", "get", {
        SelectionCriteria: includeArchived ? {} : { Archived: "NO" },
        FieldNames: ["Login", "ClientInfo", "Currency", "Archived"],
      }),
    );
  } catch (err) {
    if (err instanceof YandexDirectError && err.code === NOT_AGENCY_CODE) {
      return { accountType: "advertiser", clients: configured };
    }
    throw err;
  }
  const clients: ClientEntry[] = [];
  const seen = new Set<string>();
  for (const c of result.Clients ?? []) {
    if (!c.Login) continue;
    seen.add(c.Login.toLowerCase());
    clients.push({
      login: c.Login,
      name: c.ClientInfo,
      currency: c.Currency,
      ...(c.Archived === "YES" ? { archived: true } : {}),
      source: "agency",
    });
  }
  for (const c of configured) if (!seen.has(c.login.toLowerCase())) clients.push(c);
  return {
    accountType: "agency",
    clients,
    ...(typeof result.LimitedBy === "number" ? { incomplete: true } : {}),
  };
}

const ADVERTISER_EMPTY_NOTE =
  "Токен принадлежит обычному аккаунту, а не агентству. API Директа не умеет перечислять " +
  "кабинеты в управлении (где этот логин — представитель), поэтому их список берётся из " +
  "YANDEX_DIRECT_CLIENTS в конфигурации MCP-клиента (логины через запятую). Любой такой логин " +
  "можно и без списка передать в client_login — попросите пользователя назвать логин кабинета.";

/** Clients summarised in parallel: different advertisers, so no shared per-advertiser limit. */
export const OVERVIEW_CONCURRENCY = 4;
/** Default and hard cap on the clients one clients_overview call walks. */
export const OVERVIEW_DEFAULT_CLIENTS = 50;
export const OVERVIEW_MAX_CLIENTS = 200;
/** AccountManagement.Get takes at most 50 logins per request. */
const BALANCE_BATCH = 50;
/** Campaign states that matter for "what is running"; archived campaigns are skipped. */
const LIVE_STATES = ["ON", "SUSPENDED", "OFF", "ENDED"];

/** Campaign counts of one client. */
export interface CampaignCounts {
  total: number;
  /** State=ON: showing or allowed to show. */
  on: number;
  /** State=SUSPENDED: paused by the user. */
  suspended: number;
  /** State=OFF: not showing for another reason (no money, schedule, moderation). */
  off: number;
  ended: number;
  /** Status=MODERATION / REJECTED / DRAFT, across the states above. */
  moderation: number;
  rejected: number;
  draft: number;
}

/** Periods clients_overview can report spend for (Reports DateRangeType). */
export const STATS_PERIODS = ["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH"] as const;
/**
 * Time the spend phase may take. Reports allows one request per ~10 s per token, so the
 * reports go one by one; whoever is left when this runs out is marked, not waited for.
 */
export const STATS_DEADLINE_MS = 300_000;

/** One client's totals for the period, money in account currency, VAT included. */
export interface ClientStats {
  impressions: number;
  clicks: number;
  cost: number;
}

/** One row of clients_overview. */
export interface ClientSummary {
  login: string;
  name?: string;
  currency?: string;
  balance?: { amount: number; currency?: string };
  balanceError?: string;
  campaigns?: CampaignCounts;
  error?: string;
  stats?: ClientStats;
  statsError?: string;
  /** Why no report was requested for this client. */
  statsSkipped?: string;
}

/** Totals from an ACCOUNT_PERFORMANCE_REPORT TSV: a header row and at most one data row. */
export function parseAccountTotals(tsv: string): ClientStats {
  const [header, row] = tsv.split("\n").filter((line) => line.trim() !== "");
  const totals: ClientStats = { impressions: 0, clicks: 0, cost: 0 };
  if (!header || !row) return totals;
  const names = header.split("\t");
  const values = row.split("\t");
  const pick = (name: string) => {
    const n = Number(values[names.indexOf(name)]);
    return Number.isFinite(n) ? n : 0;
  };
  return { impressions: pick("Impressions"), clicks: pick("Clicks"), cost: pick("Cost") };
}

/** One client's totals for `period`, under its own Client-Login. */
async function fetchClientStats(client: YandexDirectClient, login: string, period: string): Promise<ClientStats> {
  const tsv = await withClientLogin(login, () =>
    client.report({
      SelectionCriteria: {},
      FieldNames: ["Impressions", "Clicks", "Cost"],
      ReportName: `mcp-overview-${login}-${period}-${Date.now()}`,
      ReportType: "ACCOUNT_PERFORMANCE_REPORT",
      DateRangeType: period,
      Format: "TSV",
      IncludeVAT: "YES",
      IncludeDiscount: "NO",
    }),
  );
  return parseAccountTotals(tsv);
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Counts campaigns by state and status. */
export function countCampaigns(campaigns: { State?: string; Status?: string }[]): CampaignCounts {
  const counts: CampaignCounts = { total: 0, on: 0, suspended: 0, off: 0, ended: 0, moderation: 0, rejected: 0, draft: 0 };
  for (const c of campaigns) {
    counts.total++;
    if (c.State === "ON") counts.on++;
    else if (c.State === "SUSPENDED") counts.suspended++;
    else if (c.State === "OFF") counts.off++;
    else if (c.State === "ENDED") counts.ended++;
    if (c.Status === "MODERATION") counts.moderation++;
    else if (c.Status === "REJECTED") counts.rejected++;
    else if (c.Status === "DRAFT") counts.draft++;
  }
  return counts;
}

interface V4Accounts {
  Accounts?: { Login?: string; Amount?: string; Currency?: string }[];
  ActionsResult?: { Login?: string; Errors?: { FaultString?: string; FaultDetail?: string }[] }[];
}

/**
 * Shared-account balances for `logins`, 50 per Live v4 request. A login without one (or
 * without access) comes back as an error string — never fails the others.
 */
async function fetchBalances(
  client: YandexDirectClient,
  logins: string[],
): Promise<Map<string, { amount: number; currency?: string } | string>> {
  const out = new Map<string, { amount: number; currency?: string } | string>();
  for (let i = 0; i < logins.length; i += BALANCE_BATCH) {
    const batch = logins.slice(i, i + BALANCE_BATCH);
    try {
      const data = await client.callV4<V4Accounts>("AccountManagement", {
        Action: "Get",
        SelectionCriteria: { Logins: batch },
      });
      for (const a of data.Accounts ?? []) {
        if (a.Login) out.set(a.Login.toLowerCase(), { amount: Number(a.Amount), currency: a.Currency });
      }
      for (const r of data.ActionsResult ?? []) {
        const err = r.Errors?.[0];
        if (r.Login && err) {
          out.set(r.Login.toLowerCase(), [err.FaultString, err.FaultDetail].filter(Boolean).join(": "));
        }
      }
    } catch (err) {
      for (const login of batch) out.set(login.toLowerCase(), message(err));
    }
  }
  return out;
}

/** One client's campaign counts, under its own Client-Login. */
async function summarizeCampaigns(client: YandexDirectClient, login: string): Promise<CampaignCounts> {
  const result = await withClientLogin(login, () =>
    client.getAll<{ Campaigns?: { State?: string; Status?: string }[] }>("campaigns", {
      SelectionCriteria: { States: LIVE_STATES },
      FieldNames: ["Id", "State", "Status"],
    }),
  );
  return countCampaigns(result.Campaigns ?? []);
}

export function registerClientTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "list_clients",
    {
      title: "Клиенты и кабинеты в управлении",
      annotations: READ_ONLY,
      description:
        "Перечисляет рекламодателей, с которыми может работать токен: клиентов агентства (AgencyClients.get) и кабинеты в управлении из YANDEX_DIRECT_CLIENTS. Логин из ответа передаётся в параметр client_login любого инструмента данных — так один сервер работает со всеми клиентами без перезапуска. accountType=agency — токен агентства: без client_login (и без YANDEX_DIRECT_LOGIN) инструменты видят собственный аккаунт агентства, где обычно нет кампаний. accountType=advertiser — обычный аккаунт: API не перечисляет кабинеты, где этот логин представитель, поэтому список есть только если его задали в YANDEX_DIRECT_CLIENTS. Архивные клиенты агентства по умолчанию скрыты. Сводка по всем клиентам сразу (баланс, кампании) — clients_overview.",
      inputSchema: {
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Фильтр по подстроке логина или названия клиента, без учёта регистра."),
        includeArchived: z
          .boolean()
          .optional()
          .describe("Показать и архивных клиентов агентства. По умолчанию — только активных."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_TOOL_LIMIT)
          .optional()
          .describe(`Сколько клиентов вернуть, 1–${MAX_TOOL_LIMIT}. По умолчанию 200.`),
      },
    },
    async ({ search, includeArchived, limit }) => {
      try {
        const list = await fetchClients(client, includeArchived);
        const needle = search?.toLowerCase();
        const matched = needle
          ? list.clients.filter(
              (c) => c.login.toLowerCase().includes(needle) || c.name?.toLowerCase().includes(needle),
            )
          : list.clients;
        const cap = limit ?? 200;
        const shown = matched.slice(0, cap);
        return ok({
          accountType: list.accountType,
          total: matched.length,
          clients: shown,
          ...(matched.length > shown.length || list.incomplete
            ? {
                _truncated: true,
                _truncatedNote: list.incomplete
                  ? "AgencyClients.get вернул не всех клиентов (больше одной страницы) — сузьте поиск через search."
                  : `Показаны первые ${shown.length} из ${matched.length} — сузьте поиск через search или поднимите limit.`,
              }
            : {}),
          ...(list.accountType === "advertiser" && list.clients.length === 0
            ? { note: ADVERTISER_EMPTY_NOTE }
            : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "clients_overview",
    {
      title: "Сводка по клиентам",
      annotations: READ_ONLY,
      description:
        "Сводка по всем клиентам агентства и кабинетам в управлении за один вызов — для вопросов вроде «что у меня по аккаунтам в управлении»: по каждому клиенту баланс общего счёта и число кампаний по состояниям (on — идут или могут идти, suspended — остановлены пользователем, off — не идут по другой причине, ended) и статусам модерации (moderation, rejected, draft). Архивные кампании не считаются. Клиенты — из list_clients, либо явный список logins. Ошибка по одному клиенту (нет доступа, нет общего счёта) не прерывает остальных и попадает в его строку. С параметром stats добавляет показы, клики и расход (с НДС, в валюте клиента) за период — по одному отчёту Reports на клиента, строго по очереди: Яндекс пускает примерно один отчёт в 10 секунд, так что 30 клиентов — около 5 минут; клиенты без неархивных кампаний не запрашиваются, а кто не уложился в 5 минут, помечается statsSkipped. Без stats ответ приходит за секунды — запрашивать расход, только когда вопрос про деньги или трафик. Не вызывать list_campaigns по каждому клиенту в цикле — эта сводка дешевле. Тратит баллы API каждого клиента: один запрос кампаний на клиента и один запрос баланса на 50 клиентов.",
      inputSchema: {
        logins: z
          .array(z.string().trim().min(1))
          .max(OVERVIEW_MAX_CLIENTS)
          .optional()
          .describe("Только эти логины клиентов. По умолчанию — все из list_clients."),
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Только клиенты, у которых логин или название содержит эту подстроку."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(OVERVIEW_MAX_CLIENTS)
          .optional()
          .describe(`Сколько клиентов обойти, 1–${OVERVIEW_MAX_CLIENTS}. По умолчанию ${OVERVIEW_DEFAULT_CLIENTS}.`),
        stats: z
          .enum(STATS_PERIODS)
          .optional()
          .describe("Добавить показы, клики и расход за этот период. Медленно: около 10 с на клиента."),
      },
    },
    async ({ logins, search, limit, stats }) => {
      try {
        let accountType: ClientList["accountType"] | undefined;
        let entries: ClientEntry[];
        if (logins?.length) {
          entries = logins.map((login) => ({ login, source: "config" as const }));
        } else {
          const list = await fetchClients(client);
          accountType = list.accountType;
          entries = list.clients;
        }
        const needle = search?.toLowerCase();
        if (needle) {
          entries = entries.filter(
            (c) => c.login.toLowerCase().includes(needle) || c.name?.toLowerCase().includes(needle),
          );
        }
        if (entries.length === 0) {
          return ok({
            ...(accountType ? { accountType } : {}),
            total: 0,
            clients: [],
            note: accountType === "advertiser" && !needle ? ADVERTISER_EMPTY_NOTE : "Под фильтр не попал ни один клиент.",
          });
        }
        const cap = limit ?? OVERVIEW_DEFAULT_CLIENTS;
        const chosen = entries.slice(0, cap);
        const op = currentOperation();

        const balances = await fetchBalances(client, chosen.map((c) => c.login));
        let done = 0;
        const rows = await mapLimit(chosen, OVERVIEW_CONCURRENCY, async (entry): Promise<ClientSummary> => {
          throwIfCancelled(op);
          const row: ClientSummary = { login: entry.login, name: entry.name, currency: entry.currency };
          const balance = balances.get(entry.login.toLowerCase());
          if (typeof balance === "string") row.balanceError = balance;
          else if (balance) row.balance = balance;
          try {
            row.campaigns = await summarizeCampaigns(client, entry.login);
          } catch (err) {
            row.error = message(err);
          }
          op.progress(`Сводка по клиентам: ${++done}/${chosen.length}`);
          return row;
        });

        if (stats) {
          const deadline = Date.now() + STATS_DEADLINE_MS;
          let reported = 0;
          for (const row of rows) {
            throwIfCancelled(op);
            if (row.error) {
              row.statsSkipped = "нет доступа к кабинету";
            } else if (row.campaigns?.total === 0) {
              row.statsSkipped = "нет неархивных кампаний";
            } else if (Date.now() >= deadline) {
              row.statsSkipped = "не хватило времени — запросите этого клиента отдельно";
            } else {
              try {
                row.stats = await fetchClientStats(client, row.login, stats);
              } catch (err) {
                row.statsError = message(err);
              }
            }
            op.progress(`Расход по клиентам: ${++reported}/${rows.length}`);
          }
        }

        const failed = rows.filter((r) => r.error).length;
        return ok({
          ...(accountType ? { accountType } : {}),
          total: entries.length,
          clients: rows,
          ...(failed ? { failed } : {}),
          ...(stats ? { statsPeriod: stats, statsNote: "Расход с НДС, в валюте каждого клиента — не складывать разные валюты." } : {}),
          ...(entries.length > chosen.length
            ? {
                _truncated: true,
                _truncatedNote: `Обойдены первые ${chosen.length} из ${entries.length} клиентов — сузьте выбор через search/logins или поднимите limit.`,
              }
            : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
