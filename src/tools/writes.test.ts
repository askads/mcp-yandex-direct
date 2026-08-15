import { test } from "node:test";
import assert from "node:assert/strict";
import { registerKeywordTools } from "./keywords.js";
import { registerCampaignTools } from "./campaigns.js";
import { registerAdGroupTools } from "./adGroups.js";
import { registerAdTools } from "./ads.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;
interface RecordedCall {
  service: string;
  method: string;
  params: Record<string, any>;
}

/** Registers tools against a fake server with a mock client so handlers run without network. */
function harness(register: (server: any, client: any) => void, opts: { getResult?: unknown } = {}) {
  const calls: RecordedCall[] = [];
  const tools: Record<string, Handler> = {};
  const client = {
    call: async (service: string, method: string, params: Record<string, unknown>) => {
      calls.push({ service, method, params });
      if (method === "get") return opts.getResult ?? {};
      const key = `${method[0].toUpperCase()}${method.slice(1)}Results`;
      return { [key]: [{ Id: 1 }] };
    },
  };
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  register(server, client);
  return { calls, tools };
}

test("set_keyword_bids converts bids to micros and calls keywordbids/set", async () => {
  const { calls, tools } = harness(registerKeywordTools);
  const res = await tools.set_keyword_bids({ bids: [{ keywordId: 5, bid: 1.5, contextBid: 2 }] });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].service, "keywordbids");
  assert.equal(calls[0].method, "set");
  assert.deepEqual(calls[0].params.KeywordBids[0], {
    KeywordId: 5,
    Bid: 1_500_000,
    ContextBid: 2_000_000,
  });
});

test("set_keyword_bids rejects an item with no target id and makes no call", async () => {
  const { calls, tools } = harness(registerKeywordTools);
  const res = await tools.set_keyword_bids({ bids: [{ bid: 1 }] });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test("set_keyword_bids rejects an item with no bid", async () => {
  const { calls, tools } = harness(registerKeywordTools);
  const res = await tools.set_keyword_bids({ bids: [{ keywordId: 5 }] });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test("update_campaign sends only provided fields and converts the budget", async () => {
  const { calls, tools } = harness(registerCampaignTools);
  const res = await tools.update_campaign({
    id: 7,
    name: "New",
    dailyBudgetAmount: 100,
    dailyBudgetMode: "STANDARD",
  });
  assert.equal(res.isError, undefined);
  // An explicit dailyBudgetMode goes straight to update — no read-before-write.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "update");
  assert.deepEqual(calls[0].params.Campaigns[0], {
    Id: 7,
    Name: "New",
    DailyBudget: { Amount: 100_000_000, Mode: "STANDARD" },
  });
});

test("update_campaign preserves the campaign's current budget mode when none is given", async () => {
  // Regression: Mode used to default to STANDARD, silently flipping a DISTRIBUTED
  // campaign into spend-as-fast-as-possible on any budget change.
  const { calls, tools } = harness(registerCampaignTools, {
    getResult: { Campaigns: [{ DailyBudget: { Amount: 1, Mode: "DISTRIBUTED" } }] },
  });
  const res = await tools.update_campaign({ id: 7, dailyBudgetAmount: 100 });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].method, "get");
  assert.deepEqual(calls[0].params.SelectionCriteria, { Ids: [7] });
  assert.deepEqual(calls[0].params.FieldNames, ["DailyBudget"]);
  assert.equal(calls[1].method, "update");
  assert.deepEqual(calls[1].params.Campaigns[0].DailyBudget, {
    Amount: 100_000_000,
    Mode: "DISTRIBUTED",
  });
});

test("update_campaign falls back to STANDARD when the campaign has no daily budget yet", async () => {
  const { calls, tools } = harness(registerCampaignTools, { getResult: { Campaigns: [{}] } });
  await tools.update_campaign({ id: 7, dailyBudgetAmount: 100 });
  assert.equal(calls[1].params.Campaigns[0].DailyBudget.Mode, "STANDARD");
});

test("update_campaign without a budget change does not read the campaign", async () => {
  const { calls, tools } = harness(registerCampaignTools);
  await tools.update_campaign({ id: 7, name: "Only name" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "update");
});

test("update_campaign rejects an empty update and makes no call", async () => {
  const { calls, tools } = harness(registerCampaignTools);
  const res = await tools.update_campaign({ id: 7 });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test("update_ad_group updates regions via adgroups/update", async () => {
  const { calls, tools } = harness(registerAdGroupTools);
  const res = await tools.update_ad_group({ id: 9, regionIds: [225] });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].method, "update");
  assert.deepEqual(calls[0].params.AdGroups[0], { Id: 9, RegionIds: [225] });
});

test("update_campaign sets negative keywords as NegativeKeywords.Items", async () => {
  const { calls, tools } = harness(registerCampaignTools);
  const res = await tools.update_campaign({ id: 7, negativeKeywords: ["free", "download"] });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls[0].params.Campaigns[0], {
    Id: 7,
    NegativeKeywords: { Items: ["free", "download"] },
  });
});

test("update_ad_group clears negative keywords with an empty array", async () => {
  const { calls, tools } = harness(registerAdGroupTools);
  const res = await tools.update_ad_group({ id: 9, negativeKeywords: [] });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls[0].params.AdGroups[0], { Id: 9, NegativeKeywords: { Items: [] } });
});

test("update_text_ad updates only provided fields", async () => {
  const { calls, tools } = harness(registerAdTools);
  const res = await tools.update_text_ad({ id: 3, title: "Hi" });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].method, "update");
  assert.deepEqual(calls[0].params.Ads[0], { Id: 3, TextAd: { Title: "Hi" } });
});

test("update_text_ad rejects an empty update", async () => {
  const { calls, tools } = harness(registerAdTools);
  const res = await tools.update_text_ad({ id: 3 });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test("delete_ad_groups calls adgroups/delete with the ids", async () => {
  const { calls, tools } = harness(registerAdGroupTools);
  const res = await tools.delete_ad_groups({ ids: [9, 10] });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].service, "adgroups");
  assert.equal(calls[0].method, "delete");
  assert.deepEqual(calls[0].params, { SelectionCriteria: { Ids: [9, 10] } });
});
