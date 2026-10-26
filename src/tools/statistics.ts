import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { fail, isoDate, ok, READ_ONLY } from "./util.js";
import { aggregateReport, countDataRows, MAX_TOP_N, truncateTsv } from "./statistics.aggregate.js";

export const REPORT_TYPES = [
  "ACCOUNT_PERFORMANCE_REPORT",
  "CAMPAIGN_PERFORMANCE_REPORT",
  "ADGROUP_PERFORMANCE_REPORT",
  "AD_PERFORMANCE_REPORT",
  "CRITERIA_PERFORMANCE_REPORT",
  "SEARCH_QUERY_PERFORMANCE_REPORT",
  // Arbitrary groupings (Device, Age, Gender, region, placement, …): the caller
  // composes fieldNames from dimensions + metrics.
  "CUSTOM_REPORT",
] as const;

type ReportType = (typeof REPORT_TYPES)[number];

/** Full documented DateRangeType list (AUTO = the period Yandex may still restate). */
const DATE_RANGES = [
  "TODAY",
  "YESTERDAY",
  "LAST_3_DAYS",
  "LAST_5_DAYS",
  "LAST_7_DAYS",
  "LAST_14_DAYS",
  "LAST_30_DAYS",
  "LAST_90_DAYS",
  "LAST_365_DAYS",
  "THIS_WEEK_MON_TODAY",
  "THIS_WEEK_SUN_TODAY",
  "LAST_WEEK",
  "LAST_BUSINESS_WEEK",
  "LAST_WEEK_SUN_SAT",
  "THIS_MONTH",
  "LAST_MONTH",
  "ALL_TIME",
  "CUSTOM_DATE",
  "AUTO",
] as const;

/** Documented attribution models; LC is the API default. */
const ATTRIBUTION_MODELS = ["FCCD", "LC", "LSCCD", "AUTO"] as const;

/** Documented SelectionCriteria.Filter operators. */
const FILTER_OPERATORS = [
  "EQUALS",
  "NOT_EQUALS",
  "IN",
  "NOT_IN",
  "LESS_THAN",
  "GREATER_THAN",
  "STARTS_WITH_IGNORE_CASE",
  "DOES_NOT_START_WITH_IGNORE_CASE",
  "STARTS_WITH_ANY_IGNORE_CASE",
  "DOES_NOT_START_WITH_ALL_IGNORE_CASE",
] as const;

const METRICS = ["Impressions", "Clicks", "Cost", "Ctr", "AvgCpc"];

/**
 * Default columns per report type. Each report type allows a different set of
 * dimension fields — e.g. ACCOUNT_PERFORMANCE_REPORT rejects CampaignName — so
 * a single shared default cannot work. All sets below are verified against the
 * live Reports service.
 *
 * `Date` is intentionally OMITTED from the defaults: in the Reports service Date
 * is a grouping dimension, so including it splits the report by day (one row per
 * object × day → up to ×30 rows on LAST_30_DAYS). The default is a period-
 * aggregate (one row per object); a caller asking about daily dynamics/trends
 * adds "Date" to fieldNames explicitly.
 */
export const DEFAULT_FIELDS_BY_TYPE: Record<ReportType, string[]> = {
  ACCOUNT_PERFORMANCE_REPORT: [...METRICS],
  CAMPAIGN_PERFORMANCE_REPORT: ["CampaignId", "CampaignName", ...METRICS],
  ADGROUP_PERFORMANCE_REPORT: ["CampaignName", "AdGroupId", "AdGroupName", ...METRICS],
  AD_PERFORMANCE_REPORT: ["CampaignName", "AdGroupName", "AdId", ...METRICS],
  CRITERIA_PERFORMANCE_REPORT: [
    "CampaignName",
    "AdGroupName",
    "CriterionId",
    "Criterion",
    ...METRICS,
  ],
  SEARCH_QUERY_PERFORMANCE_REPORT: ["CampaignName", "Query", ...METRICS],
  // No natural default — CUSTOM_REPORT exists for caller-chosen dimensions.
  CUSTOM_REPORT: ["CampaignId", "CampaignName", ...METRICS],
};

