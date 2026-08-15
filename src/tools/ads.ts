import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, compact, fail, MAX_TOOL_LIMIT, ok, okOrPartial, READ_ONLY, WRITE_CREATE, WRITE_DELETE, WRITE_UPDATE } from "./util.js";

const AD_STATES = ["ON", "OFF", "SUSPENDED", "OFF_BY_MONITORING", "ARCHIVED"] as const;
const AD_STATUSES = ["ACCEPTED", "DRAFT", "MODERATION", "PREACCEPTED", "REJECTED"] as const;

const DEFAULT_FIELDS = ["Id", "AdGroupId", "CampaignId", "Status", "State", "Type"];

export function registerAdTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "list_ads",
    {
      title: "Список объявлений",
      annotations: READ_ONLY,
      description: "Возвращает список объявлений с необязательными фильтрами по кампании, группе, id, состоянию и статусу.",
      inputSchema: {
        campaignIds: z.array(z.number().int()).optional().describe("Фильтр по id кампаний."),
        adGroupIds: z.array(z.number().int()).optional().describe("Фильтр по id групп объявлений."),
        ids: z.array(z.number().int()).optional().describe("Фильтр по id объявлений."),
        states: z.array(z.enum(AD_STATES)).optional().describe("Фильтр по состояниям объявлений."),
        statuses: z.array(z.enum(AD_STATUSES)).optional().describe("Фильтр по статусам модерации."),
        fieldNames: z.array(z.string()).optional().describe("Какие поля объявления вернуть."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Максимум объектов на страницу."),
        offset: z.number().int().min(0).optional().describe("Смещение постраничной выдачи (сколько объектов пропустить)."),
        autoPaginate: z
          .boolean()
          .optional()
          .describe("Забрать все страницы, идя по LimitedBy (limit тогда не ограничивает общий объём)."),
      },
    },
    async ({ campaignIds, adGroupIds, ids, states, statuses, fieldNames, limit, offset, autoPaginate }) => {
      try {
        const selection = compact({
          CampaignIds: campaignIds?.length ? campaignIds : undefined,
          AdGroupIds: adGroupIds?.length ? adGroupIds : undefined,
          Ids: ids?.length ? ids : undefined,
          States: states?.length ? states : undefined,
          Statuses: statuses?.length ? statuses : undefined,
        });
        const params: Record<string, unknown> = {
          SelectionCriteria: selection,
          FieldNames: fieldNames?.length ? fieldNames : DEFAULT_FIELDS,
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = autoPaginate
          ? await client.getAll("ads", params)
          : await client.call("ads", "get", params);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_text_ad",
    {
      title: "Создать текстовое объявление",
      annotations: WRITE_CREATE,
      description:
        "Создаёт текстовое объявление (TextAd) в группе объявлений. Новые объявления создаются черновиками. " +
        "TextAdAdd требует хотя бы одно из Href/TurboPageId/VCardId/BusinessId — этот инструмент передаёт посадочную " +
        "страницу через href (обязателен); объявление с BusinessId вместо ссылки создаётся через raw_request.",
      inputSchema: {
        adGroupId: z.number().int().describe("Id родительской группы объявлений."),
        title: z.string().min(1).max(56).describe("Заголовок (Title 1), до 56 символов."),
        title2: z.string().max(30).optional().describe("Второй заголовок (Title 2), до 30 символов."),
        text: z.string().min(1).max(81).describe("Текст объявления, до 81 символа."),
        href: z.string().min(1).describe("URL посадочной страницы (обязателен для TextAdAdd)."),
        mobile: z
          .boolean()
          .default(false)
          .describe("Мобильное ли это объявление. Поле в API устарело (значение принудительно NO), но остаётся обязательным."),
      },
    },
    async ({ adGroupId, title, title2, text, href, mobile }) => {
      try {
        const textAd = compact({
          Title: title,
          Title2: title2,
          Text: text,
          Href: href,
          // Mobile is REQUIRED in TextAdAdd (deprecated: the API coerces it to NO).
          // It must always be sent — compact() used to drop the unset field and
          // ads/add rejected the object with a per-object error.
          Mobile: mobile ? "YES" : "NO",
        });
        const ad = { AdGroupId: adGroupId, TextAd: textAd };
        const result = await client.call("ads", "add", { Ads: [ad] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "ad_action",
    {
      title: "Действие с объявлениями",
      annotations: WRITE_DELETE,
      description:
        "Выполняет действие над объявлениями по id: moderate, suspend, resume, archive, unarchive или delete.",
      inputSchema: {
        action: z.enum(["moderate", "suspend", "resume", "archive", "unarchive", "delete"]),
        ids: z.array(z.number().int()).min(1).describe("Id объявлений, к которым применить действие."),
      },
    },
    async ({ action, ids }) => {
      try {
        const result = await client.call("ads", action, { SelectionCriteria: { Ids: ids } });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_text_ad",
    {
      title: "Обновить текстовое объявление",
      annotations: WRITE_UPDATE,
      description:
        "Обновляет заголовок, текст или посадочную страницу текстового объявления (ads/update). Правка активного объявления отправляет его на повторную модерацию.",
      inputSchema: {
        id: z.number().int().describe("Id объявления, которое нужно обновить."),
        title: z.string().min(1).max(56).optional().describe("Новый заголовок (Title 1), до 56 символов."),
        title2: z.string().max(30).optional().describe("Новый второй заголовок (Title 2), до 30 символов."),
        text: z.string().min(1).max(81).optional().describe("Новый текст объявления, до 81 символа."),
        href: z.string().optional().describe("Новый URL посадочной страницы."),
      },
    },
    async ({ id, title, title2, text, href }) => {
      try {
        const textAd = compact({ Title: title, Title2: title2, Text: text, Href: href });
        if (Object.keys(textAd).length === 0) {
          return fail("Нужно указать хотя бы одно поле для обновления.");
        }
        const result = await client.call("ads", "update", { Ads: [{ Id: id, TextAd: textAd }] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
