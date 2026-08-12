import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { fail, ok, READ_ONLY } from "./util.js";

const DICTIONARY_NAMES = [
  "GeoRegions",
  "Currencies",
  "TimeZones",
  "Constants",
  "AdCategories",
  "MetroStations",
  "OperationSystemVersions",
  "Interests",
] as const;

export interface GeoRegion {
  GeoRegionId: number;
  GeoRegionName: string;
  GeoRegionType?: string;
  ParentId?: number;
}

/**
 * Per-client cache of the GeoRegions dictionary. GeoRegions is static for the life of the
 * process, but get_regions used to re-download the whole (large) dictionary on every call.
 * Keyed by the client (a WeakMap, so it never outlives it) → correct per token/language.
 * In the per-request askads deploy the client is short-lived so this is a no-op there, but
 * standalone/long-lived clients skip the repeated download.
 */
const geoRegionsCache = new WeakMap<YandexDirectClient, GeoRegion[]>();

/** Filters geo regions by a case-insensitive name substring and caps the count. */
export function filterRegions(
  regions: GeoRegion[],
  query: string | undefined,
  limit: number,
): GeoRegion[] {
  const q = query?.toLowerCase();
  const filtered = q
    ? regions.filter((r) => String(r.GeoRegionName ?? "").toLowerCase().includes(q))
    : regions;
  return filtered.slice(0, limit);
}

export function registerDictionaryTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "get_regions",
    {
      title: "Поиск регионов",
      annotations: READ_ONLY,
      description:
        "Ищет id регионов для таргетинга (те самые regionIds, которые нужны create_ad_group). Фильтр — подстрока названия; количество результатов ограничено limit.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Подстрока названия региона без учёта регистра, например 'Москва' или 'Moscow'."),
        limit: z.number().int().min(1).max(1000).optional().describe("Максимум регионов в ответе. По умолчанию 50."),
      },
    },
    async ({ query, limit }) => {
      try {
        let all = geoRegionsCache.get(client);
        if (!all) {
          const result = await client.call<{ GeoRegions?: GeoRegion[] }>("dictionaries", "get", {
            DictionaryNames: ["GeoRegions"],
          });
          all = result.GeoRegions ?? [];
          geoRegionsCache.set(client, all);
        }
        const regions = filterRegions(all, query, limit ?? 50);
        return ok({ GeoRegions: regions, Count: regions.length });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_dictionaries",
    {
      title: "Справочники",
      annotations: READ_ONLY,
      description:
        "Возвращает справочники Яндекс Директа (валюты, часовые пояса, константы, категории объявлений, …). GeoRegions может быть очень большим — для поиска регионов лучше get_regions.",
      inputSchema: {
        names: z.array(z.enum(DICTIONARY_NAMES)).min(1).describe("Названия нужных справочников."),
      },
    },
    async ({ names }) => {
      try {
        const result = await client.call("dictionaries", "get", { DictionaryNames: names });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
