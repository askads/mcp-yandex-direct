import { test } from "node:test";
import assert from "node:assert/strict";
import {
  E2E_CAMPAIGN_PREFIX,
  STALE_AFTER_MS,
  e2eCampaignCreatedAt,
  e2eCampaignName,
  isAllowedAccount,
  minWeeklySpendLimit,
  staleCampaignIds,
} from "./integrationGuard.js";

test("isAllowedAccount: only the expected login passes, case-insensitively", () => {
  assert.equal(isAllowedAccount("askads-demo", "askads-demo"), true);
  assert.equal(isAllowedAccount("askads-demo", "AskAds-Demo"), true);
  assert.equal(isAllowedAccount("ASKADS-DEMO", " askads-demo "), true);
  assert.equal(isAllowedAccount("askads-demo", "real-client"), false);
  assert.equal(isAllowedAccount("askads-demo", "askads-demo2"), false);
});

test("isAllowedAccount: an empty or missing login on either side refuses", () => {
  assert.equal(isAllowedAccount(undefined, "askads-demo"), false);
  assert.equal(isAllowedAccount("", "askads-demo"), false);
  assert.equal(isAllowedAccount("   ", "askads-demo"), false);
  assert.equal(isAllowedAccount("askads-demo", undefined), false);
  assert.equal(isAllowedAccount("askads-demo", ""), false);
  assert.equal(isAllowedAccount("", ""), false);
  assert.equal(isAllowedAccount(undefined, undefined), false);
});

test("e2eCampaignName round-trips through e2eCampaignCreatedAt", () => {
  const now = 1_800_000_000_000;
  const name = e2eCampaignName(now);
  assert.ok(name.startsWith(E2E_CAMPAIGN_PREFIX));
  assert.equal(e2eCampaignCreatedAt(name), now);
  assert.equal(e2eCampaignCreatedAt("ci-e2e-"), undefined);
  assert.equal(e2eCampaignCreatedAt("ci-e2e-abc"), undefined);
  assert.equal(e2eCampaignCreatedAt("ci-healthcheck-1800000000000"), undefined);
  assert.equal(e2eCampaignCreatedAt("Brand campaign"), undefined);
  assert.equal(e2eCampaignCreatedAt(undefined), undefined);
});

test("staleCampaignIds: only ci-e2e- campaigns older than an hour", () => {
  const now = 1_800_000_000_000;
  const campaigns = [
    { Id: 1, Name: e2eCampaignName(now - STALE_AFTER_MS - 1) },
    { Id: 2, Name: e2eCampaignName(now - 2 * STALE_AFTER_MS) },
    { Id: 3, Name: e2eCampaignName(now - STALE_AFTER_MS) },
    { Id: 4, Name: e2eCampaignName(now - 5_000) },
    { Id: 5, Name: e2eCampaignName(now + 60_000) },
    { Id: 6, Name: "ci-healthcheck-1" },
    { Id: 7, Name: "Весенняя распродажа" },
    { Id: 8, Name: "ci-e2e-" },
    { Id: 9, Name: "ci-e2e-1 copy" },
    { Id: 10 },
  ];
  assert.deepEqual(staleCampaignIds(campaigns, now), [1, 2]);
  assert.deepEqual(staleCampaignIds([], now), []);
});

test("minWeeklySpendLimit: MinimumWeeklySpendLimit of the account's currency, in micros", () => {
  const currencies = [
    { Currency: "RUB", Properties: [{ Name: "MinimumPayment", Value: "300000000" }, { Name: "MinimumWeeklySpendLimit", Value: "300000000" }] },
    { Currency: "USD", Properties: [{ Name: "MinimumWeeklySpendLimit", Value: "10000000" }] },
    { Currency: "EUR", Properties: [{ Name: "MinimumPayment", Value: "15000000" }] },
    { Currency: "KZT", Properties: [{ Name: "MinimumWeeklySpendLimit", Value: "XXXX" }] },
  ];
  assert.equal(minWeeklySpendLimit(currencies, "USD"), 10_000_000);
  assert.equal(minWeeklySpendLimit(currencies, "usd"), 10_000_000);
  assert.equal(minWeeklySpendLimit(currencies, "RUB"), 300_000_000);
  assert.equal(minWeeklySpendLimit(currencies, "EUR"), undefined);
  assert.equal(minWeeklySpendLimit(currencies, "KZT"), undefined);
  assert.equal(minWeeklySpendLimit(currencies, "UAH"), undefined);
  assert.equal(minWeeklySpendLimit([], "USD"), undefined);
});
