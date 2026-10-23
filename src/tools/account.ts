import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { currentClientLogin } from "../clientLogin.js";
import { fail, ok, READ_ONLY } from "./util.js";

const DEFAULT_FIELDS = [
  "Login",
  "ClientId",
  "ClientInfo",
  "Currency",
  "Type",
  "CountryId",
  "AccountQuality",
];

export function registerAccountTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "get_account_info",
    {
      title: "Данные аккаунта",
      annotations: READ_ONLY,
      description:
        "Возвращает данные текущего аккаунта рекламодателя (логин, валюта, тип, страна) через сервис `clients` Яндекс Директа.",
      inputSchema: {
        fieldNames: z
          .array(z.string())
          .optional()
          .describe("Какие поля клиента вернуть. По умолчанию — типовой набор."),
      },
    },
    async ({ fieldNames }) => {
      try {
        const result = await client.call("clients", "get", {
          FieldNames: fieldNames?.length ? fieldNames : DEFAULT_FIELDS,
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_balance",
    {
      title: "Баланс аккаунта",
      annotations: READ_ONLY,
      description:
        "Возвращает баланс общего счёта и финансовые поля (Amount, AmountAvailableForTransfer, Currency, Discount, AccountID) через устаревший сервис AccountManagement Live v4 — единственный API Яндекс Директа, который отдаёт баланс (в v5 финансового метода нет). Amount — строка в ВАЛЮТЕ АККАУНТА (не в микроединицах); отрицательный Amount означает задолженность. По умолчанию — собственный аккаунт токена, а при переданном client_login — счёт этого клиента; чтобы получить несколько общих счетов разом (агентство, до 50 логинов), передать logins.",
      inputSchema: {
        logins: z
          .array(z.string())
          .optional()
          .describe("Логины аккаунтов, по которым нужны данные. По умолчанию — собственный аккаунт токена."),
      },
    },
    async ({ logins }) => {
      try {
        // Live v4 has no Client-Login header: a client chosen for this call becomes the
        // selection instead. YANDEX_DIRECT_LOGIN deliberately does not — that default has
        // always meant the token's own account here.
        const scoped = currentClientLogin();
        const selected = logins?.length ? logins : scoped ? [scoped] : undefined;
        // Money in Live v4 is already in currency units — do NOT normalizeMoney it.
        const result = await client.callV4("AccountManagement", {
          Action: "Get",
          SelectionCriteria: selected ? { Logins: selected } : {},
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_quota",
    {
      title: "Квота API",
      annotations: READ_ONLY,
      description:
        "Возвращает сегодняшнюю квоту баллов API (потрачено / осталось / лимит) из заголовка Units — чтобы не упереться в дневной лимит.",
      inputSchema: {},
    },
    async () => {
      try {
        await client.call("clients", "get", { FieldNames: ["Login"] });
        const units = client.units;
        return ok(units ?? "API не вернул квоту Units.");
      } catch (e) {
        return fail(e);
      }
    },
  );
}
