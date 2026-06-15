import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { compact, fail, ok } from "./util.js";

const DEFAULT_FIELDS = ["Id", "Name", "CampaignId", "RegionIds", "Status", "Type"];

export function registerAdGroupTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "list_ad_groups",
    {
      title: "List ad groups",
      description:
        "Lists ad groups. Provide campaignIds and/or ids — the Yandex Direct API requires at least one selection criterion.",
      inputSchema: {
        campaignIds: z.array(z.number().int()).optional().describe("Filter by campaign ids."),
        ids: z.array(z.number().int()).optional().describe("Filter by ad group ids."),
        fieldNames: z.array(z.string()).optional().describe("Ad group fields to return."),
        limit: z.number().int().min(1).max(10000).optional().describe("Max number of ad groups."),
      },
    },
    async ({ campaignIds, ids, fieldNames, limit }) => {
      try {
        const selection = compact({
          CampaignIds: campaignIds?.length ? campaignIds : undefined,
          Ids: ids?.length ? ids : undefined,
        });
        const params: Record<string, unknown> = {
          SelectionCriteria: selection,
          FieldNames: fieldNames?.length ? fieldNames : DEFAULT_FIELDS,
        };
        if (limit) params.Page = { Limit: limit };
        const result = await client.call("adgroups", "get", params);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_ad_group",
    {
      title: "Create ad group",
      description: "Creates an ad group inside a campaign with a target geo.",
      inputSchema: {
        name: z.string().min(1).describe("Ad group name."),
        campaignId: z.number().int().describe("Parent campaign id."),
        regionIds: z
          .array(z.number().int())
          .min(1)
          .describe("Target geo region ids, e.g. [225] for Russia."),
      },
    },
    async ({ name, campaignId, regionIds }) => {
      try {
        const adGroup = { Name: name, CampaignId: campaignId, RegionIds: regionIds };
        const result = await client.call("adgroups", "add", { AdGroups: [adGroup] });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
