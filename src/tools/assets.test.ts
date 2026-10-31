import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerAssetTools } from "./assets.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function harness() {
  const calls: { service: string; method: string; params: any }[] = [];
  const tools: Record<string, Handler> = {};
  const schemas: Record<string, z.ZodObject<z.ZodRawShape>> = {};
  const client = {
    call: async (service: string, method: string, params: any) => {
      calls.push({ service, method, params });
      return { AddResults: [{ Id: 1 }] };
    },
  };
  const server = {
    registerTool: (name: string, cfg: { inputSchema: z.ZodRawShape }, handler: Handler) => {
      tools[name] = handler;
      schemas[name] = z.object(cfg.inputSchema);
    },
  };
  registerAssetTools(server as never, client as never);
  return { calls, tools, schemas };
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

const link = (title: number, description = 0, href = 0) => ({
  title: "т".repeat(title),
  ...(description ? { description: "о".repeat(description) } : {}),
  ...(href ? { href: "https://x.test/" + "p".repeat(href - 15) } : {}),
});

test("create_sitelinks_set: documented maximum lengths pass the schema", () => {
  const { schemas } = harness();
  const sitelinks = Array.from({ length: 8 }, () => link(30, 60, 1024));
  assert.equal(sitelinks[0].href?.length, 1024);
  assert.equal(schemas.create_sitelinks_set.safeParse({ sitelinks }).success, true);
});

test("create_sitelinks_set: values over the API limits are rejected by the schema, before any request", () => {
  const { calls, schemas } = harness();
  const schema = schemas.create_sitelinks_set;
  for (const sitelinks of [
    [link(31)],
    [link(30, 61)],
    [link(30, 0, 1025)],
    Array.from({ length: 9 }, () => link(5)),
  ]) {
    assert.equal(schema.safeParse({ sitelinks }).success, false, JSON.stringify(sitelinks).slice(0, 80));
  }
  assert.equal(calls.length, 0);
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

test("add_callouts: 25 characters and 1000 texts pass, more is rejected by the schema", () => {
  const { calls, schemas } = harness();
  const schema = schemas.add_callouts;
  assert.equal(schema.safeParse({ texts: ["у".repeat(25)] }).success, true);
  assert.equal(schema.safeParse({ texts: Array(1000).fill("Гарантия") }).success, true);
  assert.equal(schema.safeParse({ texts: ["у".repeat(26)] }).success, false);
  assert.equal(schema.safeParse({ texts: Array(1001).fill("Гарантия") }).success, false);
  assert.equal(calls.length, 0);
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
