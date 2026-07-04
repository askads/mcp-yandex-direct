// Законсервированный Yandex Direct API для README-демо: патчит глобальный fetch,
// так что настоящий код сервера проходит весь свой путь (заголовки, ретраи,
// парсинг, normalizeMoney), но ни один байт не уходит в сеть. Подключается в
// процесс сервера через NODE_OPTIONS=--import из docs/demo/run.mjs; продовый
// код не меняется. Цифры согласованы со сценарием в run.mjs.

// Имена кампаний короткие сознательно: терминал vhs при наших настройках — 95
// колонок, таблица отчёта должна помещаться без переносов.
const CAMPAIGNS = {
  Campaigns: [
    {
      Id: 4482911,
      Name: "Поиск | Суши Москва",
      Type: "TEXT_CAMPAIGN",
      Status: "ACCEPTED",
      State: "ON",
      StartDate: "2026-03-14",
      Currency: "RUB",
      DailyBudget: { Amount: 3000000000, Mode: "STANDARD" },
    },
    {
      Id: 4482915,
      Name: "Поиск | Бренд",
      Type: "TEXT_CAMPAIGN",
      Status: "ACCEPTED",
      State: "ON",
      StartDate: "2026-03-14",
      Currency: "RUB",
      DailyBudget: { Amount: 800000000, Mode: "STANDARD" },
    },
    {
      Id: 4508122,
      Name: "РСЯ | Доставка еды",
      Type: "TEXT_CAMPAIGN",
      Status: "ACCEPTED",
      State: "ON",
      StartDate: "2026-04-02",
      Currency: "RUB",
      DailyBudget: { Amount: 5000000000, Mode: "DISTRIBUTED" },
    },
    {
      Id: 4519307,
      Name: "Мастер кампаний | Акции",
      Type: "UNIFIED_CAMPAIGN",
      Status: "ACCEPTED",
      State: "ON",
      StartDate: "2026-05-19",
      Currency: "RUB",
      DailyBudget: { Amount: 1500000000, Mode: "STANDARD" },
    },
  ],
};

// Отчёт CAMPAIGN_PERFORMANCE_REPORT за LAST_7_DAYS: сервер шлёт
// skipReportHeader/skipReportSummary, поэтому тело = строка колонок + данные.
const REPORT_TSV = [
  "CampaignName\tImpressions\tClicks\tCost\tCtr\tAvgCpc\tConversions",
  "Поиск | Суши Москва\t48210\t1730\t38420.50\t3.59\t22.21\t179",
  "Поиск | Бренд\t9840\t1120\t8660.00\t11.38\t7.73\t96",
  "РСЯ | Доставка еды\t512480\t1490\t31240.80\t0.29\t20.97\t3",
  "Мастер кампаний | Акции\t96320\t1210\t18158.70\t1.26\t15.01\t41",
  "",
].join("\n");

const CLIENTS = {
  Clients: [
    {
      Login: "sushi-master-msk",
      ClientId: 188712,
      ClientInfo: "Суши Мастер",
      Currency: "RUB",
      Type: "CLIENT",
      CountryId: 225,
      AccountQuality: 4.6,
    },
  ],
};

// Live v4 AccountManagement: деньги уже в валюте (строками), не в микроединицах.
const BALANCE = {
  data: {
    Accounts: [
      {
        Login: "sushi-master-msk",
        AccountID: 188712,
        Amount: "58620.00",
        AmountAvailableForTransfer: "58620.00",
        Currency: "RUB",
        Discount: 0,
      },
    ],
  },
};

const UNITS_HEADER = "12/20816/64000";

function json(body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function apiError(detail) {
  // Формат ошибки API v5 — сервер покажет её как обычный tool-error: если сценарий
  // demo уехал от фикстур, это видно сразу, а в реальную сеть запрос не уходит.
  return json({
    error: { request_id: "demo", error_code: 8800, error_string: "Not mocked in demo", error_detail: detail },
  });
}

const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));

  // JSON API v5
  if (url.host === "api.direct.yandex.com") {
    const service = url.pathname.replace(/^\/json\/v5\//, "");
    if (service === "reports") {
      return new Response(REPORT_TSV, {
        status: 200,
        headers: { "Content-Type": "text/tab-separated-values; charset=utf-8", Units: UNITS_HEADER },
      });
    }
    const { method } = JSON.parse(init?.body ?? "{}");
    if (service === "campaigns" && method === "get") return json({ result: CAMPAIGNS }, { Units: UNITS_HEADER });
    if (service === "clients" && method === "get") return json({ result: CLIENTS }, { Units: UNITS_HEADER });
    return apiError(`${service}.${method}`);
  }

  // Live v4 (единственный API с балансом)
  if (url.host === "api.direct.yandex.ru") {
    const { method } = JSON.parse(init?.body ?? "{}");
    if (method === "AccountManagement") return json(BALANCE);
    return json({ error_code: 8800, error_str: "Not mocked in demo", error_detail: method });
  }

  return realFetch(input, init);
};
