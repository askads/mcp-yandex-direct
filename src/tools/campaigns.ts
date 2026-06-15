import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { compact, fail, ok, okOrPartial, toMicros } from "./util.js";

const CAMPAIGN_TYPES = [
  "TEXT_CAMPAIGN",
  "MOBILE_APP_CAMPAIGN",
  "DYNAMIC_TEXT_CAMPAIGN",
  "CPM_BANNER_CAMPAIGN",
  "SMART_CAMPAIGN",
  "MCBANNER_CAMPAIGN",
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

export function registerCampaignTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      description: "Lists campaigns in the account with optional filtering by id, type, state and status.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Filter by campaign ids."),
        types: z.array(z.enum(CAMPAIGN_TYPES)).optional().describe("Filter by campaign types."),
        states: z.array(z.enum(CAMPAIGN_STATES)).optional().describe("Filter by campaign states."),
        statuses: z
          .array(z.enum(CAMPAIGN_STATUSES))
          .optional()
          .describe("Filter by moderation statuses."),
        fieldNames: z.array(z.string()).optional().describe("Campaign fields to return."),
        limit: z.number().int().min(1).max(10000).optional().describe("Max number of campaigns."),
      },
    },
    async ({ ids, types, states, statuses, fieldNames, limit }) => {
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
        if (limit) params.Page = { Limit: limit };
        const result = await client.call("campaigns", "get", params);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_text_campaign",
    {
      title: "Create text campaign",
      description:
        "Creates a TextCampaign (search + network). Provide a custom biddingStrategy for production; the default suits the sandbox.",
      inputSchema: {
        name: z.string().min(1).describe("Campaign name."),
        startDate: z.string().describe("Start date, format YYYY-MM-DD."),
        endDate: z.string().optional().describe("End date, format YYYY-MM-DD."),
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
        const campaign = compact({
          Name: name,
          StartDate: startDate,
          EndDate: endDate,
          DailyBudget: dailyBudgetAmount
            ? { Amount: toMicros(dailyBudgetAmount), Mode: dailyBudgetMode ?? "STANDARD" }
            : undefined,
          TextCampaign: {
            BiddingStrategy: biddingStrategy ?? {
              Search: { BiddingStrategyType: "HIGHEST_POSITION" },
              Network: { BiddingStrategyType: "SERVING_OFF" },
            },
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
}
