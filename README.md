# mcp-weather

MCP server for real-time weather data. Powered by [Open-Meteo](https://open-meteo.com/) — free, no API key required.

Part of the [Pipeworx](https://pipeworx.io) open MCP gateway.

## Tools

| Tool | Description |
|------|-------------|
| `get_weather` | Get current weather conditions for a location (temperature, humidity, wind, conditions) |
| `get_forecast` | Get a multi-day weather forecast (1-16 days) with daily highs, lows, and conditions |

## Quick Start

Connect directly via the Pipeworx gateway — no setup needed:

```json
{
  "mcpServers": {
    "weather": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://gateway.pipeworx.io/weather/mcp"]
    }
  }
}
```

Or use the CLI:

```bash
npx pipeworx use weather
```

## API

Uses the [Open-Meteo API](https://open-meteo.com/en/docs) — completely free for non-commercial use, no API key required.

## License

MIT
