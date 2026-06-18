import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FIELDS_BY_TYPE, REPORT_TYPES } from "./statistics.js";
import { aggregateReport } from "./statistics.aggregate.js";

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
