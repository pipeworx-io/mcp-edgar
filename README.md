# mcp-edgar

EDGAR MCP — SEC EDGAR public APIs (free, no auth)

Part of the [Pipeworx](https://pipeworx.io) open MCP gateway.

## Tools

| Tool | Description |
|------|-------------|

## Quick Start

Add to your MCP client config:

```json
{
  "mcpServers": {
    "edgar": {
      "url": "https://gateway.pipeworx.io/edgar/mcp"
    }
  }
}
```

Or use the CLI:

```bash
npx pipeworx use edgar
```

## License

MIT
