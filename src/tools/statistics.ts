import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { fail, isoDate, ok } from "./util.js";
import { aggregateReport, MAX_TOP_N } from "./statistics.aggregate.js";

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
      title: "Get statistics",
      description:
        "Requests a performance report via the Yandex Direct Reports service. By default the report is AGGREGATED over the whole period (one row per object) — add \"Date\" to fieldNames only for day-by-day dynamics or trend questions. ALL_TIME without a campaign filter is rejected for SEARCH_QUERY/CRITERIA reports; pass campaignIds or a bounded date range. SEARCH_QUERY_PERFORMANCE_REPORT returns a COMPUTED SUMMARY (totals over ALL rows + top-N detail + tail rollup + zero-click/zero-conversion counts), not raw rows — shape it with sortBy/topN/minCost/queryContains/zeroClicksOnly/zeroConversionsOnly, and add Conversions to fieldNames for conversion-based counts. Other report types return tab-separated rows (no header).",
      inputSchema: {
        reportType: z.enum(REPORT_TYPES).optional().describe("Report type. Default CAMPAIGN_PERFORMANCE_REPORT."),
        dateRangeType: z
          .enum(DATE_RANGES)
          .optional()
          .describe("Predefined date range. Inferred as CUSTOM_DATE when dateFrom/dateTo are given."),
        dateFrom: isoDate.optional().describe("Start date YYYY-MM-DD (required for CUSTOM_DATE)."),
        dateTo: isoDate.optional().describe("End date YYYY-MM-DD (required for CUSTOM_DATE)."),
        fieldNames: z.array(z.string()).optional().describe("Report columns (must be valid for the report type)."),
        campaignIds: z.array(z.number().int()).optional().describe("Limit the report to these campaign ids."),
        includeVat: z.boolean().optional().describe("Whether costs include VAT. Default true."),
        // Aggregation controls — apply to SEARCH_QUERY_PERFORMANCE_REPORT (computed summary).
        sortBy: z
          .enum(["Cost", "Clicks", "Impressions", "Conversions", "Ctr", "AvgCpc"])
          .optional()
          .describe("Metric to rank the detail rows by. Default Cost."),
        order: z.enum(["asc", "desc"]).optional().describe("Sort order for detail rows. Default desc."),
        topN: z
          .number()
          .int()
          .min(1)
          .max(MAX_TOP_N)
          .optional()
          .describe(`Max detail rows in the summary (server-capped at ${MAX_TOP_N}). Default 50.`),
        minCost: z.number().min(0).optional().describe("Only include rows with Cost >= this in the detail list."),
        queryContains: z
          .string()
          .optional()
          .describe("Only include rows whose query/criterion contains this substring (case-insensitive)."),
        zeroClicksOnly: z.boolean().optional().describe("Only include rows with 0 clicks in the detail list."),
        zeroConversionsOnly: z
          .boolean()
          .optional()
          .describe("Only rows with clicks>0 and 0 conversions (needs Conversions in fieldNames)."),
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
        const range = dateRangeType ?? (dateFrom && dateTo ? "CUSTOM_DATE" : "LAST_30_DAYS");

        // L3: ALL_TIME без фильтра по кампании для построчных «тяжёлых» отчётов тянет
        // весь аккаунт за всё время → взрыв размера. Падаем громко, до запроса.
        const heavy =
          type === "SEARCH_QUERY_PERFORMANCE_REPORT" || type === "CRITERIA_PERFORMANCE_REPORT";
        if (range === "ALL_TIME" && heavy && !campaignIds?.length) {
          return fail(
            `ALL_TIME without a campaign filter is not allowed for ${type} (it returns the whole account and explodes in size). Pass campaignIds, or a bounded date range like LAST_30_DAYS or CUSTOM_DATE.`,
          );
        }

        const selection: Record<string, unknown> = {};
        if (range === "CUSTOM_DATE") {
          if (!dateFrom || !dateTo) {
            return fail("CUSTOM_DATE range requires both dateFrom and dateTo (YYYY-MM-DD).");
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
        // L3 fail-loud: явный фильтр по кампании, но 0 строк — почти всегда неверный
        // campaignId или период. Пустой ответ провоцирует модель «снять фильтр и
        // расширить охват»; явная ошибка заставляет починить фильтр.
        if (campaignIds?.length && tsv.trim() === "") {
          return fail(
            `Report returned 0 rows for campaignIds [${campaignIds.join(", ")}] over ${range}. Check the campaignId(s) and the date range — do not broaden the filter blindly.`,
          );
        }
        // L2: SEARCH_QUERY is high-cardinality → return a computed summary (totals over
        // 100% of rows + top-N + tail), not raw rows. Other types stay raw (bounded by
        // entity count).
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
        return ok(tsv);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
