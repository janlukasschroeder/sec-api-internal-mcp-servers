# SEC-API Internal MCP Servers

Add servers to Claude Code by adding JSON to Claude Code project file `.mcp.json` (project root):

```json
{
  "mcpServers": {
    "browser-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:22001/mcp"
    }
  }
}
```

In Claude Code project, run `/mcp` to confirm the server is working. Close and restart Claude session if not visible.

Use the MCP server in Claude Code agent by saying:

```text
Verify the URLs with the fetch-website MCP tool.
```
