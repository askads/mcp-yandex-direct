import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { fail, ok } from "./util.js";

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
      title: "Get account info",
      description:
        "Returns information about the current advertiser account (login, currency, type, country) using the Yandex Direct `clients` service.",
      inputSchema: {
        fieldNames: z
          .array(z.string())
          .optional()
          .describe("Client fields to return. Defaults to a common set."),
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
}
