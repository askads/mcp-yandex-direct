import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, compact, fail, ok, okOrPartial } from "./util.js";

const AD_STATES = ["ON", "OFF", "SUSPENDED", "OFF_BY_MONITORING", "ARCHIVED"] as const;
const AD_STATUSES = ["ACCEPTED", "DRAFT", "MODERATION", "PREACCEPTED", "REJECTED"] as const;

const DEFAULT_FIELDS = ["Id", "AdGroupId", "CampaignId", "Status", "State", "Type"];

export function registerAdTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "list_ads",
    {
      title: "List ads",
      description: "Lists ads with optional filtering by campaign, ad group, id, state and status.",
      inputSchema: {
        campaignIds: z.array(z.number().int()).optional().describe("Filter by campaign ids."),
        adGroupIds: z.array(z.number().int()).optional().describe("Filter by ad group ids."),
        ids: z.array(z.number().int()).optional().describe("Filter by ad ids."),
        states: z.array(z.enum(AD_STATES)).optional().describe("Filter by ad states."),
        statuses: z.array(z.enum(AD_STATUSES)).optional().describe("Filter by moderation statuses."),
        fieldNames: z.array(z.string()).optional().describe("Ad fields to return."),
        limit: z.number().int().min(1).max(10000).optional().describe("Max objects per page."),
        offset: z.number().int().min(0).optional().describe("Pagination offset (objects to skip)."),
        autoPaginate: z
          .boolean()
          .optional()
          .describe("Fetch all pages by following LimitedBy (ignores limit as a total cap)."),
      },
    },
    async ({ campaignIds, adGroupIds, ids, states, statuses, fieldNames, limit, offset, autoPaginate }) => {
      try {
        const selection = compact({
          CampaignIds: campaignIds?.length ? campaignIds : undefined,
          AdGroupIds: adGroupIds?.length ? adGroupIds : undefined,
          Ids: ids?.length ? ids : undefined,
          States: states?.length ? states : undefined,
          Statuses: statuses?.length ? statuses : undefined,
        });
        const params: Record<string, unknown> = {
          SelectionCriteria: selection,
          FieldNames: fieldNames?.length ? fieldNames : DEFAULT_FIELDS,
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = autoPaginate
          ? await client.getAll("ads", params)
          : await client.call("ads", "get", params);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_text_ad",
    {
      title: "Create text ad",
      description: "Creates a text ad (TextAd) inside an ad group. New ads start as drafts.",
      inputSchema: {
        adGroupId: z.number().int().describe("Parent ad group id."),
        title: z.string().min(1).describe("Title (Title 1), up to 56 characters."),
        title2: z.string().optional().describe("Second title (Title 2), up to 30 characters."),
        text: z.string().min(1).describe("Ad body text, up to 81 characters."),
        href: z.string().optional().describe("Landing page URL."),
        mobile: z.boolean().optional().describe("Whether this is a mobile ad."),
      },
    },
    async ({ adGroupId, title, title2, text, href, mobile }) => {
      try {
        const textAd = compact({
          Title: title,
          Title2: title2,
          Text: text,
          Href: href,
          Mobile: mobile === undefined ? undefined : mobile ? "YES" : "NO",
        });
        const ad = { AdGroupId: adGroupId, TextAd: textAd };
        const result = await client.call("ads", "add", { Ads: [ad] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "ad_action",
    {
      title: "Ad action",
      description:
        "Performs a lifecycle action on ads by id: moderate, suspend, resume, archive, unarchive or delete.",
      inputSchema: {
        action: z.enum(["moderate", "suspend", "resume", "archive", "unarchive", "delete"]),
        ids: z.array(z.number().int()).min(1).describe("Ad ids to act on."),
      },
    },
    async ({ action, ids }) => {
      try {
        const result = await client.call("ads", action, { SelectionCriteria: { Ids: ids } });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_text_ad",
    {
      title: "Update text ad",
      description:
        "Updates a text ad's title, text or landing page (ads/update). Editing an active ad sends it back to moderation.",
      inputSchema: {
        id: z.number().int().describe("Ad id to update."),
        title: z.string().optional().describe("New Title (Title 1), up to 56 characters."),
        title2: z.string().optional().describe("New second title (Title 2), up to 30 characters."),
        text: z.string().optional().describe("New body text, up to 81 characters."),
        href: z.string().optional().describe("New landing page URL."),
      },
    },
    async ({ id, title, title2, text, href }) => {
      try {
        const textAd = compact({ Title: title, Title2: title2, Text: text, Href: href });
        if (Object.keys(textAd).length === 0) {
          return fail("Provide at least one field to update.");
        }
        const result = await client.call("ads", "update", { Ads: [{ Id: id, TextAd: textAd }] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
