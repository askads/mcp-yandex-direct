# Changelog

Все заметные изменения проекта документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.0.0/),
проект придерживается [семантического версионирования](https://semver.org/lang/ru/).

## [Unreleased]

## [1.2.0] — 2026-07-02

### Исправлено
- `get_statistics`: «0 строк при фильтре по кампании» больше не мёртвая проверка — живой Reports
  всегда возвращает строку-заголовок, поэтому теперь считаем DATA-строки, а не пустой TSV; при 0
  строках с фильтром `campaignIds` падаем с понятной ошибкой (SEARCH_QUERY-агрегация не затронута).
- `get_statistics`: одиночная граница диапазона (`dateFrom` без `dateTo` или наоборот) — теперь
  ошибка, а не молчаливый `LAST_30_DAYS`; пара дат вместе с предустановленным `dateRangeType`
  форсирует `CUSTOM_DATE` вместо тихого игнорирования дат.
- `get_bid_modifiers`: запрашивается `VideoAdjustmentFieldNames` — корректировка для видео
  (VIDEO_ADJUSTMENT) больше не теряется молча.
- `list_campaigns`: денежные поля единого счёта (`Funds`: Sum, Balance, SumAvailableForTransfer,
  Spend) конвертируются из микроединиц в валюту аккаунта, как и обещает описание тула.
- `getAll` (autoPaginate): при обрезке на потолке страниц `LimitedBy` теперь указывает курсор
  после последней слитой страницы (а не устаревшее значение первой), чтобы ручная пагинация с
  `offset` продолжалась с правильного места.

### Безопасность / устойчивость
- Клиент: HTTP 5xx и сетевые ошибки/таймауты повторяются только для идемпотентных (read: get/has/
  check) методов — write (add/update/delete/set) больше не рискует продублироваться после ошибки
  шлюза. Rate-limit коды (429/506/52) по-прежнему повторяются для любого метода. То же для `callV4`
  (повтор только при `Action=Get`).
- Клиент: таймаут теперь покрывает и чтение тела ответа (тело читается внутри охраняемой зоны
  `fetchWithTimeout`), а не только заголовки.
- `raw_request`/клиент: defense-in-depth-валидация `service` (не должен содержать `://` или
  начинаться с `/`) — путь не может увести запрос с Authorization-заголовком на чужой хост.
- `upload_ad_image`: загрузка картинки по URL ограничена по времени (AbortController) и размеру
  (>10 MB → ошибка до кодирования, по Content-Length и по факту), не-http(s) URL отклоняются.

### Добавлено / улучшено
- `YandexDirectError`: `request_id` дописывается в текст ошибки (когда есть) — проще диагностировать.
- `get_regions`: справочник GeoRegions кэшируется на клиента (не качается заново на каждый вызов).
- `get_statistics` (SEARCH_QUERY): `zeroConversionsOnly` без `Conversions` в `fieldNames` теперь
  явная ошибка с подсказкой, а не тихо проигнорированный фильтр.
- Единый потолок `limit` (`MAX_TOOL_LIMIT`) в тулах assets/media вместо магического `10000`.

### Документация
- README/`docs/DEVELOPMENT.md`: требуемая версия Node — 20+ (было 18+); CI-матрица 20/22/24.
- `docs/TOOLS.md`: добавлена строка `get_balance`; уточнён формат вывода `get_statistics`
  (TSV для обычных типов, вычисленная JSON-сводка для SEARCH_QUERY).

## [1.1.5] — 2026-07-01

### Добавлено
- Тул `get_balance` — баланс единого счёта (`Amount`, `AmountAvailableForTransfer`, `Currency`,
  `AccountID`) через legacy Live v4 `AccountManagement`: единственный метод API, отдающий баланс
  (в v5 финансового сервиса нет). Деньги в валюте счёта, не в микроединицах; отрицательная
  сумма = задолженность. Клиент получил `callV4` — вызов Live v4 (другой base URL, токен в теле).

### Исправлено
- `list_campaigns`: в `CAMPAIGN_TYPES` добавлен `UNIFIED_CAMPAIGN` (Единая перформанс-кампания) —
  без него фильтр по типам молча пропускал перформанс-кампании.

## [1.1.1] — 2026-06-27

### Изменено
- Репозиторий переехал в организацию `askads`: обновлены ссылки (`repository`/`homepage`/
  `bugs`, README, `server.json`) и MCP-namespace (`io.github.askads/mcp-yandex-direct`).
  Код пакета не изменился.

## [1.1.0] — 2026-06-24

### Добавлено
- MCP-аннотации (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`)
  на всех тулах — клиент MCP может авто-подтверждать чтение и предупреждать перед записью.
- Тул `delete_ad_groups` — удаление групп объявлений по id (`adgroups/delete`).

### Исправлено
- Сервер сообщает MCP-клиентам реальную версию из `package.json` (была захардкожена `1.0.0`).

### Изменено
- Публикуемый пакет уменьшен: чистка `dist/` перед сборкой, без source maps и `.d.ts`,
  dev-скрипты (`smoke`/`integration`) исключены из сборки.

## [1.0.7] — 2026-06-23

### Исправлено
- `raw_request` (и любой другой тул) больше не падает с непонятной ошибкой MCP SDK,
  когда ответ Яндекс Директа не содержит ни `result`, ни `error` — например, `HTTP 404`
  на несуществующем в API v5 сервисе. Теперь `client.call` бросает читаемую ошибку с
  сырым ответом API, а `ok()`/`okOrPartial()` не отдают `text: undefined` (что и было
  причиной краша). Диагностировать ответы Яндекса стало возможно.

## [1.0.6] — 2026-06-21

### Исправлено
- `get_statistics`: срезаем строку-заголовок колонок TSV — пустой срез больше не
  читается как фантомная нулевая строка.
- `server.json`: описание и описание токена приведены к ≤100 символов (требование реестра MCP).

## [1.0.5] — 2026-06-18

### Добавлено
- Тул `upload_ad_image` — загрузка картинки объявления по URL или base64 (→ `AdImageHash`).
- `server.json` + гайд по публикации для листинга в реестре MCP.

## [1.0.4] — 2026-06-18

### Исправлено
- CI: sandbox-healthcheck отправляет `StartDate = завтра (UTC)` — проверка перестала
  зависеть от таймзоны.

## [1.0.3] — 2026-06-18

### Добавлено
- `get_statistics` (L2): серверная агрегация для `SEARCH_QUERY_PERFORMANCE_REPORT`.

## [1.0.2] — 2026-06-18

### Добавлено
- Дефолты period-aggregate, input-guards (L3) и детерминированный потолок `getAll`
  (предсказуемая ёмкость постраничной выгрузки вместо path-dependent).

## [1.0.1] — 2026-06-16

### Изменено
- Вывод тулов — компактный JSON (без pretty-print): меньше токенов для LLM-потребителя.

## [1.0.0] — 2026-06-15

### Добавлено
- Первый релиз. Тулы для кампаний/групп/объявлений/ключевых слов, управление ставками
  и bid-модификаторами, расширения (sitelinks, callouts, vCards), медиа-тулы,
  `raw_request` (escape hatch на любой сервис API v5), пагинация (offset + авто по
  `LimitedBy`), ретраи транзиентных ошибок, квота из заголовка `Units`, валидация дат и
  длин текстов.

[1.1.1]: https://github.com/askads/mcp-yandex-direct/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/askads/mcp-yandex-direct/compare/v1.0.7...v1.1.0
[1.0.7]: https://github.com/askads/mcp-yandex-direct/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/askads/mcp-yandex-direct/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/askads/mcp-yandex-direct/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/askads/mcp-yandex-direct/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/askads/mcp-yandex-direct/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/askads/mcp-yandex-direct/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/askads/mcp-yandex-direct/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/askads/mcp-yandex-direct/releases/tag/v1.0.0
