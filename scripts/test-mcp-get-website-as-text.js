const config = require('../config');

const { log } = console;

const TEST_URLS = [
  'https://example.org/',
  'https://www.nvidia.com/en-us/',
  'https://searchengineland.com/microsoft-bing-copilot-use-schema-for-its-llms-453455',
  'https://www.cherryservers.com/pricing/dedicated-servers',
];

const BLOCK_MARKERS = [
  'Access Denied',
  'Just a moment',
  'Attention Required',
  'Checking your browser',
  'ERR_TIMED_OUT',
];

const MIN_CHARS = 500;
const REQUEST_TIMEOUT_MS = 240_000;

const callTool = async ({ url, id }) => {
  const response = await fetch(config.mcp.httpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'get-website-as-text', arguments: { websiteUrl: url } },
    }),
  });

  return response.json();
};

const checkText = (answer) => {
  if (answer.error) {
    return { ok: false, reason: answer.error.message };
  }

  if (answer.result.isError) {
    return { ok: false, reason: answer.result.content[0].text.slice(0, 120) };
  }

  const text = answer.result.content[0].text;
  const marker = BLOCK_MARKERS.find((m) => text.includes(m));

  if (marker) {
    return { ok: false, reason: 'blocked: ' + marker };
  }

  if (text.length < MIN_CHARS) {
    return { ok: false, reason: 'only ' + text.length + ' chars' };
  }

  return { ok: true, reason: text.length + ' chars' };
};

const main = async () => {
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : TEST_URLS;

  log(`Server: ${config.mcp.httpUrl}`);

  let failed = 0;

  for (const [index, url] of urls.entries()) {
    const startedAt = Date.now();
    let result;

    try {
      const answer = await callTool({ url, id: index + 1 });
      result = checkText(answer);
    } catch (err) {
      result = { ok: false, reason: err.message };
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    log(`${result.ok ? 'PASS' : 'FAIL'} ${url}`);
    log(`     ${result.reason} (${seconds}s)`);

    if (!result.ok) {
      failed++;
    }
  }

  log(`${urls.length - failed}/${urls.length} passed`);
  process.exit(failed ? 1 : 0);
};

if (require.main === module) {
  main();
}
