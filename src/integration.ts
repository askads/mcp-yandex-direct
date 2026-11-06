#!/usr/bin/env node
/**
 * E2E check against the production API on the dedicated demo account: reads along the
 * paths the tools use (clients, campaigns via v501, Live v4 balance, dictionaries,
 * Reports), then a write round-trip for each campaign type the tools create — a draft
 * Единая перформанс-кампания on manual bids (HighestPosition) and a draft TextCampaign on
 * WB_MAXIMUM_CLICKS (TextCampaign manual bids have no budget) — add, read back, delete. No ad groups or ads are ever created, so the campaign cannot serve
 * or spend. Writes happen only after `clients.get` answered with the login from
 * E2E_ACCOUNT_LOGIN; any other account, a missing login or the sandbox refuses.
 */
import { YandexDirectClient } from "./client.js";
import { loadConfig } from "./config.js";
import {
  type CurrencyItem,
  e2eCampaignName,
  isAllowedAccount,
  minWeeklySpendLimit,
  staleCampaignIds,
} from "./integrationGuard.js";
import { reportName } from "./tools/util.js";

interface ObjectResult {
  Id?: number;
  Errors?: { Message?: string; Details?: string }[];
}

interface Strategy {
  BiddingStrategyType?: string;
  [params: string]: unknown;
}

interface Campaign {
  Id: number;
  Name?: string;
  Type?: string;
  State?: string;
  UnifiedCampaign?: TypeBlock;
  TextCampaign?: TypeBlock;
}

interface TypeBlock {
  BiddingStrategy?: { Search?: Strategy; Network?: Strategy };
  WeeklyBudgetRollover?: number | null;
}

type CampaignKind = "UnifiedCampaign" | "TextCampaign";
const PLAN: Record<CampaignKind, { type: string; strategy: string; params: string }> = {
  UnifiedCampaign: { type: "UNIFIED_CAMPAIGN", strategy: "HIGHEST_POSITION", params: "HighestPosition" },
  TextCampaign: { type: "TEXT_CAMPAIGN", strategy: "WB_MAXIMUM_CLICKS", params: "WbMaximumClicks" },
};

const passed: string[] = [];

function pass(line: string): void {
  passed.push(line);
  console.log(`ok   ${line}`);
}

function refuse(reason: string): never {
  console.error(`Refusing to run: ${reason}`);
  process.exit(1);
}

