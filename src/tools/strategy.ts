import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { fail, normalizeMoney, okOrPartial, toMicros, WRITE_UPDATE } from "./util.js";

/**
 * Money keys inside BiddingStrategy and PriorityGoals (all ×10⁶ in the API, per
 * campaigns/update-unified-campaign and update-text-campaign). Scoped to the strategy
 * subtree only — "Value" is money in PriorityGoals but would be too generic elsewhere.
 * Crr, BudgetIncreasePercent, LimitPercent are percents and stay as they are.
 */
export const STRATEGY_MONEY_FIELDS = new Set([
  "WeeklySpendLimit",
  "BidCeiling",
  "AverageCpc",
  "AverageCpa",
  "Cpa",
  "SpendLimit",
  "MinimumExplorationBudget",
  "Value",
]);

/** Type-specific settings, requested via TextCampaignFieldNames / UnifiedCampaignFieldNames. */
export const STRATEGY_READ_FIELDS = ["BiddingStrategy", "PriorityGoals", "CounterIds", "AttributionModel", "PackageBiddingStrategy"];

/** Campaign Type → the wrapper key the strategy lives under. Other types: raw_request. */
const WRAPPERS: Record<string, "TextCampaign" | "UnifiedCampaign"> = {
  TEXT_CAMPAIGN: "TextCampaign",
  UNIFIED_CAMPAIGN: "UnifiedCampaign",
};

/** Deep copy with the strategy money keys converted from account currency to micros. */
export function strategyToMicros<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => strategyToMicros(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = STRATEGY_MONEY_FIELDS.has(key) && typeof val === "number" ? toMicros(val) : strategyToMicros(val);
    }
    return out as T;
  }
  return value;
}

/** In place: converts strategy money in TextCampaign/UnifiedCampaign blocks of a campaigns.get result. */
export function normalizeStrategyMoney<T>(result: T): T {
  const campaigns = (result as { Campaigns?: Record<string, unknown>[] })?.Campaigns ?? [];
  for (const campaign of campaigns) {
    for (const wrapper of ["TextCampaign", "UnifiedCampaign"]) {
      const block = campaign[wrapper] as Record<string, unknown> | undefined;
      if (!block) continue;
      normalizeMoney(block.BiddingStrategy, STRATEGY_MONEY_FIELDS);
      normalizeMoney(block.PriorityGoals, STRATEGY_MONEY_FIELDS);
    }
  }
  return result;
}

const side = (name: string) =>
  z
    .object({ BiddingStrategyType: z.string().min(1).describe("Тип стратегии, например AVERAGE_CPA или SERVING_OFF.") })
    .passthrough()
    .describe(
      `Стратегия ${name} в формате API: {BiddingStrategyType, <Структура параметров>: {...}}, деньги в валюте аккаунта.`,
    );

export function registerStrategyTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "set_campaign_strategy",
    {
      title: "Изменить стратегию кампании",
      annotations: WRITE_UPDATE,
      description:
        "Меняет стратегию показа (BiddingStrategy) текстовой кампании или ЕПК. Формат — объект API как есть, " +
        "в том же виде, в каком его отдаёт list_campaigns с strategy: true, поэтому порядок такой: прочитать текущую " +
        "стратегию, показать её пользователю, скопировать и поправить нужное поле. Сервер делает только три вещи: " +
        "(1) одним campaigns.get узнаёт тип кампании и кладёт стратегию в TextCampaign или UnifiedCampaign; " +
        "(2) переводит деньги из валюты аккаунта в микроединицы — WeeklySpendLimit, BidCeiling, AverageCpc, " +
        "AverageCpa, Cpa, SpendLimit, MinimumExplorationBudget (Crr и BudgetIncreasePercent — проценты, не деньги); " +
        "(3) возвращает previous — стратегию до изменения — рядом с UpdateResults. Больше ничего не дописывается " +
        "и не проверяется: правила совместимости проверяет API и отвечает ошибкой по объекту.\n" +
        "Передаются обе стороны, search и network. Внутри структуры параметров непереданные поля той же стратегии " +
        "сохраняют текущие значения (проверено вживую на ЕПК). PriorityGoals, CounterIds и AttributionModel " +
        "этим инструментом не меняются (raw_request). Правила API: автостратегия на поиске ⇒ в сетях только " +
        "NETWORK_DEFAULT или SERVING_OFF; автостратегия в сетях ⇒ на поиске SERVING_OFF. Конверсионные стратегии " +
        "требуют GoalId цели Метрики и счётчик на кампании; стратегии *_MULTIPLE_GOALS берут цели из PriorityGoals. " +
        "Минимумы бюджета и ставок — get_dictionaries → Currencies. Смена типа стратегии перезапускает её " +
        "обучение. Кампании других типов и кампании в пакетной стратегии — через raw_request.",
      inputSchema: {
        id: z.number().int().describe("Id кампании."),
        search: side("на поиске"),
        network: side("в сетях"),
      },
    },
    async ({ id, search, network }) => {
      try {
        const current = await client.call<{ Campaigns?: Record<string, any>[] }>("campaigns", "get", {
          SelectionCriteria: { Ids: [id] },
          FieldNames: ["Id", "Type"],
          TextCampaignFieldNames: ["BiddingStrategy", "PackageBiddingStrategy"],
          UnifiedCampaignFieldNames: ["BiddingStrategy", "PackageBiddingStrategy"],
        });
        const campaign = current.Campaigns?.[0];
        if (!campaign) return fail(`Кампания ${id} не найдена — ничего не записано.`);
        const wrapper = WRAPPERS[campaign.Type];
        if (!wrapper) {
          return fail(
            `Кампания ${id} имеет тип ${campaign.Type}: стратегию этого типа инструмент не меняет — raw_request campaigns.update.`,
          );
        }
        const block = campaign[wrapper] ?? {};
        if (block.PackageBiddingStrategy) {
          return fail(
            `Кампания ${id} привязана к пакетной стратегии ${JSON.stringify(block.PackageBiddingStrategy)}: ` +
              "её стратегию меняют в пакете, а отвязка (PackageBiddingStrategy: null) — через raw_request.",
          );
        }
        const strategy = { Search: search, Network: network };
        const result = await client.call<Record<string, unknown>>("campaigns", "update", {
          Campaigns: [{ Id: id, [wrapper]: { BiddingStrategy: strategyToMicros(strategy) } }],
        });
        const previous = normalizeMoney(block.BiddingStrategy ?? null, STRATEGY_MONEY_FIELDS);
        return okOrPartial({ id, campaignType: campaign.Type, previous, sent: strategy, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