export function registerStatisticsTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "get_statistics",
    {
      title: "Статистика",
      annotations: READ_ONLY,
      description:
        "Запрашивает отчёт по эффективности через сервис Reports Яндекс Директа. По умолчанию отчёт АГРЕГИРОВАН за весь период (одна строка на объект) — добавлять \"Date\" в fieldNames только для динамики по дням или вопросов о трендах. Почасовой статистики в Reports нет: минимум — сутки, внутридневную динамику дают только повторные снимки TODAY. Готового ROAS нет — считать Revenue / Cost; GoalsRoi — это ROI ((Revenue − Cost) / Cost), не ROAS. Revenue, Profit, GoalsRoi и конверсии заполняются только по целям Метрики с ценностью. ALL_TIME без фильтра по кампаниям отклоняется для отчётов SEARCH_QUERY/CRITERIA: нужно передать campaignIds или ограниченный период. SEARCH_QUERY_PERFORMANCE_REPORT возвращает не сырые строки, а ВЫЧИСЛЕННУЮ СВОДКУ (итоги по ВСЕМ строкам + детализация top-N + свёртка хвоста + количество строк без кликов и без конверсий); её форму задают sortBy/topN/minCost/queryContains/zeroClicksOnly/zeroConversionsOnly, а для подсчётов по конверсиям нужно добавить Conversions в fieldNames. Остальные типы отчётов возвращают строки, разделённые табуляцией (без заголовка).",
      inputSchema: {
        reportType: z.enum(REPORT_TYPES).optional().describe("Тип отчёта. По умолчанию CAMPAIGN_PERFORMANCE_REPORT."),
        dateRangeType: z
          .enum(DATE_RANGES)
          .optional()
          .describe("Предустановленный период. Если заданы dateFrom/dateTo, подставляется CUSTOM_DATE."),
        dateFrom: isoDate().optional().describe("Дата начала YYYY-MM-DD (обязательна для CUSTOM_DATE)."),
        dateTo: isoDate().optional().describe("Дата окончания YYYY-MM-DD (обязательна для CUSTOM_DATE)."),
        fieldNames: z
          .array(z.string())
          .optional()
          .describe(
            "Колонки отчёта (должны быть допустимы для его типа). Сверх базовых метрик: Conversions, " +
              "ConversionRate, CostPerConversion, Revenue, Profit, GoalsRoi. Разрезы CUSTOM_REPORT: Date, Device, " +
              "Age, Gender, LocationOfPresenceName, Placement, AdNetworkType, Slot и др.",
          ),
        campaignIds: z.array(z.number().int()).optional().describe("Ограничить отчёт этими id кампаний."),
        filters: z
          .array(
            z.object({
              field: z.string().describe("Поле для фильтрации (должно быть допустимо для типа отчёта)."),
              operator: z.enum(FILTER_OPERATORS).describe("Оператор сравнения."),
              values: z.array(z.string()).min(1).describe("Значения; числа передавать строками."),
            }),
          )
          .optional()
          .describe(
            "Произвольные условия SelectionCriteria.Filter, складываются с campaignIds по И. " +
              "Например Clicks GREATER_THAN 0 или Device EQUALS MOBILE.",
          ),
        goals: z
          .array(z.string())
          .min(1)
          .max(10)
          .optional()
          .describe(
            "Id целей Яндекс Метрики (не более 10). Без них Conversions и Revenue считаются по всем целям " +
              "кампании; с ними колонки приходят как <поле>_<idЦели>_<модель> (по одной на цель × модель). " +
              "Для SEARCH_QUERY_PERFORMANCE_REPORT — только одна цель и одна модель.",
          ),
        attributionModels: z
          .array(z.enum(ATTRIBUTION_MODELS))
          .min(1)
          .optional()
          .describe("Модели атрибуции для конверсий. По умолчанию LC (последний переход)."),
        includeVat: z.boolean().optional().describe("Включать ли НДС в расход. По умолчанию true."),
        // Aggregation controls — apply to SEARCH_QUERY_PERFORMANCE_REPORT (computed summary).
        sortBy: z
          .enum(["Cost", "Clicks", "Impressions", "Conversions", "Ctr", "AvgCpc"])
          .optional()
          .describe("Метрика для ранжирования строк детализации. По умолчанию Cost."),
        order: z.enum(["asc", "desc"]).optional().describe("Порядок сортировки строк детализации. По умолчанию desc."),
        topN: z
          .number()
          .int()
          .min(1)
          .max(MAX_TOP_N)
          .optional()
          .describe(`Максимум строк детализации в сводке (на сервере ограничено ${MAX_TOP_N}). По умолчанию 50.`),
        minCost: z.number().min(0).optional().describe("Включать в детализацию только строки с Cost >= этого значения."),
        queryContains: z
          .string()
          .optional()
          .describe("Включать только строки, где запрос или условие содержит эту подстроку (без учёта регистра)."),
        zeroClicksOnly: z.boolean().optional().describe("Включать в детализацию только строки с 0 кликов."),
        zeroConversionsOnly: z
          .boolean()
          .optional()
          .describe("Только строки с clicks>0 и 0 конверсий (нужно Conversions в fieldNames)."),
      },
    },
    async ({
      reportType,
      dateRangeType,
      dateFrom,
      dateTo,
      fieldNames,
      campaignIds,
      filters,
      goals,
      attributionModels,
      includeVat,
      sortBy,
      order,
      topN,
      minCost,
      queryContains,
      zeroClicksOnly,
      zeroConversionsOnly,
    }) => {
      try {
        const type = reportType ?? "CAMPAIGN_PERFORMANCE_REPORT";
        // A single date bound is ambiguous: silently falling back to LAST_30_DAYS hides the
        // mistake. Require both dates or neither.
        if ((dateFrom === undefined) !== (dateTo === undefined)) {
          return fail(
            "Нужно указать обе даты — dateFrom и dateTo (YYYY-MM-DD) — либо ни одной: одна граница периода неоднозначна.",
          );
        }
        // An explicit date pair must win over a predefined dateRangeType, otherwise passing
        // dates alongside e.g. LAST_7_DAYS would silently ignore the dates.
        let range = dateRangeType ?? (dateFrom && dateTo ? "CUSTOM_DATE" : "LAST_30_DAYS");
        if (dateFrom && dateTo) range = "CUSTOM_DATE";

        // L3: ALL_TIME без фильтра по кампании для построчных «тяжёлых» отчётов тянет
        // весь аккаунт за всё время → взрыв размера. Падаем громко, до запроса.
        const heavy =
          type === "SEARCH_QUERY_PERFORMANCE_REPORT" || type === "CRITERIA_PERFORMANCE_REPORT";
        if (range === "ALL_TIME" && heavy && !campaignIds?.length) {
          return fail(
            `ALL_TIME без фильтра по кампаниям недопустим для ${type} (вернётся весь аккаунт, и размер ответа взорвётся). Нужно передать campaignIds или ограниченный период — например LAST_30_DAYS или CUSTOM_DATE.`,
          );
        }

        // The search-query summary reads columns by fieldNames position; with Goals every
        // conversion/revenue field becomes one column per goal × model, which only lines
        // up when there is exactly one pair. Refuse before the request burns a Reports task.
        const goalColumns = (goals?.length ?? 0) * (attributionModels?.length || 1);
        if (type === "SEARCH_QUERY_PERFORMANCE_REPORT" && goalColumns > 1) {
          return fail(
            "Для SEARCH_QUERY_PERFORMANCE_REPORT сводка поддерживает одну цель и одну модель атрибуции. " +
              "Передать одну цель в goals (и не больше одной модели) или вызвать отчёт отдельно для каждой цели.",
          );
        }

        const selection: Record<string, unknown> = {};
        if (range === "CUSTOM_DATE") {
          if (!dateFrom || !dateTo) {
            return fail("Для периода CUSTOM_DATE нужны обе даты: dateFrom и dateTo (YYYY-MM-DD).");
          }
          selection.DateFrom = dateFrom;
          selection.DateTo = dateTo;
        }
        // campaignIds is the shorthand; `filters` carries anything else. Both land in one
        // Filter array, which the API ANDs together.
        const filter = [
          ...(campaignIds?.length
            ? [{ Field: "CampaignId", Operator: "IN", Values: campaignIds.map(String) }]
            : []),
          ...(filters ?? []).map((f) => ({ Field: f.field, Operator: f.operator, Values: f.values })),
        ];
        if (filter.length) selection.Filter = filter;

        const params = {
          SelectionCriteria: selection,
          FieldNames: fieldNames?.length ? fieldNames : DEFAULT_FIELDS_BY_TYPE[type],
          ReportName: `mcp-${type}-${Date.now()}`,
          ReportType: type,
          DateRangeType: range,
          Format: "TSV",
          IncludeVAT: includeVat === false ? "NO" : "YES",
          IncludeDiscount: "NO",
          // Goals/AttributionModels sit NEXT TO SelectionCriteria, not inside it.
          ...(goals?.length ? { Goals: goals } : {}),
          ...(attributionModels?.length ? { AttributionModels: attributionModels } : {}),
        };

        const tsv = await client.report(params);
        // L2: SEARCH_QUERY is high-cardinality → return a computed summary (totals over
        // 100% of rows + top-N + tail), not raw rows. Other types stay raw (bounded by
        // entity count). Handled first: the summary carries its own explicit empty-slice
        // note, so it must not be pre-empted by the raw-row guard below.
        if (type === "SEARCH_QUERY_PERFORMANCE_REPORT") {
          return ok(
            aggregateReport(tsv, params.FieldNames, type, {
              sortBy,
              order,
              topN,
              minCost,
              queryContains,
              zeroClicksOnly,
              zeroConversionsOnly,
            }),
          );
        }
        // A 0-row report for an explicit campaign filter is a legitimate empty slice
        // (paused campaign, no traffic) — Reports cannot distinguish it from a wrong
        // CampaignId. The live Reports body ALWAYS carries the column-header row
        // (skipColumnHeader is not sent), so tsv.trim() is never empty — count data
        // rows (header detection reused from parseRows). Answer with a calm success
        // note (mirroring aggregateReport's empty-slice note): an isError here read
        // as "the request failed, retry", and every retry burns a Reports task + Units.
        if (campaignIds?.length && countDataRows(tsv, params.FieldNames) === 0) {
          return ok(
            `0 строк для campaignIds [${campaignIds.join(", ")}] за ${range} — отчёт построился, ` +
              "но показов и расходов в этом срезе нет. Либо кампании не откручивались за период, " +
              "либо такого id не существует (Reports их не различает; при сомнении сверить id через list_campaigns). " +
              "Не повторять запрос и не расширять фильтр вслепую.",
          );
        }
        // Row/byte caps on the raw TSV: a wide report without a campaign filter can be
        // megabytes — cut it EXPLICITLY (loud trailing note) instead of dumping it all
        // into the context. Units and the daily Reports quota are already spent either
        // way; the note steers the model to narrow the request, not to retry.
        const cut = truncateTsv(tsv, params.FieldNames);
        if (cut.truncated) {
          return ok(
            cut.text +
              `\n[_truncated] Показано строк: ${cut.shownRows} из ${cut.totalRows} — ответ обрезан по лимиту размера. ` +
              "Сузить период (dateFrom/dateTo), передать campaignIds или убрать лишние колонки из fieldNames.",
          );
        }
        return ok(tsv);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
