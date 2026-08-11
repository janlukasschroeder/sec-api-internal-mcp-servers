// see https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStreamableHttp.ts
require('../config');
const { randomUUID } = require('node:crypto');
const express = require('express');
const mcpTools = require('./mcp-tools');

const PORT = process.env.PORT || 22_001;

const { log } = console;

const store = {
  McpServer: null,
  StreamableHTTPServerTransport: null,
  createMcpExpressApp: null,
};

async function init() {
  // CommonJS version of:
  // import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
  const mcpJs = await import('@modelcontextprotocol/sdk/server/mcp.js');
  store.McpServer = mcpJs.McpServer;
  // CommonJS version of:
  // import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
  const streamableHttpJs =
    await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  store.StreamableHTTPServerTransport =
    streamableHttpJs.StreamableHTTPServerTransport;
  // CommonJS version of:
  // import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
  const expressJs = await import('@modelcontextprotocol/sdk/server/express.js');
  store.createMcpExpressApp = expressJs.createMcpExpressApp;
}

function buildMcpServer() {
  const server = new store.McpServer({
    name: 'browser-mcp',
    version: '1.0.0',
  });

  mcpTools.registerTools(server);

  return server;
}

// -----------------------------
// Express + MCP endpoint
// -----------------------------

const start = async () => {
  await init();

  // const app = createMcpExpressApp({
  //   host: '127.0.0.1',
  // });
  const app = express(); // plain express, no MCP middleware

  app.use(express.json());

  // Fake OAuth endpoints
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    res.json({
      issuer: `http://127.0.0.1:${PORT}`,
      authorization_endpoint: `http://127.0.0.1:${PORT}/authorize`,
      registration_endpoint: `http://127.0.0.1:${PORT}/register`,
      token_endpoint: `http://127.0.0.1:${PORT}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      redirect_uris: [`http://127.0.0.1:${PORT}/callback`],
    });
  });

  app.get('/authorize', (req, res) => {
    // Redirect back with a fake code
    const { redirect_uri, state } = req.query;
    res.redirect(`${redirect_uri}?code=local-code&state=${state}`);
  });

  app.post('/token', (req, res) => {
    res.json({
      access_token: 'local-token',
      token_type: 'bearer',
      expires_in: 86400,
    });
  });

  app.post('/register', (req, res) => {
    res.json({
      client_id: 'local',
      client_secret: 'local',
      redirect_uris: req.body.redirect_uris || ['http://localhost/callback'],
    });
  });

  app.post('/mcp', async (req, res) => {
    log('Received MCP request:', {
      method: req.body.method,
      params: req.body.params,
    });

    try {
      const mcpServer = buildMcpServer();
      const mcpTransport = new store.StreamableHTTPServerTransport({
        // sessionIdGenerator: () => randomUUID(),
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      await mcpServer.connect(mcpTransport);
      await mcpTransport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: err.message || 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  // const interface = '127.0.0.1';
  const interface = '0.0.0.0';

  // app.listen(Number(PORT), interface, () => {
  // expose server to LAN interface so that Claude docker can access it
  app.listen(Number(PORT), interface, () => {
    console.log(`MCP server listening on http://${interface}:${PORT}/mcp`);
  });
};

init().then(() => {
  log(`Imported MCP modules`);

  start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
});
