/**
 * Period-over-period comparison for get_statistics (compareTo). Pure: two TSV bodies in,
 * one aligned table out. Deliberately no "drivers" model — every number in the answer is
 * either a value Yandex reported or the difference of two such values; totals are sums
 * of summable metrics only (no recomputed ratios), so nothing needs our formula to read.
 */
import { METRIC_FIELDS, parseRows, SUMMABLE } from "./statistics.aggregate.js";

/** Time dimensions split a report by date — meaningless when the two periods are lined up. */
export const TIME_FIELDS = ["Date", "Week", "Month", "Quarter", "Year"];

export interface Period {
  dateFrom: string;
  dateTo: string;
}

export interface CompareOptions {
  sortBy?: string;
  topN?: number;
}

type Metrics = Record<string, number>;

interface CompareRow {
  [dim: string]: unknown;
  onlyIn?: "current" | "previous";
  current: Metrics | null;
  previous: Metrics | null;
  delta: Metrics;
  deltaPct: Record<string, number | null>;
}

/** Inclusive day count of a YYYY-MM-DD period. */
function days(p: Period): number {
  return Math.round((Date.parse(p.dateTo) - Date.parse(p.dateFrom)) / 86_400_000) + 1;
}

const round = (n: number) => Math.round(n * 100) / 100;

function diff(cur: Metrics | null, prev: Metrics | null, metrics: string[]) {
  const delta: Metrics = {};
  const deltaPct: Record<string, number | null> = {};
  for (const m of metrics) {
    // A row present in one period only: summable metrics compare against 0, ratios have no delta.
    const summable = SUMMABLE.includes(m);
    if ((!cur || !prev) && !summable) continue;
    const c = cur?.[m] ?? 0;
    const p = prev?.[m] ?? 0;
    delta[m] = round(c - p);
    deltaPct[m] = p === 0 ? null : round(((c - p) / p) * 100);
  }
  return { delta, deltaPct };
}

function sum(rows: (Metrics | null)[], metrics: string[]): Metrics {
  const out: Metrics = {};
  for (const m of metrics) {
    if (!SUMMABLE.includes(m)) continue;
    out[m] = round(rows.reduce((acc, r) => acc + (r?.[m] ?? 0), 0));
  }
  return out;
}

export function compareReports(
  currentTsv: string,
  previousTsv: string,
  fieldNames: string[],
  current: Period,
  previous: Period,
  opts: CompareOptions = {},
) {
  const metrics = fieldNames.filter((f) => METRIC_FIELDS.has(f));
  const dims = fieldNames.filter((f) => !METRIC_FIELDS.has(f));
  // Every dimension is part of the key (CampaignId + AdNetworkType are two rows), except a
  // name whose id is also requested: ids survive a rename, names do not.
  const nameOfId = (d: string) =>
    (d.endsWith("Name") && dims.includes(d.replace(/Name$/, "Id"))) || (d === "Criterion" && dims.includes("CriterionId"));
  const matchKey = dims.filter((d) => !nameOfId(d));
  const keyOf = (d: Record<string, string>) => matchKey.map((k) => d[k] ?? "").join("\u0001");

  const index = (tsv: string) => {
    const map = new Map<string, { dims: Record<string, string>; m: Metrics }>();
    for (const row of parseRows(tsv, fieldNames)) map.set(keyOf(row.dims), row);
    return map;
  };
  const cur = index(currentTsv);
  const prev = index(previousTsv);

  const rows: CompareRow[] = [];
  for (const key of new Set([...cur.keys(), ...prev.keys()])) {
    const c = cur.get(key);
    const p = prev.get(key);
    const curM = c?.m ?? null;
    const prevM = p?.m ?? null;
    rows.push({
      ...(c ?? p)!.dims,
      ...(c && !p ? { onlyIn: "current" as const } : {}),
      ...(p && !c ? { onlyIn: "previous" as const } : {}),
      current: curM,
      previous: prevM,
      ...diff(curM, prevM, metrics),
    });
  }

  const sortBy = opts.sortBy && metrics.includes(opts.sortBy) ? opts.sortBy : metrics.includes("Cost") ? "Cost" : metrics[0];
  rows.sort((a, b) => Math.abs(b.delta[sortBy] ?? 0) - Math.abs(a.delta[sortBy] ?? 0));
  const topN = opts.topN ?? 50;
  const shown = rows.slice(0, topN);
  const rest = rows.slice(topN);

  const totalsCur = sum([...cur.values()].map((r) => r.m), metrics);
  const totalsPrev = sum([...prev.values()].map((r) => r.m), metrics);
  return {
    compare: true,
    current: { ...current, days: days(current), rows: cur.size },
    previous: { ...previous, days: days(previous), rows: prev.size },
    matchKey,
    sortedBy: `|delta.${sortBy}|`,
    counts: {
      matched: rows.filter((r) => !r.onlyIn).length,
      onlyCurrent: rows.filter((r) => r.onlyIn === "current").length,
      onlyPrevious: rows.filter((r) => r.onlyIn === "previous").length,
    },
    totals: { current: totalsCur, previous: totalsPrev, ...diff(totalsCur, totalsPrev, Object.keys(totalsCur)) },
    rows: shown,
    ...(rest.length
      ? {
          tail: {
            rows: rest.length,
            current: sum(rest.map((r) => r.current), metrics),
            previous: sum(rest.map((r) => r.previous), metrics),
          },
        }
      : {}),
    note:
      "Числа — значения Яндекса за каждый период и их разность. totals — только суммы суммируемых метрик " +
      "(Impressions, Clicks, Cost, Conversions, Revenue, Profit); Ctr, AvgCpc и другие отношения в итогах не " +
      "пересчитываются. deltaPct = null — в прошлом периоде было 0 (это не бесконечный рост). У строки только " +
      "из одного периода (onlyIn) delta отношений не считается. Δ Ctr и ConversionRate — в процентных пунктах. " +
      "Нормализации на число дней нет — сравнивать периоды равной длины (см. days).",
  };
}
