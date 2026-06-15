#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { YandexDirectClient } from "./client.js";
import type { YandexDirectConfig } from "./types.js";
import { registerAccountTools } from "./tools/account.js";
import { registerCampaignTools } from "./tools/campaigns.js";
import { registerAdGroupTools } from "./tools/adGroups.js";
import { registerAdTools } from "./tools/ads.js";
import { registerKeywordTools } from "./tools/keywords.js";
import { registerStatisticsTools } from "./tools/statistics.js";

function loadConfig(): YandexDirectConfig {
  const token = process.env.YANDEX_DIRECT_TOKEN;
  if (!token) {
    console.error("Error: YANDEX_DIRECT_TOKEN environment variable is required.");
    process.exit(1);
  }
  return {
    token,
    login: process.env.YANDEX_DIRECT_LOGIN || undefined,
    lang: process.env.YANDEX_DIRECT_LANG || "ru",
    sandbox: /^(1|true|yes)$/i.test(process.env.YANDEX_DIRECT_SANDBOX ?? ""),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new YandexDirectClient(config);

  const server = new McpServer({
    name: "mcp-yandex-direct",
    version: "0.1.0",
  });

  registerAccountTools(server, client);
  registerCampaignTools(server, client);
  registerAdGroupTools(server, client);
  registerAdTools(server, client);
  registerKeywordTools(server, client);
  registerStatisticsTools(server, client);

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
