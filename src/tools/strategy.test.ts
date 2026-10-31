import { test } from "node:test";
import assert from "node:assert/strict";
import { registerStrategyTools } from "./strategy.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;
interface RecordedCall {
  service: string;
  method: string;
  params: Record<string, any>;
}

function harness(getResult: unknown) {
  const calls: RecordedCall[] = [];
  const tools: Record<string, Handler> = {};
  const client = {
    call: async (service: string, method: string, params: Record<string, any>) => {
      calls.push({ service, method, params });
      return method === "get" ? structuredClone(getResult) : { UpdateResults: [{ Id: 7 }] };
    },
  };
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerStrategyTools(server as any, client as any);
  return { calls, run: tools.set_campaign_strategy };
}

const body = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);

const UNIFIED = {
  Campaigns: [
    {
      Id: 7,
      Type: "UNIFIED_CAMPAIGN",
      UnifiedCampaign: {
        BiddingStrategy: {
          Search: {
            BiddingStrategyType: "AVERAGE_CPA_MULTIPLE_GOALS",
            AverageCpaMultipleGoals: { WeeklySpendLimit: 3_000_000_000, BidCeiling: null },
          },
          Network: { BiddingStrategyType: "SERVING_OFF" },
        },
        PackageBiddingStrategy: null,
      },
    },
  ],
};

const NEW_SEARCH = {
  BiddingStrategyType: "AVERAGE_CPA_MULTIPLE_GOALS",
  AverageCpaMultipleGoals: { WeeklySpendLimit: 5000, BidCeiling: 30, BudgetIncreasePercent: 20 },
};

test("ЕПК: strategy goes under UnifiedCampaign with money in micros, percents untouched", async () => {
  const { calls, run } = harness(UNIFIED);
  const res = await run({ id: 7, search: NEW_SEARCH, network: { BiddingStrategyType: "SERVING_OFF" } });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.map((c) => c.method), ["get", "update"]);
  assert.deepEqual(calls[0].params.UnifiedCampaignFieldNames, ["BiddingStrategy", "PackageBiddingStrategy"]);
  assert.deepEqual(calls[1].params.Campaigns[0], {
    Id: 7,
    UnifiedCampaign: {
      BiddingStrategy: {
        Search: {
          BiddingStrategyType: "AVERAGE_CPA_MULTIPLE_GOALS",
          AverageCpaMultipleGoals: { WeeklySpendLimit: 5_000_000_000, BidCeiling: 30_000_000, BudgetIncreasePercent: 20 },
        },
        Network: { BiddingStrategyType: "SERVING_OFF" },
      },
    },
  });
});

test("answer carries previous (in currency) and sent (as given)", async () => {
  const { run } = harness(UNIFIED);
  const out = body(await run({ id: 7, search: NEW_SEARCH, network: { BiddingStrategyType: "SERVING_OFF" } }));
  assert.equal(out.campaignType, "UNIFIED_CAMPAIGN");
  assert.equal(out.previous.Search.AverageCpaMultipleGoals.WeeklySpendLimit, 3000);
  assert.equal(out.sent.Search.AverageCpaMultipleGoals.WeeklySpendLimit, 5000);
  assert.deepEqual(out.UpdateResults, [{ Id: 7 }]);
});

test("text campaign: strategy goes under TextCampaign", async () => {
  const { calls, run } = harness({
    Campaigns: [{ Id: 7, Type: "TEXT_CAMPAIGN", TextCampaign: { BiddingStrategy: {}, PackageBiddingStrategy: null } }],
  });
  await run({
    id: 7,
    search: { BiddingStrategyType: "WB_MAXIMUM_CLICKS", WbMaximumClicks: { WeeklySpendLimit: 1000 } },
    network: { BiddingStrategyType: "NETWORK_DEFAULT", NetworkDefault: {} },
  });
  const sent = calls[1].params.Campaigns[0];
  assert.equal("UnifiedCampaign" in sent, false);
  assert.equal(sent.TextCampaign.BiddingStrategy.Search.WbMaximumClicks.WeeklySpendLimit, 1_000_000_000);
});

test("other campaign types and package strategies are refused without a write", async () => {
  for (const getResult of [
    { Campaigns: [{ Id: 7, Type: "SMART_CAMPAIGN" }] },
    { Campaigns: [{ Id: 7, Type: "UNIFIED_CAMPAIGN", UnifiedCampaign: { PackageBiddingStrategy: { Id: 3 } } }] },
    { Campaigns: [] },
  ]) {
    const { calls, run } = harness(getResult);
    const res = await run({ id: 7, search: NEW_SEARCH, network: { BiddingStrategyType: "SERVING_OFF" } });
    assert.equal(res.isError, true, JSON.stringify(getResult));
    assert.equal(calls.length, 1, "only the get");
  }
});
