import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, compact, fail, MAX_TOOL_LIMIT, normalizeMoney, ok, okOrPartial, READ_ONLY, toMicros, WRITE_CREATE, WRITE_DELETE, WRITE_UPDATE } from "./util.js";

const DEFAULT_FIELDS = ["Id", "Keyword", "AdGroupId", "CampaignId", "Bid", "ContextBid", "State", "Status"];

export function registerKeywordTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "list_keywords",
    {
      title: "Список ключевых фраз",
      annotations: READ_ONLY,
      description:
        "Возвращает список ключевых фраз с фильтром по кампании, группе объявлений или id. Bid и ContextBid отдаются в валюте аккаунта.",
      inputSchema: {
        campaignIds: z.array(z.number().int()).optional().describe("Фильтр по id кампаний."),
        adGroupIds: z.array(z.number().int()).optional().describe("Фильтр по id групп объявлений."),
        ids: z.array(z.number().int()).optional().describe("Фильтр по id ключевых фраз."),
        fieldNames: z.array(z.string()).optional().describe("Какие поля ключевой фразы вернуть."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Максимум объектов на страницу."),
        offset: z.number().int().min(0).optional().describe("Смещение постраничной выдачи (сколько объектов пропустить)."),
        autoPaginate: z
          .boolean()
          .optional()
          .describe("Забрать все страницы, идя по LimitedBy (limit тогда не ограничивает общий объём)."),
      },
    },
    async ({ campaignIds, adGroupIds, ids, fieldNames, limit, offset, autoPaginate }) => {
      try {
        const selection = compact({
          CampaignIds: campaignIds?.length ? campaignIds : undefined,
          AdGroupIds: adGroupIds?.length ? adGroupIds : undefined,
          Ids: ids?.length ? ids : undefined,
        });
        const params: Record<string, unknown> = {
          SelectionCriteria: selection,
          FieldNames: fieldNames?.length ? fieldNames : DEFAULT_FIELDS,
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = autoPaginate
          ? await client.getAll("keywords", params)
          : await client.call("keywords", "get", params);
        return ok(normalizeMoney(result));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "add_keywords",
    {
      title: "Добавить ключевые фразы",
      annotations: WRITE_CREATE,
      description: "Добавляет ключевые фразы в группу объявлений, при необходимости — со ставками для поиска и сетей.",
      inputSchema: {
        adGroupId: z.number().int().describe("Id группы объявлений."),
        keywords: z
          .array(
            z.object({
              keyword: z.string().min(1).describe("Ключевая фраза, при необходимости с операторами."),
              bid: z.number().positive().optional().describe("Ставка на поиске в валюте аккаунта."),
              contextBid: z.number().positive().optional().describe("Ставка в сетях в валюте аккаунта."),
            }),
          )
          .min(1)
          .describe("Ключевые фразы для добавления."),
      },
    },
    async ({ adGroupId, keywords }) => {
      try {
        const payload = keywords.map((k) =>
          compact({
            AdGroupId: adGroupId,
            Keyword: k.keyword,
            Bid: k.bid !== undefined ? toMicros(k.bid) : undefined,
            ContextBid: k.contextBid !== undefined ? toMicros(k.contextBid) : undefined,
          }),
        );
        const result = await client.call("keywords", "add", { Keywords: payload });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "keyword_action",
    {
      title: "Действие с ключевыми фразами",
      annotations: WRITE_DELETE,
      description: "Выполняет действие над ключевыми фразами по id: suspend, resume или delete.",
      inputSchema: {
        action: z.enum(["suspend", "resume", "delete"]),
        ids: z.array(z.number().int()).min(1).describe("Id ключевых фраз, к которым применить действие."),
      },
    },
    async ({ action, ids }) => {
      try {
        const result = await client.call("keywords", action, { SelectionCriteria: { Ids: ids } });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "set_keyword_bids",
    {
      title: "Задать ставки ключевых фраз",
      annotations: WRITE_UPDATE,
      description:
        "Задаёт ручные ставки на поиске и в сетях для ключевых фраз либо для всех фраз указанных групп объявлений или кампаний (keywordbids/set). Ставки — в валюте аккаунта.",
      inputSchema: {
        bids: z
          .array(
            z.object({
              keywordId: z.number().int().optional().describe("Применить к одной ключевой фразе."),
              adGroupId: z.number().int().optional().describe("Применить ко всем фразам группы объявлений."),
              campaignId: z.number().int().optional().describe("Применить ко всем фразам кампании."),
              bid: z.number().positive().optional().describe("Ставка на поиске в валюте аккаунта."),
              contextBid: z.number().positive().optional().describe("Ставка в сетях в валюте аккаунта."),
            }),
          )
          .min(1)
          .describe("В каждом элементе нужен один целевой id и хотя бы одно из полей bid/contextBid."),
      },
    },
    async ({ bids }) => {
      try {
        for (const b of bids) {
          if (b.keywordId === undefined && b.adGroupId === undefined && b.campaignId === undefined) {
            return fail("В каждом элементе нужен keywordId, adGroupId или campaignId.");
          }
          if (b.bid === undefined && b.contextBid === undefined) {
            return fail("В каждом элементе нужен bid и/или contextBid.");
          }
        }
        const KeywordBids = bids.map((b) =>
          compact({
            KeywordId: b.keywordId,
            AdGroupId: b.adGroupId,
            CampaignId: b.campaignId,
            Bid: b.bid !== undefined ? toMicros(b.bid) : undefined,
            ContextBid: b.contextBid !== undefined ? toMicros(b.contextBid) : undefined,
          }),
        );
        const result = await client.call("keywordbids", "set", { KeywordBids });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
