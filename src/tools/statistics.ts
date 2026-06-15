import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { fail, ok } from "./util.js";

const REPORT_TYPES = [
  "ACCOUNT_PERFORMANCE_REPORT",
  "CAMPAIGN_PERFORMANCE_REPORT",
  "ADGROUP_PERFORMANCE_REPORT",
  "AD_PERFORMANCE_REPORT",
  "CRITERIA_PERFORMANCE_REPORT",
  "SEARCH_QUERY_PERFORMANCE_REPORT",
] as const;

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

const DEFAULT_FIELDS = ["Date", "CampaignName", "Impressions", "Clicks", "Cost", "Ctr", "AvgCpc"];

export function registerStatisticsTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "get_statistics",
    {
      title: "Get statistics",
      description:
        "Requests a TSV performance report via the Yandex Direct Reports service. Returns the report as tab-separated text with a column header row.",
      inputSchema: {
        reportType: z.enum(REPORT_TYPES).optional().describe("Report type. Default CAMPAIGN_PERFORMANCE_REPORT."),
        dateRangeType: z
          .enum(DATE_RANGES)
          .optional()
          .describe("Predefined date range. Inferred as CUSTOM_DATE when dateFrom/dateTo are given."),
        dateFrom: z.string().optional().describe("Start date YYYY-MM-DD (required for CUSTOM_DATE)."),
        dateTo: z.string().optional().describe("End date YYYY-MM-DD (required for CUSTOM_DATE)."),
        fieldNames: z.array(z.string()).optional().describe("Report columns (must be valid for the report type)."),
        campaignIds: z.array(z.number().int()).optional().describe("Limit the report to these campaign ids."),
        includeVat: z.boolean().optional().describe("Whether costs include VAT. Default true."),
      },
    },
    async ({ reportType, dateRangeType, dateFrom, dateTo, fieldNames, campaignIds, includeVat }) => {
      try {
        const type = reportType ?? "CAMPAIGN_PERFORMANCE_REPORT";
        const range = dateRangeType ?? (dateFrom && dateTo ? "CUSTOM_DATE" : "LAST_30_DAYS");

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
          FieldNames: fieldNames?.length ? fieldNames : DEFAULT_FIELDS,
          ReportName: `mcp-${type}-${Date.now()}`,
          ReportType: type,
          DateRangeType: range,
          Format: "TSV",
          IncludeVAT: includeVat === false ? "NO" : "YES",
          IncludeDiscount: "NO",
        };

        const tsv = await client.report(params);
        return ok(tsv);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
