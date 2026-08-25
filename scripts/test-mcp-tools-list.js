const config = require('../config');

const { log } = console;

const REQUEST_TIMEOUT_MS = 30_000;

const listTools = async () => {
  const response = await fetch(config.mcp.httpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  });

  const answer = await response.json();

  if (answer.error) {
    throw new Error(answer.error.message);
  }

  return answer.result.tools;
};

const getInputs = (tool) => {
  const properties = tool.inputSchema.properties || {};
  const required = tool.inputSchema.required || [];

  return Object.keys(properties).map((name) => {
    return name + (required.includes(name) ? '' : '?');
  });
};

const main = async () => {
  log(`Server: ${config.mcp.httpUrl}`);

  const tools = await listTools();

  for (const tool of tools) {
    log('');
    log(`${tool.name}  (${tool.title || 'no title'})`);
    log(`  inputs: ${getInputs(tool).join(', ') || 'none'}`);
    log(`  ${(tool.description || 'no description').slice(0, 120)}`);
  }

  log('');
  log(`${tools.length} tools`);

  process.exit(tools.length ? 0 : 1);
};

if (require.main === module) {
  main();
}
