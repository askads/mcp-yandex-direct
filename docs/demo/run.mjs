#!/usr/bin/env node
// Демо-клиент для README-GIF: поднимает НАСТОЯЩИЙ сервер (dist/index.js) по stdio,
// делает настоящий MCP-хендшейк и настоящие tools/call через официальный SDK.
// Единственная подмена — ответы Yandex Direct API законсервированы в
// docs/demo/mock-api.mjs (NODE_OPTIONS=--import), поэтому демо воспроизводится
// без токена и без сети. Запись GIF: vhs docs/demo.tape (см. docs/demo.tape).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mockPath = path.join(repoRoot, "docs", "demo", "mock-api.mjs");

// ---------- оформление ----------
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const MAUVE = "\x1b[35m";
const WIDTH = 92;

const out = process.stdout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function typeOut(text, msPerChar) {
  for (const ch of text) {
    out.write(ch);
    await sleep(msPerChar);
  }
}

async function spinner(ms, label) {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const started = Date.now();
  let i = 0;
  while (Date.now() - started < ms) {
    out.write(`\r\x1b[2K  ${DIM}${frames[i++ % frames.length]} ${label}${RESET}`);
    await sleep(80);
  }
  out.write("\r\x1b[2K");
}

/** Перенос сырого текста результата по ширине, максимум maxLines строк. */
function wrapRaw(text, maxLines) {
  const flat = text.replace(/\s+/g, " ").trim();
  const body = WIDTH - 6;
  const lines = [];
  for (let pos = 0; pos < flat.length && lines.length < maxLines; pos += body) {
    lines.push(flat.slice(pos, pos + body));
  }
  if (flat.length > maxLines * body) {
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, body - 1) + "…";
  }
  return lines;
}

async function printResultLines(lines) {
  for (let i = 0; i < lines.length; i++) {
    out.write((i === 0 ? "  ⎿ " : "    ") + lines[i] + "\n");
    await sleep(60);
  }
}

// ---------- сценарий ----------
const QUESTION = "Как отработали кампании за последние 7 дней? Где сливается бюджет?";

const REPORT_FIELDS = [
  "CampaignName",
  "Impressions",
  "Clicks",
  "Cost",
  "Ctr",
  "AvgCpc",
  "Conversions",
];

// Финальный вывод «ассистента»: строки из сегментов [стиль, текст].
const ANSWER = [
  [[BOLD, "За 7 дней кампании потратили 96 480 ₽ и принесли 319 заявок — средний CPA 302 ₽."]],
  [],
  [
    ["", "  • "],
    [GREEN + BOLD, "Лучшая"],
    ["", " — «Поиск | Суши Москва»: 179 заявок по 215 ₽. Стоит поднять дневной бюджет."],
  ],
  [
    ["", "  • "],
    [RED + BOLD, "Слив"],
    ["", " — «РСЯ | Доставка еды»: 31 241 ₽ и всего 3 заявки, CPA 10 414 ₽ — в 48 раз дороже"],
  ],
  [["", "    поиска. Приостановите кампанию и пересоберите таргетинг."]],
  [
    ["", "  • Баланса "],
    [BOLD, "58 620 ₽"],
    ["", " при текущем расходе хватит на ~4 дня — пора пополнить счёт."],
  ],
];

function renderCampaigns(text) {
  const lines = wrapRaw(text, 2);
  const total = JSON.parse(text).Campaigns.length;
  return printResultLines([...lines.map((l) => DIM + l + RESET), `${DIM}… всего ${total} кампании, все ON${RESET}`]);
}

function renderReport(text) {
  const rows = text.trim().split("\n").map((line) => line.split("\t"));
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  const numeric = (v) => /^[\d.]+$/.test(v);
  const fmt = (row) =>
    row
      .map((cell, c) => (numeric(cell) ? cell.padStart(widths[c]) : cell.padEnd(widths[c])))
      .join("  ")
      .trimEnd();
  return printResultLines([DIM + fmt(rows[0]) + RESET, ...rows.slice(1).map(fmt)]);
}

function renderBalance(text) {
  return printResultLines(wrapRaw(text, 2).map((l) => DIM + l + RESET));
}

const STEPS = [
  {
    tool: "list_campaigns",
    args: { states: ["ON"] },
    spin: 700,
    label: "campaigns.get",
    render: renderCampaigns,
  },
  {
    tool: "get_statistics",
    args: { dateRangeType: "LAST_7_DAYS", fieldNames: REPORT_FIELDS },
    spin: 1300,
    label: "Reports: строю отчёт…",
    render: renderReport,
  },
  {
    tool: "get_balance",
    args: {},
    spin: 600,
    label: "Live v4: AccountManagement",
    render: renderBalance,
  },
];

// ---------- прогон ----------
async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "index.js")],
    cwd: repoRoot,
    stderr: "ignore",
    env: {
      ...process.env,
      YANDEX_DIRECT_TOKEN: "demo",
      YANDEX_DIRECT_SANDBOX: "",
      YANDEX_DIRECT_LOGIN: "",
      NODE_OPTIONS: `--import ${mockPath}`,
    },
  });
  const client = new Client({ name: "readme-demo", version: "1.0.0" });
  await client.connect(transport);

  const info = client.getServerVersion();
  const { tools } = await client.listTools();
  out.write("\x1b[2J\x1b[H"); // чистый экран: контент обязан уместиться без скролла
  out.write(`${GREEN}●${RESET} ${BOLD}${info.name}${RESET} ${DIM}v${info.version} · stdio · ${tools.length} инструментов${RESET}\n\n`);
  await sleep(900);

  out.write(`${CYAN}${BOLD}❯${RESET} `);
  await sleep(600);
  await typeOut(QUESTION, 42);
  await sleep(700);
  out.write("\n\n");

  for (const step of STEPS) {
    // Аргументы в одну строку: длинный JSON обрезаем, чтобы строка вызова не заворачивалась.
    let argsShown = JSON.stringify(step.args);
    const argsMax = WIDTH - step.tool.length - 3;
    if (argsShown.length > argsMax) argsShown = argsShown.slice(0, argsMax - 2) + "…}";
    out.write(`${GREEN}⏺${RESET} ${BOLD}${step.tool}${RESET} ${DIM}${argsShown}${RESET}\n`);
    const [res] = await Promise.all([
      client.callTool({ name: step.tool, arguments: step.args }),
      spinner(step.spin, step.label),
    ]);
    const text = res.content?.[0]?.text ?? "";
    if (res.isError) {
      out.write(`  ${RED}${text}${RESET}\n`);
      process.exit(1);
    }
    await step.render(text);
    out.write("\n");
    await sleep(400);
  }

  await sleep(500);
  out.write(`${MAUVE}✦${RESET} `);
  for (const line of ANSWER) {
    for (const [style, seg] of line) {
      for (const word of seg.split(/(?<= )/)) {
        out.write(style + word + RESET);
        await sleep(34);
      }
    }
    out.write("\n");
    if (line.length === 0) await sleep(120);
  }

  out.write("\x1b[?25l"); // спрятать курсор — чистый финальный кадр
  await client.close();
  // Держим кадр, пока vhs не закончит запись (короткий hold — для ручного прогона).
  await sleep(Number(process.env.DEMO_HOLD_MS ?? 120_000));
}

main().catch((err) => {
  console.error(`${RED}demo failed:${RESET}`, err);
  process.exit(1);
});
