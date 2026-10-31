import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { compact, fail, ok, okOrPartial, READ_ONLY, WRITE_CREATE, WRITE_DELETE, WRITE_UPDATE } from "./util.js";

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
      title: "Корректировки ставок",
      annotations: READ_ONLY,
      description:
        "Читает корректировки ставок (мобильные, десктоп, демография, ретаргетинг, регионы, видео) для кампаний или групп объявлений. BidModifier — это процент, а не деньги.",
      inputSchema: {
        campaignIds: z.array(z.number().int()).optional().describe("Фильтр по id кампаний."),
        adGroupIds: z.array(z.number().int()).optional().describe("Фильтр по id групп объявлений."),
        ids: z.array(z.number().int()).optional().describe("Фильтр по id корректировок."),
        types: z
          .array(z.enum(BID_MODIFIER_TYPES))
          .optional()
          .describe("Фильтр по типам корректировок."),
        levels: z
          .array(z.enum(LEVELS))
          .optional()
          .describe("Уровни, на которых читать. По умолчанию оба: CAMPAIGN и AD_GROUP."),
      },
    },
    async ({ campaignIds, adGroupIds, ids, types, levels }) => {
      try {
        if (!campaignIds?.length && !adGroupIds?.length && !ids?.length) {
          return fail("Нужно указать хотя бы одно из: campaignIds, adGroupIds или ids.");
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
          // VIDEO_ADJUSTMENT is in the type list and promised in the description; without
          // this the video adjustment is silently never returned.
          VideoAdjustmentFieldNames: ["BidModifier"],
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
      title: "Добавить корректировку ставок",
      annotations: WRITE_CREATE,
      description:
        "Добавляет корректировку ставок на кампанию или группу объявлений. Значения BidModifier — проценты по правилам API (например, 0–1300), а не деньги. " +
        "API принимает в одном элементе BidModifiers только один тип корректировки, поэтому каждый переданный тип " +
        "(mobile, desktop, demographics, retargeting, regional) уходит отдельным элементом в одном вызове bidmodifiers/add, " +
        "в этом порядке. Каждая запись AddResults помечена полем Type (MOBILE_ADJUSTMENT, DESKTOP_ADJUSTMENT, " +
        "DEMOGRAPHICS_ADJUSTMENT, RETARGETING_ADJUSTMENT, REGIONAL_ADJUSTMENT): типы создаются независимо, при частичной " +
        "ошибке повторять только типы с Errors. Внутри одного типа (массивы demographics/retargeting/regional) API " +
        "создаёт всё или ничего.",
      inputSchema: {
        campaignId: z.number().int().optional().describe("Id кампании (либо это поле, либо adGroupId)."),
        adGroupId: z.number().int().optional().describe("Id группы объявлений (либо это поле, либо campaignId)."),
        mobile: z
          .object({
            percent: z.number().int().min(0).describe("Процент корректировки."),
            os: z.enum(OS_TYPES).optional().describe("Ограничить IOS или ANDROID."),
          })
          .optional()
          .describe("Корректировка для мобильных."),
        desktop: z
          .object({ percent: z.number().int().min(0) })
          .optional()
          .describe("Корректировка для десктопа."),
        demographics: z
          .array(
            z.object({
              gender: z.enum(GENDERS).optional(),
              age: z.enum(AGES).optional(),
              percent: z.number().int().min(0),
            }),
          )
          .optional()
          .describe("Корректировки по демографии."),
        retargeting: z
          .array(
            z.object({
              retargetingConditionId: z.number().int(),
              percent: z.number().int().min(0),
            }),
          )
          .optional()
          .describe("Корректировки по ретаргетингу."),
        regional: z
          .array(z.object({ regionId: z.number().int(), percent: z.number().int().min(0) }))
          .optional()
          .describe("Корректировки по регионам."),
      },
    },
    async ({ campaignId, adGroupId, mobile, desktop, demographics, retargeting, regional }) => {
      try {
        if ((campaignId === undefined) === (adGroupId === undefined)) {
          return fail("Нужно указать ровно одно: campaignId или adGroupId.");
        }
        const target = compact({ CampaignId: campaignId, AdGroupId: adGroupId });
        const items: { type: string; item: Record<string, unknown> }[] = [];
        if (mobile) {
          items.push({
            type: "MOBILE_ADJUSTMENT",
            item: { ...target, MobileAdjustment: compact({ BidModifier: mobile.percent, OperatingSystemType: mobile.os }) },
          });
        }
        if (desktop) {
          items.push({ type: "DESKTOP_ADJUSTMENT", item: { ...target, DesktopAdjustment: { BidModifier: desktop.percent } } });
        }
        if (demographics?.length) {
          items.push({
            type: "DEMOGRAPHICS_ADJUSTMENT",
            item: {
              ...target,
              DemographicsAdjustments: demographics.map((d) => compact({ Gender: d.gender, Age: d.age, BidModifier: d.percent })),
            },
          });
        }
        if (retargeting?.length) {
          items.push({
            type: "RETARGETING_ADJUSTMENT",
            item: {
              ...target,
              RetargetingAdjustments: retargeting.map((r) => ({
                RetargetingConditionId: r.retargetingConditionId,
                BidModifier: r.percent,
              })),
            },
          });
        }
        if (regional?.length) {
          items.push({
            type: "REGIONAL_ADJUSTMENT",
            item: { ...target, RegionalAdjustments: regional.map((r) => ({ RegionId: r.regionId, BidModifier: r.percent })) },
          });
        }
        if (items.length === 0) {
          return fail("Нужно указать хотя бы одну корректировку: mobile, desktop, demographics, retargeting или regional.");
        }
        const result = await client.call("bidmodifiers", "add", { BidModifiers: items.map((i) => i.item) });
        // AddResults follow the request order; tag each with its type so the model can tell them apart.
        const addResults = (result as { AddResults?: unknown })?.AddResults;
        if (Array.isArray(addResults) && addResults.length === items.length) {
          (result as { AddResults: unknown[] }).AddResults = addResults.map((r, i) => ({ Type: items[i].type, ...(r as object) }));
        }
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "set_bid_modifiers",
    {
      title: "Изменить корректировки ставок",
      annotations: WRITE_UPDATE,
      description:
        "Меняет процент существующих корректировок (bidmodifiers/set) по id корректировки. " +
        "BidModifierSetItem принимает только Id и BidModifier; включить/выключить корректировку через API нельзя " +
        "(метод bidmodifiers/toggle устарел и не поддерживается) — чтобы отключить корректировку, удалить её " +
        "через delete_bid_modifiers.",
      inputSchema: {
        bids: z
          .array(
            z.object({
              id: z.number().int().describe("Id корректировки."),
              percent: z.number().int().min(0).describe("Новый процент корректировки."),
            }),
          )
          .min(1)
          .describe("В каждом элементе нужны id и percent."),
      },
    },
    async ({ bids }) => {
      try {
        const BidModifiers = bids.map((b) => ({ Id: b.id, BidModifier: b.percent }));
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
      title: "Удалить корректировки ставок",
      annotations: WRITE_DELETE,
      description: "Удаляет корректировки ставок по id (bidmodifiers/delete).",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Id корректировок, которые нужно удалить."),
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
