import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { withClientLogin } from "../clientLogin.js";
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

export function registerClientTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "list_clients",
    {
      title: "Клиенты и кабинеты в управлении",
      annotations: READ_ONLY,
      description:
        "Перечисляет рекламодателей, с которыми может работать токен: клиентов агентства (AgencyClients.get) и кабинеты в управлении из YANDEX_DIRECT_CLIENTS. Логин из ответа передаётся в параметр client_login любого инструмента данных — так один сервер работает со всеми клиентами без перезапуска. accountType=agency — токен агентства: без client_login (и без YANDEX_DIRECT_LOGIN) инструменты видят собственный аккаунт агентства, где обычно нет кампаний. accountType=advertiser — обычный аккаунт: API не перечисляет кабинеты, где этот логин представитель, поэтому список есть только если его задали в YANDEX_DIRECT_CLIENTS. Архивные клиенты агентства по умолчанию скрыты.",
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
}
