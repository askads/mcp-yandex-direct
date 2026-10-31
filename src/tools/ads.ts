import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, compact, fail, NO_SELECTION, MAX_TOOL_LIMIT, ok, okOrPartial, READ_ONLY, WRITE_CREATE, WRITE_DELETE, WRITE_UPDATE } from "./util.js";

const AD_STATES = ["ON", "OFF", "SUSPENDED", "OFF_BY_MONITORING", "ARCHIVED"] as const;
const AD_STATUSES = ["ACCEPTED", "DRAFT", "MODERATION", "PREACCEPTED", "REJECTED"] as const;

// ads.get FieldNames (checked live 2026-10-30).
const AD_FIELDS = [
  "AdCategories", "AgeLabel", "AdGroupId", "CampaignId", "Id", "State", "Status", "StatusClarification",
  "Type", "Subtype",
] as const;
// TextAdFieldNames: the ad's texts and links live here, not in FieldNames. Accepted in the
// same fieldNames array and routed to TextAdFieldNames — "Title"/"Text" in FieldNames was
// the usual way to draw code 8000.
const TEXT_AD_FIELDS = [
  "Title", "Title2", "Text", "Href", "FinalUrl", "DisplayDomain", "DisplayUrlPath", "Mobile",
  "SitelinkSetId", "VCardId", "AdImageHash", "AdExtensions", "TurboPageId", "BusinessId",
  "TrackingParams", "LfHref", "LfButtonText", "ErirAdDescription",
] as const;
const TEXT_AD_FIELD_SET: ReadonlySet<string> = new Set(TEXT_AD_FIELDS);

const DEFAULT_FIELDS = ["Id", "AdGroupId", "CampaignId", "Status", "State", "Type"];

export function registerAdTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "list_ads",
    {
      title: "Список объявлений",
      annotations: READ_ONLY,
      description:
        "Возвращает список объявлений. Нужно передать campaignIds, adGroupIds или ids — API Яндекс Директа требует хотя бы один из них; states и statuses только сужают выборку.",
      inputSchema: {
        campaignIds: z.array(z.number().int()).optional().describe("Фильтр по id кампаний."),
        adGroupIds: z.array(z.number().int()).optional().describe("Фильтр по id групп объявлений."),
        ids: z.array(z.number().int()).optional().describe("Фильтр по id объявлений."),
        states: z.array(z.enum(AD_STATES)).optional().describe("Фильтр по состояниям объявлений."),
        statuses: z.array(z.enum(AD_STATUSES)).optional().describe("Фильтр по статусам модерации."),
        fieldNames: z
          .array(z.enum([...AD_FIELDS, ...TEXT_AD_FIELDS]))
          .optional()
          .describe(
            "Какие поля объявления вернуть. Тексты и ссылки (Title, Title2, Text, Href, …) приходят в объекте TextAd.",
          ),
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
        if (!campaignIds?.length && !adGroupIds?.length && !ids?.length) {
          return fail(NO_SELECTION("campaignIds, adGroupIds или ids"));
        }
        const adFields = fieldNames?.filter((f) => !TEXT_AD_FIELD_SET.has(f)) ?? [];
        const textAdFields = fieldNames?.filter((f) => TEXT_AD_FIELD_SET.has(f)) ?? [];
        const selection = compact({
          CampaignIds: campaignIds?.length ? campaignIds : undefined,
          AdGroupIds: adGroupIds?.length ? adGroupIds : undefined,
          Ids: ids?.length ? ids : undefined,
          States: states?.length ? states : undefined,
          Statuses: statuses?.length ? statuses : undefined,
        });
        const params: Record<string, unknown> = {
          SelectionCriteria: selection,
          // FieldNames may not be empty: asking only for texts still returns the ids.
          FieldNames: adFields.length ? adFields : textAdFields.length ? ["Id"] : DEFAULT_FIELDS,
        };
        if (textAdFields.length) params.TextAdFieldNames = textAdFields;
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
        "TextAdAdd требует хотя бы одно из Href/TurboPageId/BusinessId — этот инструмент передаёт посадочную " +
        "страницу через href (обязателен); объявление с BusinessId вместо ссылки создаётся через raw_request. " +
        "Визитки (VCardId) Директ больше не поддерживает: контакты задаются организацией из Яндекс Бизнеса (BusinessId).",
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
