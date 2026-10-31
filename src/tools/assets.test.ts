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

test("get_sitelinks fetches by required ids and requests SitelinkFieldNames", async () => {
  const { calls, tools } = harness();
  await tools.get_sitelinks({ ids: [3] });
  assert.equal(calls[0].service, "sitelinks");
  assert.equal(calls[0].method, "get");
  assert.deepEqual(calls[0].params.SelectionCriteria, { Ids: [3] });
  assert.ok(calls[0].params.SitelinkFieldNames.includes("Title"));
});

test("get_sitelinks paginates", async () => {
  const { calls, tools } = harness();
  await tools.get_sitelinks({ ids: [3], limit: 10, offset: 5 });
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

test("get_callouts targets adextensions with the CALLOUT type and CalloutFieldNames", async () => {
  const { calls, tools } = harness();
  await tools.get_callouts({});
  assert.equal(calls[0].service, "adextensions");
  assert.deepEqual(calls[0].params.SelectionCriteria, { Types: ["CALLOUT"] });
  assert.deepEqual(calls[0].params.CalloutFieldNames, ["CalloutText"]);
});

test("add_callouts wraps each text in a Callout extension", async () => {
  const { calls, tools } = harness();
  const res = await tools.add_callouts({ texts: ["Доставка 24/7", "Гарантия"] });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].method, "add");
  assert.deepEqual(calls[0].params.AdExtensions, [
    { Callout: { CalloutText: "Доставка 24/7" } },
    { Callout: { CalloutText: "Гарантия" } },
  ]);
});

test("delete_callouts passes ids in SelectionCriteria", async () => {
  const { calls, tools } = harness();
  await tools.delete_callouts({ ids: [11] });
  assert.deepEqual(calls[0].params, { SelectionCriteria: { Ids: [11] } });
});

test("vcard tools are not registered: Direct answers 3500 to every vcards method", () => {
  const { tools } = harness();
  for (const name of ["get_vcards", "create_vcard", "delete_vcards"]) assert.equal(tools[name], undefined, name);
});
