import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_PAGE_LIMIT,
  buildPage,
  compact,
  isoDate,
  normalizeMoney,
  ok,
  okOrPartial,
  toMicros,
} from "./util.js";

function textOf(result: CallToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

test("ok() emits valid text content even when data is undefined", () => {
  // Regression: JSON.stringify(undefined) is undefined, which produced
  // {type:"text", text: undefined} → rejected by the MCP SDK as invalid content.
  const result = ok(undefined);
  assert.equal(result.content[0].type, "text");
  assert.equal(textOf(result), "null");
});

test("okOrPartial reports success when every object has an Id", () => {
  const result = okOrPartial({ AddResults: [{ Id: 1 }, { Id: 2 }] });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /"Id":1/);
});

test("okOrPartial flags a partial failure as an error", () => {
  const result = okOrPartial({
    AddResults: [
      { Id: 1 },
      { Errors: [{ Code: 5006, Message: "Object not found", Details: "AdGroupId 1" }] },
    ],
  });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /1 of 2 object\(s\) failed/);
  assert.match(text, /\[5006\] Object not found: AdGroupId 1/);
  // the full payload is still included for context
  assert.match(text, /"Id":1/);
});

test("okOrPartial flags an all-failed action response", () => {
  const result = okOrPartial({
    ActionResults: [{ Errors: [{ Code: 8800, Message: "No rights" }] }],
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /All 1 object\(s\) failed/);
});

test("okOrPartial ignores arrays that are not *Results", () => {
  const result = okOrPartial({ Campaigns: [{ Id: 1, Errors: [{ Message: "x" }] }] });
  assert.equal(result.isError, undefined);
});

test("compact drops only undefined values, keeping null/0/empty", () => {
  assert.deepEqual(compact({ a: 1, b: undefined, c: null, d: 0, e: "" }), {
    a: 1,
    c: null,
    d: 0,
    e: "",
  });
});

test("isoDate accepts YYYY-MM-DD and rejects other formats", () => {
  assert.equal(isoDate.safeParse("2026-06-15").success, true);
  assert.equal(isoDate.safeParse("2026-6-15").success, false);
  assert.equal(isoDate.safeParse("15.06.2026").success, false);
  assert.equal(isoDate.safeParse("yesterday").success, false);
});

test("buildPage defaults Limit/Offset and skips when nothing is requested", () => {
  assert.equal(buildPage(undefined, undefined), undefined);
  assert.deepEqual(buildPage(50, 10), { Limit: 50, Offset: 10 });
  assert.deepEqual(buildPage(undefined, 20), { Limit: DEFAULT_PAGE_LIMIT, Offset: 20 });
  assert.deepEqual(buildPage(50, undefined), { Limit: 50, Offset: 0 });
});

test("toMicros rounds currency units to integer micros", () => {
  assert.equal(toMicros(0.3), 300000);
  assert.equal(toMicros(12.34), 12340000);
});

test("normalizeMoney converts keyword bids from micros to units", () => {
  const result = normalizeMoney({
    Keywords: [{ Id: 1, Keyword: "x", Bid: 300000, ContextBid: 12340000 }],
  });
  assert.deepEqual(result.Keywords[0], { Id: 1, Keyword: "x", Bid: 0.3, ContextBid: 12.34 });
});

test("normalizeMoney converts nested DailyBudget.Amount and leaves null/non-money alone", () => {
  const result = normalizeMoney({
    Campaigns: [
      { Id: 7, DailyBudget: { Amount: 1_000_000_000, Mode: "STANDARD" } },
      { Id: 8, DailyBudget: null },
    ],
  });
  assert.equal(result.Campaigns[0].DailyBudget?.Amount, 1000);
  assert.equal(result.Campaigns[0].Id, 7);
  assert.equal(result.Campaigns[1].DailyBudget, null);
});
