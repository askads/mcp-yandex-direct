/**
 * L2 — server-side aggregation for heavy statistics reports (SEARCH_QUERY, …).
 *
 * Pure functions, no network. Instead of returning thousands of raw TSV rows (which
 * the consumer then truncates to a sample), we compute the answer over 100% of rows
 * and return a compact, bounded summary:
 *   - totals over ALL rows (the true period total — correctness for "сколько всего");
 *   - a top-N detail list by a chosen metric (ranking — adaptive 95% cutoff for Cost);
 *   - a tail rollup of everything not shown;
 *   - zero-click / zero-conversion counts and a conversions>clicks anomaly slice.
 *
 * Field-aware: conversion-dependent numbers appear only when "Conversions" was among
 * the requested fieldNames. No server-side n-gram/bigram extraction (naive whitespace
 * tokenization breaks on Russian morphology — the model groups queries better).
 */

const METRIC_FIELDS = new Set([
  "Impressions",
  "Clicks",
  "Cost",
  "Ctr",
  "AvgCpc",
  "Conversions",
  "ConversionRate",
  "CostPerConversion",
  "BounceRate",
  "AvgPageviews",
]);

/** Metrics that are summable across rows (ratios like Ctr/AvgCpc are NOT summed). */
const SUMMABLE = ["Impressions", "Clicks", "Cost", "Conversions"];
/** Metrics shown in each detail row when present in the report. */
const DISPLAY_METRICS = [
  "Impressions",
  "Clicks",
  "Cost",
  "Ctr",
  "AvgCpc",
  "Conversions",
  "ConversionRate",
  "CostPerConversion",
  "BounceRate",
];

export const MAX_TOP_N = 100;
const DEFAULT_TOP_N = 50;
const COST_COVERAGE = 0.95; // adaptive cutoff: enough rows to cover 95% of detail Cost

export interface AggregateOptions {
  sortBy?: string;
  order?: "asc" | "desc";
  topN?: number;
  minCost?: number;
  queryContains?: string;
  zeroClicksOnly?: boolean;
  zeroConversionsOnly?: boolean;
}

export interface ReportAggregate {
  reportType: string;
  aggregated: true;
  rowsTotal: number;
  rowsReturned: number;
  sortBy: string;
  order: "asc" | "desc";
  hasConversions: boolean;
  totals: Record<string, number>;
  counts: Record<string, number>;
  filtered?: Record<string, number>;
  top: Array<Record<string, number | string>>;
  tail: Record<string, number>;
  anomalies?: Array<Record<string, number | string>>;
  note: string;
}

