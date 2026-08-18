import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
async function connectToServer(env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    // cwd is the repo root so `--import tsx` resolves from node_modules.
    args: ["--import", "tsx", ENTRY],
    cwd: REPO_ROOT,
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      // A test run must not ping the usage endpoint on initialize.
      ASKADS_TELEMETRY: "0",
      ...env,
    },
  });
  const client = new Client({ name: "instructions-smoke", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/**
 * A server with no token at all: no env var, and a config dir that cannot hold a
 * stored login. Both halves matter — pointing XDG_CONFIG_HOME at a fresh temp dir
 * is what keeps the developer's own credentials.json from making this pass.
 */
async function connectUnconfigured(): Promise<Client> {
  return connectToServer({
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "mcp-direct-unconfigured-")),
  });
}

test("the initialize result carries the server instructions", { timeout: 60_000 }, async () => {
  // Any non-empty token gets past loadConfig; the handshake makes no API call.
  const client = await connectToServer({ YANDEX_DIRECT_TOKEN: "test-token" });
  try {
    const instructions = client.getInstructions();
    assert.ok(
      instructions && instructions.trim().length > 0,
      "the server must send non-empty instructions in the initialize result",
    );
    // Guards against a placeholder ("TODO") slipping through: the text has to name
    // the API it is briefing the model about.
    assert.match(instructions, /Яндекс Директ/);
    // A configured start must NOT carry the unconfigured warning.
    assert.doesNotMatch(instructions, /ВНИМАНИЕ/);
  } finally {
    await client.close();
  }
});

test("a server without a token still answers initialize, tools/list and a call", { timeout: 60_000 }, async () => {
  // The regression this exists for: with no YANDEX_DIRECT_TOKEN the server used
  // to exit(1) before the MCP handshake, so the client showed a dead server and
  // the user never learned why. It must now start, list its tools (including the
  // login tools), open the instructions with the fix, and answer a tool call with
  // the auth error instead of dropping the connection. No network: the token
  // check rejects the call before fetch.
  const client = await connectUnconfigured();
  try {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /не подключён/, "instructions must state the server is unusable");
    assert.match(instructions, /start_login/, "and must name the tool that fixes it");
    assert.match(instructions, /YANDEX_DIRECT_TOKEN/, "and keep the env alternative");
    assert.match(instructions, /Яндекс Директ/, "the regular briefing must still follow the prefix");

    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("start_login"), "an unconfigured server must offer the login tool");
    assert.ok(tools.includes("list_campaigns"), "an unconfigured server must still list its tools");
    assert.ok(tools.includes("get_account_info"));

    const result = await client.callTool({ name: "get_account_info", arguments: {} });
    assert.equal(result.isError, true, "the call must fail, not the connection");
    const text = (result.content as { text?: string }[]).map((c) => c.text ?? "").join(" ");
    // The message has to survive to the model verbatim: it is the only channel to
    // the user, and it must name BOTH fixes — the in-chat login and the env path.
    assert.match(text, /start_login/);
    assert.match(text, /не поможет|не сбой сети/);
    assert.match(text, /YANDEX_DIRECT_TOKEN/);
    assert.match(text, /перезапустить сервер/);
  } finally {
    await client.close();
  }
});

test("start_login hands back a PKCE authorize URL without a secret", { timeout: 60_000 }, async () => {
  const client = await connectUnconfigured();
  try {
    const result = (await client.callTool({ name: "start_login", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { authorizeUrl?: string };
    const url = new URL(payload.authorizeUrl ?? "");
    assert.equal(url.origin + url.pathname, "https://oauth.yandex.ru/authorize");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.ok(!url.search.includes("client_secret"), "a public client must not leak a secret");
  } finally {
    await client.close();
  }
});

test("auth_status reports the disconnected state without touching the network", { timeout: 60_000 }, async () => {
  const client = await connectUnconfigured();
  try {
    const result = (await client.callTool({ name: "auth_status", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const status = JSON.parse(result.content[0]?.text ?? "{}") as {
      configured?: boolean;
      path?: string;
    };
    assert.equal(status.configured, false);
    assert.match(status.path ?? "", /credentials\.json$/);
  } finally {
    await client.close();
  }
});
