import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FIELDS_BY_TYPE, registerStatisticsTools, REPORT_TYPES } from "./statistics.js";
import { aggregateReport } from "./statistics.aggregate.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** Registers the statistics tool against a fake server + client whose report() is stubbable. */
function harness(reportImpl?: (params: any) => string) {
  const calls: any[] = [];
  const tools: Record<string, Handler> = {};
  const client = {
    report: async (params: any) => {
      calls.push(params);
      return reportImpl ? reportImpl(params) : "";
    },
  };
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerStatisticsTools(server as never, client as never);
  return { calls, tools };
}

const CAMPAIGN_HEADER = "CampaignId\tCampaignName\tImpressions\tClicks\tCost\tCtr\tAvgCpc";

const SQ_FIELDS = ["Query", "Impressions", "Clicks", "Cost", "Conversions"];
// аудио: conv(26) > clicks(20) → anomaly; mp3: clicks>0 & 0 conv → zeroConversion;
// мусор: 0 clicks → zeroClick.
const SQ_TSV = [
  "аудио в текст\t100\t20\t160.00\t26",
  "whisper\t50\t10\t90.00\t8",
  "mp3 в текст\t30\t3\t27.00\t0",
  "мусор\t40\t0\t0\t0",
].join("\n");

test("every report type has a default field set", () => {
  for (const type of REPORT_TYPES) {
    assert.ok(DEFAULT_FIELDS_BY_TYPE[type]?.length, `${type} has defaults`);
  }
});

test("ACCOUNT_PERFORMANCE_REPORT defaults exclude fields the API rejects for it", () => {
  const fields = DEFAULT_FIELDS_BY_TYPE.ACCOUNT_PERFORMANCE_REPORT;
  for (const forbidden of ["CampaignName", "CampaignId", "AdGroupName", "AdId", "CriterionId"]) {
    assert.ok(!fields.includes(forbidden), `${forbidden} must not be a default`);
  }
});

test("defaults exclude Date so reports aggregate over the period (LD)", () => {
  for (const type of REPORT_TYPES) {
    assert.ok(
      !DEFAULT_FIELDS_BY_TYPE[type].includes("Date"),
      `${type} default must not include Date (would split the report by day)`,
    );
  }
});

test("SEARCH_QUERY default is the period aggregate: CampaignName + Query + metrics", () => {
  assert.deepEqual(DEFAULT_FIELDS_BY_TYPE.SEARCH_QUERY_PERFORMANCE_REPORT, [
    "CampaignName",
    "Query",
    "Impressions",
    "Clicks",
    "Cost",
    "Ctr",
    "AvgCpc",
  ]);
});

// ---- L2 aggregation ----

test("aggregate: totals are over 100% of rows (true period total)", () => {
  const a = aggregateReport(SQ_TSV, SQ_FIELDS, "SEARCH_QUERY_PERFORMANCE_REPORT");
  assert.equal(a.rowsTotal, 4);
  assert.equal(a.totals.Impressions, 220);
  assert.equal(a.totals.Clicks, 33);
  assert.equal(a.totals.Cost, 277);
  assert.equal(a.totals.Conversions, 34);
  assert.equal(a.counts.zeroClick, 1); // мусор
  assert.equal(a.counts.zeroConversion, 1); // mp3 в текст
});

test("aggregate: top sorted by Cost desc with 95% adaptive cutoff; tail = rest", () => {
  const a = aggregateReport(SQ_TSV, SQ_FIELDS, "SEARCH_QUERY_PERFORMANCE_REPORT");
  // cumulative cost reaches 95% at row 3 (160+90+27 = 277 of 277) → 3 shown, 1 in tail.
  assert.equal(a.top.length, 3);
  assert.equal(a.top[0].Query, "аудио в текст");
  assert.equal(a.tail.rows, 1);
  // top + tail reconstruct the full set.
  const topCost = a.top.reduce((s, r) => s + Number(r.Cost), 0);
  assert.equal(Math.round((topCost + a.tail.Cost) * 100) / 100, a.totals.Cost);
});

test("aggregate: conversions>clicks anomaly is flagged", () => {
  const a = aggregateReport(SQ_TSV, SQ_FIELDS, "SEARCH_QUERY_PERFORMANCE_REPORT");
  assert.equal(a.anomalies?.length, 1);
  assert.equal(a.anomalies?.[0].Query, "аудио в текст");
});

test("aggregate: field-aware — no Conversions in fieldNames omits conversion data", () => {
  const fields = ["Query", "Impressions", "Clicks", "Cost"];
  const tsv = SQ_TSV.split("\n").map((l) => l.split("\t").slice(0, 4).join("\t")).join("\n");
  const a = aggregateReport(tsv, fields, "SEARCH_QUERY_PERFORMANCE_REPORT");
  assert.equal(a.hasConversions, false);
  assert.equal(a.counts.zeroConversion, undefined);
  assert.equal(a.anomalies, undefined);
  assert.equal("Conversions" in a.totals, false);
  assert.equal("Conversions" in a.top[0], false);
});

