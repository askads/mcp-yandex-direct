import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, fail, ok } from "./util.js";

export function registerMediaTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "get_ad_images",
    {
      title: "Get ad images",
      description: "Lists images in the ad image library, keyed by image hash. Uploads go via raw_request (adimages/add).",
      inputSchema: {
        hashes: z.array(z.string()).optional().describe("Filter by image hashes."),
        limit: z.number().int().min(1).max(10000).optional().describe("Max objects per page."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
      },
    },
    async ({ hashes, limit, offset }) => {
      try {
        const params: Record<string, unknown> = {
          SelectionCriteria: hashes?.length ? { AdImageHashes: hashes } : {},
          FieldNames: ["AdImageHash", "Name", "Type", "Subtype", "Associated"],
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = await client.call("adimages", "get", params);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_ad_videos",
    {
      title: "Get ad videos",
      description:
        "Reads videos from the ad video library by id (the API requires ids). Uploads go via raw_request (advideos/add).",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Video ids (required by the API)."),
        limit: z.number().int().min(1).max(10000).optional().describe("Max objects per page."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
      },
    },
    async ({ ids, limit, offset }) => {
      try {
        const params: Record<string, unknown> = {
          SelectionCriteria: { Ids: ids },
          FieldNames: ["Id", "Name", "Status"],
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = await client.call("advideos", "get", params);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_creatives",
    {
      title: "Get creatives",
      description: "Lists creatives (smart banners, HTML5) from the creative library.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Filter by creative ids."),
        limit: z.number().int().min(1).max(10000).optional().describe("Max objects per page."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
      },
    },
    async ({ ids, limit, offset }) => {
      try {
        const params: Record<string, unknown> = {
          SelectionCriteria: ids?.length ? { Ids: ids } : {},
          FieldNames: ["Id", "Type", "Name"],
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = await client.call("creatives", "get", params);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
