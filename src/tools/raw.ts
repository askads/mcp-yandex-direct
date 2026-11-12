import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { API_VERSIONS, V501_DEFAULT_SERVICES, type YandexDirectClient } from "../client.js";
import { fail, isReadMethod, okOrPartial, WRITE_DELETE } from "./util.js";

// isReadMethod now lives in util.ts (shared with the client's retry-idempotency
// check); re-exported here so existing importers/tests keep resolving it.
export { isReadMethod };

export function registerRawTool(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "raw_request",
    {
      title: "Прямой вызов API Яндекс Директа",
      // Escape hatch: can perform any method including deletes, so flag it destructive.
      annotations: WRITE_DELETE,
      description:
        'Универсальный запрос: вызывает напрямую любой сервис или метод API Яндекс Директа (например service "bidmodifiers", method "get"). Нужен для сервисов, у которых нет отдельного инструмента. Деньги — в микроединицах (без конвертации). Методы чтения (get/has/check) выполняются свободно; любой другой метод считается записью и требует confirmWrite=true. ' +
        `Версия API по умолчанию — v5, а для сервисов ${V501_DEFAULT_SERVICES.join(" и ")} — v501: только она называет Единую перформанс-кампанию и её группы настоящими типами (UNIFIED_CAMPAIGN, UNIFIED_AD_GROUP) и фильтрует по ним, v5 выдаёт их за TEXT_CAMPAIGN и TEXT_AD_GROUP. Параметр apiVersion задаёт версию явно для любого сервиса.`,
      inputSchema: {
        service: z
          .string()
          .min(1)
          .describe(
            "Путь сервиса строчными буквами, например campaigns, bidmodifiers, sitelinks, adextensions, changes, keywordsresearch.",
          ),
        method: z
          .string()
          .min(1)
          .describe("Метод API, например get, add, update, delete, set, toggle, checkCampaigns."),
        params: z.record(z.any()).optional().describe("Объект params для метода — как есть."),
        apiVersion: z
          .enum(API_VERSIONS)
          .optional()
          .describe(
            `Версия API для этого запроса. Если не указана — v5, а для ${V501_DEFAULT_SERVICES.join(" и ")} — v501. В песочнице доступна только v5.`,
          ),
        confirmWrite: z
          .boolean()
          .optional()
          .describe("Должен быть true для запуска метода записи (всё, кроме get/has/check)."),
      },
    },
    async ({ service, method, params, apiVersion, confirmWrite }) => {
      try {
        if (!isReadMethod(method) && confirmWrite !== true) {
          return fail(
            `"${method}" в "${service}" — операция записи. Чтобы выполнить её, повторить вызов с confirmWrite=true.`,
          );
        }
        // The version is passed only when the caller named one; otherwise the client's default applies.
        const result = apiVersion
          ? await client.call(service, method, params ?? {}, { apiVersion })
          : await client.call(service, method, params ?? {});
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
