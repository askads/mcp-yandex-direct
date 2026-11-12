import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerAccountTools } from "./account.js";
import { registerAdTools } from "./ads.js";
import { registerAdGroupTools } from "./adGroups.js";
import { registerCampaignTools } from "./campaigns.js";
import { registerKeywordTools } from "./keywords.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** Fake server keeping each tool's inputSchema next to its handler; mock client records calls. */
function harness(register: (server: any, client: any) => void) {
  const calls: { service: string; params: any }[] = [];
  const tools: Record<string, { schema: z.ZodObject<any>; handler: Handler }> = {};
  const client = {
    call: async (service: string, _method: string, params: any) => {
      calls.push({ service, params });
      return {};
    },
    getAll: async (service: string, params: any) => {
      calls.push({ service, params });
      return {};
    },
  };
  const server = {
    registerTool: (name: string, cfg: { inputSchema: z.ZodRawShape }, handler: Handler) => {
      tools[name] = { schema: z.object(cfg.inputSchema), handler };
    },
  };
  register(server, client);
  return { calls, tools };
}

const LISTS = [
  { register: registerCampaignTools, tool: "list_campaigns", valid: "Funds", args: {} },
  { register: registerAdGroupTools, tool: "list_ad_groups", valid: "RegionIds", args: { campaignIds: [1] } },
  { register: registerAdTools, tool: "list_ads", valid: "Title", args: { campaignIds: [1] } },
  { register: registerKeywordTools, tool: "list_keywords", valid: "Bid", args: { campaignIds: [1] } },
];

for (const { register, tool, valid, args } of LISTS) {
  test(`${tool}: fieldNames outside the API enum are rejected by the schema`, () => {
    const { schema } = harness(register).tools[tool];
    assert.equal(schema.safeParse({ ...args, fieldNames: [valid] }).success, true);
    assert.equal(schema.safeParse({ ...args, fieldNames: ["Budget"] }).success, false);
  });
}

test("list_campaigns: DailyBudget is neither requested by default nor accepted in fieldNames", async () => {
  // Yandex retires DailyBudget on 2026-11-30; the budget is weekly and lives in BiddingStrategy.
  const { calls, tools } = harness(registerCampaignTools);
  assert.equal(tools.list_campaigns.schema.safeParse({ fieldNames: ["DailyBudget"] }).success, false);
  await tools.list_campaigns.handler({});
  assert.equal(calls[0].params.FieldNames.includes("DailyBudget"), false);
});

test("get_account_info: fieldNames outside the clients.get enum are rejected by the schema", () => {
  const { schema } = harness(registerAccountTools).tools.get_account_info;
  assert.equal(schema.safeParse({ fieldNames: ["Login", "Currency", "Representatives"] }).success, true);
  assert.equal(schema.safeParse({ fieldNames: ["Balance"] }).success, false);
});

for (const { register, tool } of LISTS.slice(1)) {
  test(`${tool}: no id filter answers before the request (API code 4001)`, async () => {
    const { calls, tools } = harness(register);
    const res = await tools[tool].handler({});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /campaignIds/);
    assert.equal(calls.length, 0, "no request without a selection");
  });
}

test("list_ads: states alone are not a selection", async () => {
  const { calls, tools } = harness(registerAdTools);
  const res = await tools.list_ads.handler({ states: ["ON"] });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test("list_ads: text-ad fields go to TextAdFieldNames, the rest to FieldNames", async () => {
  const { calls, tools } = harness(registerAdTools);
  await tools.list_ads.handler({ campaignIds: [1], fieldNames: ["Id", "State", "Title", "Text", "Href"] });
  assert.deepEqual(calls[0].params.FieldNames, ["Id", "State"]);
  assert.deepEqual(calls[0].params.TextAdFieldNames, ["Title", "Text", "Href"]);
});

test("list_ads: only text-ad fields still sends a non-empty FieldNames", async () => {
  const { calls, tools } = harness(registerAdTools);
  await tools.list_ads.handler({ campaignIds: [1], fieldNames: ["Title"] });
  assert.deepEqual(calls[0].params.FieldNames, ["Id"]);
  assert.deepEqual(calls[0].params.TextAdFieldNames, ["Title"]);
});

test("list_ads: default fields send no TextAdFieldNames", async () => {
  const { calls, tools } = harness(registerAdTools);
  await tools.list_ads.handler({ campaignIds: [1] });
  assert.equal("TextAdFieldNames" in calls[0].params, false);
});

// Without a responsive field Direct reports a комбинаторное объявление as TEXT_AD and hides
// its texts (checked live 2026-11-12), so the responsive names always travel with the text ones.
test("list_ads: text fields are also asked as ResponsiveAdFieldNames, mapped and deduplicated", async () => {
  const { calls, tools } = harness(registerAdTools);
  await tools.list_ads.handler({
    campaignIds: [1],
    fieldNames: ["Id", "Title", "Title2", "Text", "Href", "AdImageHash", "Mobile", "VCardId", "TurboPageId"],
  });
  assert.deepEqual(calls[0].params.ResponsiveAdFieldNames, ["Titles", "Texts", "Href", "AdImages"]);
  assert.deepEqual(calls[0].params.TextAdFieldNames, ["Title", "Title2", "Text", "Href", "AdImageHash", "Mobile", "VCardId", "TurboPageId"]);
});

test("list_ads: Type without text fields still asks one responsive field, so the type is the real one", async () => {
  const { calls, tools } = harness(registerAdTools);
  await tools.list_ads.handler({ campaignIds: [1] });
  assert.deepEqual(calls[0].params.ResponsiveAdFieldNames, ["Href"]);
  await tools.list_ads.handler({ campaignIds: [1], fieldNames: ["Id", "Type"] });
  assert.deepEqual(calls[1].params.ResponsiveAdFieldNames, ["Href"]);
});

test("list_ads: neither Type nor texts asked sends no ResponsiveAdFieldNames", async () => {
  const { calls, tools } = harness(registerAdTools);
  await tools.list_ads.handler({ campaignIds: [1], fieldNames: ["Id", "State"] });
  assert.equal("ResponsiveAdFieldNames" in calls[0].params, false);
  // Text fields with no responsive counterpart: nothing to ask, and no Type to keep honest.
  await tools.list_ads.handler({ campaignIds: [1], fieldNames: ["Mobile"] });
  assert.equal("ResponsiveAdFieldNames" in calls[1].params, false);
});

test("list_ads: TextAd fields the API rejects on use are not in the enum", () => {
  // Listed in the API's code-8000 enumeration, but ads.get answers 4000/5006 for them.
  const { schema } = harness(registerAdTools).tools.list_ads;
  for (const field of ["TrackingParams", "LfHref", "LfButtonText", "Carousel"]) {
    assert.equal(schema.safeParse({ campaignIds: [1], fieldNames: [field] }).success, false, field);
  }
});
