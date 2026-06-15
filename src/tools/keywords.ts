import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, compact, fail, normalizeMoney, ok, okOrPartial, toMicros } from "./util.js";

const DEFAULT_FIELDS = ["Id", "Keyword", "AdGroupId", "CampaignId", "Bid", "ContextBid", "State", "Status"];

export function registerKeywordTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "list_keywords",
    {
      title: "List keywords",
      description:
        "Lists keywords filtered by campaign, ad group or id. Bid and ContextBid are returned in account currency units.",
      inputSchema: {
        campaignIds: z.array(z.number().int()).optional().describe("Filter by campaign ids."),
        adGroupIds: z.array(z.number().int()).optional().describe("Filter by ad group ids."),
        ids: z.array(z.number().int()).optional().describe("Filter by keyword ids."),
        fieldNames: z.array(z.string()).optional().describe("Keyword fields to return."),
        limit: z.number().int().min(1).max(10000).optional().describe("Max objects per page."),
        offset: z.number().int().min(0).optional().describe("Pagination offset (objects to skip)."),
        autoPaginate: z
          .boolean()
          .optional()
          .describe("Fetch all pages by following LimitedBy (ignores limit as a total cap)."),
      },
    },
    async ({ campaignIds, adGroupIds, ids, fieldNames, limit, offset, autoPaginate }) => {
      try {
        const selection = compact({
          CampaignIds: campaignIds?.length ? campaignIds : undefined,
          AdGroupIds: adGroupIds?.length ? adGroupIds : undefined,
          Ids: ids?.length ? ids : undefined,
        });
        const params: Record<string, unknown> = {
          SelectionCriteria: selection,
          FieldNames: fieldNames?.length ? fieldNames : DEFAULT_FIELDS,
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = autoPaginate
          ? await client.getAll("keywords", params)
          : await client.call("keywords", "get", params);
        return ok(normalizeMoney(result));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "add_keywords",
    {
      title: "Add keywords",
      description: "Adds keywords to an ad group, with optional search and network bids.",
      inputSchema: {
        adGroupId: z.number().int().describe("Target ad group id."),
        keywords: z
          .array(
            z.object({
              keyword: z.string().min(1).describe("Keyword phrase, with operators if needed."),
              bid: z.number().positive().optional().describe("Search bid in currency units."),
              contextBid: z.number().positive().optional().describe("Network bid in currency units."),
            }),
          )
          .min(1)
          .describe("Keywords to add."),
      },
    },
    async ({ adGroupId, keywords }) => {
      try {
        const payload = keywords.map((k) =>
          compact({
            AdGroupId: adGroupId,
            Keyword: k.keyword,
            Bid: k.bid !== undefined ? toMicros(k.bid) : undefined,
            ContextBid: k.contextBid !== undefined ? toMicros(k.contextBid) : undefined,
          }),
        );
        const result = await client.call("keywords", "add", { Keywords: payload });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "keyword_action",
    {
      title: "Keyword action",
      description: "Performs a lifecycle action on keywords by id: suspend, resume or delete.",
      inputSchema: {
        action: z.enum(["suspend", "resume", "delete"]),
        ids: z.array(z.number().int()).min(1).describe("Keyword ids to act on."),
      },
    },
    async ({ action, ids }) => {
      try {
        const result = await client.call("keywords", action, { SelectionCriteria: { Ids: ids } });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "set_keyword_bids",
    {
      title: "Set keyword bids",
      description:
        "Sets manual search/network bids on keywords, or on all keywords in given ad groups or campaigns (keywordbids/set). Bids are in account currency units.",
      inputSchema: {
        bids: z
          .array(
            z.object({
              keywordId: z.number().int().optional().describe("Target a single keyword."),
              adGroupId: z.number().int().optional().describe("Target all keywords in an ad group."),
              campaignId: z.number().int().optional().describe("Target all keywords in a campaign."),
              bid: z.number().positive().optional().describe("Search bid in currency units."),
              contextBid: z.number().positive().optional().describe("Network bid in currency units."),
            }),
          )
          .min(1)
          .describe("Each item needs one target id and at least one of bid/contextBid."),
      },
    },
    async ({ bids }) => {
      try {
        for (const b of bids) {
          if (b.keywordId === undefined && b.adGroupId === undefined && b.campaignId === undefined) {
            return fail("Each bid item requires keywordId, adGroupId or campaignId.");
          }
          if (b.bid === undefined && b.contextBid === undefined) {
            return fail("Each bid item requires bid and/or contextBid.");
          }
        }
        const KeywordBids = bids.map((b) =>
          compact({
            KeywordId: b.keywordId,
            AdGroupId: b.adGroupId,
            CampaignId: b.campaignId,
            Bid: b.bid !== undefined ? toMicros(b.bid) : undefined,
            ContextBid: b.contextBid !== undefined ? toMicros(b.contextBid) : undefined,
          }),
        );
        const result = await client.call("keywordbids", "set", { KeywordBids });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
