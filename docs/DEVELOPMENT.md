# Разработка

Требования: Node.js 20+.

```bash
npm install
npm run build      # сборка в dist/ (без тестов)
npm run dev        # запуск из исходников (tsx watch)
npm test           # юнит-тесты (без сети)
npm run typecheck  # проверка типов: исходники + тесты (без эмита)
```

## Локальный запуск из сборки

Вместо `npx` можно указать путь к собранному файлу:

```json
{
  "mcpServers": {
    "yandex-direct": {
      "command": "node",
      "args": ["/абсолютный/путь/к/mcp-yandex-direct/dist/index.js"],
      "env": { "YANDEX_DIRECT_TOKEN": "ваш_токен" }
    }
  }
}
```

## Smoke-проверка (вживую, только чтение)

`npm run smoke` делает несколько **read-only** вызовов к аккаунту из окружения
(данные аккаунта, квота, первые кампании). Запись не выполняется. Запускайте
локально со своим токеном — никогда не кладите продакшн-токен в CI:

```bash
YANDEX_DIRECT_TOKEN=ваш_токен npm run smoke
# песочница:
YANDEX_DIRECT_SANDBOX=true YANDEX_DIRECT_TOKEN=ваш_токен npm run smoke
```

## E2E-проверка на демо-кабинете (вживую, чтение и запись)

`npm run integration` ходит в **боевой** API (не в песочницу: она живёт в v5, а
`campaigns` на проде — в v501, см. `src/client.ts`) и проверяет путь, которым идут
инструменты:

- чтение — `clients.get` (логин, валюта, квота Units), `campaigns.get` через v501,
  баланс через Live v4 `AccountManagement` (как `get_balance`), справочник валют,
  отчёт `ACCOUNT_PERFORMANCE_REPORT` за вчера через Reports (пустой результат — норма);
- запись — по черновику обоих типов, чью стратегию задают инструменты, с именем
  `ci-e2e-<timestamp>` и выключенными сетями: ЕПК `UnifiedCampaign` на ручных ставках
  (`HIGHEST_POSITION`, `HighestPosition.WeeklySpendLimit`) и `TextCampaign` на
  `WB_MAXIMUM_CLICKS` (`WbMaximumClicks.WeeklySpendLimit`) — у ручных ставок текстовой
  кампании бюджета в API нет, `HighestPosition` там даёт 8000. Бюджет — минимальный
  недельный для валюты кабинета (`dictionaries.get` → `Currencies` →
  `MinimumWeeklySpendLimit`). Затем `campaigns.get` каждой кампании (сверка
  `WeeklySpendLimit`) и `campaigns.delete` — удаление идёт даже при упавшей проверке. Групп и объявлений
  нет, крутиться и тратить кампания не может.

Защита от записи в чужой кабинет — по логину: обязательная переменная
`E2E_ACCOUNT_LOGIN`, и до любой записи скрипт сверяет её с `Login` из `clients.get`
(без учёта регистра). Не совпало, пусто или задан `YANDEX_DIRECT_SANDBOX=true` —
выход с кодом 1 без единой записи. В начале прогона удаляются только кампании
`ci-e2e-<timestamp>` старше часа — остатки упавших прогонов.

```bash
E2E_ACCOUNT_LOGIN=askads-demo YANDEX_DIRECT_TOKEN=токен_askads-demo npm run integration
```

В CI (`.github/workflows/health.yml`, «Demo account e2e») логин зашит как
`askads-demo`, токен берётся из секрета репозитория `YANDEX_DIRECT_DEMO_TOKEN` —
туда кладут токен **только** кабинета askads-demo (пустой, не пополнен). Выпускать его
ссылкой `https://oauth.yandex.ru/authorize?response_type=token&client_id=c48790e11f0e48c588d2cd2d1b4bb92d&force_confirm=yes&login_hint=askads-demo`:
без `force_confirm` Яндекс молча выдаст токен аккаунта, под которым открыт браузер. Чистые
функции защиты (сверка логина, фильтр подчистки, выбор минимального бюджета) —
`src/integrationGuard.ts`, покрыты юнит-тестами.

## Демо-GIF в README

`docs/demo.gif` — запись настоящей MCP-сессии: `docs/demo/run.mjs` поднимает
собранный сервер по stdio и делает реальные tools/call через официальный SDK,
а `docs/demo/mock-api.mjs` (подключается в процесс сервера через
`NODE_OPTIONS=--import`) подменяет глобальный `fetch` и отдаёт записанные
ответы Яндекс Директа — токен и сеть не нужны. Перегенерация:

```bash
npm run build && vhs docs/demo.tape   # требуется vhs: brew install vhs
```

Важно: терминал vhs при настройках из `docs/demo.tape` — 97 колонок × 33 строки,
и капчер замирает при скролле буфера. Меняя сценарий или фикстуры, следите,
чтобы весь вывод помещался на один экран.

## CI

GitHub Actions прогоняет `typecheck` + `build` + `test` на Node 20/22/24 при push и pull request.
Отдельный workflow «Demo account e2e» гоняет `npm run integration` на кабинете askads-demo
при push в main, раз в сутки и по кнопке — не на pull request, чтобы секрет не утёк в форки;
два прогона одновременно не идут (`concurrency`).

## Телеметрия использования

Сервер отправляет анонимные события на `usage.gistrec.cloud` (`server_start`
при подключении клиента и `tool_call` с **именем** инструмента), чтобы считать
активные установки и востребованность тулов. В событии только обезличенные
технические поля: случайный идентификатор установки
(`~/.config/mcp-yandex-direct/instance-id`), версия пакета, имя и версия
AI-приложения из MCP-handshake, версия Node.js и ОС.

Токен, данные аккаунта, аргументы вызовов и тексты запросов не отправляются
и не сохраняются (реализация — `src/telemetry.ts`). Отправка идёт в фоне
с таймаутом 2 с и молча пропускается при любой ошибке. Отключение для всех
MCP-серверов Ask Ads разом: `ASKADS_TELEMETRY=0`.
