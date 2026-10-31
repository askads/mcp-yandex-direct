import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { YandexDirectClient } from "../client.js";
import { fail, okOrPartial, stringList } from "./util.js";

/**
 * Shared engine of the list-editing tools (update_negative_keywords, update_excluded_sites).
 * The API stores these fields as one ArrayOfString and replaces it on every write, so
 * add/remove are read-modify-write here: one get, one update, both named in each tool's
 * description, and the answer says exactly what happened (before/after, added/…).
 */
export const LIST_ACTIONS = ["add", "remove", "replace", "clear"] as const;
export type ListAction = (typeof LIST_ACTIONS)[number];

export interface ListTarget {
  service: "campaigns" | "adgroups";
  listKey: "Campaigns" | "AdGroups";
  /** Name of the id in the tool's answer (campaignId / adGroupId). */
  idKey: string;
  id: number;
  /** API field: NegativeKeywords, ExcludedSites. */
  field: string;
  /** "Кампания" / "Группа объявлений" — for the not-found message. */
  label: string;
  /** Comparison key: the same folding the API applies when it stores the list. */
  key: (item: string) => string;
}

/** Answers the structural mistakes before any call; undefined when the input is fine. */
export function checkListInput(action: ListAction, items: string[] | undefined): string | undefined {
  if (action === "clear" && items !== undefined) {
    return "Для clear список не передаётся: действие удаляет все элементы.";
  }
  if (action !== "clear" && !items?.length) {
    return `Для ${action} нужен непустой список. Чтобы удалить всё — action: clear.`;
  }
  return undefined;
}

/** Trims, collapses inner whitespace, keeps the first spelling per key (the API rejects repeats, code 9802). */
function dedupe(items: string[], key: (item: string) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim().replace(/\s+/g, " ");
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export async function editList(
  client: YandexDirectClient,
  target: ListTarget,
  action: ListAction,
  items: string[] | undefined,
): Promise<CallToolResult> {
  const input = dedupe(items ?? [], target.key);
  const head = { [target.idKey]: target.id, action };

  const write = async (next: string[], summary: Record<string, unknown>) => {
    const res = await client.call<{ UpdateResults?: { Errors?: unknown[] }[] }>(target.service, "update", {
      [target.listKey]: [{ Id: target.id, [target.field]: stringList(next) }],
    });
    // A per-object error means nothing was written: say so instead of a stale "changed: true".
    const changed = !(res.UpdateResults ?? []).some((r) => (r.Errors?.length ?? 0) > 0);
    if (!changed) {
      // Never report an "after" that was not written; added/removed then show the attempt.
      const { after: _after, ...attempt } = summary;
      return okOrPartial({
        ...head,
        changed,
        ...attempt,
        note: "Запись не прошла, список не изменился. added/removed — то, что пытались записать.",
        ...res,
      });
    }
    return okOrPartial({ ...head, changed, ...summary, ...res });
  };

  if (action === "replace") return write(input, { after: input.length });
  if (action === "clear") return write([], { after: 0 });

  const res = await client.call<Record<string, Record<string, { Items?: string[] } | null>[]>>(
    target.service,
    "get",
    { SelectionCriteria: { Ids: [target.id] }, FieldNames: ["Id", target.field] },
  );
  const found = res[target.listKey]?.[0];
  if (!found) return fail(`${target.label} ${target.id} не найдена — ничего не записано.`);
  const current = found[target.field]?.Items ?? [];
  const currentKeys = new Set(current.map(target.key));
  const unchanged = (summary: Record<string, unknown>) =>
    okOrPartial({ ...head, changed: false, before: current.length, ...summary, after: current.length });

  if (action === "add") {
    const added = input.filter((item) => !currentKeys.has(target.key(item)));
    const alreadyPresent = input.filter((item) => currentKeys.has(target.key(item)));
    if (added.length === 0) return unchanged({ added, alreadyPresent });
    const next = [...current, ...added];
    return write(next, { before: current.length, added, alreadyPresent, after: next.length });
  }

  const inputKeys = new Set(input.map(target.key));
  const removed = current.filter((item) => inputKeys.has(target.key(item)));
  const removedKeys = new Set(removed.map(target.key));
  const notFound = input.filter((item) => !removedKeys.has(target.key(item)));
  if (removed.length === 0) return unchanged({ removed, notFound });
  const next = current.filter((item) => !inputKeys.has(target.key(item)));
  return write(next, { before: current.length, removed, notFound, after: next.length });
}
