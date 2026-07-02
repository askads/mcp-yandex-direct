import { test } from "node:test";
import assert from "node:assert/strict";
import { filterRegions, registerDictionaryTools, type GeoRegion } from "./dictionaries.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** Registers the dictionary tools against a fake client that counts dictionary downloads. */
function harness(regions: GeoRegion[]) {
  let callCount = 0;
  const tools: Record<string, Handler> = {};
  const client = {
    call: async () => {
      callCount++;
      return { GeoRegions: regions };
    },
  };
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerDictionaryTools(server as never, client as never);
  return { tools, downloads: () => callCount };
}

const REGIONS: GeoRegion[] = [
  { GeoRegionId: 225, GeoRegionName: "Россия", GeoRegionType: "Country" },
  { GeoRegionId: 213, GeoRegionName: "Москва", GeoRegionType: "City", ParentId: 1 },
  { GeoRegionId: 2, GeoRegionName: "Санкт-Петербург", GeoRegionType: "City" },
  { GeoRegionId: 1, GeoRegionName: "Москва и область", GeoRegionType: "Region" },
];

test("filterRegions matches a case-insensitive name substring", () => {
  const result = filterRegions(REGIONS, "москва", 50);
  assert.deepEqual(
    result.map((r) => r.GeoRegionId),
    [213, 1],
  );
});

test("filterRegions caps results by limit", () => {
  assert.equal(filterRegions(REGIONS, undefined, 2).length, 2);
});

test("filterRegions returns all (capped) when no query is given", () => {
  assert.equal(filterRegions(REGIONS, undefined, 50).length, REGIONS.length);
});

test("get_regions downloads the GeoRegions dictionary once and reuses it (cache)", async () => {
  const { tools, downloads } = harness(REGIONS);
  const first = await tools.get_regions({ query: "москва" });
  const second = await tools.get_regions({ query: "россия" });
  assert.equal(downloads(), 1); // dictionary fetched once, then served from cache
  assert.match(first.content[0].text, /213/); // Москва
  assert.match(second.content[0].text, /225/); // Россия
});
