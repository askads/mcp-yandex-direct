import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FIELDS_BY_TYPE, REPORT_TYPES } from "./statistics.js";

test("every report type has a default field set", () => {
  for (const type of REPORT_TYPES) {
    assert.ok(DEFAULT_FIELDS_BY_TYPE[type]?.length, `${type} has defaults`);
  }
});

test("ACCOUNT_PERFORMANCE_REPORT defaults exclude fields the API rejects for it", () => {
  const fields = DEFAULT_FIELDS_BY_TYPE.ACCOUNT_PERFORMANCE_REPORT;
  for (const forbidden of ["CampaignName", "CampaignId", "AdGroupName", "AdId", "CriterionId"]) {
    assert.ok(!fields.includes(forbidden), `${forbidden} must not be a default`);
  }
});
