import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, fail, MAX_TOOL_LIMIT, ok, okOrPartial, READ_ONLY, WRITE_CREATE } from "./util.js";

/** Yandex accepts ad images up to 10 MB — reject anything larger before encoding. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Hard cap on how long we wait for a remote image before giving up. */
const IMAGE_FETCH_TIMEOUT_MS = 30_000;
/** Redirect hops are followed manually (each one re-validated); more than this is abuse. */
const MAX_REDIRECTS = 5;

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

/** RFC1918/loopback/link-local/CGNAT/"this network" IPv4 — never fetchable via a model-supplied URL. */
function isBlockedV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || // "this network"
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) // RFC1918
  );
}

/**
 * True for addresses a model-supplied image URL must never reach: private, loopback,
 * link-local and their IPv6 forms (::1, ULA fc00::/7, link-local fe80::/10, IPv4-mapped).
 * Anything that is not a parseable IP is blocked too — better a false positive than a
 * blind SSRF probe of the internal network.
 */
export function isBlockedAddress(ip: string): boolean {
  const zoneless = ip.split("%")[0]; // fe80::1%en0 → fe80::1
  if (isIP(zoneless) === 4) return isBlockedV4(zoneless);
  if (isIP(zoneless) !== 6) return true;
  const lower = zoneless.toLowerCase();
  if (lower === "::" || lower === "::1") return true; // unspecified / loopback
  const mapped = lower.match(/^::ffff:(.+)$/); // IPv4-mapped: dotted or two hex groups
  if (mapped) {
    const rest = mapped[1];
    if (rest.includes(".")) return isBlockedV4(rest);
    const groups = rest.split(":");
    if (groups.length === 2) {
      const hi = parseInt(groups[0], 16);
      const lo = parseInt(groups[1], 16);
      return isBlockedV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    return true;
  }
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  return false;
}

/**
 * Rejects a URL whose scheme is not http(s) or whose host resolves to a blocked
 * address. Hostnames are resolved via DNS and EVERY returned address must be public
 * (one private A-record is enough to refuse). The fetch afterwards re-resolves on its
 * own — a DNS-rebinding TOCTOU window remains, which is accepted for this tool.
 */
async function assertPublicImageUrl(u: URL): Promise<void> {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`URL изображения должен быть http(s), получен "${u.protocol}"`);
  }
  const host = u.hostname; // for IPv6 literals the brackets are already stripped
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new Error("Не удалось разрешить хост из url изображения — нужен публичный http(s)-адрес.");
    }
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new Error(
      "url изображения указывает на приватный или служебный адрес — допускаются только публичные http(s)-хосты.",
    );
  }
}

/**
 * Fetches an image URL and returns its bytes as base64 for adimages/add. Guards a
 * user-supplied URL against SSRF and abuse: only http(s), only public addresses
 * (checked on EVERY redirect hop — redirects are followed manually), the response
 * must look like an image, a timeout bounds a hung/drip-feed download, and the size
 * is checked against Yandex's 10 MB limit — first against Content-Length (fail fast)
 * and again against the actual bytes (a lying/absent header can't slip through).
 */
async function fetchImageBase64(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    let target = new URL(url);
    let res: Response;
    for (let hop = 0; ; hop++) {
      await assertPublicImageUrl(target);
      res = await fetch(target, { signal: controller.signal, redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("Location");
        if (!location || hop >= MAX_REDIRECTS) {
          throw new Error("Не удалось скачать изображение: слишком длинная или некорректная цепочка перенаправлений.");
        }
        void res.body?.cancel().catch(() => {});
        target = new URL(location, target);
        continue;
      }
      break;
    }
    if (!res.ok) {
      throw new Error(`Не удалось скачать изображение: HTTP ${res.status}.`);
    }
    // Junk guard, not a security boundary (Yandex validates the actual bytes): an
    // explicit non-image Content-Type is rejected; a missing header or octet-stream
    // (common for object storages) is allowed through.
    const contentType = (res.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith("image/") && contentType !== "application/octet-stream") {
      throw new Error(`url отдал не изображение (Content-Type ${contentType}) — нужен image/*.`);
    }
    const declared = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new Error(
        `Изображение весит ${declared} байт — больше лимита ${MAX_IMAGE_BYTES} байт (10 МБ).`,
      );
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `Изображение весит ${bytes.length} байт — больше лимита ${MAX_IMAGE_BYTES} байт (10 МБ).`,
      );
    }
    return bytes.toString("base64");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Скачивание изображения превысило таймаут ${IMAGE_FETCH_TIMEOUT_MS} мс`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
