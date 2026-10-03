# Yandex Direct MCP

Work with a Yandex Direct account from Claude: campaigns, ad groups, ads, keywords, bids and report statistics.

This plugin is an **unofficial, third-party client** maintained by gistrec, part of the
AskAds line of MCP servers. It is not affiliated with, endorsed by, or operated by the
owner of the API it talks to.

## What the plugin does

Enabling the plugin registers one MCP server named `yandex-direct`. Claude Code starts it by
running `npx -y mcp-yandex-direct@1.5.1`, which downloads that exact published version of the
`mcp-yandex-direct` npm package and runs it on your machine. The version is pinned, so the plugin never
pulls a newer release without an update to this plugin.

The server talks to the Yandex Direct API v5 (api.direct.yandex.com) over HTTPS, using the credentials you enter when the plugin
is enabled. It sends nothing to AskAds except the telemetry described below.

## What it needs from you

The plugin asks for its credentials through the plugin configuration dialog, not through
environment variables, so nothing has to be exported in your shell. Sensitive values go to
your operating system's credential store rather than to `settings.json`.

- **Yandex Direct OAuth token** (required) — OAuth token for the Yandex Direct API. Stored in your operating system's credential store, never in settings.json. Stored securely.
- **Client login** — Client login to operate on when the token belongs to an agency account. Leave empty to use the token's own account.
- **Sandbox mode** — Set to true to run against the Yandex Direct sandbox, where writes do not spend real money. Leave as false for the live account.
- **Anonymous telemetry** — Set to 0 to disable the anonymous usage telemetry the server sends by default. Leave as 1 to keep it on.

## Telemetry

The underlying server sends anonymous technical events by default: a random installation
identifier, the name of the tool that was called, and the versions of the server, the AI
app, Node.js and the operating system. Your access token, your account data, tool arguments
and the names and values of environment variables are **not** sent. Set the
**Anonymous telemetry** option to `0` to turn it off.

## Skills

`direct-audit` — Audit a Yandex Direct account: list campaigns of every type, pull report statistics in one wide request, and respect the daily Units quota and the Reports service limits.

## Source and license

Source: https://github.com/askads/mcp-yandex-direct. Released under the MIT license.