test("aggregate: filters drive the detail list; totals stay over 100%", () => {
  const a = aggregateReport(SQ_TSV, SQ_FIELDS, "SEARCH_QUERY_PERFORMANCE_REPORT", { minCost: 50 });
  assert.equal(a.totals.Cost, 277); // unchanged — totals are over all rows
  assert.equal(a.filtered?.rows, 2); // only аудио + whisper survive minCost:50
  assert.ok(a.top.every((r) => Number(r.Cost) >= 50));
});

test("aggregate: zeroClicksOnly filter", () => {
  const a = aggregateReport(SQ_TSV, SQ_FIELDS, "SEARCH_QUERY_PERFORMANCE_REPORT", {
    zeroClicksOnly: true,
  });
  assert.equal(a.filtered?.rows, 1);
  assert.equal(a.top[0].Query, "мусор");
});

// ---- column-header stripping (the live Reports TSV keeps the header row) ----

test("aggregate: leading column-header row is dropped, not counted as data", () => {
  // The live Reports service returns the column header as the first TSV line.
  const withHeader = [SQ_FIELDS.join("\t"), SQ_TSV].join("\n");
  const a = aggregateReport(withHeader, SQ_FIELDS, "SEARCH_QUERY_PERFORMANCE_REPORT");
  // Identical to the headerless fixture — the header must not become a phantom row.
  assert.equal(a.rowsTotal, 4);
  assert.equal(a.counts.zeroClick, 1); // not 2 — header is not a zero-click row
  assert.equal(a.totals.Cost, 277);
  assert.ok(!a.top.some((r) => r.Query === "Query"), "header must not leak into top rows");
});

test("aggregate: empty slice (header-only TSV) → 0 rows with an explicit empty note", () => {
  // No traffic in the slice → the report body is just the column header.
  const a = aggregateReport(SQ_FIELDS.join("\t"), SQ_FIELDS, "SEARCH_QUERY_PERFORMANCE_REPORT");
  assert.equal(a.rowsTotal, 0);
  assert.equal(a.totals.Cost, 0);
  assert.equal(a.top.length, 0);
  assert.match(a.note, /0 rows for this slice/);
  assert.match(a.note, /not that the report is unavailable/);
});

test("aggregate: a real query literally equal to a field name is not mistaken for a header", () => {
  // First data line whose first cell is "Query" but other cells are numbers — not a header.
  const tsv = ["Query\t10\t2\t5.00\t0", "whisper\t50\t10\t90.00\t8"].join("\n");
  const a = aggregateReport(tsv, SQ_FIELDS, "SEARCH_QUERY_PERFORMANCE_REPORT");
  assert.equal(a.rowsTotal, 2);
  assert.equal(a.totals.Clicks, 12);
});

test("aggregate: zeroConversionsOnly without Conversions in fieldNames throws a clear error", () => {
  const fields = ["Query", "Impressions", "Clicks", "Cost"];
  assert.throws(
    () =>
      aggregateReport("audio\t100\t20\t160.00", fields, "SEARCH_QUERY_PERFORMANCE_REPORT", {
        zeroConversionsOnly: true,
      }),
    /Conversions/,
  );
});

// ---- get_statistics handler: date-range and empty-slice guards ----

test("get_statistics rejects a single date bound and makes no report request", async () => {
  const { calls, tools } = harness();
  const res = await tools.get_statistics({ dateFrom: "2026-01-01" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /both dateFrom and dateTo/);
  assert.equal(calls.length, 0);
});

test("get_statistics forces CUSTOM_DATE when both dates accompany a predefined range", async () => {
  const { calls, tools } = harness(() => `${CAMPAIGN_HEADER}\n1\tA\t10\t2\t5\t20\t2.5\n`);
  const res = await tools.get_statistics({
    dateRangeType: "LAST_7_DAYS",
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
  });
  assert.equal(res.isError, undefined);
  // The explicit date pair wins over LAST_7_DAYS instead of being silently ignored.
  assert.equal(calls[0].DateRangeType, "CUSTOM_DATE");
  assert.equal(calls[0].SelectionCriteria.DateFrom, "2026-01-01");
  assert.equal(calls[0].SelectionCriteria.DateTo, "2026-01-31");
});

test("get_statistics fails when a campaign filter yields only the header row (0 data rows)", async () => {
  // Live Reports always echoes the column header, so tsv.trim() is never empty — the guard
  // must count DATA rows, not test for an empty string.
  const { calls, tools } = harness(() => `${CAMPAIGN_HEADER}\n`);
  const res = await tools.get_statistics({ campaignIds: [999] });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /0 rows for campaignIds \[999\]/);
  assert.equal(calls.length, 1); // the report WAS requested; the failure is post-hoc
});

test("get_statistics returns the raw TSV when a campaign filter has data rows", async () => {
  const { tools } = harness(() => `${CAMPAIGN_HEADER}\n123\tMy campaign\t100\t20\t50.00\t20\t2.5\n`);
  const res = await tools.get_statistics({ campaignIds: [123] });
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /My campaign/);
});
