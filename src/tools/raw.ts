import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { fail, okOrPartial } from "./util.js";

/** Methods that only read data and never mutate the account. */
export function isReadMethod(method: string): boolean {
  return /^(get|has|check)/i.test(method);
}

export function registerRawTool(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "raw_request",
    {
      title: "Raw Yandex Direct API call",
      description:
        'Escape hatch to call any Yandex Direct API v5 service/method directly (e.g. service "bidmodifiers", method "get"). Use this for services that have no dedicated tool. Money is in micros (no conversion). Read methods (get/has/check) run freely; any other method is a write and requires confirmWrite=true.',
      inputSchema: {
        service: z
          .string()
          .min(1)
          .describe(
            "Lowercase service path, e.g. campaigns, bidmodifiers, sitelinks, vcards, changes, keywordsresearch.",
          ),
        method: z
          .string()
          .min(1)
          .describe("API method, e.g. get, add, update, delete, set, toggle, checkCampaigns."),
        params: z.record(z.any()).optional().describe("Raw params object for the method."),
        confirmWrite: z
          .boolean()
          .optional()
          .describe("Must be true to run a write method (anything other than get/has/check)."),
      },
    },
    async ({ service, method, params, confirmWrite }) => {
      try {
        if (!isReadMethod(method) && confirmWrite !== true) {
          return fail(
            `"${method}" on "${service}" is a write operation. Re-run with confirmWrite=true to proceed.`,
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
