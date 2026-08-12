import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, compact, fail, MAX_TOOL_LIMIT, ok, okOrPartial, READ_ONLY, WRITE_CREATE, WRITE_DELETE, WRITE_UPDATE } from "./util.js";

const DEFAULT_FIELDS = ["Id", "Name", "CampaignId", "RegionIds", "Status", "Type"];

export function registerAdGroupTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "list_ad_groups",
    {
      title: "Список групп объявлений",
      annotations: READ_ONLY,
      description:
        "Возвращает список групп объявлений. Нужно передать campaignIds и/или ids — API Яндекс Директа требует хотя бы один критерий отбора.",
      inputSchema: {
        campaignIds: z.array(z.number().int()).optional().describe("Фильтр по id кампаний."),
        ids: z.array(z.number().int()).optional().describe("Фильтр по id групп объявлений."),
        fieldNames: z.array(z.string()).optional().describe("Какие поля группы вернуть."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Максимум объектов на страницу."),
        offset: z.number().int().min(0).optional().describe("Смещение постраничной выдачи (сколько объектов пропустить)."),
        autoPaginate: z
          .boolean()
          .optional()
          .describe("Забрать все страницы, идя по LimitedBy (limit тогда не ограничивает общий объём)."),
      },
    },
    async ({ campaignIds, ids, fieldNames, limit, offset, autoPaginate }) => {
      try {
        const selection = compact({
          CampaignIds: campaignIds?.length ? campaignIds : undefined,
          Ids: ids?.length ? ids : undefined,
        });
        const params: Record<string, unknown> = {
          SelectionCriteria: selection,
          FieldNames: fieldNames?.length ? fieldNames : DEFAULT_FIELDS,
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = autoPaginate
          ? await client.getAll("adgroups", params)
          : await client.call("adgroups", "get", params);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_ad_group",
    {
      title: "Создать группу объявлений",
      annotations: WRITE_CREATE,
      description: "Создаёт группу объявлений в кампании с заданными регионами показа.",
      inputSchema: {
        name: z.string().min(1).describe("Название группы объявлений."),
        campaignId: z.number().int().describe("Id родительской кампании."),
        regionIds: z
          .array(z.number().int())
          .min(1)
          .describe("Id регионов показа, например [225] — Россия."),
      },
    },
    async ({ name, campaignId, regionIds }) => {
      try {
        const adGroup = { Name: name, CampaignId: campaignId, RegionIds: regionIds };
        const result = await client.call("adgroups", "add", { AdGroups: [adGroup] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_ad_group",
    {
      title: "Обновить группу объявлений",
      annotations: WRITE_UPDATE,
      description: "Обновляет название и/или регионы показа группы объявлений (adgroups/update).",
      inputSchema: {
        id: z.number().int().describe("Id группы, которую нужно обновить."),
        name: z.string().min(1).optional().describe("Новое название группы."),
        regionIds: z
          .array(z.number().int())
          .min(1)
          .optional()
          .describe("Новые id регионов показа."),
        negativeKeywords: z
          .array(z.string())
          .optional()
          .describe("Заменяет минус-фразы группы; пустой массив очищает их."),
      },
    },
    async ({ id, name, regionIds, negativeKeywords }) => {
      try {
        const adGroup = compact({
          Id: id,
          Name: name,
          RegionIds: regionIds,
          NegativeKeywords: negativeKeywords !== undefined ? { Items: negativeKeywords } : undefined,
        });
        if (Object.keys(adGroup).length === 1) {
          return fail("Нужно указать хотя бы одно поле для обновления.");
        }
        const result = await client.call("adgroups", "update", { AdGroups: [adGroup] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_ad_groups",
    {
      title: "Удалить группы объявлений",
      annotations: WRITE_DELETE,
      description:
        "Удаляет группы объявлений по id (adgroups/delete). Вместе с группой удаляются её объявления и ключевые фразы; отменить это нельзя.",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Id групп, которые нужно удалить."),
      },
    },
    async ({ ids }) => {
      try {
        const result = await client.call("adgroups", "delete", { SelectionCriteria: { Ids: ids } });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
