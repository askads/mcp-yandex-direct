import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
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
        'Универсальный запрос: вызывает напрямую любой сервис или метод API Яндекс Директа v5 (например service "bidmodifiers", method "get"). Нужен для сервисов, у которых нет отдельного инструмента. Деньги — в микроединицах (без конвертации). Методы чтения (get/has/check) выполняются свободно; любой другой метод считается записью и требует confirmWrite=true.',
      inputSchema: {
        service: z
          .string()
          .min(1)
          .describe(
            "Путь сервиса строчными буквами, например campaigns, bidmodifiers, sitelinks, vcards, changes, keywordsresearch.",
          ),
        method: z
          .string()
          .min(1)
          .describe("Метод API, например get, add, update, delete, set, toggle, checkCampaigns."),
        params: z.record(z.any()).optional().describe("Объект params для метода — как есть."),
        confirmWrite: z
          .boolean()
          .optional()
          .describe("Должен быть true для запуска метода записи (всё, кроме get/has/check)."),
      },
    },
    async ({ service, method, params, confirmWrite }) => {
      try {
        if (!isReadMethod(method) && confirmWrite !== true) {
          return fail(
            `"${method}" в "${service}" — операция записи. Чтобы выполнить её, повторить вызов с confirmWrite=true.`,
          );
        }
        const result = await client.call(service, method, params ?? {});
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
