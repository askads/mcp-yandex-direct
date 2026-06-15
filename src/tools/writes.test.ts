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
function harness(register: (server: any, client: any) => void) {
  const calls: RecordedCall[] = [];
  const tools: Record<string, Handler> = {};
  const client = {
    call: async (service: string, method: string, params: Record<string, unknown>) => {
      calls.push({ service, method, params });
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
  const res = await tools.update_campaign({ id: 7, name: "New", dailyBudgetAmount: 100 });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].method, "update");
  assert.deepEqual(calls[0].params.Campaigns[0], {
    Id: 7,
    Name: "New",
    DailyBudget: { Amount: 100_000_000, Mode: "STANDARD" },
  });
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
