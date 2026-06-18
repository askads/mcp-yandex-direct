#!/usr/bin/env node
// Sandbox integration check: a read pass plus a create/delete write round-trip.
// Hard-guarded to the sandbox so it can never write to a real account.
import { YandexDirectClient } from "./client.js";
import { loadConfig } from "./config.js";

interface ObjectResult {
  Id?: number;
  Errors?: { Message?: string }[];
}

function startDate(): string {
  // StartDate is required and must be >= the account's current date (in the account's
  // own timezone). Computing "today" in UTC underflows for accounts ahead of UTC during
  // the 21:00-24:00 UTC window (e.g. MSK has already rolled to the next day) → the API
  // rejects it as a past date ("Поле задано неверно"). Tomorrow (UTC) is >= today in any
  // timezone (-12..+14), so it's valid for every account without assuming a timezone.
  // The campaign is deleted right after, so the actual start date is irrelevant.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function firstError(result?: ObjectResult): string {
  return result?.Errors?.map((e) => e.Message).join("; ") ?? "unknown error";
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.sandbox) {
    console.error("Refusing to run: integration writes require the sandbox (set YANDEX_DIRECT_SANDBOX=true).");
    process.exit(1);
  }
  const client = new YandexDirectClient(config);
  console.log("Yandex Direct sandbox integration check\n");

  // 1. Read: account info (also carries the Units quota header).
  const account = await client.call<{ Clients?: { Login?: string; Currency?: string }[] }>(
    "clients",
    "get",
    { FieldNames: ["Login", "Currency"] },
  );
  const c = account.Clients?.[0];
  console.log(`account: ${c?.Login ?? "?"} (${c?.Currency ?? "?"})`);
  const units = client.units;
  if (units) console.log(`quota:   ${units.spent} spent / ${units.rest} left / ${units.limit} limit`);

  // 2. Write round-trip: create a campaign, then delete it (leaves the sandbox clean).
  const name = `ci-healthcheck-${Date.now()}`;
  const add = await client.call<{ AddResults?: ObjectResult[] }>("campaigns", "add", {
    Campaigns: [
      {
        Name: name,
        StartDate: startDate(),
        TextCampaign: {
          BiddingStrategy: {
            Search: { BiddingStrategyType: "HIGHEST_POSITION" },
            Network: { BiddingStrategyType: "SERVING_OFF" },
          },
        },
      },
    ],
  });
  const created = add.AddResults?.[0];
  if (!created?.Id) {
    throw new Error(`campaign create failed: ${firstError(created)}`);
  }
  console.log(`created campaign ${created.Id}`);

  const del = await client.call<{ DeleteResults?: ObjectResult[] }>("campaigns", "delete", {
    SelectionCriteria: { Ids: [created.Id] },
  });
  const deleted = del.DeleteResults?.[0];
  if (deleted?.Errors?.length) {
    throw new Error(`campaign delete failed: ${firstError(deleted)}`);
  }
  console.log(`deleted campaign ${created.Id}`);

  console.log("\nIntegration check passed.");
}

main().catch((err) => {
  console.error(`\nIntegration check FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
