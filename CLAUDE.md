# CLAUDE.md — mcp-yandex-direct

MCP server for the Yandex Direct API v5 (TypeScript, stdio). Tools wrap the JSON
services; `raw_request` is the escape hatch for everything without a dedicated tool.

## Commands

```bash
npm run dev        # run from source (tsx watch)
npm test           # unit tests, no network
npm run typecheck  # types for src + tests
npm run build      # emit dist/
npm run smoke      # live READ-ONLY calls (needs YANDEX_DIRECT_TOKEN)
```

More detail in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Tool list: [docs/TOOLS.md](docs/TOOLS.md).

## Architecture

- `src/client.ts` — HTTP client: timeout, retry/backoff, Units quota, `getAll` cursor pagination,
  report polling. Every request path (`call`/`callV4`/`report`) first rejects a missing token
  with `CredentialsError` (before building the request, the retries and fetch — the message is
  the product: it keeps the historical startup text verbatim and names the fix).
- `src/tools/*.ts` — one file per service, each exports `register<Name>Tools(server, client)`.
- `src/tools/util.ts` — shared helpers (see conventions below).
- `src/index.ts` — wires every `register*` into the McpServer. `loadConfigOrDegraded` starts
  the server even on a config problem; without a token the initialize `instructions` open with
  the unconfigured prefix (set `YANDEX_DIRECT_TOKEN` and restart).
- `src/telemetry.ts` — anonymous usage pings (ids/names/versions only, never data or
  arguments; fire-and-forget, must never block or throw; opt-out `ASKADS_TELEMETRY=0`).
  `server_start` means "a usable install started"; an install without a token sends
  `unconfigured_start` instead. The `reason` is a closed vocabulary (`missing_token`, …) —
  never a variable's name or value. `startup_failed` remains for a config unusable at load
  time (malformed values), also fire-and-forget.
- `src/config.ts` — env → config. A missing `YANDEX_DIRECT_TOKEN` is NOT an error: the field
  stays `undefined`, the server starts degraded and the client raises `CredentialsError` at
  call time. `ConfigError` (with a `reason` code) is reserved for malformed values, caught by
  `loadConfigOrDegraded` in `index.ts` (no such checks exist today — the optional variables
  fall back to defaults on junk).

## Conventions (do not break)

- **Never exit because of configuration.** A server that dies before the MCP handshake leaves
  the user with a red cross and no reason — the sibling Metrica server's telemetry showed that
  state accounted for nearly every unconfigured install. A missing token is a survivable
  state: start, answer `initialize`/`tools/list` (with the unconfigured prefix in the
  instructions), and reject tool calls with `CredentialsError`. There are no login tools:
  the token comes only from the environment, so the fix is the operator setting
  `YANDEX_DIRECT_TOKEN` and restarting the server. `config.test.ts`, `client.test.ts` and
  `index.test.ts` pin this.
- **Credential failures are not transport failures.** `CredentialsError` is thrown before the
  retry/backoff branches (and before fetch) in `call`/`callV4`/`report` — retrying it burns
  seconds of backoff before the user sees the one message that helps. Pinned by "fetch must
  not be called" assertions in `client.test.ts`.
- **Money in account currency units, never micros.** Inputs/outputs are in units;
  convert at the boundary with `toMicros`/`fromMicros`, normalize read results with
  `normalizeMoney`. The only place micros leak is `raw_request` (documented).
- **Writes go through `okOrPartial`,** not `ok` — the API returns HTTP 200 with
  per-object `Errors`, and partial failures must surface as `isError`.
- **Validate inputs with zod** in `inputSchema`; reject empty updates before any call
  (see `update_campaign`/`update_text_ad` tests).
- **Output compact JSON via `ok`** — the consumer is an LLM; pretty-printing only burns tokens.
- **Pagination:** single-page tools clamp to `MAX_TOOL_LIMIT`; `autoPaginate` uses
  `getAll` at `DEFAULT_PAGE_LIMIT` and flags `_truncated` instead of silently cutting.
- **Runtime guidance for the consuming model goes in the tool `description`,** not in
  this file — the external agent never reads CLAUDE.md. API gotchas (budget minimums,
  bid-modifier rules, field limits) belong in the relevant tool's description.

## Adding a tool

Before changing the tool registry, read [the MCP capability documentation contract](docs/CAPABILITY-DOCUMENTATION.md). Every registered tool must have exactly one task-oriented page in `docs/capabilities/`; update that page, the index, and the coverage test in the same change.

1. Add (or extend) `src/tools/<name>.ts` with `register<Name>Tools(server, client)`.
2. Import and call it in `src/index.ts`.
3. Add a `*.test.ts` using the fake-server/mock-client harness (no network).
4. Document the tool in `docs/TOOLS.md`.
5. `npm run typecheck && npm test`.

## Safety

- Tools hit a **real ad account with real money.** `smoke` is read-only by design;
  never put a production token in CI.

## Releasing

Keep the version in sync across **all** channels in one go — publishing to npm alone silently
drifts from the rest (`git push --follow-tags` pushes the tag but does **not** create a GitHub
Release; the registry is immutable per version, so even a metadata-only change needs a bump):

1. Bump `version` in `package.json` **and** `server.json` (root + `packages[].version`)
   together. `mcpName` in `package.json` must match `name` in `server.json`.
2. `npm publish` (runs typecheck + tests + build via `prepublishOnly` / `prepare`).
3. `git commit`, `git tag -a vX.Y.Z -m vX.Y.Z`, `git push origin main --follow-tags`.
4. **GitHub Release:** `gh release create vX.Y.Z --title vX.Y.Z --generate-notes --verify-tag`.
5. **Official MCP registry:** `mcp-publisher publish`.

See [docs/PUBLISHING.md](docs/PUBLISHING.md) for the registry details.
