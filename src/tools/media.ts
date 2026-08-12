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
      title: "Изображения объявлений",
      annotations: READ_ONLY,
      description: "Возвращает список изображений из библиотеки изображений, ключ — хеш изображения. Новые изображения загружает upload_ad_image.",
      inputSchema: {
        hashes: z.array(z.string()).optional().describe("Фильтр по хешам изображений."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Максимум объектов на страницу."),
        offset: z.number().int().min(0).optional().describe("Смещение постраничной выдачи."),
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
      title: "Видео объявлений",
      annotations: READ_ONLY,
      description:
        "Читает видео из библиотеки видео по id (API требует id). Загрузка идёт через raw_request (advideos/add).",
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe("Id видео (обязательны по требованию API)."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Максимум объектов на страницу."),
        offset: z.number().int().min(0).optional().describe("Смещение постраничной выдачи."),
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
      title: "Креативы",
      annotations: READ_ONLY,
      description: "Возвращает список креативов (смарт-баннеры, HTML5) из библиотеки креативов.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Фильтр по id креативов."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Максимум объектов на страницу."),
        offset: z.number().int().min(0).optional().describe("Смещение постраничной выдачи."),
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
      title: "Загрузить изображение",
      annotations: WRITE_CREATE,
      description:
        "Загружает изображение в библиотеку изображений (adimages/add) и возвращает его AdImageHash — этот хеш подставляется в поле AdImageHash текстово-графического объявления. Изображение передаётся публичным URL (сервер сам скачает и закодирует) или в base64 через imageData. Яндекс принимает JPG/PNG/GIF до 10 МБ; текстово-графическому объявлению нужна горизонтальная картинка (минимум 1080×607).",
      inputSchema: {
        name: z.string().min(1).max(255).describe("Название изображения в библиотеке."),
        url: z
          .string()
          .url()
          .optional()
          .describe("Публичный URL изображения; сервер скачает его и закодирует в base64. Нужно передать это поле или imageData."),
        imageData: z
          .string()
          .min(1)
          .optional()
          .describe("Байты изображения в base64 (префикс data:-URL отбрасывается). Нужно передать это поле или url."),
      },
    },
    async ({ name, url, imageData }) => {
      try {
        if (!url && !imageData) {
          return fail(new Error("Нужно передать url или imageData."));
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
    throw new Error(`URL изображения должен быть http(s), получен "${parsed.protocol}"`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Не удалось скачать изображение по "${url}": HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new Error(
        `Изображение по "${url}" весит ${declared} байт — больше лимита ${MAX_IMAGE_BYTES} байт (10 МБ).`,
      );
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `Изображение по "${url}" весит ${bytes.length} байт — больше лимита ${MAX_IMAGE_BYTES} байт (10 МБ).`,
      );
    }
    return bytes.toString("base64");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Скачивание изображения по "${url}" превысило таймаут ${IMAGE_FETCH_TIMEOUT_MS} мс`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
