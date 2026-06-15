import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { compact, fail, ok, okOrPartial } from "./util.js";

const BID_MODIFIER_TYPES = [
  "MOBILE_ADJUSTMENT",
  "DESKTOP_ADJUSTMENT",
  "DEMOGRAPHICS_ADJUSTMENT",
  "RETARGETING_ADJUSTMENT",
  "REGIONAL_ADJUSTMENT",
  "VIDEO_ADJUSTMENT",
  "SMART_TV_ADJUSTMENT",
] as const;

const LEVELS = ["CAMPAIGN", "AD_GROUP"] as const;
const GENDERS = ["GENDER_MALE", "GENDER_FEMALE"] as const;
const AGES = ["AGE_0_17", "AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45", "AGE_45_54", "AGE_55"] as const;
const OS_TYPES = ["IOS", "ANDROID"] as const;

export function registerBidModifierTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "get_bid_modifiers",
    {
      title: "Get bid modifiers",
      description:
        "Reads bid adjustments (mobile, desktop, demographics, retargeting, regional, video) for campaigns or ad groups. BidModifier is a percentage, not money.",
      inputSchema: {
        campaignIds: z.array(z.number().int()).optional().describe("Filter by campaign ids."),
        adGroupIds: z.array(z.number().int()).optional().describe("Filter by ad group ids."),
        ids: z.array(z.number().int()).optional().describe("Filter by bid modifier ids."),
        types: z
          .array(z.enum(BID_MODIFIER_TYPES))
          .optional()
          .describe("Filter by adjustment types."),
        levels: z
          .array(z.enum(LEVELS))
          .optional()
          .describe("Levels to read. Defaults to both CAMPAIGN and AD_GROUP."),
      },
    },
    async ({ campaignIds, adGroupIds, ids, types, levels }) => {
      try {
        if (!campaignIds?.length && !adGroupIds?.length && !ids?.length) {
          return fail("Provide at least one of campaignIds, adGroupIds or ids.");
        }
        const selection = compact({
          CampaignIds: campaignIds?.length ? campaignIds : undefined,
          AdGroupIds: adGroupIds?.length ? adGroupIds : undefined,
          Ids: ids?.length ? ids : undefined,
          Types: types?.length ? types : undefined,
          Levels: levels?.length ? levels : ["CAMPAIGN", "AD_GROUP"],
        });
        const params = {
          SelectionCriteria: selection,
          FieldNames: ["Id", "CampaignId", "AdGroupId", "Level", "Type"],
          MobileAdjustmentFieldNames: ["BidModifier", "OperatingSystemType"],
          DesktopAdjustmentFieldNames: ["BidModifier"],
          DemographicsAdjustmentFieldNames: ["Gender", "Age", "BidModifier", "Enabled"],
          RetargetingAdjustmentFieldNames: ["RetargetingConditionId", "BidModifier", "Enabled"],
          RegionalAdjustmentFieldNames: ["RegionId", "BidModifier", "Enabled"],
        };
        const result = await client.call("bidmodifiers", "get", params);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "add_bid_modifier",
    {
      title: "Add bid modifier",
      description:
        "Adds a bid adjustment to a campaign or ad group. BidModifier values are percentages per the API (e.g. 0–1300), not money.",
      inputSchema: {
        campaignId: z.number().int().optional().describe("Target campaign id (use this OR adGroupId)."),
        adGroupId: z.number().int().optional().describe("Target ad group id (use this OR campaignId)."),
        mobile: z
          .object({
            percent: z.number().int().min(0).describe("Adjustment percent."),
            os: z.enum(OS_TYPES).optional().describe("Limit to IOS or ANDROID."),
          })
          .optional()
          .describe("Mobile bid adjustment."),
        desktop: z
          .object({ percent: z.number().int().min(0) })
          .optional()
          .describe("Desktop bid adjustment."),
        demographics: z
          .array(
            z.object({
              gender: z.enum(GENDERS).optional(),
              age: z.enum(AGES).optional(),
              percent: z.number().int().min(0),
            }),
          )
          .optional()
          .describe("Demographic bid adjustments."),
        retargeting: z
          .array(
            z.object({
              retargetingConditionId: z.number().int(),
              percent: z.number().int().min(0),
            }),
          )
          .optional()
          .describe("Retargeting bid adjustments."),
        regional: z
          .array(z.object({ regionId: z.number().int(), percent: z.number().int().min(0) }))
          .optional()
          .describe("Regional bid adjustments."),
      },
    },
    async ({ campaignId, adGroupId, mobile, desktop, demographics, retargeting, regional }) => {
      try {
        if ((campaignId === undefined) === (adGroupId === undefined)) {
          return fail("Provide exactly one of campaignId or adGroupId.");
        }
        const item = compact({
          CampaignId: campaignId,
          AdGroupId: adGroupId,
          MobileAdjustment: mobile
            ? compact({ BidModifier: mobile.percent, OperatingSystemType: mobile.os })
            : undefined,
          DesktopAdjustment: desktop ? { BidModifier: desktop.percent } : undefined,
          DemographicsAdjustments: demographics?.length
            ? demographics.map((d) => compact({ Gender: d.gender, Age: d.age, BidModifier: d.percent }))
            : undefined,
          RetargetingAdjustments: retargeting?.length
            ? retargeting.map((r) => ({
                RetargetingConditionId: r.retargetingConditionId,
                BidModifier: r.percent,
              }))
            : undefined,
          RegionalAdjustments: regional?.length
            ? regional.map((r) => ({ RegionId: r.regionId, BidModifier: r.percent }))
            : undefined,
        });
        const hasAdjustment = Object.keys(item).some((k) => k !== "CampaignId" && k !== "AdGroupId");
        if (!hasAdjustment) {
          return fail("Provide at least one adjustment (mobile, desktop, demographics, retargeting or regional).");
        }
        const result = await client.call("bidmodifiers", "add", { BidModifiers: [item] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "set_bid_modifiers",
    {
      title: "Set bid modifiers",
      description:
        "Changes the percent of existing bid modifiers and/or enables/disables them (bidmodifiers/set), by modifier id.",
      inputSchema: {
        bids: z
          .array(
            z.object({
              id: z.number().int().describe("Bid modifier id."),
              percent: z.number().int().min(0).optional().describe("New adjustment percent."),
              enabled: z.boolean().optional().describe("Enable or disable the adjustment."),
            }),
          )
          .min(1)
          .describe("Each item needs an id and at least one of percent/enabled."),
      },
    },
    async ({ bids }) => {
      try {
        for (const b of bids) {
          if (b.percent === undefined && b.enabled === undefined) {
            return fail("Each item needs percent and/or enabled.");
          }
        }
        const BidModifiers = bids.map((b) =>
          compact({
            Id: b.id,
            BidModifier: b.percent,
            Enabled: b.enabled === undefined ? undefined : b.enabled ? "YES" : "NO",
          }),
        );
        const result = await client.call("bidmodifiers", "set", { BidModifiers });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_bid_modifiers",
    {
      title: "Delete bid modifiers",
      description: "Deletes bid modifiers by id (bidmodifiers/delete).",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Bid modifier ids to delete."),
      },
    },
    async ({ ids }) => {
      try {
        const result = await client.call("bidmodifiers", "delete", {
          SelectionCriteria: { Ids: ids },
        });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
