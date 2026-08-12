import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The instructions text only counts if it survives to the wire — it is built in
 * index.ts, but only the `initialize` result proves the SDK actually shipped it to
 * the client. So this spawns the REAL entry point over stdio and does a real MCP
 * handshake with the official SDK client (the same setup as docs/demo/run.mjs).
 *
 * Source, not dist/: `npm test` does not build, so asserting against dist would
 * silently grade a stale bundle. tsx is already the runner for these tests.
 */
const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Starts the server as a child process and returns a connected MCP client. */
async function connectToServer(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    // cwd is the repo root so `--import tsx` resolves from node_modules.
    args: ["--import", "tsx", ENTRY],
    cwd: REPO_ROOT,
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      // Any non-empty token gets past loadConfig; the handshake makes no API call.
      YANDEX_DIRECT_TOKEN: "test-token",
      // A test run must not ping the usage endpoint on initialize.
      ASKADS_TELEMETRY: "0",
    },
  });
  const client = new Client({ name: "instructions-smoke", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

test("the initialize result carries the server instructions", { timeout: 60_000 }, async () => {
  const client = await connectToServer();
  try {
    const instructions = client.getInstructions();
    assert.ok(
      instructions && instructions.trim().length > 0,
      "the server must send non-empty instructions in the initialize result",
    );
    // Guards against a placeholder ("TODO") slipping through: the text has to name
    // the API it is briefing the model about.
    assert.match(instructions, /Яндекс Директ/);
  } finally {
    await client.close();
  }
});
