import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedAddress, registerMediaTools } from "./media.js";

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

// ---- SSRF guard on model-supplied image URLs ----

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const original = globalThis.fetch;
  const fetches: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const u = String(url);
    const i = (init ?? {}) as RequestInit;
    fetches.push({ url: u, init: i });
    return handler(u, i);
  }) as typeof fetch;
  return {
    fetches,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("isBlockedAddress covers private, loopback, link-local and IPv6 forms", () => {
  for (const blocked of [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "::1",
    "::",
    "fd12::1", // ULA
    "fe80::1", // link-local
    "fe80::1%en0",
    "::ffff:127.0.0.1", // IPv4-mapped, dotted
    "::ffff:7f00:1", // IPv4-mapped, hex
    "not-an-ip",
  ]) {
    assert.equal(isBlockedAddress(blocked), true, `${blocked} must be blocked`);
  }
  for (const allowed of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2a02:6b8::2:242"]) {
    assert.equal(isBlockedAddress(allowed), false, `${allowed} must be allowed`);
  }
});

test("upload_ad_image rejects private/loopback/metadata URLs before any fetch", async () => {
  const mock = mockFetch(() => new Response("nope", { status: 200 }));
  try {
    const { calls, tools } = harness();
    for (const url of [
      "http://127.0.0.1/img.png",
      "http://10.0.0.5/img.png",
      "http://169.254.169.254/latest/meta-data",
      "http://192.168.1.1/router",
      "http://[::1]/img.png",
      "http://[::ffff:127.0.0.1]/img.png",
      "http://localhost/img.png", // resolves locally to loopback
    ]) {
      const res = await tools.upload_ad_image({ name: "Cover", url });
      assert.equal(res.isError, true, `${url} must be rejected`);
      // localhost goes through DNS: in a sandbox without resolution it fails with the
      // "cannot resolve" message instead — both are a refusal before any fetch.
      assert.match(res.content[0].text, /приватный или служебный адрес|Не удалось разрешить хост/);
    }
    assert.equal(mock.fetches.length, 0); // nothing was fetched
    assert.equal(calls.length, 0); // nothing was uploaded
  } finally {
    mock.restore();
  }
});

test("upload_ad_image follows redirects manually and blocks a hop onto a private address", async () => {
  const mock = mockFetch((url) => {
    if (url.startsWith("http://203.0.113.5/")) {
      return new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1/secret" },
      });
    }
    throw new Error("must not fetch the private hop");
  });
  try {
    const { calls, tools } = harness();
    const res = await tools.upload_ad_image({ name: "Cover", url: "http://203.0.113.5/img.png" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /приватный или служебный адрес/);
    assert.equal(mock.fetches.length, 1); // only the first hop was fetched
    assert.equal(calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("upload_ad_image follows a public redirect and uploads the image", async () => {
  const mock = mockFetch((url) => {
    if (url === "http://203.0.113.5/img.png") {
      return new Response(null, {
        status: 302,
        headers: { Location: "http://203.0.113.6/real.png" },
      });
    }
    return new Response("ABC", { status: 200, headers: { "Content-Type": "image/png" } });
  });
  try {
    const { calls, tools } = harness();
    const res = await tools.upload_ad_image({ name: "Cover", url: "http://203.0.113.5/img.png" });
    assert.equal(res.isError, undefined);
    assert.equal(mock.fetches.length, 2);
    assert.equal(mock.fetches[0].init.redirect, "manual");
    assert.equal(calls[0].params.AdImages[0].ImageData, "QUJD"); // base64("ABC")
  } finally {
    mock.restore();
  }
});

test("upload_ad_image rejects an explicit non-image Content-Type", async () => {
  const mock = mockFetch(
    () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }),
  );
  try {
    const { calls, tools } = harness();
    const res = await tools.upload_ad_image({ name: "Cover", url: "http://203.0.113.5/img.png" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /не изображение/);
    assert.equal(calls.length, 0);
  } finally {
    mock.restore();
  }
});
