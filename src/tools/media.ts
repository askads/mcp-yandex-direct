import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, fail, MAX_TOOL_LIMIT, ok, okOrPartial, READ_ONLY, WRITE_CREATE } from "./util.js";

/** Yandex accepts ad images up to 10 MB — reject anything larger before encoding. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Hard cap on how long we wait for a remote image before giving up. */
const IMAGE_FETCH_TIMEOUT_MS = 30_000;

export function registerMediaTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "get_ad_images",
    {
      title: "Get ad images",
      annotations: READ_ONLY,
      description: "Lists images in the ad image library, keyed by image hash. Upload new images with upload_ad_image.",
      inputSchema: {
        hashes: z.array(z.string()).optional().describe("Filter by image hashes."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Max objects per page."),
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
      annotations: READ_ONLY,
      description:
        "Reads videos from the ad video library by id (the API requires ids). Uploads go via raw_request (advideos/add).",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Video ids (required by the API)."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Max objects per page."),
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
      annotations: READ_ONLY,
      description: "Lists creatives (smart banners, HTML5) from the creative library.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Filter by creative ids."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Max objects per page."),
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

  server.registerTool(
    "upload_ad_image",
    {
      title: "Upload ad image",
      annotations: WRITE_CREATE,
      description:
        "Uploads an image to the ad image library (adimages/add) and returns its AdImageHash — use that hash as AdImageHash on a text & image ad. Provide the image as a public URL (fetched and encoded server-side) or as base64 in imageData. Yandex accepts JPG/PNG/GIF up to 10 MB; a text & image ad needs a landscape image (min 1080×607).",
      inputSchema: {
        name: z.string().min(1).max(255).describe("Image name shown in the library."),
        url: z
          .string()
          .url()
          .optional()
          .describe("Public image URL; fetched and base64-encoded server-side. Provide this or imageData."),
        imageData: z
          .string()
          .min(1)
          .optional()
          .describe("Base64-encoded image bytes (a data: URL prefix is stripped). Provide this or url."),
      },
    },
    async ({ name, url, imageData }) => {
      try {
        if (!url && !imageData) {
          return fail(new Error("Provide either url or imageData."));
        }
        const data = imageData ? stripDataUrlPrefix(imageData) : await fetchImageBase64(url as string);
        const result = await client.call("adimages", "add", {
          AdImages: [{ Name: name, ImageData: data }],
        });
        return okOrPartial(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}

/** Drops a `data:<mime>;base64,` prefix so callers can paste a data URL verbatim. */
function stripDataUrlPrefix(data: string): string {
  return data.replace(/^data:[^;,]*;base64,/, "");
}

/**
 * Fetches an image URL and returns its bytes as base64 for adimages/add. Guards a
 * user-supplied URL: only http(s) is allowed (no file:/data:/ftp:), a timeout bounds a
 * hung/drip-feed download, and the size is checked against Yandex's 10 MB limit — first
 * against Content-Length (fail fast, before downloading) and again against the actual
 * bytes (a lying/absent header can't slip an oversized image through).
 */
async function fetchImageBase64(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Image URL must be http(s), got "${parsed.protocol}"`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Failed to fetch image from "${url}": HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image at "${url}" is ${declared} bytes, over the ${MAX_IMAGE_BYTES}-byte (10 MB) limit.`,
      );
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image at "${url}" is ${bytes.length} bytes, over the ${MAX_IMAGE_BYTES}-byte (10 MB) limit.`,
      );
    }
    return bytes.toString("base64");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Fetching image from "${url}" timed out after ${IMAGE_FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
