import { test } from "node:test";
import assert from "node:assert/strict";
import { registerExcludedSiteTools } from "./excludedSites.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;
interface RecordedCall {
  service: string;
  method: string;
  params: Record<string, any>;
}

function harness(getResult: unknown = {}) {
  const calls: RecordedCall[] = [];
  const tools: Record<string, Handler> = {};
  const client = {
    call: async (service: string, method: string, params: Record<string, any>) => {
      calls.push({ service, method, params });
      return method === "get" ? getResult : { UpdateResults: [{ Id: 7 }] };
    },
  };
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerExcludedSiteTools(server as any, client as any);
  return { calls, run: tools.update_excluded_sites };
}

const body = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);
const campaign = (items: string[] | null) => ({
  Campaigns: [{ Id: 7, ExcludedSites: items === null ? null : { Items: items } }],
});

test("add reads ExcludedSites and writes the merged list", async () => {
  const { calls, run } = harness(campaign(["example.org"]));
  const res = await run({ campaignId: 7, action: "add", sites: ["com.example.app", "BidSwitch"] });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls[0].params.FieldNames, ["Id", "ExcludedSites"]);
  assert.deepEqual(calls[1].params.Campaigns[0], {
    Id: 7,
    ExcludedSites: { Items: ["example.org", "com.example.app", "BidSwitch"] },
  });
  assert.deepEqual(body(res).added, ["com.example.app", "BidSwitch"]);
});

test("a www./case variant of a stored domain counts as already excluded", async () => {
  // The API stores "www.Example.org" as "example.org" (checked live).
  const { calls, run } = harness(campaign(["example.org"]));
  const out = body(await run({ campaignId: 7, action: "add", sites: ["www.Example.org"] }));
  assert.equal(calls.length, 1);
  assert.equal(out.changed, false);
  assert.deepEqual(out.alreadyPresent, ["www.Example.org"]);
});

test("remove matches www./case variants and reports misses", async () => {
  const { calls, run } = harness(campaign(["example.org", "bad.ru"]));
  const out = body(await run({ campaignId: 7, action: "remove", sites: ["WWW.bad.ru", "other.com"] }));
  assert.deepEqual(calls[1].params.Campaigns[0].ExcludedSites, { Items: ["example.org"] });
  assert.deepEqual(out.removed, ["bad.ru"]);
  assert.deepEqual(out.notFound, ["other.com"]);
});

test("clear sends ExcludedSites: null without reading", async () => {
  const { calls, run } = harness();
  await run({ campaignId: 7, action: "clear" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.Campaigns[0].ExcludedSites, null);
});

test("rejects a URL with a protocol and an empty replace before any call", async () => {
  for (const args of [
    { campaignId: 7, action: "add", sites: ["https://example.com"] },
    { campaignId: 7, action: "replace", sites: [] },
    { campaignId: 7, action: "clear", sites: ["x.ru"] },
  ]) {
    const { calls, run } = harness();
    const res = await run(args);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});
