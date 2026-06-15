# mcp-yandex-direct

An [MCP](https://modelcontextprotocol.io) server for the **Yandex Direct API v5**. It lets MCP-compatible clients (Claude Desktop, Claude Code, etc.) manage PPC campaigns, ad groups, ads and keywords, and pull performance statistics.

This is an original, from-scratch implementation released under the MIT license.

## Tools

The server exposes typed tools for the common objects, plus a generic `raw_request` escape hatch for any other service/method — so the **entire API v5 is reachable**.

**Account & reference**

| Tool | Description |
| --- | --- |
| `get_account_info` | Account details: login, currency, type, country. |
| `get_quota` | Remaining daily API points (Units: spent / rest / limit). |
| `get_regions` | Look up geo region ids by name (for `create_ad_group`). |
| `get_dictionaries` | Reference dictionaries (currencies, time zones, constants, ...). |

**Campaigns, ad groups, ads, keywords**

| Tool | Description |
| --- | --- |
| `list_campaigns` / `create_text_campaign` / `update_campaign` / `campaign_action` | List, create, update (name, budget, **negative keywords**), suspend/resume/archive/delete. |
| `list_ad_groups` / `create_ad_group` / `update_ad_group` | List, create, update ad groups (name, regions, **negative keywords**). |
| `list_ads` / `create_text_ad` / `update_text_ad` / `ad_action` | List, create, update text ads, and moderate/suspend/resume/archive/delete. |
| `list_keywords` / `add_keywords` / `set_keyword_bids` / `keyword_action` | List, add, set manual bids, suspend/resume/delete keywords. |

**Bid modifiers**

| Tool | Description |
| --- | --- |
| `get_bid_modifiers` | Read bid adjustments (mobile, desktop, demographics, retargeting, regional, video). |
| `add_bid_modifier` | Add an adjustment to a campaign or ad group. |
| `set_bid_modifiers` | Change percent and/or enable/disable existing modifiers. |
| `delete_bid_modifiers` | Delete modifiers by id. |

**Ad assets**

| Tool | Description |
| --- | --- |
| `get_sitelinks` / `create_sitelinks_set` / `delete_sitelinks` | Sitelink sets (быстрые ссылки). |
| `get_callouts` / `add_callouts` / `delete_callouts` | Callouts (уточнения). |
| `get_vcards` / `create_vcard` / `delete_vcards` | Virtual business cards (визитки). |
| `get_ad_images` / `get_ad_videos` / `get_creatives` | Read the image / video / creative libraries. |

**Statistics & escape hatch**

| Tool | Description |
| --- | --- |
| `get_statistics` | TSV performance report via the Reports service. |
| `raw_request` | Call any service/method directly (full API coverage). Writes require `confirmWrite=true`. |

Monetary values use account currency units in the typed tools both ways: inputs (budgets, bids) are converted to micros automatically, and `list_*` output is converted back. `raw_request` is raw (micros). List tools accept `limit`/`offset` plus an `autoPaginate` flag that follows the `LimitedBy` cursor.

## Requirements

- Node.js 18+
- A Yandex Direct OAuth token ([how to get one](https://yandex.com/dev/direct/doc/dg/concepts/auth-token.html))

## Setup

```bash
npm install
npm run build
```

## Configuration

The server is configured through environment variables:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `YANDEX_DIRECT_TOKEN` | yes | — | OAuth token for the Yandex Direct API. |
| `YANDEX_DIRECT_LOGIN` | no | — | `Client-Login` header (agency accounts only). |
| `YANDEX_DIRECT_LANG` | no | `ru` | `Accept-Language` for API responses (`ru`, `en`, `uk`, `tr`). |
| `YANDEX_DIRECT_SANDBOX` | no | `false` | Set to `true` to target the API sandbox. |
| `YANDEX_DIRECT_TIMEOUT_MS` | no | `60000` | Per-request timeout in milliseconds. |
| `YANDEX_DIRECT_MAX_RETRIES` | no | `3` | Retries for transient errors (rate limits, 5xx). |

> Tip: start with `YANDEX_DIRECT_SANDBOX=true` to experiment safely before touching live campaigns.

## Usage with an MCP client

Once published, run it with `npx` — no local build required:

```json
{
  "mcpServers": {
    "yandex-direct": {
      "command": "npx",
      "args": ["-y", "mcp-yandex-direct"],
      "env": {
        "YANDEX_DIRECT_TOKEN": "your-oauth-token",
        "YANDEX_DIRECT_SANDBOX": "true"
      }
    }
  }
}
```

Or point `args` at a local build (copy `.mcp.json.example` to your client config and set your token):

```json
{
  "mcpServers": {
    "yandex-direct": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-yandex-direct/dist/index.js"],
      "env": {
        "YANDEX_DIRECT_TOKEN": "your-oauth-token",
        "YANDEX_DIRECT_SANDBOX": "true"
      }
    }
  }
}
```

## Development

```bash
npm run dev        # run from source with tsx watch
npm test           # run unit tests (no network)
npm run typecheck  # type-check sources and tests (no emit)
npm run build      # emit dist/ (excludes tests)
```

### Live smoke check

`npm run smoke` runs a **read-only** check against the account in your environment
(account info, quota, and the first few campaigns). It makes no writes. Run it
locally with your own token — never put a production token in CI:

```bash
YANDEX_DIRECT_TOKEN=your-oauth-token npm run smoke
# or YANDEX_DIRECT_SANDBOX=true YANDEX_DIRECT_TOKEN=... npm run smoke
```

## License

MIT — see [LICENSE](./LICENSE).
