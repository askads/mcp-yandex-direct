#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { YandexDirectClient } from "./client.js";
import { ConfigError, loadConfig } from "./config.js";
import { instrumentToolCalls, Telemetry } from "./telemetry.js";
import type { YandexDirectConfig } from "./types.js";

/** Reads the package version so the server reports its real version to MCP clients. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
import { registerAccountTools } from "./tools/account.js";
import { registerCampaignTools } from "./tools/campaigns.js";
import { registerAdGroupTools } from "./tools/adGroups.js";
import { registerAdTools } from "./tools/ads.js";
import { registerKeywordTools } from "./tools/keywords.js";
import { registerStatisticsTools } from "./tools/statistics.js";
import { registerDictionaryTools } from "./tools/dictionaries.js";
import { registerRawTool } from "./tools/raw.js";
import { registerBidModifierTools } from "./tools/bidModifiers.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerMediaTools } from "./tools/media.js";

/**
 * The prose the calling model receives in the `initialize` result — the only text it
 * reads before it picks a tool, in every session. Cross-cutting facts only: what this
 * API is, what it refuses to do, what a call costs and which failures lie about their
 * cause. Per-tool gotchas belong in that tool's `description` (see CLAUDE.md), and
 * every line here is paid for out of the client's context, so keep it dense.
 */
const INSTRUCTIONS =
  "Yandex Direct API v5 is one advertiser's PPC cabinet — search and network, not Metrica site " +
  "analytics. New campaigns and ads can only be created as text ones, but objects of any type " +
  "(smart, dynamic, CPM, unified performance) can still be listed, renamed, re-budgeted, paused, " +
  "archived or deleted by id; anything else needs raw_request. No finance service: balance is " +
  "read-only and nothing moves money. Every call spends the daily Units quota (get_quota shows the " +
  "rest), and get_statistics starts an async Reports job with its own daily caps — ask for one wide " +
  "period, not a loop per day or campaign. Money is in account currency units everywhere except " +
  "raw_request, where it is micros. An agency token acts on the agency's own account unless " +
  "YANDEX_DIRECT_LOGIN names the client — check that before trusting an empty list; a types filter " +
  "without UNIFIED_CAMPAIGN hides current performance campaigns. Writes spend real money unless " +
  "YANDEX_DIRECT_SANDBOX=true, deletes are irreversible, and a partly-failed batch still returns " +
  "HTTP 200 — read the per-object errors, retry only what failed.";

/**
 * Loads the config, reporting the drop-off if it is missing. An unconfigured
 * server dies before the MCP handshake, so this ping is the only trace such an
 * install ever leaves — and it has to be awaited, or process.exit() below would
 * kill the request in flight.
 */
async function loadConfigOrExit(telemetry: Telemetry): Promise<YandexDirectConfig> {
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`Error: ${err.message}`);
    await telemetry.sendBlocking("startup_failed", { reason: err.reason });
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Anonymous usage pings (ids/names/versions only, never data or arguments);
  // opt out with ASKADS_TELEMETRY=0. Built before the config so a missing token
  // can be reported; wired to the server before tools register.
  const telemetry = new Telemetry(readVersion());
  const config = await loadConfigOrExit(telemetry);
  const client = new YandexDirectClient(config);

  const server = new McpServer(
    {
      name: "mcp-yandex-direct",
      version: readVersion(),
    },
    // Rides along in the initialize result; the SDK carries it as a ServerOption.
    { instructions: INSTRUCTIONS },
  );

  instrumentToolCalls(server, telemetry);
  server.server.oninitialized = () => {
    telemetry.setClientInfo(server.server.getClientVersion());
    telemetry.send("server_start");
  };

  registerAccountTools(server, client);
  registerCampaignTools(server, client);
  registerAdGroupTools(server, client);
  registerAdTools(server, client);
  registerKeywordTools(server, client);
  registerStatisticsTools(server, client);
  registerDictionaryTools(server, client);
  registerRawTool(server, client);
  registerBidModifierTools(server, client);
  registerAssetTools(server, client);
  registerMediaTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `mcp-yandex-direct running on stdio${config.sandbox ? " (sandbox)" : ""}`,
  );
}

main().catch((err) => {
  console.error("Fatal error starting mcp-yandex-direct:", err);
  process.exit(1);
});
