/**
 * Pure pieces of the e2e run (src/integration.ts): which account it may write to,
 * what it names its campaigns and which leftovers of earlier runs it may delete.
 * Kept free of I/O so the guards are unit-tested without a token.
 */

export const E2E_CAMPAIGN_PREFIX = "ci-e2e-";

/** A run deletes its own campaign within seconds; one older than this is a leftover of a crashed run. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Whether the account the token answered for (`clients.get` → Login) is the one the run
 * is allowed to write to. Logins compare case-insensitively, as Direct treats them;
 * an empty or missing login on either side refuses.
 */
export function isAllowedAccount(expected: string | undefined, actual: string | undefined): boolean {
  const want = (expected ?? "").trim().toLowerCase();
  const got = (actual ?? "").trim().toLowerCase();
  return want !== "" && want === got;
}

/** Name of this run's campaign: the prefix plus the creation time in ms. */
export function e2eCampaignName(now: number = Date.now()): string {
  return `${E2E_CAMPAIGN_PREFIX}${now}`;
}

/** Creation time encoded in an e2e campaign name; undefined for any other name. */
export function e2eCampaignCreatedAt(name: string | undefined): number | undefined {
  const match = /^ci-e2e-(\d+)$/.exec(name ?? "");
  if (!match) return undefined;
  const at = Number(match[1]);
  return Number.isSafeInteger(at) ? at : undefined;
}

/**
 * Ids of campaigns an earlier run left behind: named by this script and created more
 * than STALE_AFTER_MS ago. Anything else — other names, a fresh e2e campaign of a run
 * going on right now, a prefixed name without a timestamp — is left alone.
 */
export function staleCampaignIds(
  campaigns: { Id: number; Name?: string }[],
  now: number = Date.now(),
): number[] {
  return campaigns
    .filter((c) => {
      const at = e2eCampaignCreatedAt(c.Name);
      return at !== undefined && now - at > STALE_AFTER_MS;
    })
    .map((c) => c.Id);
}

export interface CurrencyItem {
  Currency?: string;
  Properties?: { Name?: string; Value?: string }[];
}

/**
 * The minimum weekly budget (micros) of `currency` from the Currencies dictionary —
 * the MinimumWeeklySpendLimit property; undefined when the dictionary lacks it.
 */
export function minWeeklySpendLimit(currencies: CurrencyItem[], currency: string): number | undefined {
  const item = currencies.find((c) => (c.Currency ?? "").toUpperCase() === currency.toUpperCase());
  const raw = item?.Properties?.find((p) => p.Name === "MinimumWeeklySpendLimit")?.Value;
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
