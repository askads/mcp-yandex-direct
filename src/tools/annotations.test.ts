import { test } from "node:test";
import assert from "node:assert/strict";
import { registerAccountTools } from "./account.js";
import { registerCampaignTools } from "./campaigns.js";
import { registerAdGroupTools } from "./adGroups.js";
import { registerAdTools } from "./ads.js";
import { registerKeywordTools } from "./keywords.js";
import { registerStatisticsTools } from "./statistics.js";
import { registerDictionaryTools } from "./dictionaries.js";
import { registerRawTool } from "./raw.js";
import { registerBidModifierTools } from "./bidModifiers.js";
import { registerAssetTools } from "./assets.js";
import { registerMediaTools } from "./media.js";

interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Registers every tool against a fake server, capturing each tool's annotations. */
function collectAnnotations(): Record<string, Annotations | undefined> {
  const annotations: Record<string, Annotations | undefined> = {};
  const server = {
    registerTool: (name: string, cfg: { annotations?: Annotations }) => {
      annotations[name] = cfg.annotations;
    },
  };
  const registrars = [
    registerAccountTools,
    registerCampaignTools,
    registerAdGroupTools,
    registerAdTools,
    registerKeywordTools,
    registerStatisticsTools,
    registerDictionaryTools,
    registerRawTool,
    registerBidModifierTools,
    registerAssetTools,
    registerMediaTools,
  ];
  for (const register of registrars) register(server as any, {} as any);
  return annotations;
}

const ANN = collectAnnotations();

test("every tool declares annotations", () => {
  const names = Object.keys(ANN);
  assert.ok(names.length >= 30, `expected many tools, got ${names.length}`);
  for (const [name, a] of Object.entries(ANN)) {
    assert.ok(a, `${name} is missing annotations`);
    // Every tool hits the remote API.
    assert.equal(a?.openWorldHint, true, `${name} should set openWorldHint`);
  }
});

test("read tools are read-only", () => {
  const readTools = [
    "get_account_info", "get_balance", "get_quota", "list_campaigns", "list_ad_groups", "list_ads",
    "list_keywords", "get_statistics", "get_regions", "get_dictionaries",
    "get_bid_modifiers", "get_sitelinks", "get_callouts", "get_vcards",
    "get_ad_images", "get_ad_videos", "get_creatives",
  ];
  for (const name of readTools) {
    assert.equal(ANN[name]?.readOnlyHint, true, `${name} should be readOnly`);
    // A read-only tool never mutates, so it is non-destructive and idempotent. Some clients
    // (OpenAI Apps review) require destructiveHint on every tool, so assert all four hints.
    assert.equal(ANN[name]?.destructiveHint, false, `${name} should not be destructive`);
    assert.equal(ANN[name]?.idempotentHint, true, `${name} should be idempotent`);
    assert.equal(ANN[name]?.openWorldHint, true, `${name} should set openWorldHint`);
  }
});

test("delete, *_action and raw_request are flagged destructive", () => {
  const destructive = [
    "campaign_action", "ad_action", "keyword_action", "delete_ad_groups",
    "delete_bid_modifiers", "delete_sitelinks", "delete_callouts", "delete_vcards",
    "raw_request",
  ];
  for (const name of destructive) {
    assert.equal(ANN[name]?.readOnlyHint, false, `${name} should not be readOnly`);
    assert.equal(ANN[name]?.destructiveHint, true, `${name} should be destructive`);
  }
});

test("update/set tools are idempotent, non-destructive writes", () => {
  const updates = [
    "update_campaign", "update_ad_group", "update_text_ad",
    "set_keyword_bids", "set_bid_modifiers",
  ];
  for (const name of updates) {
    assert.equal(ANN[name]?.readOnlyHint, false, `${name} should not be readOnly`);
    assert.equal(ANN[name]?.destructiveHint, false, `${name} should not be destructive`);
    assert.equal(ANN[name]?.idempotentHint, true, `${name} should be idempotent`);
  }
});

test("create/add/upload tools are non-destructive, non-idempotent writes", () => {
  const creates = [
    "create_text_campaign", "create_ad_group", "create_text_ad", "add_keywords",
    "add_bid_modifier", "create_sitelinks_set", "add_callouts", "create_vcard",
    "upload_ad_image",
  ];
  for (const name of creates) {
    assert.equal(ANN[name]?.readOnlyHint, false, `${name} should not be readOnly`);
    assert.equal(ANN[name]?.destructiveHint, false, `${name} should not be destructive`);
    assert.equal(ANN[name]?.idempotentHint, false, `${name} should not be idempotent`);
  }
});
