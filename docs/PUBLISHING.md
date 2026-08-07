# Публикация и листинг сервера

Как попасть в каталоги MCP, чтобы сервер находили из Claude, Cursor, LobeHub и др.

Канонический источник — **официальный реестр MCP** (`registry.modelcontextprotocol.io`).
Большинство агрегаторов (включая LobeHub) подтягивают данные из него или прямо из
GitHub-репозитория, поэтому начинаем с реестра, а затем точечно сабмитим в LobeHub.

## 1. Официальный реестр MCP

Манифест уже лежит в корне репозитория — [`server.json`](../server.json)
(схема `2025-12-11`, имя namespace `io.github.askads/mcp-yandex-direct`).

### Что проверяет реестр

- **Namespace** — имя `io.github.askads/*` подтверждается входом под GitHub-аккаунтом с доступом к организации `askads`.
- **Владение npm-пакетом** — в `package.json` опубликованного пакета должно быть поле
  `mcpName` со значением `io.github.askads/mcp-yandex-direct` (оно уже добавлено).
  Реестр сверяет его с `name` из `server.json`.

> ⚠️ Поле `mcpName` появилось после версии, которая сейчас в npm. Перед публикацией в
> реестр нужно выпустить новую версию пакета (`npm publish`), чтобы `mcpName` оказался
> в npm. Версии в `server.json` (корень и `packages[].version`) должны совпадать с
> опубликованной версией npm.

### Шаги

```bash
# 1. Установить CLI (macOS)
brew install mcp-publisher
#    или скачать бинарь из релизов modelcontextprotocol/registry

# 2. Залогиниться под GitHub-аккаунтом-владельцем namespace
mcp-publisher logout                  # login поверх живого токена его не перевыпустит
mcp-publisher login github --token "$(gh auth token)"   # НЕ голый login — см. ниже

# 3. Из корня репозитория (где лежит server.json) опубликовать
mcp-publisher publish
```

> ⚠️ **Вход именно по токену, а не через device-flow.** `mcp-publisher login github` без
> `--token` авторизует OAuth-приложение реестра, а организация с политикой «Only approved
> applications can access data» такому приложению не видна — реестр получает пустой список
> организаций и отвечает `403 Forbidden: You have permission to publish:
> io.github.<личный-логин>/*`. Токен `gh` уже имеет scope `read:org` и организацию видит.
>
> Опознаётся по самому тексту 403: в нём перечислены доступные namespace. Если там **только
> личный** `io.github.<логин>/*` и ни одной организации — дело в способе входа. Публичность
> членства (`gh api -X PUT /orgs/<орг>/public_members/<логин>`) необходима, но её одной мало;
> проверить: `curl -s https://api.github.com/users/<логин>/orgs` должен показывать организацию.

После успеха сервер появляется по адресу
`https://registry.modelcontextprotocol.io/v0/servers?search=mcp-yandex-direct`.

### Обновление при новом релизе

1. Поднять версию в `package.json` → `npm publish`.
2. Синхронизировать `version` в `server.json` (в двух местах) с новой версией npm.
3. `mcp-publisher publish`.

## 2. LobeHub

LobeHub индексирует репозиторий как `askads-mcp-yandex-direct`.

1. Открыть [lobehub.com/mcp](https://lobehub.com/mcp).
2. Нажать **«Submit MCP»** (Community → MCP в левом меню).
3. Указать URL репозитория `https://github.com/askads/mcp-yandex-direct`.
   LobeHub сам подтянет README, список инструментов и конфиг установки (`npx -y mcp-yandex-direct`).

Для корректной карточки в README/`server.json` уже есть: описание, переменные окружения,
команда запуска и ссылки — отдельный манифест LobeHub не требуется.

## 3. Community-список modelcontextprotocol/servers (опционально)

Многие каталоги скрейпят список community-серверов в
[`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers).
Можно отправить PR, добавив строку с сервером в раздел Community Servers README.
