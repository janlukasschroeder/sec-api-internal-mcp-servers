const config = require('../config');

const { log } = console;

// the first one comes back over the plain download, the second one only over
// the cloak browser: sec.gov answers 403 to a browser agent.
const TEST_URLS = [
  'https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=1032747',
  'https://www.sec.gov/files/form10-k.pdf',
];

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
      params: { name: 'get-pdf', arguments: { pdfUrl: url } },
    }),
  });

  return response.json();
};

const checkPdf = ({ answer, url }) => {
  if (answer.error) {
    return { ok: false, reason: answer.error.message };
  }

  if (answer.result.isError) {
    return { ok: false, reason: answer.result.content[0].text };
  }

  const resource = answer.result.content.find((c) => c.type === 'resource');

  if (!resource) {
    return { ok: false, reason: 'The answer holds no resource' };
  }

  const buffer = Buffer.from(resource.resource.blob, 'base64');
  const header = buffer.subarray(0, 5).toString('latin1');
  const hasEof = buffer.subarray(-1024).includes('%%EOF');

  if (header !== '%PDF-' || !hasEof) {
    return {
      ok: false,
      reason: 'header ' + JSON.stringify(header) + ', end marker ' + hasEof,
    };
  }

  return {
    ok: true,
    reason:
      buffer.length +
      ' bytes, ' +
      resource.resource.mimeType +
      ', ' +
      answer.result.structuredContent.bytes +
      ' bytes reported',
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
      result = checkPdf({ answer, url });
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