/** Parse a Yandex Reports cell into a number ("--" / "" → 0; tolerant of comma decimals). */
function num(v: string | undefined): number {
  if (v == null) return 0;
  const s = String(v).trim();
  if (s === "" || s === "--") return 0;
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

interface ParsedRow {
  dims: Record<string, string>;
  m: Record<string, number>;
}

/** Splits a TSV body into rows keyed positionally by fieldNames, dropping the column header. */
export function parseRows(tsv: string, fieldNames: string[]): ParsedRow[] {
  const rows: ParsedRow[] = [];
  let sawHeader = false;
  for (const line of tsv.split("\n")) {
    if (!line.trim()) continue;
    const cells = line.split("\t");
    // The Reports service keeps the column-header row in the TSV body — we strip
    // only the report header/summary via request headers, NOT skipColumnHeader.
    // Drop a leading line whose cells equal the requested fieldNames; otherwise it
    // parses as a phantom all-zero row (Query="Query", …) that inflates rowsTotal/
    // zeroClick by 1 and, on an empty slice, becomes the ONLY "row" → the model reads
    // "1 row, all zeros" and invents reasons instead of reporting an empty slice.
    if (!sawHeader) {
      sawHeader = true;
      if (cells.length === fieldNames.length && fieldNames.every((f, i) => cells[i] === f)) {
        continue;
      }
    }
    const dims: Record<string, string> = {};
    const m: Record<string, number> = {};
    fieldNames.forEach((f, i) => {
      const cell = cells[i] ?? "";
      if (METRIC_FIELDS.has(f)) m[f] = num(cell);
      else dims[f] = cell;
    });
    rows.push({ dims, m });
  }
  return rows;
}

/**
 * Counts DATA rows in a raw Reports TSV, reusing parseRows' header detection so the
 * always-present column-header row is not miscounted. Used by the raw-TSV report types
 * to detect "0 rows for the requested campaign filter" (tsv.trim() never empties on a
 * live report, which always echoes the header row).
 */
export function countDataRows(tsv: string, fieldNames: string[]): number {
  return parseRows(tsv, fieldNames).length;
}

function primaryDimension(fieldNames: string[]): string {
  for (const f of ["Query", "Criterion", "AdGroupName", "CampaignName"]) {
    if (fieldNames.includes(f)) return f;
  }
  return fieldNames.find((f) => !METRIC_FIELDS.has(f)) ?? "";
}

function sumMetrics(rows: ParsedRow[], keys: string[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const k of keys) t[k] = 0;
  for (const r of rows) for (const k of keys) t[k] += r.m[k] ?? 0;
  // Round Cost to 2 decimals to avoid float dust.
  if ("Cost" in t) t.Cost = Math.round(t.Cost * 100) / 100;
  return t;
}

export function aggregateReport(
  tsv: string,
  fieldNames: string[],
  reportType: string,
  opts: AggregateOptions = {},
): ReportAggregate {
  const rows = parseRows(tsv, fieldNames);
  const hasConversions = fieldNames.includes("Conversions");
  // zeroConversionsOnly is meaningless without conversion data — fail loudly instead of
  // silently ignoring the filter (which would look like "no zero-conversion rows").
  if (opts.zeroConversionsOnly && !hasConversions) {
    throw new Error(
      'zeroConversionsOnly needs conversion data — add "Conversions" to fieldNames.',
    );
  }
  const dimKey = primaryDimension(fieldNames);
  const sumKeys = SUMMABLE.filter((k) => fieldNames.includes(k));

  // Totals over 100% of rows — the true period total (this is the correctness point).
  const totals = sumMetrics(rows, sumKeys);
  const counts: Record<string, number> = {
    zeroClick: rows.filter((r) => (r.m.Clicks ?? 0) === 0).length,
  };
  if (hasConversions) {
    counts.zeroConversion = rows.filter(
      (r) => (r.m.Clicks ?? 0) > 0 && (r.m.Conversions ?? 0) === 0,
    ).length;
  }

  // Filtered set drives the detail list (totals above stay over 100%).
  let detail = rows;
  if (opts.minCost != null) detail = detail.filter((r) => (r.m.Cost ?? 0) >= opts.minCost!);
  if (opts.queryContains) {
    const q = opts.queryContains.toLowerCase();
    detail = detail.filter((r) => (r.dims[dimKey] ?? "").toLowerCase().includes(q));
  }
  if (opts.zeroClicksOnly) detail = detail.filter((r) => (r.m.Clicks ?? 0) === 0);
  if (opts.zeroConversionsOnly && hasConversions) {
    detail = detail.filter((r) => (r.m.Clicks ?? 0) > 0 && (r.m.Conversions ?? 0) === 0);
  }

  const sortBy = METRIC_FIELDS.has(opts.sortBy ?? "") ? (opts.sortBy as string) : "Cost";
  const order = opts.order === "asc" ? "asc" : "desc";
  const sorted = [...detail].sort((a, b) => {
    const d = (a.m[sortBy] ?? 0) - (b.m[sortBy] ?? 0);
    return order === "asc" ? d : -d;
  });

  const cap = Math.min(Math.max(opts.topN ?? DEFAULT_TOP_N, 1), MAX_TOP_N);
  let take = Math.min(cap, sorted.length);
  // Adaptive: for Cost desc, stop once cumulative cost covers 95% of the detail set —
  // no point listing thousands of ~0-cost rows.
  if (sortBy === "Cost" && order === "desc") {
    const detailCost = sorted.reduce((s, r) => s + (r.m.Cost ?? 0), 0);
    if (detailCost > 0) {
      let cum = 0;
      let n = 0;
      for (const r of sorted) {
        cum += r.m.Cost ?? 0;
        n++;
        if (cum >= COST_COVERAGE * detailCost) break;
      }
      take = Math.min(cap, n);
    }
  }

  const topRows = sorted.slice(0, take);
  const top = topRows.map((r) => {
    const o: Record<string, number | string> = { ...r.dims };
    for (const k of DISPLAY_METRICS) if (k in r.m) o[k] = r.m[k];
    return o;
  });

  // tail rolls up the detail rows not shown, so top + tail reconstruct the detail set.
  const tailRows = sorted.slice(take);
  const tail = { rows: tailRows.length, ...sumMetrics(tailRows, sumKeys) };

  const anomalies = hasConversions
    ? rows
        .filter((r) => (r.m.Conversions ?? 0) > (r.m.Clicks ?? 0))
        .slice(0, 10)
        .map((r) => ({
          [dimKey]: r.dims[dimKey] ?? "",
          clicks: r.m.Clicks ?? 0,
          conversions: r.m.Conversions ?? 0,
          reason: "conversions>clicks",
        }))
    : [];

  const filtered =
    detail.length !== rows.length
      ? { rows: detail.length, ...sumMetrics(detail, sumKeys) }
      : undefined;

  return {
    reportType,
    aggregated: true,
    rowsTotal: rows.length,
    rowsReturned: top.length,
    sortBy,
    order,
    hasConversions,
    totals, // over 100% of rows — the full-period total
    counts,
    ...(filtered ? { filtered } : {}),
    top,
    tail,
    ...(anomalies.length ? { anomalies } : {}),
    note:
      rows.length === 0
        ? "0 rows for this slice — the report ran fine but there is no search-query data " +
          "for this campaign/period. This means the slice is EMPTY, not that the report is " +
          "unavailable or access-restricted. Report it as empty and suggest checking the " +
          "campaign id / date range; do not invent causes (campaign type, autotargeting, rights)."
        : `totals are over all ${rows.length} row(s) (the full period, not a sample); ` +
          `top lists ${top.length} row(s) by ${sortBy} ${order}` +
          (filtered ? ` from ${detail.length} filtered row(s)` : "") +
          "; tail rolls up the rest.",
  };
}
