const fs = require('fs');
const path = require('path');
const axios = require('axios');
const helpers = require('../modules/helpers');
const browserFactory = require('../modules/browser-factory-v2');

const { log } = console;

const DEFAULT_URL =
  'https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=1032747';

const OUTPUT_PATH = path.join(__dirname, '..', 'output', 'tmp.pdf');
const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_WAIT_MS = 3_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const isPdf = (buffer) => {
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
};

// the cheap way. the magic number decides, and not the status or the content
// type: a login page, a soft 404 and the html of the built-in pdf viewer all
// come with status 200, and the last one even with the type application/pdf.
const getPdfWithAxios = async (url) => {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: TIMEOUT_MS,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/pdf,*/*',
    },
  });

  const buffer = Buffer.from(response.data);

  if (!isPdf(buffer)) {
    throw new Error(
      buffer.length +
        ' bytes of ' +
        (response.headers['content-type'] || 'unknown') +
        ', and no pdf'
    );
  }

  return buffer;
};

// runs in the page: the fetch goes through chromium itself, thus it carries the
// cookies and the headers of the browser. the page must sit on the same origin,
// or the fetch fails on cors.
const fetchAsBase64 = async (url) => {
  const response = await fetch(url, { credentials: 'include' });
  const bytes = new Uint8Array(await response.arrayBuffer());

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
};

// a navigation to a pdf gives the html of the built-in viewer and not the file,
// thus navigate first and fetch the bytes from inside the page afterwards.
const getPdfWithCloakBrowser = async (url) => {
  const browser = await browserFactory.getBrowser({ useProxy: false, url });
  const page = await browser.newPage();

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await page.goto(url, { waitUntil: 'load', timeout: TIMEOUT_MS });

      const base64 = await page.evaluate(fetchAsBase64, url);
      const buffer = Buffer.from(base64, 'base64');

      if (isPdf(buffer)) {
        return buffer;
      }

      log(
        `Attempt ${attempt}/${MAX_ATTEMPTS}: no pdf yet, ${buffer.length} bytes`
      );

      await helpers.wait(RETRY_WAIT_MS);
    }

    throw new Error('No pdf after ' + MAX_ATTEMPTS + ' attempts: ' + url);
  } finally {
    await page.close().catch(() => {});
  }
};

const getPdf = async (url) => {
  let buffer;

  try {
    buffer = await getPdfWithAxios(url);
    log('Downloaded with axios');
  } catch (err) {
    log('Axios failed, using the cloak browser:', err.message);
    buffer = await getPdfWithCloakBrowser(url);
    log('Downloaded with the cloak browser');
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, buffer);

  log(`Wrote ${buffer.length} bytes to ${OUTPUT_PATH}`);
};

const main = async () => {
  const url = process.argv[2] || DEFAULT_URL;

  log(`Downloading ${url}`);

  await getPdf(url);
  await browserFactory.closeBrowserAndCleanUp();
  process.exit(0);
};

if (require.main === module) {
  main();
}
