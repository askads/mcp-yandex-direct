import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, compact, fail, isoDate, MAX_TOOL_LIMIT, normalizeMoney, ok, okOrPartial, READ_ONLY, stringList, toMicros, WRITE_CREATE, WRITE_DELETE, WRITE_UPDATE } from "./util.js";
import { normalizeStrategyMoney, STRATEGY_READ_FIELDS, strategyToMicros } from "./strategy.js";

// Types accepted by campaigns.get SelectionCriteria.Types. UNIFIED_CAMPAIGN is the
// "Единая перформанс-кампания" (ЕПК) — the type new performance campaigns are created as.
// Yandex is consolidating the legacy types into it, so without UNIFIED_CAMPAIGN a
// type-filtered query silently omits every performance campaign. Only v501 reports the type
// (client.ts routes campaigns there; v5 calls an ЕПК TEXT_CAMPAIGN). Legacy types are kept:
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

// campaigns.get FieldNames as v501 lists them (checked live 2026-10-30). Type-specific
// settings (strategy, TextCampaign.*, UnifiedCampaign.*) are separate *FieldNames params,
// not values here — an enum keeps the model from sending them and drawing code 8000.
// DailyBudget is gone: Yandex retires it on 2026-11-30 (manual-bid campaigns moved to the
// weekly budget, HighestPosition.WeeklySpendLimit inside BiddingStrategy).
const CAMPAIGN_FIELDS = [
  "BlockedIps", "ExcludedSites", "Currency", "Notification", "EndDate", "Funds",
  "ClientInfo", "Id", "Name", "NegativeKeywords", "RepresentedBy", "StartDate", "CreateTime",
  "Statistics", "State", "Status", "StatusPayment", "StatusClarification", "SourceId",
  "TimeTargeting", "TimeZone", "Type",
] as const;

const DEFAULT_FIELDS = [
  "Id",
  "Name",
  "Type",
  "Status",
  "State",
  "StartDate",
  "Currency",
];

/**
 * Manual search bids with the network disabled. HIGHEST_POSITION is the
 * manual-bid BiddingStrategyType (current in API v5, not a removed legacy
 * value) and SERVING_OFF keeps a new campaign from spending on the network
 * unexpectedly. The weekly budget of manual bids lives inside the strategy
 * (HighestPosition.WeeklySpendLimit, micros). Pass an explicit biddingStrategy
 * to use an auto-strategy.
 */
/**
 * The retired DailyBudget parameters stay in the schema on purpose: the MCP SDK strips
 * arguments the schema does not know, so a client with a cached tools/list (ChatGPT keeps
 * it per chat) would send them, get them dropped and create or update a campaign without
 * its budget while seeing success. Keeping them lets the handler refuse explicitly.
 */
function deprecatedDailyBudget(hint: string) {
  const note = `Устарело: дневного бюджета в Директе больше нет (с 30.11.2026) — вызов с этим параметром отклоняется. ${hint}`;
  return {
    dailyBudgetAmount: z.number().optional().describe(note),
    dailyBudgetMode: z.enum(["STANDARD", "DISTRIBUTED"]).optional().describe(note),
  };
}

function rejectDailyBudget(args: { dailyBudgetAmount?: number; dailyBudgetMode?: string }, hint: string) {
  if (args.dailyBudgetAmount === undefined && args.dailyBudgetMode === undefined) return undefined;
  return fail(
    "dailyBudgetAmount и dailyBudgetMode больше не поддерживаются: с 30.11.2026 дневного бюджета (DailyBudget) " +
      `в Директе нет, бюджет недельный и является частью стратегии. ${hint}`,
  );
}

const CREATE_BUDGET_HINT =
  "Недельный бюджет ручных ставок — weeklyBudgetAmount; у явной biddingStrategy — WeeklySpendLimit внутри неё.";
const UPDATE_BUDGET_HINT =
  "Менять бюджет — set_campaign_strategy (ручные ставки — HighestPosition: {WeeklySpendLimit}, автостратегии — WeeklySpendLimit в их структуре параметров).";

function defaultBiddingStrategy(weeklyBudgetAmount?: number) {
  return {
    Search: compact({
      BiddingStrategyType: "HIGHEST_POSITION",
      HighestPosition: weeklyBudgetAmount ? { WeeklySpendLimit: toMicros(weeklyBudgetAmount) } : undefined,
    }),
    Network: { BiddingStrategyType: "SERVING_OFF" },
  };
}

