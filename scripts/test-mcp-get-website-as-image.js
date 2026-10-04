const fs = require('fs');
const path = require('path');
const config = require('../config');

const { log } = console;

const TEST_URLS = ['https://www.cherryservers.com/pricing/dedicated-servers'];

const OUT_DIR = path.join(__dirname, '..', 'output');
const MIN_BYTES = 10_000;
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
      params: { name: 'get-website-as-image', arguments: { websiteUrl: url } },
    }),
  });

  return response.json();
};

const checkImage = ({ answer, url }) => {
  if (answer.error) {
    return { ok: false, reason: answer.error.message.slice(0, 120) };
  }

  if (answer.result.isError) {
    return { ok: false, reason: answer.result.content[0].text.slice(0, 120) };
  }

  const image = answer.result.content.find((c) => c.type === 'image');

  if (!image) {
    return { ok: false, reason: 'the answer holds no image' };
  }

  const buffer = Buffer.from(image.data, 'base64');

  // ff d8 ff starts every jpeg file
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;

  if (!isJpeg) {
    return {
      ok: false,
      reason: 'no jpeg: ' + buffer.subarray(0, 4).toString('hex'),
    };
  }

  if (buffer.length < MIN_BYTES) {
    return {
      ok: false,
      reason: 'only ' + buffer.length + ' bytes, likely a blank page',
    };
  }

  const fileName =
    'screenshot-' + url.replace(/[^a-z0-9]/gi, '_').slice(0, 80) + '.jpg';
  const filePath = path.join(OUT_DIR, fileName);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(filePath, buffer);

  return {
    ok: true,
    reason:
      buffer.length +
      ' bytes, ' +
      image.mimeType +
      ', saved to ' +
      path.relative(process.cwd(), filePath),
  };
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
      result = checkImage({ answer, url });
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
