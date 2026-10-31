import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { fail, WRITE_DELETE } from "./util.js";
import { checkListInput, editList, LIST_ACTIONS } from "./listEdit.js";

/**
 * Comparison key for "is this phrase already in the list". Case-insensitive because
 * the API itself folds case variants into one phrase on write (checked live:
 * "тестслово" + "Тестслово" was stored as one); no morphology, no word reordering —
 * those are the API's matching rules, not ours to guess.
 */
function phraseKey(phrase: string): string {
  return phrase.trim().replace(/\s+/g, " ").toLowerCase();
}

export function registerNegativeKeywordTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "update_negative_keywords",
    {
      title: "Изменить минус-фразы",
      annotations: WRITE_DELETE,
      description:
        "Меняет минус-фразы одной кампании или одной группы объявлений. API хранит список целиком и при записи " +
        "заменяет его, поэтому действие задаётся явно:\n" +
        "- add — дописать фразы к текущим. Инструмент читает текущий список (campaigns/get или adgroups/get) и " +
        "записывает объединённый (update): два вызова API. Уже имеющиеся фразы не дублируются.\n" +
        "- remove — убрать указанные фразы из текущего списка. Тоже чтение + запись.\n" +
        "- replace — записать ровно переданный список вместо текущего, без чтения. Пустой список здесь " +
        "не принимается — для очистки есть clear.\n" +
        "- clear — удалить все минус-фразы (отправляется null).\n" +
        "Фразы сравниваются без учёта регистра и лишних пробелов — так же склеивает их сам API; морфологию и " +
        "порядок слов инструмент не учитывает. Если add/remove ничего не меняют, записи нет (changed: false). " +
        "Ответ: before/after — число фраз до и после, added/alreadyPresent или removed/notFound — что именно " +
        "произошло. Между чтением и записью нет блокировки: правка того же списка в интерфейсе в эту секунду " +
        "будет перезаписана. Ограничения API: фраза без минуса в начале, до 7 слов, слово до 35 символов; " +
        "суммарно до 20 000 символов на кампанию и 4096 на группу — нарушения API вернёт ошибкой по объекту. " +
        "Минус-фразы кампании и группы действуют вместе.",
      inputSchema: {
        campaignId: z.number().int().optional().describe("Id кампании (либо это поле, либо adGroupId)."),
        adGroupId: z.number().int().optional().describe("Id группы объявлений (либо это поле, либо campaignId)."),
        action: z.enum(LIST_ACTIONS).describe("add, remove, replace или clear — см. описание инструмента."),
        phrases: z
          .array(z.string().trim().min(1))
          .optional()
          .describe("Минус-фразы без ведущего минуса, например [\"бесплатно\", \"!скачать\"]. Не передаётся для clear."),
      },
    },
    async ({ campaignId, adGroupId, action, phrases }) => {
      try {
        if ((campaignId === undefined) === (adGroupId === undefined)) {
          return fail("Нужно указать ровно одно: campaignId или adGroupId.");
        }
        const problem = checkListInput(action, phrases);
        if (problem) return fail(problem);
        const target =
          campaignId !== undefined
            ? { service: "campaigns", listKey: "Campaigns", idKey: "campaignId", id: campaignId, label: "Кампания" } as const
            : { service: "adgroups", listKey: "AdGroups", idKey: "adGroupId", id: adGroupId!, label: "Группа объявлений" } as const;
        return await editList(client, { ...target, field: "NegativeKeywords", key: phraseKey }, action, phrases);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
