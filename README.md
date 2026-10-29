# Weather — Current Conditions and Forecast

Current weather and 7–10 day forecast for any location. Backed by Open-Meteo (https://open-meteo.com), a free aggregator of national meteorological agency data (NOAA in the US, DWD in Germany, etc.). Returns temperature, humidity, wind, precipitation, conditions. Free, no auth, no API key.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Why this matters for AI agents

Weather is one of those things agents need to know about constantly — for travel planning, agricultural questions, energy demand context, event planning, real estate ("is this market in a flood zone with active flooding?"). Open-Meteo is the right backend: free, accurate, global coverage, no key gymnastics.

Common flows:

- **Current conditions.** "Weather in Tokyo right now" → `get_weather({location: "Tokyo"})` → temp, humidity, wind, conditions.
- **Forecast.** "7-day forecast for Denver" → `get_forecast({location: "Denver"})` → daily highs/lows, precipitation chance.
- **By coordinates.** `get_weather({latitude: 39.74, longitude: -104.99})` for places that don't geocode well by name.

## Auth

None. Open-Meteo is free and unauthenticated. Generous fair-use limits (~10,000 requests/day per IP). Pipeworx caches per-location for short windows so repeated calls don't burn your daily quota.

## Geocoding

The `location` parameter accepts:
- City names (`"Tokyo"`, `"London"`, `"Denver"`)
- City + country (`"Paris, France"` to disambiguate from Paris, TX)
- ZIP/postal codes (`"94070"` for US, `"SW1A 1AA"` for UK)
- Coordinates as a separate `latitude` + `longitude` argument

For ambiguous names, the tool returns a disambiguation hint. For weird locations or precision-sensitive queries (offshore, remote), pass coordinates directly.

## Update cadence

| Data | Refresh |
|---|---|
| Current conditions | ~10 minutes |
| Hourly forecast (next 24h) | Every 1–3 hours |
| Daily forecast (1–10 days) | Every 6 hours |

Pipeworx caches with a 10-minute TTL so repeated calls within that window are cheap.

## Common pitfalls

- **Time zones.** Forecast hours are in UTC by default. The tool also returns the location's timezone — convert client-side when displaying to users.
- **Precipitation probability vs. amount.** "70% chance of rain" and "0.4 inches expected" are different fields. For agricultural and travel use, both matter; report both.
- **Forecast accuracy degrades by day.** Day 1 is reliable; day 7+ is "directional weather signal." Don't quote 10-day forecasts as confident predictions.
- **Severe weather events.** Open-Meteo has hazard fields but they're less reliable than NWS active alerts for the US. For severe weather agents, layer NOAA NWS API on top.
- **Historical weather.** Default tools are present + future. For historical data (yesterday and back), Open-Meteo has separate endpoints — let the team know via [pipeworx_feedback](/docs/concepts/meta-tools) if that's needed.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "weather": {
      "url": "https://gateway.pipeworx.io/weather/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/weather/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/get_weather \
  -H 'Content-Type: application/json' \
  -d '{"latitude":40.7128,"longitude":-74.006}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/get_weather`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-weather` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/weather/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "weather": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-weather"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Weather data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
