// stdio to http bridge for the mcp server in docker.
//
// claude desktop and cowork spawn a local process and speak json-rpc over
// stdio. their config takes no http url. this worker reads each message from
// stdin, posts it to the http server, and writes the answer to stdout.
const config = require('../config');
const readline = require('readline');

// stdout carries the mcp protocol: one stray log line breaks every answer.
console.log = console.error;

const { log } = console;

const HTTP_URL = config.mcp.httpUrl;
const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

// the server answers with plain json, because it runs with
// enableJsonResponse. a stream answer stays possible, thus read the data lines
// of the event stream as well.
const parseBody = ({ body, contentType }) => {
  if (contentType.includes('text/event-stream')) {
    const dataLines = body
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());

    return dataLines.length ? JSON.parse(dataLines.join('')) : null;
  }

  return body.trim() ? JSON.parse(body) : null;
};

const forward = async (message) => {
  const response = await fetch(HTTP_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(message),
  });

  const body = await response.text();

  return parseBody({
    body,
    contentType: response.headers.get('content-type') || '',
  });
};

const send = (message) => {
  process.stdout.write(JSON.stringify(message) + '\n');
};

const handleLine = async (line) => {
  if (!line.trim()) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch (err) {
    log('Skipping a line that is not json:', err.message);
    return;
  }

  try {
    const answer = await forward(message);

    // a notification has no id, and the server answers it with an empty body.
    if (answer) {
      send(answer);
    }
  } catch (err) {
    log('Request to ' + HTTP_URL + ' failed:', err.message);

    if (message.id !== undefined) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: err.message },
      });
    }
  }
};

const main = async () => {
  log('MCP stdio to http worker ready:', HTTP_URL);

  const lines = readline.createInterface({ input: process.stdin });

  // one message per line, and one at a time: the client counts on the order.
  for await (const line of lines) {
    await handleLine(line);
  }
};

if (require.main === module) {
  main();
}
