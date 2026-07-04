# Yandex Direct MCP

[![npm](https://img.shields.io/npm/v/mcp-yandex-direct)](https://www.npmjs.com/package/mcp-yandex-direct)
[![CI](https://github.com/askads/mcp-yandex-direct/actions/workflows/ci.yml/badge.svg)](https://github.com/askads/mcp-yandex-direct/actions/workflows/ci.yml)
[![Glama](https://glama.ai/mcp/servers/askads/mcp-yandex-direct/badges/score.svg)](https://glama.ai/mcp/servers/askads/mcp-yandex-direct)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

MCP-сервер для **Yandex Direct API v5**: управляйте контекстной рекламой из Claude, Cursor, Codex и других AI-клиентов на естественном языке.

Ассистент сам собирает данные из статистики, ключей, ставок и расширений, находит закономерности и вносит правки — то, что в веб-кабинете Директа приходится делать вручную и по одному экрану.

## Быстрый старт

Два способа подключиться:

**По URL, без установки** — MCP-эндпоинт `https://mcp.askads.ru/mcp`: вставляете URL в клиент и входите через Яндекс в браузере, токены не нужны. Бесплатно, только чтение — статистика и аудит. → [Подключение по URL](#подключение-по-url-без-установки)

**Локально через npx** — полный доступ, включая правки ставок и бюджетов; токен хранится только у вас:

Шаг 1 — [получите токен](#получение-токена) — одна ссылка, токен покажется на странице.

Шаг 2 — добавьте сервер — например, в Claude Code ([другие клиенты](#установка)):

```bash
claude mcp add yandex-direct -e YANDEX_DIRECT_TOKEN=ваш_токен -- npx -y mcp-yandex-direct
```

Шаг 3 — спросите ассистента: «Проанализируй мои кампании за неделю и предложи, что улучшить».

## Что умеет

- **Полное покрытие API v5** — частые объекты как удобные инструменты, всё остальное — через универсальный `raw_request`.
- **Защита от случайных записей** — универсальный `raw_request` блокирует любой не-read метод без `confirmWrite=true`; выделенные write-инструменты (ставки, бюджеты, минус-слова, статусы) проходят штатное подтверждение MCP-клиента перед вызовом.
- **Деньги в валюте аккаунта** — бюджеты и ставки на вход и на выход в той же валюте, что и кабинет (например, в рублях), без ручного пересчёта микроединиц.
- **`autoPaginate`** — проход всех страниц по курсору `LimitedBy`, без молчаливой обрезки на больших аккаунтах.
- **`get_quota`** — остаток дневной квоты API в Units (потрачено / осталось / лимит).
- **`get_balance`** — баланс единого счёта (сумма, доступно к переводу, валюта) через Live v4 `AccountManagement` — единственный метод API, отдающий баланс (в v5 его нет). Отрицательная сумма = задолженность.
- **Устойчивость** — ретраи на лимитах и 5xx с бэкоффом плюс режим песочницы (`YANDEX_DIRECT_SANDBOX`) для безопасных тестов.

## Примеры запросов

Попросите ассистента на русском — например:

- «Какие ключевые фразы тратят бюджет, но не приносят кликов?»
- «Подними ставки до 3 ₽ на фразы с CTR выше 15%»
- «Найди id региона Москва и создай группу с таргетингом на Москву»
- «Поставь корректировку −20% на мобильные в кампании 708589088»

## Пример: аудит кампании

> **Вы:** Проанализируй кампанию ClearTranscriptBot за последнюю неделю и предложи, что улучшить.

> **Claude** *(вызывает `get_statistics`, `list_keywords`, `get_callouts`, `get_sitelinks`)*:
>
> Кампания «EPK/Поиск — бот в Max и Telegram» за 7 дней:
>
> | Дата | Показы | Клики | CTR | Расход, ₽ | Ср. клик, ₽ |
> |------|-------:|------:|----:|----------:|------------:|
> | 08.06 | 544 | 90 | 16.5% | 782.50 | 8.69 |
> | 09.06 | 456 | 70 | 15.4% | 528.93 | 7.56 |
> | 10.06 | 206 | 39 | 18.9% | 254.48 | 6.53 |
> | 11.06 | 198 | 36 | 18.2% | 205.87 | 5.72 |
> | 12.06 | 275 | 37 | 13.5% | 178.95 | 4.84 |
> | 13.06 | 332 | 45 | 13.6% | 214.62 | 4.77 |
> | 14.06 | 419 | 82 | 19.6% | 481.55 | 5.87 |
> | **Итого** | **2 430** | **399** | **16.4%** | **2 646.90** | **6.63** |
>
> **Что улучшить:**
> 1. **Автотаргетинг забирает почти весь трафик.** Условие `---autotargeting` собирает основную долю показов и кликов, а ключи («расшифровка интервью», «транскрибация записи» …) получают по 1–22 показа и почти 0 кликов — стоит усилить ставки на фразы или точнее настроить автотаргетинг.
> 2. **Ставки на минимуме (0.30 ₽), а CTR высокий (16–20%).** На поиске при таком CTR имеет смысл поднять ставки на топ-фразы — заберёте больше недорогих показов.
> 3. **Объявление 17674525479 отстаёт** (CTR 2–10% против 17–20% у основного) — кандидат на переработку заголовка/текста или отключение.
> 4. **Расширения в порядке** — 9 уточнений и 3 быстрые ссылки; можно добавить ещё пару быстрых ссылок (лимит — 8).

## Подключение по URL (без установки)

`https://mcp.askads.ru/mcp` — удалённый сервер Яндекс Директа (зеркало — `https://mcp.askads.cloud/mcp`). Не нужны ни Node.js, ни токен в конфиге: клиент откроет браузер, вы войдёте через Яндекс и подтвердите доступ — как обычное «Войти с Яндексом». Сервер **только читает** (статистика, кампании, аудит) и бесплатен — правки доступны в локальной установке. Подробнее — на [mcp.askads.ru](https://mcp.askads.ru).

<details>
<summary><b>Claude Desktop / claude.ai</b></summary>

Настройки → **Connectors** → **Add custom connector** → вставьте `https://mcp.askads.ru/mcp` → войдите через Яндекс.

</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add --transport http yandex-direct https://mcp.askads.ru/mcp
```

Затем в сессии `/mcp` → **Authenticate**. Либо через маркетплейс плагинов:

```
/plugin marketplace add askads/claude-plugins
/plugin install yandex-direct@askads
```

</details>

<details>
<summary><b>ChatGPT</b></summary>

Settings → **Apps & Connectors** → **Advanced settings** → включите **Developer mode** → **Create** → вставьте `https://mcp.askads.cloud/mcp` (для ChatGPT используйте зеркало `.cloud`). Требуется план с поддержкой коннекторов.

</details>

<details>
<summary><b>Cursor</b></summary>

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "yandex-direct": { "url": "https://mcp.askads.ru/mcp" }
  }
}
```

</details>

## Установка

Локальный сервер через npx — полный доступ, включая write-инструменты. Разверните своего клиента:

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add yandex-direct -e YANDEX_DIRECT_TOKEN=ваш_токен -- npx -y mcp-yandex-direct
```

</details>

<details>
<summary><b>Claude Desktop</b></summary>

`claude_desktop_config.json` — macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`

```json
{
  "mcpServers": {
    "yandex-direct": {
      "command": "npx",
      "args": ["-y", "mcp-yandex-direct"],
      "env": { "YANDEX_DIRECT_TOKEN": "ваш_токен" }
    }
  }
}
```

</details>

<details>
<summary><b>Cursor</b></summary>

`~/.cursor/mcp.json` (или `.cursor/mcp.json` в проекте)

```json
{
  "mcpServers": {
    "yandex-direct": {
      "command": "npx",
      "args": ["-y", "mcp-yandex-direct"],
      "env": { "YANDEX_DIRECT_TOKEN": "ваш_токен" }
    }
  }
}
```

</details>

<details>
<summary><b>OpenAI Codex</b></summary>

Командой: `codex mcp add yandex-direct --env YANDEX_DIRECT_TOKEN=ваш_токен -- npx -y mcp-yandex-direct`

Или в `~/.codex/config.toml`:

```toml
[mcp_servers.yandex-direct]
command = "npx"
args = ["-y", "mcp-yandex-direct"]

[mcp_servers.yandex-direct.env]
YANDEX_DIRECT_TOKEN = "ваш_токен"
```

</details>

<details>
<summary><b>VS Code</b></summary>

`.vscode/mcp.json` — ключ `servers` (не `mcpServers`)

```json
{
  "servers": {
    "yandex-direct": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-yandex-direct"],
      "env": { "YANDEX_DIRECT_TOKEN": "ваш_токен" }
    }
  }
}
```

</details>

## Получение токена

Откройте ссылку, **залогинившись под аккаунтом с доступом к нужному кабинету Яндекс Директа**, и подтвердите доступ:

[**→ Получить токен**](https://oauth.yandex.ru/authorize?response_type=token&client_id=c48790e11f0e48c588d2cd2d1b4bb92d)

Браузер вернёт вас на сайт Ask Ads — токен покажется **во всплывающем окне**, скопируйте его в `YANDEX_DIRECT_TOKEN`. Токен персональный (привязан к вашему кабинету) и действует около года; при утере его можно получить заново по той же ссылке.

⚠️ Токен даёт **полный доступ** к рекламному кабинету (включая трату бюджета) и хранится **открытым текстом** в конфиге — относитесь к нему как к паролю.

## Настройка

| Переменная | Обяз. | Описание |
|---|---|---|
| `YANDEX_DIRECT_TOKEN` | да | OAuth-токен Яндекс Директа. |
| `YANDEX_DIRECT_LOGIN` | нет | Логин клиента (для агентских аккаунтов). |
| `YANDEX_DIRECT_SANDBOX` | нет | `true` — работать в песочнице API. |

Полный список переменных (язык ответов, таймауты, повторы) и инструментов — в [docs/TOOLS.md](https://github.com/askads/mcp-yandex-direct/blob/main/docs/TOOLS.md).

## Требования

- Для подключения по URL — ничего: только аккаунт Яндекса с доступом к кабинету.
- Для локальной установки: Node.js 20+ (запускается через `npx`, отдельная установка не нужна) и OAuth-токен — см. [Получение токена](#получение-токена).

## Ограничения

- `get_statistics` использует асинхронный сервис Reports: отчёт генерируется на стороне Яндекса (сервер опрашивает готовность) и имеет собственные лимиты на объём и число отчётов в сутки.
- Токен живёт около года — потом нужно получить заново.
- Для агентских аккаунтов укажите клиента через `YANDEX_DIRECT_LOGIN`.

## Документация

- [Все инструменты](https://github.com/askads/mcp-yandex-direct/blob/main/docs/TOOLS.md) — полный список с описанием.
- [Разработка](https://github.com/askads/mcp-yandex-direct/blob/main/docs/DEVELOPMENT.md) — сборка, тесты, smoke-проверка.

## Смотрите также

- **[Ask Ads](https://askads.ru)** — чат-аналитик и «Сторож» рекламных кабинетов от авторов этого сервера: алерты о сливах бюджета и поломках трекинга — в Telegram.
- **[askads/claude-plugins](https://github.com/askads/claude-plugins)** — маркетплейс плагинов Claude: серверы Ask Ads ставятся одной командой, токены спрашиваются при включении.

## Поддержка

Вопросы, идеи и доработки — пишите в Telegram: [@gistrec](http://t.me/gistrec).

## Лицензия

MIT — см. [LICENSE](./LICENSE).
