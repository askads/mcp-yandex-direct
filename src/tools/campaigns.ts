import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, compact, fail, isoDate, MAX_TOOL_LIMIT, normalizeMoney, ok, okOrPartial, READ_ONLY, toMicros, WRITE_CREATE, WRITE_DELETE, WRITE_UPDATE } from "./util.js";

// Types accepted by campaigns.get SelectionCriteria.Types. UNIFIED_CAMPAIGN is the
// "Единая перформанс-кампания" (ЕПК) — the type new performance campaigns are created as.
// Yandex is consolidating the legacy types into it, so without UNIFIED_CAMPAIGN a
// type-filtered query silently omits every performance campaign. Legacy types are kept:
// existing (not-yet-migrated) campaigns still report them and remain filterable.
const CAMPAIGN_TYPES = [
  "TEXT_CAMPAIGN",
  "MOBILE_APP_CAMPAIGN",
  "DYNAMIC_TEXT_CAMPAIGN",
  "CPM_BANNER_CAMPAIGN",
  "SMART_CAMPAIGN",
  "MCBANNER_CAMPAIGN",
  "UNIFIED_CAMPAIGN",
] as const;

const CAMPAIGN_STATES = ["ON", "OFF", "SUSPENDED", "ENDED", "CONVERTED", "ARCHIVED"] as const;
const CAMPAIGN_STATUSES = ["ACCEPTED", "DRAFT", "MODERATION", "REJECTED"] as const;

const DEFAULT_FIELDS = [
  "Id",
  "Name",
  "Type",
  "Status",
  "State",
  "StartDate",
  "Currency",
  "DailyBudget",
];

/**
 * Manual search bids with the network disabled. HIGHEST_POSITION is the
 * manual-bid BiddingStrategyType (current in API v5, not a removed legacy
 * value) and SERVING_OFF keeps a new campaign from spending on the network
 * unexpectedly. Pass an explicit biddingStrategy to use an auto-strategy.
 */
const DEFAULT_BIDDING_STRATEGY = {
  Search: { BiddingStrategyType: "HIGHEST_POSITION" },
  Network: { BiddingStrategyType: "SERVING_OFF" },
};

export function registerCampaignTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      annotations: READ_ONLY,
      description:
        "Lists campaigns with optional filtering by id, type, state and status. Monetary fields (DailyBudget.Amount and shared-account Funds — Sum, Balance, SumAvailableForTransfer, Spend) are returned in account currency units.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Filter by campaign ids."),
        types: z.array(z.enum(CAMPAIGN_TYPES)).optional().describe("Filter by campaign types."),
        states: z.array(z.enum(CAMPAIGN_STATES)).optional().describe("Filter by campaign states."),
        statuses: z
          .array(z.enum(CAMPAIGN_STATUSES))
          .optional()
          .describe("Filter by moderation statuses."),
        fieldNames: z.array(z.string()).optional().describe("Campaign fields to return."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Max objects per page."),
        offset: z.number().int().min(0).optional().describe("Pagination offset (objects to skip)."),
        autoPaginate: z
          .boolean()
          .optional()
          .describe("Fetch all pages by following LimitedBy (ignores limit as a total cap)."),
      },
    },
    async ({ ids, types, states, statuses, fieldNames, limit, offset, autoPaginate }) => {
      try {
        const selection = compact({
          Ids: ids?.length ? ids : undefined,
          Types: types?.length ? types : undefined,
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
          ? await client.getAll("campaigns", params)
          : await client.call("campaigns", "get", params);
        return ok(normalizeMoney(result));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_text_campaign",
    {
      title: "Create text campaign",
      annotations: WRITE_CREATE,
      description:
        "Creates a TextCampaign (Text & Image ads). Without biddingStrategy it defaults to manual search bids with the network off (Search HIGHEST_POSITION, Network SERVING_OFF); pass a full biddingStrategy {Search, Network} to use an auto-strategy or enable the network.",
      inputSchema: {
        name: z.string().min(1).describe("Campaign name."),
        startDate: isoDate().describe("Start date, format YYYY-MM-DD."),
        endDate: isoDate().optional().describe("End date, format YYYY-MM-DD."),
        dailyBudgetAmount: z
          .number()
          .positive()
          .optional()
          .describe("Daily budget in account currency units (converted to micros)."),
        dailyBudgetMode: z.enum(["STANDARD", "DISTRIBUTED"]).optional(),
        biddingStrategy: z
          .record(z.any())
          .optional()
          .describe("Full BiddingStrategy object {Search, Network}. Overrides the default."),
      },
    },
    async ({ name, startDate, endDate, dailyBudgetAmount, dailyBudgetMode, biddingStrategy }) => {
      try {
        if (biddingStrategy && (!biddingStrategy.Search || !biddingStrategy.Network)) {
          return fail("biddingStrategy must include both Search and Network strategy objects.");
        }
        const campaign = compact({
          Name: name,
          StartDate: startDate,
          EndDate: endDate,
          DailyBudget: dailyBudgetAmount
            ? { Amount: toMicros(dailyBudgetAmount), Mode: dailyBudgetMode ?? "STANDARD" }
            : undefined,
          TextCampaign: {
            BiddingStrategy: biddingStrategy ?? DEFAULT_BIDDING_STRATEGY,
          },
        });
        const result = await client.call("campaigns", "add", { Campaigns: [campaign] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "campaign_action",
    {
      title: "Campaign action",
      annotations: WRITE_DELETE,
      description:
        "Performs a lifecycle action on campaigns by id: suspend, resume, archive, unarchive or delete.",
      inputSchema: {
        action: z.enum(["suspend", "resume", "archive", "unarchive", "delete"]),
        ids: z.array(z.number().int()).min(1).describe("Campaign ids to act on."),
      },
    },
    async ({ action, ids }) => {
      try {
        const result = await client.call("campaigns", action, {
          SelectionCriteria: { Ids: ids },
        });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_campaign",
    {
      title: "Update campaign",
      annotations: WRITE_UPDATE,
      description: "Updates a campaign's name, end date and/or daily budget (campaigns/update).",
      inputSchema: {
        id: z.number().int().describe("Campaign id to update."),
        name: z.string().min(1).optional().describe("New campaign name."),
        endDate: isoDate().optional().describe("New end date, format YYYY-MM-DD."),
        dailyBudgetAmount: z
          .number()
          .positive()
          .optional()
          .describe("Daily budget in account currency units."),
        dailyBudgetMode: z.enum(["STANDARD", "DISTRIBUTED"]).optional(),
        negativeKeywords: z
          .array(z.string())
          .optional()
          .describe("Replace the campaign's negative keywords; pass an empty array to clear them."),
      },
    },
    async ({ id, name, endDate, dailyBudgetAmount, dailyBudgetMode, negativeKeywords }) => {
      try {
        const campaign = compact({
          Id: id,
          Name: name,
          EndDate: endDate,
          DailyBudget: dailyBudgetAmount
            ? { Amount: toMicros(dailyBudgetAmount), Mode: dailyBudgetMode ?? "STANDARD" }
            : undefined,
          NegativeKeywords: negativeKeywords !== undefined ? { Items: negativeKeywords } : undefined,
        });
        if (Object.keys(campaign).length === 1) {
          return fail("Provide at least one field to update.");
        }
        const result = await client.call("campaigns", "update", { Campaigns: [campaign] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
