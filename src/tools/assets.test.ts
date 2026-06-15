import { test } from "node:test";
import assert from "node:assert/strict";
import { registerAssetTools } from "./assets.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function harness() {
  const calls: { service: string; method: string; params: any }[] = [];
  const tools: Record<string, Handler> = {};
  const client = {
    call: async (service: string, method: string, params: any) => {
      calls.push({ service, method, params });
      return { AddResults: [{ Id: 1 }] };
    },
  };
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerAssetTools(server as never, client as never);
  return { calls, tools };
}

test("get_sitelinks requests SitelinkFieldNames and empty selection without ids", async () => {
  const { calls, tools } = harness();
  await tools.get_sitelinks({});
  assert.equal(calls[0].service, "sitelinks");
  assert.equal(calls[0].method, "get");
  assert.deepEqual(calls[0].params.SelectionCriteria, {});
  assert.ok(calls[0].params.SitelinkFieldNames.includes("Title"));
});

test("get_sitelinks filters by ids and paginates", async () => {
  const { calls, tools } = harness();
  await tools.get_sitelinks({ ids: [3], limit: 10, offset: 5 });
  assert.deepEqual(calls[0].params.SelectionCriteria, { Ids: [3] });
  assert.deepEqual(calls[0].params.Page, { Limit: 10, Offset: 5 });
});

test("create_sitelinks_set maps links into SitelinksSets", async () => {
  const { calls, tools } = harness();
  const res = await tools.create_sitelinks_set({
    sitelinks: [{ title: "Прайс", href: "https://x.test/price" }],
  });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].method, "add");
  assert.deepEqual(calls[0].params.SitelinksSets[0], {
    Sitelinks: [{ Title: "Прайс", Href: "https://x.test/price" }],
  });
});

test("delete_sitelinks passes ids in SelectionCriteria", async () => {
  const { calls, tools } = harness();
  await tools.delete_sitelinks({ ids: [7] });
  assert.deepEqual(calls[0].params, { SelectionCriteria: { Ids: [7] } });
});

test("get_callouts targets adextensions with the CALLOUT type and CalloutFieldNames", async () => {
  const { calls, tools } = harness();
  await tools.get_callouts({});
  assert.equal(calls[0].service, "adextensions");
  assert.deepEqual(calls[0].params.SelectionCriteria, { Types: ["CALLOUT"] });
  assert.deepEqual(calls[0].params.CalloutFieldNames, ["CalloutText"]);
});

test("add_callouts wraps each text in a Callout extension", async () => {
  const { calls, tools } = harness();
  const res = await tools.add_callouts({ texts: ["Доставка 24/7", "Гарантия"] });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].method, "add");
  assert.deepEqual(calls[0].params.AdExtensions, [
    { Callout: { CalloutText: "Доставка 24/7" } },
    { Callout: { CalloutText: "Гарантия" } },
  ]);
});

test("delete_callouts passes ids in SelectionCriteria", async () => {
  const { calls, tools } = harness();
  await tools.delete_callouts({ ids: [11] });
  assert.deepEqual(calls[0].params, { SelectionCriteria: { Ids: [11] } });
});

test("get_vcards requires a selection and otherwise makes no call", async () => {
  const { calls, tools } = harness();
  const res = await tools.get_vcards({});
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test("get_vcards filters by campaign ids", async () => {
  const { calls, tools } = harness();
  await tools.get_vcards({ campaignIds: [7] });
  assert.equal(calls[0].service, "vcards");
  assert.deepEqual(calls[0].params.SelectionCriteria, { CampaignIds: [7] });
  assert.ok(calls[0].params.FieldNames.includes("Phone"));
});

test("create_vcard builds the required fields and nested Phone", async () => {
  const { calls, tools } = harness();
  const res = await tools.create_vcard({
    campaignId: 7,
    country: "Россия",
    city: "Москва",
    companyName: "Acme",
    workTime: "1#5#9#00#18#00",
    phone: { countryCode: "+7", cityCode: "495", phoneNumber: "1234567" },
  });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].method, "add");
  assert.deepEqual(calls[0].params.VCards[0], {
    CampaignId: 7,
    Country: "Россия",
    City: "Москва",
    CompanyName: "Acme",
    WorkTime: "1#5#9#00#18#00",
    Phone: { CountryCode: "+7", CityCode: "495", PhoneNumber: "1234567" },
  });
});

test("delete_vcards passes ids in SelectionCriteria", async () => {
  const { calls, tools } = harness();
  await tools.delete_vcards({ ids: [42] });
  assert.deepEqual(calls[0].params, { SelectionCriteria: { Ids: [42] } });
});
