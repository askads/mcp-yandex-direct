import { test } from "node:test";
import assert from "node:assert/strict";
import { registerNegativeKeywordTools } from "./negativeKeywords.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;
interface RecordedCall {
  service: string;
  method: string;
  params: Record<string, any>;
}

/** Fake server + mock client: `get` returns getResult, `update` returns updateResult. */
function harness(opts: { getResult?: unknown; updateResult?: unknown } = {}) {
  const calls: RecordedCall[] = [];
  const tools: Record<string, Handler> = {};
  const client = {
    call: async (service: string, method: string, params: Record<string, any>) => {
      calls.push({ service, method, params });
      if (method === "get") return opts.getResult ?? {};
      return opts.updateResult ?? { UpdateResults: [{ Id: 1 }] };
    },
  };
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerNegativeKeywordTools(server as any, client as any);
  return { calls, run: tools.update_negative_keywords };
}

const body = (res: { content: { text: string }[] }) => {
  const text = res.content[0].text;
  return JSON.parse(text.slice(text.indexOf("{")));
};

const campaign = (items: string[] | null) => ({
  Campaigns: [{ Id: 7, NegativeKeywords: items === null ? null : { Items: items } }],
});

test("add reads the campaign list and writes current + new phrases", async () => {
  const { calls, run } = harness({ getResult: campaign(["free", "download"]) });
  const res = await run({ campaignId: 7, action: "add", phrases: ["скачать", "FREE"] });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.map((c) => `${c.service}.${c.method}`), ["campaigns.get", "campaigns.update"]);
  assert.deepEqual(calls[0].params, {
    SelectionCriteria: { Ids: [7] },
    FieldNames: ["Id", "NegativeKeywords"],
  });
  assert.deepEqual(calls[1].params.Campaigns[0], {
    Id: 7,
    NegativeKeywords: { Items: ["free", "download", "скачать"] },
  });
  const out = body(res);
  assert.equal(out.changed, true);
  assert.equal(out.before, 2);
  assert.equal(out.after, 3);
  assert.deepEqual(out.added, ["скачать"]);
  assert.deepEqual(out.alreadyPresent, ["FREE"]);
});

test("add into an empty list works when the API returns null", async () => {
  const { calls, run } = harness({ getResult: campaign(null) });
  await run({ campaignId: 7, action: "add", phrases: ["free"] });
  assert.deepEqual(calls[1].params.Campaigns[0].NegativeKeywords, { Items: ["free"] });
});

test("add collapses repeats inside the input (API rejects exact repeats, code 9802)", async () => {
  const { calls, run } = harness({ getResult: campaign([]) });
  await run({ campaignId: 7, action: "add", phrases: ["купить  дёшево", "Купить дёшево", "купить дёшево"] });
  assert.deepEqual(calls[1].params.Campaigns[0].NegativeKeywords, { Items: ["купить дёшево"] });
});

test("add with nothing new writes nothing and says changed: false", async () => {
  const { calls, run } = harness({ getResult: campaign(["free"]) });
  const res = await run({ campaignId: 7, action: "add", phrases: ["Free"] });
  assert.equal(res.isError, undefined);
  assert.equal(calls.length, 1);
  const out = body(res);
  assert.equal(out.changed, false);
  assert.deepEqual(out.alreadyPresent, ["Free"]);
  assert.equal(out.after, 1);
});

test("remove drops matching phrases and reports what was not found", async () => {
  const { calls, run } = harness({ getResult: campaign(["free", "download", "music"]) });
  const res = await run({ campaignId: 7, action: "remove", phrases: ["DOWNLOAD", "youtube"] });
  assert.deepEqual(calls[1].params.Campaigns[0].NegativeKeywords, { Items: ["free", "music"] });
  const out = body(res);
  assert.deepEqual(out.removed, ["download"]);
  assert.deepEqual(out.notFound, ["youtube"]);
  assert.equal(out.before, 3);
  assert.equal(out.after, 2);
});

test("remove of the last phrase clears the field with null", async () => {
  const { calls, run } = harness({ getResult: campaign(["free"]) });
  await run({ campaignId: 7, action: "remove", phrases: ["free"] });
  assert.equal(calls[1].params.Campaigns[0].NegativeKeywords, null);
});

test("remove with nothing to remove writes nothing", async () => {
  const { calls, run } = harness({ getResult: campaign(["free"]) });
  const out = body(await run({ campaignId: 7, action: "remove", phrases: ["music"] }));
  assert.equal(calls.length, 1);
  assert.equal(out.changed, false);
  assert.deepEqual(out.notFound, ["music"]);
});

test("replace writes exactly the given list without reading", async () => {
  const { calls, run } = harness();
  const res = await run({ adGroupId: 9, action: "replace", phrases: ["a", "b"] });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.map((c) => `${c.service}.${c.method}`), ["adgroups.update"]);
  assert.deepEqual(calls[0].params.AdGroups[0], { Id: 9, NegativeKeywords: { Items: ["a", "b"] } });
});

test("clear sends null without reading", async () => {
  const { calls, run } = harness();
  const out = body(await run({ adGroupId: 9, action: "clear" }));
  assert.deepEqual(calls.map((c) => `${c.service}.${c.method}`), ["adgroups.update"]);
  assert.deepEqual(calls[0].params.AdGroups[0], { Id: 9, NegativeKeywords: null });
  assert.equal(out.after, 0);
});

test("ad groups are read through adgroups.get", async () => {
  const { calls, run } = harness({ getResult: { AdGroups: [{ Id: 9, NegativeKeywords: { Items: ["x"] } }] } });
  await run({ adGroupId: 9, action: "add", phrases: ["y"] });
  assert.equal(calls[0].service, "adgroups");
  assert.deepEqual(calls[1].params.AdGroups[0].NegativeKeywords, { Items: ["x", "y"] });
});

test("rejects bad input before any call", async () => {
  const cases: Args[] = [
    { action: "add", phrases: ["x"] }, // no target
    { campaignId: 7, adGroupId: 9, action: "add", phrases: ["x"] }, // both targets
    { campaignId: 7, action: "add" }, // no phrases
    { campaignId: 7, action: "replace", phrases: [] }, // empty replace — clear is explicit
    { campaignId: 7, action: "clear", phrases: ["x"] }, // phrases with clear
  ];
  for (const args of cases) {
    const { calls, run } = harness();
    const res = await run(args);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});

test("a missing object is an error and nothing is written", async () => {
  const { calls, run } = harness({ getResult: { Campaigns: [] } });
  const res = await run({ campaignId: 7, action: "add", phrases: ["x"] });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 1);
});

test("a per-object API error surfaces as isError with changed: false", async () => {
  const { run } = harness({
    getResult: campaign([]),
    updateResult: { UpdateResults: [{ Errors: [{ Code: 5140, Message: "Слишком много слов" }] }] },
  });
  const res = await run({ campaignId: 7, action: "add", phrases: ["a b c d e f g h"] });
  assert.equal(res.isError, true);
  const out = body(res);
  assert.equal(out.changed, false);
  assert.equal("after" in out, false, "no after for a write that did not happen");
  assert.match(out.note, /не изменился/);
});
