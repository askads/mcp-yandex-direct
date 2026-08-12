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
      title: "Список кампаний",
      annotations: READ_ONLY,
      description:
        "Возвращает список кампаний с необязательными фильтрами по id, типу, состоянию и статусу. Денежные поля (DailyBudget.Amount и Funds общего счёта — Sum, Balance, SumAvailableForTransfer, Spend) отдаются в валюте аккаунта.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Фильтр по id кампаний."),
        types: z.array(z.enum(CAMPAIGN_TYPES)).optional().describe("Фильтр по типам кампаний."),
        states: z.array(z.enum(CAMPAIGN_STATES)).optional().describe("Фильтр по состояниям кампаний."),
        statuses: z
          .array(z.enum(CAMPAIGN_STATUSES))
          .optional()
          .describe("Фильтр по статусам модерации."),
        fieldNames: z.array(z.string()).optional().describe("Какие поля кампании вернуть."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Максимум объектов на страницу."),
        offset: z.number().int().min(0).optional().describe("Смещение постраничной выдачи (сколько объектов пропустить)."),
        autoPaginate: z
          .boolean()
          .optional()
          .describe("Забрать все страницы, идя по LimitedBy (limit тогда не ограничивает общий объём)."),
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
      title: "Создать текстовую кампанию",
      annotations: WRITE_CREATE,
      description:
        "Создаёт кампанию TextCampaign (текстово-графические объявления). Без biddingStrategy применяются ручные ставки на поиске с отключёнными сетями (Search HIGHEST_POSITION, Network SERVING_OFF); чтобы включить автостратегию или сети, передать biddingStrategy целиком — {Search, Network}.",
      inputSchema: {
        name: z.string().min(1).describe("Название кампании."),
        startDate: isoDate().describe("Дата начала в формате YYYY-MM-DD."),
        endDate: isoDate().optional().describe("Дата окончания в формате YYYY-MM-DD."),
        dailyBudgetAmount: z
          .number()
          .positive()
          .optional()
          .describe("Дневной бюджет в валюте аккаунта (конвертируется в микроединицы)."),
        dailyBudgetMode: z.enum(["STANDARD", "DISTRIBUTED"]).optional(),
        biddingStrategy: z
          .record(z.any())
          .optional()
          .describe("Полный объект BiddingStrategy {Search, Network}. Заменяет значение по умолчанию."),
      },
    },
    async ({ name, startDate, endDate, dailyBudgetAmount, dailyBudgetMode, biddingStrategy }) => {
      try {
        if (biddingStrategy && (!biddingStrategy.Search || !biddingStrategy.Network)) {
          return fail("biddingStrategy должен содержать оба объекта стратегии: Search и Network.");
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
      title: "Действие с кампаниями",
      annotations: WRITE_DELETE,
      description:
        "Выполняет действие над кампаниями по id: suspend, resume, archive, unarchive или delete.",
      inputSchema: {
        action: z.enum(["suspend", "resume", "archive", "unarchive", "delete"]),
        ids: z.array(z.number().int()).min(1).describe("Id кампаний, к которым применить действие."),
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
      title: "Обновить кампанию",
      annotations: WRITE_UPDATE,
      description: "Обновляет название, дату окончания и/или дневной бюджет кампании (campaigns/update).",
      inputSchema: {
        id: z.number().int().describe("Id кампании, которую нужно обновить."),
        name: z.string().min(1).optional().describe("Новое название кампании."),
        endDate: isoDate().optional().describe("Новая дата окончания в формате YYYY-MM-DD."),
        dailyBudgetAmount: z
          .number()
          .positive()
          .optional()
          .describe("Дневной бюджет в валюте аккаунта."),
        dailyBudgetMode: z.enum(["STANDARD", "DISTRIBUTED"]).optional(),
        negativeKeywords: z
          .array(z.string())
          .optional()
          .describe("Заменяет минус-фразы кампании; пустой массив очищает их."),
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
          return fail("Нужно указать хотя бы одно поле для обновления.");
        }
        const result = await client.call("campaigns", "update", { Campaigns: [campaign] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
