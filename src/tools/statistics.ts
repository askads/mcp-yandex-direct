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
] as const;

type ReportType = (typeof REPORT_TYPES)[number];

const DATE_RANGES = [
  "TODAY",
  "YESTERDAY",
  "LAST_7_DAYS",
  "LAST_30_DAYS",
  "THIS_MONTH",
  "LAST_MONTH",
  "ALL_TIME",
  "CUSTOM_DATE",
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
};

export function registerStatisticsTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "get_statistics",
    {
      title: "Статистика",
      annotations: READ_ONLY,
      description:
        "Запрашивает отчёт по эффективности через сервис Reports Яндекс Директа. По умолчанию отчёт АГРЕГИРОВАН за весь период (одна строка на объект) — добавлять \"Date\" в fieldNames только для динамики по дням или вопросов о трендах. ALL_TIME без фильтра по кампаниям отклоняется для отчётов SEARCH_QUERY/CRITERIA: нужно передать campaignIds или ограниченный период. SEARCH_QUERY_PERFORMANCE_REPORT возвращает не сырые строки, а ВЫЧИСЛЕННУЮ СВОДКУ (итоги по ВСЕМ строкам + детализация top-N + свёртка хвоста + количество строк без кликов и без конверсий); её форму задают sortBy/topN/minCost/queryContains/zeroClicksOnly/zeroConversionsOnly, а для подсчётов по конверсиям нужно добавить Conversions в fieldNames. Остальные типы отчётов возвращают строки, разделённые табуляцией (без заголовка).",
      inputSchema: {
        reportType: z.enum(REPORT_TYPES).optional().describe("Тип отчёта. По умолчанию CAMPAIGN_PERFORMANCE_REPORT."),
        dateRangeType: z
          .enum(DATE_RANGES)
          .optional()
          .describe("Предустановленный период. Если заданы dateFrom/dateTo, подставляется CUSTOM_DATE."),
        dateFrom: isoDate().optional().describe("Дата начала YYYY-MM-DD (обязательна для CUSTOM_DATE)."),
        dateTo: isoDate().optional().describe("Дата окончания YYYY-MM-DD (обязательна для CUSTOM_DATE)."),
        fieldNames: z.array(z.string()).optional().describe("Колонки отчёта (должны быть допустимы для его типа)."),
        campaignIds: z.array(z.number().int()).optional().describe("Ограничить отчёт этими id кампаний."),
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

        const selection: Record<string, unknown> = {};
        if (range === "CUSTOM_DATE") {
          if (!dateFrom || !dateTo) {
            return fail("Для периода CUSTOM_DATE нужны обе даты: dateFrom и dateTo (YYYY-MM-DD).");
          }
          selection.DateFrom = dateFrom;
          selection.DateTo = dateTo;
        }
        if (campaignIds?.length) {
          selection.Filter = [
            { Field: "CampaignId", Operator: "IN", Values: campaignIds.map(String) },
          ];
        }

        const params = {
          SelectionCriteria: selection,
          FieldNames: fieldNames?.length ? fieldNames : DEFAULT_FIELDS_BY_TYPE[type],
          ReportName: `mcp-${type}-${Date.now()}`,
          ReportType: type,
          DateRangeType: range,
          Format: "TSV",
          IncludeVAT: includeVat === false ? "NO" : "YES",
          IncludeDiscount: "NO",
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
        // L3 fail-loud: an explicit campaign filter that returns 0 DATA rows is almost always
        // a wrong campaignId or period. The live Reports body ALWAYS carries the column-header
        // row (skipColumnHeader is not sent), so tsv.trim() is never empty — count data rows
        // (header detection reused from parseRows). An empty result nudges the model to "drop
        // the filter and broaden"; an explicit error makes it fix the filter instead.
        if (campaignIds?.length && countDataRows(tsv, params.FieldNames) === 0) {
          return fail(
            `Отчёт вернул 0 строк для campaignIds [${campaignIds.join(", ")}] за ${range}. Проверить id кампаний и период — не расширять фильтр вслепую.`,
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
