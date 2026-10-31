import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { fail, WRITE_DELETE } from "./util.js";
import { checkListInput, editList, LIST_ACTIONS } from "./listEdit.js";

/**
 * Comparison key for "is this placement already excluded". The API stores domains
 * lowercased and without "www." (checked live: "www.Example.org" came back as
 * "example.org"), so the same folding here keeps add/remove in step with what is stored.
 */
function siteKey(site: string): string {
  return site.trim().toLowerCase().replace(/^www\./, "");
}

export function registerExcludedSiteTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "update_excluded_sites",
    {
      title: "Изменить запрещённые площадки",
      annotations: WRITE_DELETE,
      description:
        "Меняет список площадок, где кампании запрещено показываться (ExcludedSites): сайты, мобильные приложения " +
        "и внешние сети РСЯ. Действует только в сетях, на поиске площадки не запрещаются. API хранит список " +
        "целиком и при записи заменяет его, поэтому действие задаётся явно:\n" +
        "- add — дописать площадки к текущим. Инструмент читает текущий список (campaigns/get) и записывает " +
        "объединённый (campaigns/update): два вызова API. Уже исключённые не дублируются.\n" +
        "- remove — вернуть показы на указанных площадках. Тоже чтение + запись.\n" +
        "- replace — записать ровно переданный список вместо текущего, без чтения. Пустой список здесь " +
        "не принимается — для очистки есть clear.\n" +
        "- clear — снять все запреты (отправляется null).\n" +
        "Значения: домен без протокола (example.com — API сам уберёт www. и приведёт к нижнему регистру), " +
        "id приложения Android/iOS в виде com.example.app (числовой id App Store вида id123456789 API отвергает), " +
        "название внешней сети из get_dictionaries → SupplySidePlatforms (например BidSwitch). Значение площадки " +
        "из отчёта get_statistics (поле Placement, строки с AdNetworkType=AD_NETWORK) передаётся как есть. " +
        "Если add/remove ничего не меняют, записи нет (changed: false). Ответ: before/after — число площадок " +
        "до и после, added/alreadyPresent или removed/notFound. Между чтением и записью нет блокировки: правка " +
        "того же списка в интерфейсе в эту секунду будет перезаписана. Лимиты API: до 1000 площадок, " +
        "до 255 символов в каждой. Текущий список — list_campaigns с fieldNames [\"ExcludedSites\"].",
      inputSchema: {
        campaignId: z.number().int().describe("Id кампании."),
        action: z.enum(LIST_ACTIONS).describe("add, remove, replace или clear — см. описание инструмента."),
        sites: z
          .array(z.string().trim().min(1).max(255))
          .optional()
          .describe("Площадки: домены, id приложений, названия внешних сетей. Не передаётся для clear."),
      },
    },
    async ({ campaignId, action, sites }) => {
      try {
        const problem = checkListInput(action, sites);
        if (problem) return fail(problem);
        const withProtocol = sites?.find((s) => s.includes("://"));
        if (withProtocol) {
          return fail(`Площадка передаётся без протокола: «${withProtocol}» → домен вида example.com.`);
        }
        return await editList(
          client,
          {
            service: "campaigns",
            listKey: "Campaigns",
            idKey: "campaignId",
            id: campaignId,
            label: "Кампания",
            field: "ExcludedSites",
            key: siteKey,
          },
          action,
          sites,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}
