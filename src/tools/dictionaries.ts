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
      title: "Get geo regions",
      annotations: READ_ONLY,
      description:
        "Looks up geo region ids for targeting (the regionIds that create_ad_group needs). Filter by a name substring; results are capped by limit.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring of the region name, e.g. 'Москва' or 'Moscow'."),
        limit: z.number().int().min(1).max(1000).optional().describe("Max regions to return. Default 50."),
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
      title: "Get dictionaries",
      annotations: READ_ONLY,
      description:
        "Returns Yandex Direct reference dictionaries (currencies, time zones, constants, ad categories, ...). GeoRegions can be very large — prefer get_regions for region lookups.",
      inputSchema: {
        names: z.array(z.enum(DICTIONARY_NAMES)).min(1).describe("Dictionary names to fetch."),
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
