import { test } from "node:test";
import assert from "node:assert/strict";
import { registerMediaTools } from "./media.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function harness() {
  const calls: { service: string; method: string; params: any }[] = [];
  const tools: Record<string, Handler> = {};
  const client = {
    call: async (service: string, method: string, params: any) => {
      calls.push({ service, method, params });
      return {};
    },
  };
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerMediaTools(server as never, client as never);
  return { calls, tools };
}

test("get_ad_images selects by hashes and reads adimages", async () => {
  const { calls, tools } = harness();
  await tools.get_ad_images({ hashes: ["abc"] });
  assert.equal(calls[0].service, "adimages");
  assert.deepEqual(calls[0].params.SelectionCriteria, { AdImageHashes: ["abc"] });
  assert.ok(calls[0].params.FieldNames.includes("AdImageHash"));
});

test("get_ad_videos selects by ids and reads advideos", async () => {
  const { calls, tools } = harness();
  await tools.get_ad_videos({ ids: [5], limit: 3 });
  assert.equal(calls[0].service, "advideos");
  assert.deepEqual(calls[0].params.SelectionCriteria, { Ids: [5] });
  assert.deepEqual(calls[0].params.Page, { Limit: 3, Offset: 0 });
});

test("get_creatives reads creatives with an empty selection by default", async () => {
  const { calls, tools } = harness();
  await tools.get_creatives({});
  assert.equal(calls[0].service, "creatives");
  assert.deepEqual(calls[0].params.SelectionCriteria, {});
});

test("upload_ad_image sends base64 to adimages/add", async () => {
  const { calls, tools } = harness();
  await tools.upload_ad_image({ name: "Cover", imageData: "QUJD" });
  assert.equal(calls[0].service, "adimages");
  assert.equal(calls[0].method, "add");
  assert.deepEqual(calls[0].params.AdImages[0], { Name: "Cover", ImageData: "QUJD" });
});

test("upload_ad_image strips a data: URL prefix from imageData", async () => {
  const { calls, tools } = harness();
  await tools.upload_ad_image({ name: "Cover", imageData: "data:image/png;base64,QUJD" });
  assert.equal(calls[0].params.AdImages[0].ImageData, "QUJD");
});

test("upload_ad_image rejects when neither url nor imageData is given", async () => {
  const { calls, tools } = harness();
  const res = await tools.upload_ad_image({ name: "Cover" });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test("upload_ad_image rejects a non-http(s) image URL before any fetch/upload", async () => {
  const { calls, tools } = harness();
  const res = await tools.upload_ad_image({ name: "Cover", url: "ftp://evil.example/x" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /http\(s\)/);
  assert.equal(calls.length, 0);
});
