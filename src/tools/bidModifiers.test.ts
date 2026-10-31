import { test } from "node:test";
import assert from "node:assert/strict";
import { registerBidModifierTools } from "./bidModifiers.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function harness(response: unknown = { BidModifiers: [] }) {
  const calls: { service: string; method: string; params: any }[] = [];
  const tools: Record<string, Handler> = {};
  const client = {
    call: async (service: string, method: string, params: any) => {
      calls.push({ service, method, params });
      return structuredClone(response);
    },
  };
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerBidModifierTools(server as never, client as never);
  return { calls, tools };
}

test("get_bid_modifiers defaults Levels and requests type-specific fields", async () => {
  const { calls, tools } = harness();
  const res = await tools.get_bid_modifiers({ campaignIds: [1] });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].service, "bidmodifiers");
  assert.equal(calls[0].method, "get");
  assert.deepEqual(calls[0].params.SelectionCriteria.Levels, ["CAMPAIGN", "AD_GROUP"]);
  assert.deepEqual(calls[0].params.SelectionCriteria.CampaignIds, [1]);
  assert.ok(calls[0].params.MobileAdjustmentFieldNames.includes("BidModifier"));
  assert.ok(calls[0].params.DemographicsAdjustmentFieldNames.includes("Age"));
  // VIDEO_ADJUSTMENT is a supported type — its field selection must be requested too.
  assert.ok(calls[0].params.VideoAdjustmentFieldNames.includes("BidModifier"));
});

test("get_bid_modifiers requires a selection and otherwise makes no call", async () => {
  const { calls, tools } = harness();
  const res = await tools.get_bid_modifiers({});
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test("get_bid_modifiers passes through explicit levels and types", async () => {
  const { calls, tools } = harness();
  await tools.get_bid_modifiers({ adGroupIds: [5], levels: ["AD_GROUP"], types: ["MOBILE_ADJUSTMENT"] });
  assert.deepEqual(calls[0].params.SelectionCriteria.Levels, ["AD_GROUP"]);
  assert.deepEqual(calls[0].params.SelectionCriteria.Types, ["MOBILE_ADJUSTMENT"]);
});

test("add_bid_modifier maps a mobile adjustment", async () => {
  const { calls, tools } = harness();
  const res = await tools.add_bid_modifier({ campaignId: 7, mobile: { percent: 120, os: "IOS" } });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].method, "add");
  assert.deepEqual(calls[0].params.BidModifiers, [
    { CampaignId: 7, MobileAdjustment: { BidModifier: 120, OperatingSystemType: "IOS" } },
  ]);
});

test("add_bid_modifier sends one element per adjustment type in a single call", async () => {
  // BidModifierAddItem takes exactly one adjustment type; several in one element fail with
  // "Передано больше чем одно поле".
  const { calls, tools } = harness();
  await tools.add_bid_modifier({
    adGroupId: 9,
    mobile: { percent: 50 },
    demographics: [
      { gender: "GENDER_MALE", percent: 80 },
      { age: "AGE_55", percent: 120 },
    ],
    retargeting: [{ retargetingConditionId: 100, percent: 150 }],
    regional: [{ regionId: 225, percent: 110 }],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params.BidModifiers, [
    { AdGroupId: 9, MobileAdjustment: { BidModifier: 50 } },
    {
      AdGroupId: 9,
      DemographicsAdjustments: [
        { Gender: "GENDER_MALE", BidModifier: 80 },
        { Age: "AGE_55", BidModifier: 120 },
      ],
    },
    { AdGroupId: 9, RetargetingAdjustments: [{ RetargetingConditionId: 100, BidModifier: 150 }] },
    { AdGroupId: 9, RegionalAdjustments: [{ RegionId: 225, BidModifier: 110 }] },
  ]);
});

test("add_bid_modifier tags each AddResults entry with its type and surfaces a partial failure", async () => {
  const { tools } = harness({
    AddResults: [
      { Ids: [11] },
      { Errors: [{ Code: 8800, Message: "Объект не найден" }] },
    ],
  });
  const res = await tools.add_bid_modifier({
    campaignId: 7,
    desktop: { percent: 90 },
    regional: [{ regionId: 1, percent: 130 }],
  });
  assert.equal(res.isError, true);
  const body = JSON.parse(res.content[0].text.slice(res.content[0].text.indexOf("{")));
  assert.deepEqual(body.AddResults, [
    { Type: "DESKTOP_ADJUSTMENT", Ids: [11] },
    { Type: "REGIONAL_ADJUSTMENT", Errors: [{ Code: 8800, Message: "Объект не найден" }] },
  ]);
});

test("add_bid_modifier rejects zero or both targets", async () => {
  const { calls, tools } = harness();
  assert.equal((await tools.add_bid_modifier({ mobile: { percent: 100 } })).isError, true);
  assert.equal(
    (await tools.add_bid_modifier({ campaignId: 1, adGroupId: 2, mobile: { percent: 100 } })).isError,
    true,
  );
  assert.equal(calls.length, 0);
});

test("add_bid_modifier requires at least one adjustment", async () => {
  const { calls, tools } = harness();
  const res = await tools.add_bid_modifier({ campaignId: 7 });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test("set_bid_modifiers sends only Id and BidModifier (the fields bidmodifiers/set accepts)", async () => {
  // BidModifierSetItem has exactly Id + BidModifier; an extra Enabled key used to make
  // the API reject even a valid percent change (toggle was a separate, now-removed method).
  const { calls, tools } = harness();
  await tools.set_bid_modifiers({ bids: [{ id: 5, percent: 90 }] });
  assert.deepEqual(calls[0].params.BidModifiers[0], { Id: 5, BidModifier: 90 });
});

test("delete_bid_modifiers passes ids in SelectionCriteria", async () => {
  const { calls, tools } = harness();
  await tools.delete_bid_modifiers({ ids: [1, 2] });
  assert.deepEqual(calls[0].params, { SelectionCriteria: { Ids: [1, 2] } });
  assert.equal(calls[0].method, "delete");
});
