import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, compact, fail, ok, okOrPartial } from "./util.js";

export function registerAssetTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "get_sitelinks",
    {
      title: "Get sitelink sets",
      description:
        "Lists sitelink sets (быстрые ссылки) from the library. Attach a set to an ad via the ad's SitelinkSetId.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Filter by sitelink set ids."),
        limit: z.number().int().min(1).max(10000).optional().describe("Max objects per page."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
      },
    },
    async ({ ids, limit, offset }) => {
      try {
        const params: Record<string, unknown> = {
          SelectionCriteria: ids?.length ? { Ids: ids } : {},
          FieldNames: ["Id"],
          SitelinkFieldNames: ["Title", "Href", "Description", "TurboPageId"],
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        const result = await client.call("sitelinks", "get", params);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_sitelinks_set",
    {
      title: "Create sitelink set",
      description:
        "Creates a sitelink set (1–8 links). Sets are immutable — to change links, create a new set and reassign it to the ad.",
      inputSchema: {
        sitelinks: z
          .array(
            z.object({
              title: z.string().min(1).describe("Sitelink title."),
              href: z.string().optional().describe("Sitelink URL."),
              description: z.string().optional().describe("Sitelink description (for some ad types)."),
            }),
          )
          .min(1)
          .max(8)
          .describe("1–8 sitelinks."),
      },
    },
    async ({ sitelinks }) => {
      try {
        const set = {
          Sitelinks: sitelinks.map((s) =>
            compact({ Title: s.title, Href: s.href, Description: s.description }),
          ),
        };
        const result = await client.call("sitelinks", "add", { SitelinksSets: [set] });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_sitelinks",
    {
      title: "Delete sitelink sets",
      description: "Deletes sitelink sets by id (only sets not assigned to any ad can be deleted).",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Sitelink set ids to delete."),
      },
    },
    async ({ ids }) => {
      try {
        const result = await client.call("sitelinks", "delete", { SelectionCriteria: { Ids: ids } });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
