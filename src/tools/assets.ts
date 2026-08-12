import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, compact, fail, MAX_TOOL_LIMIT, ok, okOrPartial, READ_ONLY, WRITE_CREATE, WRITE_DELETE } from "./util.js";

export function registerAssetTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "get_sitelinks",
    {
      title: "Наборы быстрых ссылок",
      annotations: READ_ONLY,
      description:
        "Читает наборы быстрых ссылок по id. API требует id наборов — их можно взять из поля SitelinkSetId объявлений.",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Id наборов быстрых ссылок (обязательны по требованию API)."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Максимум объектов на страницу."),
        offset: z.number().int().min(0).optional().describe("Смещение постраничной выдачи."),
      },
    },
    async ({ ids, limit, offset }) => {
      try {
        const params: Record<string, unknown> = {
          SelectionCriteria: { Ids: ids },
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
      title: "Создать набор быстрых ссылок",
      annotations: WRITE_CREATE,
      description:
        "Создаёт набор быстрых ссылок (1–8 штук). Наборы неизменяемы — чтобы поменять ссылки, нужно создать новый набор и переназначить его объявлению.",
      inputSchema: {
        sitelinks: z
          .array(
            z.object({
              title: z.string().min(1).describe("Текст быстрой ссылки."),
              href: z.string().optional().describe("URL быстрой ссылки."),
              description: z.string().optional().describe("Описание быстрой ссылки (для некоторых типов объявлений)."),
            }),
          )
          .min(1)
          .max(8)
          .describe("От 1 до 8 быстрых ссылок."),
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
      title: "Удалить наборы быстрых ссылок",
      annotations: WRITE_DELETE,
      description: "Удаляет наборы быстрых ссылок по id (удалить можно только наборы, не привязанные ни к одному объявлению).",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Id наборов, которые нужно удалить."),
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
      title: "Уточнения",
      annotations: READ_ONLY,
      description:
        "Возвращает список уточнений из библиотеки adextensions. Привязать уточнение к объявлению можно через сервис Ads.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Фильтр по id уточнений."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Максимум объектов на страницу."),
        offset: z.number().int().min(0).optional().describe("Смещение постраничной выдачи."),
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
      title: "Добавить уточнения",
      annotations: WRITE_CREATE,
      description:
        "Создаёт уточнения, до 25 символов каждое. Уточнения неизменяемы — чтобы поменять, нужно удалить и создать заново. Привязка к объявлениям — через сервис Ads.",
      inputSchema: {
        texts: z
          .array(z.string().min(1).max(25))
          .min(1)
          .describe("Тексты уточнений, до 25 символов каждый."),
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
      title: "Удалить уточнения",
      annotations: WRITE_DELETE,
      description: "Удаляет уточнения по id (adextensions/delete).",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Id уточнений, которые нужно удалить."),
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
      title: "Визитки",
      annotations: READ_ONLY,
      description: "Читает виртуальные визитки по id. API требует id — их можно взять из поля VCardId объявлений.",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Id визиток (обязательны по требованию API)."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Максимум объектов на страницу."),
        offset: z.number().int().min(0).optional().describe("Смещение постраничной выдачи."),
      },
    },
    async ({ ids, limit, offset }) => {
      try {
        const params: Record<string, unknown> = {
          SelectionCriteria: { Ids: ids },
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
      title: "Создать визитку",
      annotations: WRITE_CREATE,
      description:
        "Создаёт виртуальную визитку в кампании. Визитки неизменяемы — чтобы поменять, нужно удалить и создать заново.",
      inputSchema: {
        campaignId: z.number().int().describe("Кампания, к которой относится визитка."),
        country: z.string().min(1).describe("Страна, например Россия."),
        city: z.string().min(1).describe("Город, например Москва."),
        companyName: z.string().min(1).describe("Название организации."),
        workTime: z
          .string()
          .min(1)
          .describe('Время работы в формате API, например "1#5#9#00#18#00" — пн–пт 09:00–18:00.'),
        phone: z
          .object({
            countryCode: z.string().min(1).describe('Код страны, например "+7".'),
            cityCode: z.string().min(1).describe('Код города или оператора, например "495".'),
            phoneNumber: z.string().min(1).describe("Местный номер."),
            extension: z.string().optional().describe("Добавочный номер, если есть."),
          })
          .describe("Контактный телефон."),
        street: z.string().optional(),
        house: z.string().optional(),
        building: z.string().optional(),
        apartment: z.string().optional(),
        contactPerson: z.string().optional(),
        contactEmail: z.string().optional(),
        extraMessage: z.string().optional().describe("Дополнительная информация на визитке."),
        ogrn: z.string().optional().describe("ОГРН."),
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
      title: "Удалить визитки",
      annotations: WRITE_DELETE,
      description: "Удаляет визитки по id (vcards/delete).",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Id визиток, которые нужно удалить."),
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
