import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, compact, fail, ok, okOrPartial } from "./util.js";

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
        limit: z.number().int().min(1).max(10000).optional().describe("Max objects per page."),
        offset: z.number().int().min(0).optional().describe("Pagination offset (objects to skip)."),
        autoPaginate: z
          .boolean()
          .optional()
          .describe("Fetch all pages by following LimitedBy (ignores limit as a total cap)."),
      },
    },
    async ({ campaignIds, ids, fieldNames, limit, offset, autoPaginate }) => {
      try {
        const selection = compact({
          CampaignIds: campaignIds?.length ? campaignIds : undefined,
          Ids: ids?.length ? ids : undefined,
        });
        const params: Record<string, unknown> = {
          SelectionCriteria: selection,
          FieldNames: fieldNames?.length ? fieldNames : DEFAULT_FIELDS,
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = autoPaginate
          ? await client.getAll("adgroups", params)
          : await client.call("adgroups", "get", params);
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
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_ad_group",
    {
      title: "Update ad group",
      description: "Updates an ad group's name and/or target regions (adgroups/update).",
      inputSchema: {
        id: z.number().int().describe("Ad group id to update."),
        name: z.string().min(1).optional().describe("New ad group name."),
        regionIds: z
          .array(z.number().int())
          .min(1)
          .optional()
          .describe("New target geo region ids."),
      },
    },
    async ({ id, name, regionIds }) => {
      try {
        const adGroup = compact({ Id: id, Name: name, RegionIds: regionIds });
        if (Object.keys(adGroup).length === 1) {
          return fail("Provide at least one field to update.");
        }
        const result = await client.call("adgroups", "update", { AdGroups: [adGroup] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