export function registerCampaignTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "list_campaigns",
    {
      title: "Список кампаний",
      annotations: READ_ONLY,
      description:
        "Возвращает список кампаний с необязательными фильтрами по id, типу, состоянию и статусу. Денежные поля (Funds общего счёта — Sum, Balance, SumAvailableForTransfer, Spend) отдаются в валюте аккаунта. " +
          "Бюджет кампании — недельный (WeeklySpendLimit) и у ручных ставок, и у автостратегий; он лежит внутри BiddingStrategy и виден только при strategy: true (дневного бюджета DailyBudget у API больше нет). " +
          "strategy: true добавляет блок TextCampaign/UnifiedCampaign со стратегией (BiddingStrategy), ключевыми целями (PriorityGoals), счётчиками Метрики, моделью атрибуции и пакетной стратегией — деньги в нём тоже в валюте аккаунта, а сам объект BiddingStrategy в этом виде принимает set_campaign_strategy.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Фильтр по id кампаний."),
        types: z.array(z.enum(CAMPAIGN_TYPES)).optional().describe("Фильтр по типам кампаний."),
        states: z.array(z.enum(CAMPAIGN_STATES)).optional().describe("Фильтр по состояниям кампаний."),
        statuses: z
          .array(z.enum(CAMPAIGN_STATUSES))
          .optional()
          .describe("Фильтр по статусам модерации."),
        fieldNames: z
          .array(z.enum(CAMPAIGN_FIELDS))
          .optional()
          .describe("Какие поля кампании вернуть. Стратегия здесь не запрашивается — для неё strategy: true."),
        strategy: z
          .boolean()
          .optional()
          .describe("Вернуть стратегию показа и ключевые цели (блок TextCampaign или UnifiedCampaign)."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Максимум объектов на страницу."),
        offset: z.number().int().min(0).optional().describe("Смещение постраничной выдачи (сколько объектов пропустить)."),
        autoPaginate: z
          .boolean()
          .optional()
          .describe("Забрать все страницы, идя по LimitedBy (limit тогда не ограничивает общий объём)."),
      },
    },
    async ({ ids, types, states, statuses, fieldNames, strategy, limit, offset, autoPaginate }) => {
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
        if (strategy) {
          // Both blocks may be asked for at once: each campaign answers only its own (checked live).
          params.TextCampaignFieldNames = STRATEGY_READ_FIELDS;
          params.UnifiedCampaignFieldNames = STRATEGY_READ_FIELDS;
        }
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = autoPaginate
          ? await client.getAll("campaigns", params)
          : await client.call("campaigns", "get", params);
        return ok(normalizeStrategyMoney(normalizeMoney(result)));
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
        "Создаёт кампанию TextCampaign (текстово-графические объявления). Без biddingStrategy применяются ручные ставки на поиске с отключёнными сетями (Search HIGHEST_POSITION, Network SERVING_OFF), их недельный бюджет — weeklyBudgetAmount; " +
          "чтобы включить автостратегию или сети, передать biddingStrategy целиком — {Search, Network}, бюджет тогда внутри него (WeeklySpendLimit в структуре параметров стратегии). Дневного бюджета у Директа больше нет: бюджет недельный и часть стратегии.",
      inputSchema: {
        name: z.string().min(1).describe("Название кампании."),
        startDate: isoDate().describe("Дата начала в формате YYYY-MM-DD."),
        endDate: isoDate().optional().describe("Дата окончания в формате YYYY-MM-DD."),
        weeklyBudgetAmount: z
          .number()
          .positive()
          .optional()
          .describe(
            "Недельный бюджет ручных ставок в валюте аккаунта (HighestPosition.WeeklySpendLimit стратегии по умолчанию). " +
              "Только без biddingStrategy — у явной стратегии бюджет задаётся внутри неё. Минимум — get_dictionaries → Currencies.",
          ),
        biddingStrategy: z
          .record(z.any())
          .optional()
          .describe(
            "Полный объект BiddingStrategy {Search, Network} в формате API, деньги (WeeklySpendLimit, BidCeiling, " +
              "AverageCpc, AverageCpa, Cpa…) в валюте аккаунта. Заменяет значение по умолчанию.",
          ),
        ...deprecatedDailyBudget(CREATE_BUDGET_HINT),
      },
    },
    async ({ name, startDate, endDate, weeklyBudgetAmount, biddingStrategy, ...deprecated }) => {
      try {
        const rejected = rejectDailyBudget(deprecated, CREATE_BUDGET_HINT);
        if (rejected) return rejected;
        if (biddingStrategy && (!biddingStrategy.Search || !biddingStrategy.Network)) {
          return fail("biddingStrategy должен содержать оба объекта стратегии: Search и Network.");
        }
        if (biddingStrategy && weeklyBudgetAmount !== undefined) {
          return fail(
            "weeklyBudgetAmount задаёт бюджет только стратегии по умолчанию (ручные ставки). " +
              "Вместе с biddingStrategy бюджет передаётся внутри неё: WeeklySpendLimit в структуре параметров стратегии " +
              "(для ручных ставок — HighestPosition: {WeeklySpendLimit}).",
          );
        }
        const campaign = compact({
          Name: name,
          StartDate: startDate,
          EndDate: endDate,
          TextCampaign: {
            BiddingStrategy: biddingStrategy ? strategyToMicros(biddingStrategy) : defaultBiddingStrategy(weeklyBudgetAmount),
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
      description:
        "Обновляет название, дату окончания и/или минус-фразы кампании (campaigns/update). " +
        "Бюджет здесь не меняется: у Директа он недельный и является частью стратегии — set_campaign_strategy " +
        "(у ручных ставок это HighestPosition: {WeeklySpendLimit}, у автостратегий — WeeklySpendLimit в их структуре параметров).",
      inputSchema: {
        id: z.number().int().describe("Id кампании, которую нужно обновить."),
        name: z.string().min(1).optional().describe("Новое название кампании."),
        endDate: isoDate().optional().describe("Новая дата окончания в формате YYYY-MM-DD."),
        negativeKeywords: z
          .array(z.string())
          .optional()
          .describe("Заменяет минус-фразы кампании; пустой массив очищает их. Чтобы дописать или убрать отдельные фразы, не затирая список, — update_negative_keywords."),
        ...deprecatedDailyBudget(UPDATE_BUDGET_HINT),
      },
    },
    async ({ id, name, endDate, negativeKeywords, ...deprecated }) => {
      try {
        const rejected = rejectDailyBudget(deprecated, UPDATE_BUDGET_HINT);
        if (rejected) return rejected;
        const campaign = compact({
          Id: id,
          Name: name,
          EndDate: endDate,
          NegativeKeywords: stringList(negativeKeywords),
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
