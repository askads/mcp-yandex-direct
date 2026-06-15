import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadMethod, registerRawTool } from "./raw.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function harness() {
  const calls: { service: string; method: string; params: unknown }[] = [];
  let tool: Handler | undefined;
  const client = {
    call: async (service: string, method: string, params: unknown) => {
      calls.push({ service, method, params });
      return { ok: true };
    },
  };
  const server = {
    registerTool: (_name: string, _cfg: unknown, handler: Handler) => {
      tool = handler;
    },
  };
  registerRawTool(server as never, client as never);
  return { calls, raw: tool as Handler };
}

test("isReadMethod recognizes get/has/check and rejects writes", () => {
  for (const m of ["get", "hasSearchVolume", "checkCampaigns", "checkDictionaries"]) {
    assert.equal(isReadMethod(m), true, m);
  }
  for (const m of ["add", "update", "delete", "set", "toggle", "moderate"]) {
    assert.equal(isReadMethod(m), false, m);
  }
});

test("raw_request runs a read method without confirmWrite", async () => {
  const { calls, raw } = harness();
  const res = await raw({ service: "bidmodifiers", method: "get", params: { foo: 1 } });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls[0], { service: "bidmodifiers", method: "get", params: { foo: 1 } });
});

test("raw_request blocks a write without confirmWrite and makes no call", async () => {
  const { calls, raw } = harness();
  const res = await raw({ service: "campaigns", method: "delete", params: {} });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test("raw_request runs a write when confirmWrite is true", async () => {
  const { calls, raw } = harness();
  const res = await raw({
    service: "sitelinks",
    method: "add",
    params: { SitelinksSets: [] },
    confirmWrite: true,
  });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].method, "add");
});

test("raw_request defaults params to an empty object", async () => {
  const { calls, raw } = harness();
  await raw({ service: "changes", method: "checkDictionaries" });
  assert.deepEqual(calls[0].params, {});
});
