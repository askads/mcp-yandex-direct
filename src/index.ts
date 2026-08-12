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
  "API Яндекс Директа v5 — это рекламный кабинет одного рекламодателя: поиск и сети, а не " +
  "веб-аналитика Метрики. Новые кампании и объявления создаются только текстовыми, но объекты " +
  "любого типа (смарт, динамические, CPM, единая перформанс-кампания) можно получать списком, " +
  "переименовывать, менять им бюджет, останавливать, архивировать и удалять по id; всё остальное — " +
  "через raw_request. Финансового сервиса нет: баланс доступен только на чтение, ни один " +
  "инструмент не двигает деньги. Каждый вызов тратит дневную квоту Units (остаток показывает " +
  "get_quota), " +
  "а get_statistics запускает асинхронную задачу в сервисе Reports со своими дневными лимитами — " +
  "запрашивать один широкий период, а не цикл по дням или кампаниям. Деньги везде в валюте " +
  "аккаунта, кроме raw_request, где они в микроединицах. Агентский токен работает с собственным " +
  "аккаунтом агентства, пока клиент не указан в YANDEX_DIRECT_LOGIN, — проверить это, прежде чем " +
  "верить пустому списку; фильтр по типам без UNIFIED_CAMPAIGN скрывает актуальные " +
  "перформанс-кампании. Запись тратит реальные деньги, если не задан YANDEX_DIRECT_SANDBOX=true, " +
  "удаление необратимо, а частично неудачный пакет всё равно возвращает HTTP 200 — читать ошибки " +
  "по каждому объекту и повторять только то, что не прошло.";

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
    console.error(`Ошибка: ${err.message}`);
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
    `mcp-yandex-direct работает на stdio${config.sandbox ? " (песочница)" : ""}`,
  );
}

main().catch((err) => {
  console.error("Критическая ошибка при запуске mcp-yandex-direct:", err);
  process.exit(1);
});
