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
// tools page
// -----------------------------

const escapeHtml = (value) => {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
};

const renderInputs = (tool) => {
  const properties = tool.inputSchema.properties || {};
  const required = tool.inputSchema.required || [];

  const rows = Object.entries(properties).map(([name, schema]) => {
    return `<tr>
        <td><code>${escapeHtml(name)}</code></td>
        <td>${escapeHtml(schema.type || 'any')}</td>
        <td>${required.includes(name) ? 'required' : 'optional'}</td>
      </tr>`;
  });

  return `<table>
      <tr><th>Input</th><th>Type</th><th></th></tr>
      ${rows.join('\n')}
    </table>`;
};

const renderToolsPage = (tools) => {
  const sections = tools.map((tool) => {
    return `<section>
      <h2>${escapeHtml(tool.name)}</h2>
      <p class="title">${escapeHtml(tool.title || '')}</p>
      <p>${escapeHtml(tool.description || '')}</p>
      ${renderInputs(tool)}
    </section>`;
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>browser-mcp tools</title>
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; max-width: 50rem;
             margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #222; }
      h1 { font-size: 1.4rem; }
      h2 { font-size: 1.1rem; margin-bottom: 0.2rem; font-family: monospace; }
      .title { color: #666; margin: 0 0 0.5rem; }
      section { border-top: 1px solid #ddd; padding-top: 1rem; margin-top: 2rem; }
      table { border-collapse: collapse; margin-top: 0.75rem; font-size: 0.9rem; }
      th, td { text-align: left; padding: 0.25rem 1.5rem 0.25rem 0; }
      th { color: #666; font-weight: normal; }
    </style>
  </head>
  <body>
    <h1>browser-mcp</h1>
    <p>${tools.length} tools. The MCP protocol runs over POST on this route.</p>
    ${sections.join('\n')}
  </body>
</html>`;
};

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

  // only a person opens this route, thus answer with a page and not with json.
  // the mcp protocol itself runs over POST on the same route.
  app.get('/mcp', (req, res) => {
    res.type('html').send(renderToolsPage(mcpTools.getToolList()));
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
