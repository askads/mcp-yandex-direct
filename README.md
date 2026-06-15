# mcp-yandex-direct

An [MCP](https://modelcontextprotocol.io) server for the **Yandex Direct API v5**. It lets MCP-compatible clients (Claude Desktop, Claude Code, etc.) manage PPC campaigns, ad groups, ads and keywords, and pull performance statistics.

This is an original, from-scratch implementation released under the MIT license.

## Tools

| Tool | Description |
| --- | --- |
| `get_account_info` | Account details: login, currency, type, country. |
| `list_campaigns` | List campaigns with filters (id, type, state, status). |
| `create_text_campaign` | Create a TextCampaign. |
| `campaign_action` | suspend / resume / archive / unarchive / delete campaigns. |
| `list_ad_groups` | List ad groups by campaign or id. |
| `create_ad_group` | Create an ad group with target geo. |
| `list_ads` | List ads with filters. |
| `create_text_ad` | Create a text ad (starts as draft). |
| `ad_action` | moderate / suspend / resume / archive / unarchive / delete ads. |
| `list_keywords` | List keywords by campaign, ad group or id. |
| `add_keywords` | Add keywords with optional search/network bids. |
| `keyword_action` | suspend / resume / delete keywords. |
| `get_statistics` | TSV performance report via the Reports service. |

Monetary inputs (budgets, bids) are given in account currency units and converted to micros automatically.

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

> Tip: start with `YANDEX_DIRECT_SANDBOX=true` to experiment safely before touching live campaigns.

## Usage with an MCP client

Copy `.mcp.json.example` to your client configuration (e.g. `.mcp.json`), set your token, and point `args` at the built entry point:

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
npm run dev    # run from source with tsx watch
npm test       # run unit tests
npm run build  # type-check and emit dist/
```

## License

MIT — see [LICENSE](./LICENSE).
