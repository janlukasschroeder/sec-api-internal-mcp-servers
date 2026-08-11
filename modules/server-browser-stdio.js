// stdio version of server-browser.js, for apps that spawn the mcp server as a
// local process (Claude Desktop / Cowork) instead of calling it over http.
require('../config');

// on the stdio transport, stdout carries the mcp protocol: one stray log line
// breaks every response. thus send all logs to stderr. this must run before the
// modules below bind `const { log } = console`.
console.log = console.error;

const mcpTools = require('./mcp-tools');

const { log } = console;

const store = {
  McpServer: null,
  StdioServerTransport: null,
};

const init = async () => {
  // CommonJS version of:
  // import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
  const mcpJs = await import('@modelcontextprotocol/sdk/server/mcp.js');
  store.McpServer = mcpJs.McpServer;
  // CommonJS version of:
  // import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
  const stdioJs = await import('@modelcontextprotocol/sdk/server/stdio.js');
  store.StdioServerTransport = stdioJs.StdioServerTransport;
};

const start = async () => {
  await init();

  const server = new store.McpServer({
    name: 'browser-mcp',
    version: '1.0.0',
  });

  mcpTools.registerTools(server);

  const transport = new store.StdioServerTransport();
  await server.connect(transport);

  log('MCP server ready on stdio');
};

const main = async () => {
  await start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
};

if (require.main === module) {
  main();
}
