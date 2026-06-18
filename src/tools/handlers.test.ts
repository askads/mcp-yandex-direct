import { test } from "node:test";
import assert from "node:assert/strict";
import { registerStatisticsTools } from "./statistics.js";
import { registerCampaignTools } from "./campaigns.js";
import { registerKeywordTools } from "./keywords.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** Fake server + mock client (call/report/getAll) so handlers run without network. */
function harness(
  register: (server: any, client: any) => void,
  opts: { callResult?: unknown; reportResult?: string } = {},
) {
  const calls: { service: string; method: string; params: any; getAll?: boolean }[] = [];
  const reports: { params: any }[] = [];
  const tools: Record<string, Handler> = {};
  const client = {
    call: async (service: string, method: string, params: any) => {
      calls.push({ service, method, params });
      return opts.callResult ?? {};
    },
    getAll: async (service: string, params: any) => {
      calls.push({ service, method: "get", params, getAll: true });
      return opts.callResult ?? {};
    },
    report: async (params: any) => {
      reports.push({ params });
      return opts.reportResult ?? "";
    },
  };
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  register(server, client);
  return { calls, reports, tools };
}

test("get_statistics infers CUSTOM_DATE from dates and builds a campaign filter", async () => {
  const { reports, tools } = harness(registerStatisticsTools, { reportResult: "TSV" });
  await tools.get_statistics({ dateFrom: "2026-01-01", dateTo: "2026-01-31", campaignIds: [1, 2] });
  const p = reports[0].params;
  assert.equal(p.DateRangeType, "CUSTOM_DATE");
  assert.equal(p.SelectionCriteria.DateFrom, "2026-01-01");
  assert.deepEqual(p.SelectionCriteria.Filter[0], {
    Field: "CampaignId",
    Operator: "IN",
    Values: ["1", "2"],
  });
});

test("get_statistics defaults to LAST_30_DAYS and per-type fields (no CampaignName for ACCOUNT)", async () => {
  const { reports, tools } = harness(registerStatisticsTools, { reportResult: "TSV" });
  await tools.get_statistics({ reportType: "ACCOUNT_PERFORMANCE_REPORT" });
  const p = reports[0].params;
  assert.equal(p.DateRangeType, "LAST_30_DAYS");
  assert.ok(!p.FieldNames.includes("CampaignName"));
});

test("get_statistics maps includeVat:false to IncludeVAT NO", async () => {
  const { reports, tools } = harness(registerStatisticsTools, { reportResult: "TSV" });
  await tools.get_statistics({ includeVat: false });
  assert.equal(reports[0].params.IncludeVAT, "NO");
});

test("get_statistics errors on CUSTOM_DATE without both dates and makes no request", async () => {
  const { reports, tools } = harness(registerStatisticsTools, { reportResult: "TSV" });
  const res = await tools.get_statistics({ dateRangeType: "CUSTOM_DATE", dateFrom: "2026-01-01" });
  assert.equal(res.isError, true);
  assert.equal(reports.length, 0);
});

test("ALL_TIME without a campaign filter is rejected for SEARCH_QUERY (no request)", async () => {
  const { reports, tools } = harness(registerStatisticsTools, { reportResult: "TSV" });
  const res = await tools.get_statistics({
    reportType: "SEARCH_QUERY_PERFORMANCE_REPORT",
    dateRangeType: "ALL_TIME",
  });
  assert.equal(res.isError, true);
  assert.equal(reports.length, 0);
});

test("ALL_TIME is allowed for SEARCH_QUERY when a campaign filter is present", async () => {
  const { reports, tools } = harness(registerStatisticsTools, { reportResult: "TSV" });
  const res = await tools.get_statistics({
    reportType: "SEARCH_QUERY_PERFORMANCE_REPORT",
    dateRangeType: "ALL_TIME",
    campaignIds: [1],
  });
  assert.ok(!res.isError);
  assert.equal(reports.length, 1);
});

test("explicit campaign filter with 0 rows fails loud (L3)", async () => {
  const { reports, tools } = harness(registerStatisticsTools, { reportResult: "" });
  const res = await tools.get_statistics({ campaignIds: [123], dateRangeType: "LAST_7_DAYS" });
  assert.equal(res.isError, true);
  assert.equal(reports.length, 1); // запрос сделан; ошибка — по факту 0 строк
  assert.match(res.content[0].text, /0 rows/);
});

test("SEARCH_QUERY returns a computed aggregate (L2), not raw rows", async () => {
  // Rows match DEFAULT SEARCH_QUERY fields: CampaignName, Query, Impr, Clicks, Cost, Ctr, AvgCpc.
  const tsv = ["EPK\tаудио в текст\t100\t20\t160.00\t20.0\t8.00", "EPK\tмусор\t40\t0\t0\t0\t0"].join(
    "\n",
  );
  const { tools } = harness(registerStatisticsTools, { reportResult: tsv });
  const res = await tools.get_statistics({ reportType: "SEARCH_QUERY_PERFORMANCE_REPORT" });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.aggregated, true);
  assert.equal(out.rowsTotal, 2);
  assert.equal(out.totals.Cost, 160);
  assert.equal(out.counts.zeroClick, 1);
  assert.equal(out.hasConversions, false); // Conversions not in default fields
});

test("non-heavy report (ACCOUNT) still returns raw TSV", async () => {
  const { tools } = harness(registerStatisticsTools, { reportResult: "raw\ttsv" });
  const res = await tools.get_statistics({ reportType: "ACCOUNT_PERFORMANCE_REPORT" });
  assert.equal(res.content[0].text, "raw\ttsv");
});

test("create_text_campaign applies the default strategy and converts the budget", async () => {
  const { calls, tools } = harness(registerCampaignTools, { callResult: { AddResults: [{ Id: 1 }] } });
  await tools.create_text_campaign({ name: "C", startDate: "2026-01-01", dailyBudgetAmount: 500 });
  const c = calls[0].params.Campaigns[0];
  assert.equal(c.DailyBudget.Amount, 500_000_000);
  assert.equal(c.TextCampaign.BiddingStrategy.Search.BiddingStrategyType, "HIGHEST_POSITION");
  assert.equal(c.TextCampaign.BiddingStrategy.Network.BiddingStrategyType, "SERVING_OFF");
});

test("list_campaigns sends only provided filters and normalizes money on output", async () => {
  const { calls, tools } = harness(registerCampaignTools, {
    callResult: { Campaigns: [{ Id: 1, DailyBudget: { Amount: 1_000_000_000, Mode: "STANDARD" } }] },
  });
  const res = await tools.list_campaigns({ states: ["ON"], limit: 5 });
  assert.deepEqual(calls[0].params.SelectionCriteria, { States: ["ON"] });
  assert.deepEqual(calls[0].params.Page, { Limit: 5, Offset: 0 });
  assert.match(res.content[0].text, /"Amount":1000/);
});

test("list_campaigns autoPaginate routes through getAll", async () => {
  const { calls, tools } = harness(registerCampaignTools, { callResult: { Campaigns: [] } });
  await tools.list_campaigns({ autoPaginate: true });
  assert.equal(calls[0].getAll, true);
});

test("add_keywords builds the payload with micros bids", async () => {
  const { calls, tools } = harness(registerKeywordTools, { callResult: { AddResults: [{ Id: 1 }] } });
  await tools.add_keywords({ adGroupId: 5, keywords: [{ keyword: "x", bid: 1, contextBid: 2 }] });
  assert.deepEqual(calls[0].params.Keywords[0], {
    AdGroupId: 5,
    Keyword: "x",
    Bid: 1_000_000,
    ContextBid: 2_000_000,
  });
});