function expectEqual(what: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function firstError(result?: ObjectResult): string {
  return result?.Errors?.map((e) => [e.Message, e.Details].filter(Boolean).join(": ")).join("; ") ?? "unknown error";
}

/**
 * StartDate must be >= the account's current date in its own timezone. "Today" in UTC
 * is already yesterday for MSK after 21:00 UTC, so tomorrow (UTC) — valid in any
 * timezone from -12 to +14. The campaign is deleted right after, so the date is moot.
 */
function startDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function deleteCampaigns(client: YandexDirectClient, ids: number[]): Promise<void> {
  const res = await client.call<{ DeleteResults?: ObjectResult[] }>("campaigns", "delete", {
    SelectionCriteria: { Ids: ids },
  });
  const errors = (res.DeleteResults ?? []).flatMap((r, i) => (r.Errors?.length ? [`${ids[i]}: ${firstError(r)}`] : []));
  if (errors.length) throw new Error(`campaigns.delete: ${errors.join("; ")}`);
}

async function roundTrip(client: YandexDirectClient, kind: CampaignKind, weeklyMicros: number): Promise<void> {
  const name = e2eCampaignName();
  const plan = PLAN[kind];
  const add = await client.call<{ AddResults?: ObjectResult[] }>("campaigns", "add", {
    Campaigns: [
      {
        Name: name,
        StartDate: startDate(),
        [kind]: {
          BiddingStrategy: {
            Search: { BiddingStrategyType: plan.strategy, [plan.params]: { WeeklySpendLimit: weeklyMicros } },
            Network: { BiddingStrategyType: "SERVING_OFF" },
          },
        },
      },
    ],
  });
  const created = add.AddResults?.[0];
  if (!created?.Id) throw new Error(`campaigns.add (${kind}, ${plan.strategy}): ${firstError(created)}`);
  pass(`campaigns.add (v501, ${kind}, ${plan.strategy}): "${name}" → ${created.Id}`);

  let verifyError: unknown;
  try {
    const got = await client.call<{ Campaigns?: Campaign[] }>("campaigns", "get", {
      SelectionCriteria: { Ids: [created.Id] },
      FieldNames: ["Id", "Name", "Type", "State"],
      [`${kind}FieldNames`]: ["BiddingStrategy", "WeeklyBudgetRollover"],
    });
    const campaign = got.Campaigns?.[0];
    if (!campaign) throw new Error(`campaigns.get: campaign ${created.Id} not returned`);
    expectEqual("Name", campaign.Name, name);
    expectEqual("Type", campaign.Type, plan.type);
    const block = campaign[kind];
    const strategy = block?.BiddingStrategy;
    expectEqual("Search.BiddingStrategyType", strategy?.Search?.BiddingStrategyType, plan.strategy);
    const search = strategy?.Search?.[plan.params] as { WeeklySpendLimit?: number } | undefined;
    expectEqual(`Search.${plan.params}.WeeklySpendLimit`, search?.WeeklySpendLimit, weeklyMicros);
    expectEqual("Network.BiddingStrategyType", strategy?.Network?.BiddingStrategyType, "SERVING_OFF");
    pass(
      `campaigns.get: ${campaign.Type}, State ${campaign.State}, WeeklySpendLimit ${weeklyMicros}, ` +
        `WeeklyBudgetRollover ${JSON.stringify(block?.WeeklyBudgetRollover)}`,
    );
  } catch (err) {
    verifyError = err;
  }

  // The campaign goes away even when the read-back failed; both failures get reported.
  try {
    await deleteCampaigns(client, [created.Id]);
    pass(`campaigns.delete: ${created.Id}`);
  } catch (err) {
    console.error(`FAIL campaigns.delete ${created.Id}: ${err instanceof Error ? err.message : String(err)}`);
    if (!verifyError) throw err;
  }
  if (verifyError) throw verifyError;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const expected = process.env.E2E_ACCOUNT_LOGIN;
  if (config.sandbox) {
    refuse("the e2e check covers the production path only — unset YANDEX_DIRECT_SANDBOX.");
  }
  if (!expected?.trim()) {
    refuse("E2E_ACCOUNT_LOGIN is not set — name the account this run may write to (CI: askads-demo).");
  }
  const client = new YandexDirectClient(config);
  console.log(`Yandex Direct e2e check, account "${expected}"\n`);

  // 1. Account — the gate for every write below.
  const clients = await client.call<{ Clients?: { Login?: string; Currency?: string }[] }>("clients", "get", {
    FieldNames: ["Login", "Currency"],
  });
  const account = clients.Clients?.[0];
  if (!isAllowedAccount(expected, account?.Login)) {
    refuse(`the token answers for "${account?.Login ?? "?"}", not for "${expected}" — nothing was written.`);
  }
  const currency = account?.Currency;
  if (!currency) throw new Error("clients.get: no Currency in the answer");
  const units = client.units;
  pass(`clients.get: ${account.Login}, ${currency}${units ? `, units ${units.spent} spent / ${units.rest} left` : ""}`);

  // 2. Campaigns through v501 (the production route) + leftovers of crashed runs.
  const list = await client.getAll<{ Campaigns?: Campaign[] }>("campaigns", {
    SelectionCriteria: {},
    FieldNames: ["Id", "Name", "Type"],
  });
  const campaigns = list.Campaigns ?? [];
  pass(`campaigns.get (v501): ${campaigns.length} campaign(s)`);
  const stale = staleCampaignIds(campaigns);
  if (stale.length) {
    await deleteCampaigns(client, stale);
    pass(`cleanup: deleted ${stale.length} leftover campaign(s) of earlier runs: ${stale.join(", ")}`);
  }

  // 3. Balance — Live v4, the route get_balance takes.
  const balance = await client.callV4<{ Accounts?: { Login?: string; Amount?: string; Currency?: string }[] }>(
    "AccountManagement",
    { Action: "Get", SelectionCriteria: {} },
  );
  const funds = balance.Accounts?.[0];
  pass(`AccountManagement.Get (Live v4): ${funds ? `${funds.Amount} ${funds.Currency}` : "no shared account"}`);

  // 4. Currencies dictionary → the minimum weekly budget the write below must respect.
  const dict = await client.call<{ Currencies?: CurrencyItem[] }>("dictionaries", "get", {
    DictionaryNames: ["Currencies"],
  });
  const weeklyMicros = minWeeklySpendLimit(dict.Currencies ?? [], currency);
  if (weeklyMicros === undefined) {
    throw new Error(`dictionaries.get: no MinimumWeeklySpendLimit for ${currency} in Currencies`);
  }
  pass(`dictionaries.get: MinimumWeeklySpendLimit ${currency} = ${weeklyMicros / 1_000_000}`);

  // 5. Reports — one account-level report for yesterday; an empty answer still proves the route.
  const request = {
    SelectionCriteria: {},
    FieldNames: ["Impressions", "Clicks", "Cost"],
    ReportType: "ACCOUNT_PERFORMANCE_REPORT",
    DateRangeType: "YESTERDAY",
    Format: "TSV",
    IncludeVAT: "YES",
    IncludeDiscount: "NO",
  };
  const tsv = await client.report({ ...request, ReportName: reportName("ci-e2e", request) });
  const rows = tsv.split("\n").filter((line) => line.trim() !== "").length;
  pass(`reports (ACCOUNT_PERFORMANCE_REPORT, YESTERDAY): ${rows} row(s)`);

  // 6. Write round-trips: draft campaigns with manual bids on search, networks off.
  await roundTrip(client, "UnifiedCampaign", weeklyMicros);
  await roundTrip(client, "TextCampaign", weeklyMicros);

  console.log(`\nE2E check passed: ${passed.length} checks on "${account.Login}".`);
}

main().catch((err) => {
  console.error(`\nE2E check FAILED after ${passed.length} passed check(s): ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
