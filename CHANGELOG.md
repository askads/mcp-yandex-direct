# Changelog

Все заметные изменения проекта документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.0.0/),
проект придерживается [семантического версионирования](https://semver.org/lang/ru/).

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

[1.1.0]: https://github.com/gistrec/mcp-yandex-direct/compare/v1.0.7...v1.1.0
[1.0.7]: https://github.com/gistrec/mcp-yandex-direct/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/gistrec/mcp-yandex-direct/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/gistrec/mcp-yandex-direct/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/gistrec/mcp-yandex-direct/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/gistrec/mcp-yandex-direct/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/gistrec/mcp-yandex-direct/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/gistrec/mcp-yandex-direct/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/gistrec/mcp-yandex-direct/releases/tag/v1.0.0
