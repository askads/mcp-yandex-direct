import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, compact, fail, ok, okOrPartial } from "./util.js";

export function registerAssetTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "get_sitelinks",
    {
      title: "Get sitelink sets",
      description:
        "Lists sitelink sets (быстрые ссылки) from the library. Attach a set to an ad via the ad's SitelinkSetId.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Filter by sitelink set ids."),
        limit: z.number().int().min(1).max(10000).optional().describe("Max objects per page."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
      },
    },
    async ({ ids, limit, offset }) => {
      try {
        const params: Record<string, unknown> = {
          SelectionCriteria: ids?.length ? { Ids: ids } : {},
          FieldNames: ["Id"],
          SitelinkFieldNames: ["Title", "Href", "Description", "TurboPageId"],
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = await client.call("sitelinks", "get", params);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_sitelinks_set",
    {
      title: "Create sitelink set",
      description:
        "Creates a sitelink set (1–8 links). Sets are immutable — to change links, create a new set and reassign it to the ad.",
      inputSchema: {
        sitelinks: z
          .array(
            z.object({
              title: z.string().min(1).describe("Sitelink title."),
              href: z.string().optional().describe("Sitelink URL."),
              description: z.string().optional().describe("Sitelink description (for some ad types)."),
            }),
          )
          .min(1)
          .max(8)
          .describe("1–8 sitelinks."),
      },
    },
    async ({ sitelinks }) => {
      try {
        const set = {
          Sitelinks: sitelinks.map((s) =>
            compact({ Title: s.title, Href: s.href, Description: s.description }),
          ),
        };
        const result = await client.call("sitelinks", "add", { SitelinksSets: [set] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_sitelinks",
    {
      title: "Delete sitelink sets",
      description: "Deletes sitelink sets by id (only sets not assigned to any ad can be deleted).",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Sitelink set ids to delete."),
      },
    },
    async ({ ids }) => {
      try {
        const result = await client.call("sitelinks", "delete", { SelectionCriteria: { Ids: ids } });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_callouts",
    {
      title: "Get callouts",
      description:
        "Lists callouts (уточнения) from the adextensions library. Attach a callout to an ad via the Ads service.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Filter by callout ids."),
        limit: z.number().int().min(1).max(10000).optional().describe("Max objects per page."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
      },
    },
    async ({ ids, limit, offset }) => {
      try {
        const params: Record<string, unknown> = {
          SelectionCriteria: compact({ Ids: ids?.length ? ids : undefined, Types: ["CALLOUT"] }),
          FieldNames: ["Id", "Type", "Status", "StatusClarification", "Associated"],
          CalloutFieldNames: ["CalloutText"],
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = await client.call("adextensions", "get", params);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "add_callouts",
    {
      title: "Add callouts",
      description:
        "Creates callouts (уточнения), up to 25 characters each. Callouts are immutable — delete and recreate to change. Assign to ads via the Ads service.",
      inputSchema: {
        texts: z
          .array(z.string().min(1).max(25))
          .min(1)
          .describe("Callout texts, up to 25 characters each."),
      },
    },
    async ({ texts }) => {
      try {
        const adExtensions = texts.map((text) => ({ Callout: { CalloutText: text } }));
        const result = await client.call("adextensions", "add", { AdExtensions: adExtensions });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_callouts",
    {
      title: "Delete callouts",
      description: "Deletes callouts by id (adextensions/delete).",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Callout ids to delete."),
      },
    },
    async ({ ids }) => {
      try {
        const result = await client.call("adextensions", "delete", {
          SelectionCriteria: { Ids: ids },
        });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_vcards",
    {
      title: "Get vCards",
      description: "Lists virtual business cards (визитки) by campaign or id.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Filter by vCard ids."),
        campaignIds: z.array(z.number().int()).optional().describe("Filter by campaign ids."),
        limit: z.number().int().min(1).max(10000).optional().describe("Max objects per page."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
      },
    },
    async ({ ids, campaignIds, limit, offset }) => {
      try {
        if (!ids?.length && !campaignIds?.length) {
          return fail("Provide at least one of ids or campaignIds.");
        }
        const params: Record<string, unknown> = {
          SelectionCriteria: compact({
            Ids: ids?.length ? ids : undefined,
            CampaignIds: campaignIds?.length ? campaignIds : undefined,
          }),
          FieldNames: [
            "Id",
            "CampaignId",
            "Country",
            "City",
            "CompanyName",
            "WorkTime",
            "Phone",
            "Street",
            "House",
            "Building",
            "Apartment",
            "ContactPerson",
            "ContactEmail",
            "ExtraMessage",
            "OGRN",
            "MetroStationId",
            "PointOnMap",
          ],
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = await client.call("vcards", "get", params);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_vcard",
    {
      title: "Create vCard",
      description:
        "Creates a virtual business card in a campaign. vCards are immutable — delete and recreate to change.",
      inputSchema: {
        campaignId: z.number().int().describe("Campaign the vCard belongs to."),
        country: z.string().min(1).describe("Country, e.g. Россия."),
        city: z.string().min(1).describe("City, e.g. Москва."),
        companyName: z.string().min(1).describe("Company name."),
        workTime: z
          .string()
          .min(1)
          .describe('Work time in API format, e.g. "1#5#9#00#18#00" = Mon–Fri 09:00–18:00.'),
        phone: z
          .object({
            countryCode: z.string().min(1).describe('Country code, e.g. "+7".'),
            cityCode: z.string().min(1).describe('City/operator code, e.g. "495".'),
            phoneNumber: z.string().min(1).describe("Local number."),
            extension: z.string().optional().describe("Extension, if any."),
          })
          .describe("Contact phone."),
        street: z.string().optional(),
        house: z.string().optional(),
        building: z.string().optional(),
        apartment: z.string().optional(),
        contactPerson: z.string().optional(),
        contactEmail: z.string().optional(),
        extraMessage: z.string().optional().describe("Additional info shown on the card."),
        ogrn: z.string().optional().describe("OGRN registration number."),
      },
    },
    async (a) => {
      try {
        const vcard = compact({
          CampaignId: a.campaignId,
          Country: a.country,
          City: a.city,
          CompanyName: a.companyName,
          WorkTime: a.workTime,
          Phone: compact({
            CountryCode: a.phone.countryCode,
            CityCode: a.phone.cityCode,
            PhoneNumber: a.phone.phoneNumber,
            Extension: a.phone.extension,
          }),
          Street: a.street,
          House: a.house,
          Building: a.building,
          Apartment: a.apartment,
          ContactPerson: a.contactPerson,
          ContactEmail: a.contactEmail,
          ExtraMessage: a.extraMessage,
          OGRN: a.ogrn,
        });
        const result = await client.call("vcards", "add", { VCards: [vcard] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_vcards",
    {
      title: "Delete vCards",
      description: "Deletes vCards by id (vcards/delete).",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("vCard ids to delete."),
      },
    },
    async ({ ids }) => {
      try {
        const result = await client.call("vcards", "delete", { SelectionCriteria: { Ids: ids } });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
