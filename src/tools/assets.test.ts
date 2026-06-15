import { test } from "node:test";
import assert from "node:assert/strict";
import { registerAssetTools } from "./assets.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function harness() {
  const calls: { service: string; method: string; params: any }[] = [];
  const tools: Record<string, Handler> = {};
  const client = {
    call: async (service: string, method: string, params: any) => {
      calls.push({ service, method, params });
      return { AddResults: [{ Id: 1 }] };
    },
  };
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerAssetTools(server as never, client as never);
  return { calls, tools };
}

test("get_sitelinks requests SitelinkFieldNames and empty selection without ids", async () => {
  const { calls, tools } = harness();
  await tools.get_sitelinks({});
  assert.equal(calls[0].service, "sitelinks");
  assert.equal(calls[0].method, "get");
  assert.deepEqual(calls[0].params.SelectionCriteria, {});
  assert.ok(calls[0].params.SitelinkFieldNames.includes("Title"));
});

test("get_sitelinks filters by ids and paginates", async () => {
  const { calls, tools } = harness();
  await tools.get_sitelinks({ ids: [3], limit: 10, offset: 5 });
  assert.deepEqual(calls[0].params.SelectionCriteria, { Ids: [3] });
  assert.deepEqual(calls[0].params.Page, { Limit: 10, Offset: 5 });
});

test("create_sitelinks_set maps links into SitelinksSets", async () => {
  const { calls, tools } = harness();
  const res = await tools.create_sitelinks_set({
    sitelinks: [{ title: "Прайс", href: "https://x.test/price" }],
  });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].method, "add");
  assert.deepEqual(calls[0].params.SitelinksSets[0], {
    Sitelinks: [{ Title: "Прайс", Href: "https://x.test/price" }],
  });
});

test("delete_sitelinks passes ids in SelectionCriteria", async () => {
  const { calls, tools } = harness();
  await tools.delete_sitelinks({ ids: [7] });
  assert.deepEqual(calls[0].params, { SelectionCriteria: { Ids: [7] } });
});
