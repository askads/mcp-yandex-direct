import { test } from "node:test";
import assert from "node:assert/strict";
import { reportName } from "./util.js";
import { withClientLogin } from "../clientLogin.js";

const AT = new Date("2026-11-04T22:15:00Z");
const PARAMS = { ReportType: "CAMPAIGN_PERFORMANCE_REPORT", DateRangeType: "LAST_7_DAYS", FieldNames: ["Clicks"] };

test("reportName: the same request within an hour gets the same name, so a retry reuses the queued report", () => {
  const a = reportName("mcp-x", PARAMS, AT);
  const b = reportName("mcp-x", { ...PARAMS }, new Date("2026-11-04T22:59:59Z"));
  assert.equal(a, b);
  assert.match(a, /^mcp-x-2026110422-[0-9a-f]{12}$/);
});

test("reportName: other params, another hour or another prefix give another name", () => {
  const a = reportName("mcp-x", PARAMS, AT);
  assert.notEqual(reportName("mcp-x", { ...PARAMS, FieldNames: ["Cost"] }, AT), a);
  assert.notEqual(reportName("mcp-x", PARAMS, new Date("2026-11-04T23:00:00Z")), a);
  assert.notEqual(reportName("mcp-x-compare", PARAMS, AT), a);
});

test("reportName: two advertisers never share a name", () => {
  const a = withClientLogin("client-a", () => reportName("mcp-x", PARAMS, AT));
  const b = withClientLogin("client-b", () => reportName("mcp-x", PARAMS, AT));
  assert.notEqual(a, b);
  assert.notEqual(a, reportName("mcp-x", PARAMS, AT));
});
