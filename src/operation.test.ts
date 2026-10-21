import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { currentOperation, instrumentOperations, timing, wait } from "./operation.js";
import { DIRECT_RATE_LIMITED_MARKER } from "./types.js";

/** A server with one tool whose body runs `body` inside the instrumented operation. */
async function connected(body: () => Promise<void>) {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  instrumentOperations(server);
  server.registerTool("probe", { inputSchema: { n: z.number().optional() } }, async () => {
    await body();
    return { content: [{ type: "text" as const, text: "ok" }] };
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function instantSleep() {
  const original = timing.sleep;
  timing.sleep = async () => {};
  return () => {
    timing.sleep = original;
  };
}

test("progress notes reach a client that asked for them, every step of a long wait", async () => {
  const restore = instantSleep();
  try {
    const client = await connected(() => wait(25_000, (left) => `ждём ${left} с`));
    const notes: string[] = [];
    await client.callTool({ name: "probe", arguments: {} }, undefined, {
      onprogress: (p) => notes.push(String(p.message)),
    });
    // A heartbeat at least every 10 s: 25 s → three notes.
    assert.deepEqual(notes, ["ждём 25 с", "ждём 15 с", "ждём 5 с"]);
  } finally {
    restore();
  }
});

test("a result slowed by code 56 carries the rate-limit note; a normal one does not", async () => {
  const slowed = await connected(async () => {
    const op = currentOperation();
    op.rateWaitedMs += 20_000;
    op.rateLimit = "не чаще 1 раз в 10 с";
  });
  const slowResult = (await slowed.callTool({ name: "probe", arguments: {} })) as {
    content: { text: string }[];
  };
  assert.equal(slowResult.content.length, 2);
  assert.equal(
    slowResult.content[1].text.startsWith(`${DIRECT_RATE_LIMITED_MARKER} (не чаще 1 раз в 10 с): ответ задержан на 20 с`),
    true,
  );

  const normal = await connected(async () => {});
  const normalResult = (await normal.callTool({ name: "probe", arguments: {} })) as { content: unknown[] };
  assert.equal(normalResult.content.length, 1);
});

test("concurrent tool calls keep separate operations", async () => {
  const seen: number[] = [];
  const client = await connected(async () => {
    const op = currentOperation();
    op.rateWaitedMs += 1;
    await new Promise((r) => setTimeout(r, 5));
    seen.push(op.rateWaitedMs);
  });
  await Promise.all([1, 2, 3].map(() => client.callTool({ name: "probe", arguments: {} })));
  assert.deepEqual(seen, [1, 1, 1]);
});
