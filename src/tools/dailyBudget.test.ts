import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCampaignTools } from "./campaigns.js";

/**
 * Through the real SDK, not a fake server: the SDK validates arguments against the
 * zod schema and strips keys it does not know, so a test that bypasses it cannot show
 * what a client with a cached tools/list (ChatGPT keeps it per chat) actually gets.
 */
async function connected() {
  const calls: { method: string; params: Record<string, any> }[] = [];
  const client = {
    call: async (_service: string, method: string, params: Record<string, any>) => {
      calls.push({ method, params });
      return { AddResults: [{ Id: 1 }], UpdateResults: [{ Id: 1 }] };
    },
  };
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerCampaignTools(server, client as any);
  const mcp = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  const callTool = async (name: string, args: Record<string, unknown>) =>
    (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { calls, callTool };
}

test("create_text_campaign: a cached-schema client sending dailyBudgetAmount is refused, no API call", async () => {
  for (const args of [{ dailyBudgetAmount: 500 }, { dailyBudgetMode: "STANDARD" }, { dailyBudgetAmount: 500, dailyBudgetMode: "DISTRIBUTED" }]) {
    const { calls, callTool } = await connected();
    const res = await callTool("create_text_campaign", { name: "C", startDate: "2026-01-01", ...args });
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.match(res.content[0].text, /weeklyBudgetAmount/);
    assert.equal(calls.length, 0, "no campaign without its budget");
  }
});

test("update_campaign: a cached-schema client sending the daily budget is refused, no API call", async () => {
  for (const args of [{ dailyBudgetAmount: 100 }, { dailyBudgetMode: "DISTRIBUTED" }]) {
    const { calls, callTool } = await connected();
    const res = await callTool("update_campaign", { id: 7, name: "New", ...args });
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.match(res.content[0].text, /set_campaign_strategy/);
    assert.equal(calls.length, 0, "no rename that silently skips the budget");
  }
});

test("create_text_campaign: weeklyBudgetAmount survives the SDK and lands in HighestPosition", async () => {
  const { calls, callTool } = await connected();
  const res = await callTool("create_text_campaign", { name: "C", startDate: "2026-01-01", weeklyBudgetAmount: 500 });
  assert.equal(res.isError, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params.Campaigns[0].TextCampaign.BiddingStrategy.Search, {
    BiddingStrategyType: "HIGHEST_POSITION",
    HighestPosition: { WeeklySpendLimit: 500_000_000 },
  });
});
