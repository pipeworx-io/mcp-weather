# mcp-weather

Weather MCP — wraps Open-Meteo API (free, no auth)

Part of the [Pipeworx](https://pipeworx.io) open MCP gateway.

## Tools

| Tool | Description |
|------|-------------|

## Quick Start

Add to your MCP client config:

```json
{
  "mcpServers": {
    "weather": {
      "url": "https://gateway.pipeworx.io/weather/mcp"
    }
  }
}
```

Or use the CLI:

```bash
npx pipeworx use weather
```

## License

MIT
