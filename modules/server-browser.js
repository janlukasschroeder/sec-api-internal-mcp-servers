// see https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStreamableHttp.ts
const config = require('../config');
const fs = require('fs');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { ScrapingBeeClient } = require('scrapingbee');

const PORT = process.env.PORT || 22_001;

const { log } = console;

let McpServer, StreamableHTTPServerTransport, createMcpExpressApp;

async function init() {
  // CommonJS version of:
  // import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
  const mcpJs = await import('@modelcontextprotocol/sdk/server/mcp.js');
  McpServer = mcpJs.McpServer;
  // CommonJS version of:
  // import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
  const streamableHttpJs =
    await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  StreamableHTTPServerTransport =
    streamableHttpJs.StreamableHTTPServerTransport;
  // CommonJS version of:
  // import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
  const expressJs = await import('@modelcontextprotocol/sdk/server/express.js');
  createMcpExpressApp = expressJs.createMcpExpressApp;
}

// -----------------------------
// ScrapingBee
// -----------------------------

async function getWebsiteContent(url) {
  const client = new ScrapingBeeClient(config.scrapingbee.apiKey);

  const response = await client.get({
    url: url,
    params: {
      render_js: true,
    },
  });

  const decoder = new TextDecoder();
  const text = decoder.decode(response.data);
  // console.log(text);

  return text;
}

// -----------------------------
// MCP server
// -----------------------------

function buildMcpServer() {
  const server = new McpServer({
    name: 'browser-mcp',
    version: '1.0.0',
  });

  server.registerTool(
    'fetch-website',
    {
      title: 'Fetch Website',
      description: 'Fetch a website and return its content.',
      inputSchema: z.object({
        websiteUrl: z.string().url(),
      }),
    },
    async ({ websiteUrl }) => {
      log(`Fetching website: ${websiteUrl}`);

      const content = await getWebsiteContent(websiteUrl);

      const urlEncoded = websiteUrl.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const timestamp = Date.now();
      const filename = `website-content-${urlEncoded}-${timestamp}.html`;
      fs.writeFileSync(`./output/${filename}`, content);

      return {
        content: [
          {
            type: 'text',
            text: content,
          },
        ],
        structuredContent: { content },
      };
    }
  );

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
      const mcpTransport = new StreamableHTTPServerTransport({
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
  app.listen(Number(PORT), '127.0.0.1', () => {
    console.log(`MCP server listening on http://127.0.0.1:${PORT}/mcp`);
  });
};

init().then(() => {
  log(`Imported MCP modules`);

  start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
});

const testRun = async () => {
  const url = 'https://www.congress.gov/bill/111th-congress/house-bill/4173';

  const content = await getWebsiteContent(url);

  log('Website content:', content);

  // write to ./output/website-content.txt
  fs.writeFileSync('./output/website-content.txt', content);
};

// testRun();
