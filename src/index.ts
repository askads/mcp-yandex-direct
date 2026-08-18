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
 * Prepended to INSTRUCTIONS when the token is missing. The model reads this
 * before it picks a tool, so an unconfigured session opens with the fix rather
 * than with a failed call. There is no in-chat login for an OAuth token: it
 * comes only from the environment, so the fix is the operator's — set the
 * variable and restart the server.
 */
const UNCONFIGURED_PREFIX =
  "ВНИМАНИЕ: Яндекс Директ ещё не подключён — не задана переменная окружения " +
  "YANDEX_DIRECT_TOKEN, поэтому любой вызов инструмента вернёт ошибку. Подключиться из диалога " +
  "нельзя: оператор должен получить OAuth-токен Яндекс Директа " +
  "(https://oauth.yandex.ru/authorize?response_type=token&client_id=c48790e11f0e48c588d2cd2d1b4bb92d — " +
  "войти под аккаунтом с доступом к нужному кабинету), задать его в YANDEX_DIRECT_TOKEN в " +
  "конфигурации MCP-клиента и перезапустить сервер. ";

/**
 * Loads the config without dying on a bad value. A server that exits here never
 * completes the MCP handshake, so the user sees a red cross and no reason —
 * instead the problem is carried into the session, where the model can read it
 * and relay it. (A missing token is not an error at all — loadConfig leaves the
 * field undefined; today it has no malformed-value checks either, so the catch
 * guards future ones.)
 */
function loadConfigOrDegraded(telemetry: Telemetry): {
  config: YandexDirectConfig;
  problem?: ConfigError;
} {
  try {
    return { config: loadConfig() };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`Ошибка конфигурации: ${err.message}`);
    // Fire-and-forget now that the process survives: the historical
    // `startup_failed` funnel stays comparable, but nothing blocks startup.
    telemetry.send("startup_failed", { reason: err.reason });
    return {
      // Degraded to "no credentials"; the non-credential settings the user did
      // set are kept (same env reads as loadConfig).
      config: {
        lang: process.env.YANDEX_DIRECT_LANG || "ru",
        sandbox: /^(1|true|yes)$/i.test(process.env.YANDEX_DIRECT_SANDBOX ?? ""),
      },
      problem: err,
    };
  }
}

async function main(): Promise<void> {
  // Anonymous usage pings (ids/names/versions only, never data or arguments);
  // opt out with ASKADS_TELEMETRY=0. Built before the config so a config
  // problem can be reported; wired to the server before tools register.
  const telemetry = new Telemetry(readVersion());
  const { config, problem } = loadConfigOrDegraded(telemetry);
  const client = new YandexDirectClient(config);

  // The token comes only from the environment, so this cannot change
  // mid-session: an unconfigured start stays unconfigured until the operator
  // sets the variable and restarts the server.
  const connected = Boolean(config.token);

  const server = new McpServer(
    {
      name: "mcp-yandex-direct",
      version: readVersion(),
    },
    // Rides along in the initialize result; the SDK carries it as a ServerOption.
    {
      instructions: connected
        ? INSTRUCTIONS
        : UNCONFIGURED_PREFIX + (problem ? `Проблема конфигурации: ${problem.message} ` : "") + INSTRUCTIONS,
    },
  );

  instrumentToolCalls(server, telemetry);
  server.server.oninitialized = () => {
    telemetry.setClientInfo(server.server.getClientVersion());
    // Split on purpose: `server_start` keeps meaning "a usable install started",
    // so the unconfigured case gets its own event instead of inflating that
    // number. The reason vocabulary is the historical closed set.
    if (connected) telemetry.send("server_start");
    else telemetry.send("unconfigured_start", { reason: problem?.reason ?? "missing_token" });
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
    `mcp-yandex-direct работает на stdio${config.sandbox ? " (песочница)" : ""}${
      connected ? "" : " (не задан YANDEX_DIRECT_TOKEN — задайте переменную и перезапустите сервер)"
    }`,
  );
}

main().catch((err) => {
  console.error("Критическая ошибка при запуске mcp-yandex-direct:", err);
  process.exit(1);
});
