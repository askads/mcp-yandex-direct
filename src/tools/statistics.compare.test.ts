import { test } from "node:test";
import assert from "node:assert/strict";
import { compareReports } from "./statistics.compare.js";
import { registerStatisticsTools } from "./statistics.js";

const FIELDS = ["CampaignId", "CampaignName", "Impressions", "Clicks", "Cost", "Ctr"];
const HEADER = FIELDS.join("\t");
const OCT = { dateFrom: "2026-10-01", dateTo: "2026-10-31" };
const SEP = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };

const CUR = [HEADER, "1\tПоиск\t1000\t50\t500\t5", "2\tРСЯ\t2000\t20\t100\t1", "3\tНовая\t100\t5\t50\t5"].join("\n");
const PREV = [HEADER, "1\tПоиск (старое имя)\t800\t40\t300\t5", "2\tРСЯ\t2000\t40\t400\t2", "4\tУдалённая\t10\t1\t10\t10"].join("\n");

test("rows are matched by id even after a rename, with Yandex values and their difference", () => {
  const out = compareReports(CUR, PREV, FIELDS, OCT, SEP);
  assert.deepEqual(out.matchKey, ["CampaignId"]);
  const search = out.rows.find((r) => r.CampaignId === "1")!;
  assert.equal(search.CampaignName, "Поиск");
  assert.deepEqual(search.current, { Impressions: 1000, Clicks: 50, Cost: 500, Ctr: 5 });
  assert.deepEqual(search.previous, { Impressions: 800, Clicks: 40, Cost: 300, Ctr: 5 });
  assert.equal(search.delta.Cost, 200);
  assert.equal(search.deltaPct.Cost, 66.67);
  assert.equal(search.delta.Ctr, 0, "ratio delta is the difference of Yandex's own values");
});

test("rows from one period only are flagged and get no ratio delta", () => {
  const out = compareReports(CUR, PREV, FIELDS, OCT, SEP);
  const fresh = out.rows.find((r) => r.CampaignId === "3")!;
  assert.equal(fresh.onlyIn, "current");
  assert.equal(fresh.previous, null);
  assert.equal(fresh.delta.Cost, 50);
  assert.equal(fresh.deltaPct.Cost, null, "growth from 0 is not a percent");
  assert.equal("Ctr" in fresh.delta, false);
  assert.equal(out.rows.find((r) => r.CampaignId === "4")!.onlyIn, "previous");
  assert.deepEqual(out.counts, { matched: 2, onlyCurrent: 1, onlyPrevious: 1 });
});

test("totals sum summable metrics only — ratios are not recomputed", () => {
  const out = compareReports(CUR, PREV, FIELDS, OCT, SEP);
  assert.deepEqual(out.totals.current, { Impressions: 3100, Clicks: 75, Cost: 650 });
  assert.deepEqual(out.totals.previous, { Impressions: 2810, Clicks: 81, Cost: 710 });
  assert.equal(out.totals.delta.Cost, -60);
  assert.equal("Ctr" in out.totals.current, false);
});

test("sorted by |delta Cost| by default; topN collapses the rest into tail", () => {
  const out = compareReports(CUR, PREV, FIELDS, OCT, SEP, { topN: 2 });
  assert.deepEqual(out.rows.map((r) => r.CampaignId), ["2", "1"]); // |−300| > |+200|
  assert.equal(out.tail!.rows, 2);
  assert.equal(out.current.days, 31);
  assert.equal(out.previous.days, 30);
});

test("other dimensions stay in the key next to the id (SEARCH and AD_NETWORK are two rows)", () => {
  const fields = ["CampaignId", "CampaignName", "AdNetworkType", "Clicks"];
  const h = fields.join("\t");
  const out = compareReports(
    `${h}\n1\tA\tSEARCH\t10\n1\tA\tAD_NETWORK\t5`,
    `${h}\n1\tA\tSEARCH\t4\n1\tA\tAD_NETWORK\t5`,
    fields,
    OCT,
    SEP,
  );
  assert.deepEqual(out.matchKey, ["CampaignId", "AdNetworkType"]);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows.find((r) => r.AdNetworkType === "SEARCH")!.delta.Clicks, 6);
});

test("without id columns the key is all dimensions", () => {
  const fields = ["Device", "Clicks", "Cost"];
  const out = compareReports("Device\tClicks\tCost\nMOBILE\t5\t50", "Device\tClicks\tCost\nMOBILE\t2\t20", fields, OCT, SEP);
  assert.deepEqual(out.matchKey, ["Device"]);
  assert.equal(out.rows[0].delta.Clicks, 3);
});

// --- handler ---

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function harness() {
  const calls: any[] = [];
  const tools: Record<string, Handler> = {};
  const client = {
    report: async (params: any) => {
      calls.push(params);
      return params.SelectionCriteria.DateFrom === OCT.dateFrom ? CUR : PREV;
    },
  };
  registerStatisticsTools({ registerTool: (n: string, _c: unknown, h: Handler) => (tools[n] = h) } as never, client as never);
  return { calls, run: tools.get_statistics };
}

test("compareTo runs two reports with the two periods and distinct names", async () => {
  const { calls, run } = harness();
  const res = await run({ ...OCT, compareTo: SEP, fieldNames: FIELDS, campaignIds: [1, 2] });
  assert.equal(res.isError, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[0].SelectionCriteria.DateFrom, calls[1].SelectionCriteria.DateFrom], ["2026-10-01", "2026-09-01"]);
  assert.deepEqual(calls[1].SelectionCriteria.Filter, calls[0].SelectionCriteria.Filter, "same filter in both");
  assert.notEqual(calls[0].ReportName, calls[1].ReportName);
  assert.equal(JSON.parse(res.content[0].text).compare, true);
});

test("compareTo refusals cost no report", async () => {
  for (const args of [
    { dateRangeType: "LAST_7_DAYS", compareTo: SEP },
    { ...OCT, compareTo: SEP, reportType: "SEARCH_QUERY_PERFORMANCE_REPORT" },
    { ...OCT, compareTo: SEP, fieldNames: ["Date", "Clicks"] },
    { ...OCT, compareTo: SEP, goals: ["1", "2"] },
  ]) {
    const { calls, run } = harness();
    const res = await run(args);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});
