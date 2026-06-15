import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMoney, okOrPartial, toMicros } from "./util.js";

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join("");
}

test("okOrPartial reports success when every object has an Id", () => {
  const result = okOrPartial({ AddResults: [{ Id: 1 }, { Id: 2 }] });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /"Id": 1/);
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
  assert.match(text, /"Id": 1/);
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
  assert.equal(result.Campaigns[0].DailyBudget.Amount, 1000);
  assert.equal(result.Campaigns[0].Id, 7);
  assert.equal(result.Campaigns[1].DailyBudget, null);
});
