const config = require('../config');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const axios = require('axios');
const { ScrapingBeeClient } = require('scrapingbee');
const htmlToAscii = require('./html-to-ascii');
const helpers = require('./helpers');
const browserFactory = require('./browser-factory-v2');

const { log } = console;

// cloakbrowser: how long page.goto waits for the network to go idle before we
// give up and keep whatever rendered so far.
const CLOAK_TIMEOUT_MS = 15_000;

const CACHE_DIR = path.join(__dirname, '..', 'output', 'cache');

// the readable part of a cache file name. the rest of the name is a hash, a
// timestamp and the extension, and all of it must stay under the 255 byte cap.
const MAX_FILE_NAME_LENGTH = 120;

// cookie banners cover the page, and some sites keep the content empty until
// the banner is gone. these run in the page: the id selectors are the common
// consent platforms (onetrust, trustarc, didomi, cookiebot), the texts are the
// fallback. the order is important, because the first match wins: 'accept all'
// must come before 'accept'.
const COOKIE_ACCEPT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#truste-consent-button',
  '#didomi-notice-agree-button',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  'button[id*="accept-all" i]',
  'button[class*="accept-all" i]',
  '[aria-label*="accept all" i]',
];

const COOKIE_ACCEPT_TEXTS = [
  'accept all cookies',
  'allow all cookies',
  'accept all',
  'allow all',
  'accept cookies',
  'allow cookies',
  'i accept',
  'i agree',
  'accept',
  'agree',
  'got it',
];

// wait after the click, so that the banner can close and the page can render
// the content it held back.
const COOKIE_CLICK_WAIT_MS = 1_000;

// consent sdks (onetrust and the like) load async and inject the banner after
// the page is idle, thus one look is not enough. poll until this deadline. a
// page without a banner pays the full wait, thus keep it short.
const COOKIE_WAIT_MS = 4_000;
const COOKIE_POLL_MS = 500;

// bot walls (akamai, cloudflare) block the first request from a fresh profile
// and let it through once the profile holds their cookies. the browser keeps
// its profile between calls, thus a reload usually passes.
const RETRY_STATUS_CODES = [403, 429, 503];
const MAX_GOTO_ATTEMPTS = 3;
const RETRY_WAIT_MS = 1_000;

// a page often renders the content it held back only after the banner is gone,
// thus wait for the network once more. best effort: a page with polling or a
// websocket never goes idle, and then we take what rendered so far.
const SETTLE_TIMEOUT_MS = 5_000;

// lists and tables below the fold load only when they scroll into view. scroll
// to the end of the page to trigger them. the step count bounds an infinite
// scroll feed, which would never end.
const MAX_SCROLL_STEPS = 25;
const SCROLL_WAIT_MS = 300;

// -----------------------------
// ScrapingBee
// -----------------------------

const getWebsiteContent = async (url) => {
  // check if url ends with .json. if yes, use axios get
  if (url.endsWith('.json')) {
    const response = await axios.get(url);
    return {
      data: response.data,
      contentType: 'application/json',
    };
  }

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

  return {
    data: text,
    contentType: response.headers['content-type'],
  };
};
module.exports.getWebsiteContent = getWebsiteContent;

// -----------------------------
// cloakbrowser
// -----------------------------

// launchPersistentContext comes up with an about:blank page already open, so
// newPage() would always leave that idle tab behind. take over the blank page
// when it is there, and open a new one only if it is not. pages() and the
// _claimed flag are both synchronous, so two parallel requests can never claim
// the same page.
const getCloakPage = async (browser) => {
  const openPages = typeof browser.pages === 'function' ? browser.pages() : [];

  const blankPage = openPages.find(
    (page) => !page.isClosed() && !page._claimed && page.url() === 'about:blank'
  );

  if (blankPage) {
    blankPage._claimed = true;
    return blankPage;
  }

  const page = await browser.newPage();
  page._claimed = true;
  return page;
};

// runs in the page. walks the light dom and all shadow roots, because consent
// widgets are custom elements more often than not.
const clickCookieButton = ({ selectors, texts }) => {
  const elements = [];

  const collect = (root) => {
    for (const element of root.querySelectorAll('*')) {
      elements.push(element);
      if (element.shadowRoot) {
        collect(element.shadowRoot);
      }
    }
  };
  collect(document);

  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  for (const selector of selectors) {
    const match = elements.find((element) => {
      return element.matches(selector) && isVisible(element);
    });
    if (match) {
      match.click();
      return selector;
    }
  }

  // only real buttons, so that a link to the cookie policy cannot match
  const buttons = elements.filter((element) => {
    return (
      ['BUTTON', 'INPUT'].includes(element.tagName) ||
      element.getAttribute('role') === 'button'
    );
  });

  for (const text of texts) {
    const match = buttons.find((element) => {
      const label = (element.innerText || element.value || '')
        .trim()
        .toLowerCase();
      return label === text && isVisible(element);
    });
    if (match) {
      match.click();
      return text;
    }
  }

  return null;
};

// the banner can sit in an iframe (trustarc does this), thus try every frame.
const clickAcceptInAnyFrame = async (page) => {
  for (const frame of page.frames()) {
    try {
      const clicked = await frame.evaluate(clickCookieButton, {
        selectors: COOKIE_ACCEPT_SELECTORS,
        texts: COOKIE_ACCEPT_TEXTS,
      });

      if (clicked) {
        return clicked;
      }
    } catch (err) {
      // frame detached, or it navigated away as we clicked
      log(`Cookie banner check failed on ${frame.url()}: ${err.message}`);
    }
  }

  return null;
};

const acceptCookieBanner = async (page) => {
  const deadline = Date.now() + COOKIE_WAIT_MS;

  while (Date.now() < deadline) {
    const clicked = await clickAcceptInAnyFrame(page);

    if (clicked) {
      log(`Accepted cookie banner: ${clicked}`);
      await helpers.wait(COOKIE_CLICK_WAIT_MS);
      return true;
    }

    await helpers.wait(COOKIE_POLL_MS);
  }

  return false;
};

// scroll step by step and stop as soon as the page stops growing, so that a
// short page costs one step and only a long one pays the full walk. back to the
// top at the end, because some layouts render the header only there.
const scrollToBottom = async (page) => {
  let lastHeight = 0;

  for (let step = 0; step < MAX_SCROLL_STEPS; step++) {
    const height = await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
      return document.body.scrollHeight;
    });

    const atEnd = await page.evaluate(() => {
      return window.scrollY + window.innerHeight >= document.body.scrollHeight;
    });

    if (atEnd && height === lastHeight) {
      break;
    }

    lastHeight = height;
    await helpers.wait(SCROLL_WAIT_MS);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
};

// frame.content() only serializes the document of one frame: its iframes come
// out as empty shells, and that is where much of the content hides on
// investor-relations style pages. so before we serialize a frame, we put a
// <cloak-iframe> placeholder next to each of its child frames. the html of each
// child frame then goes into its placeholder. the result is one html document
// that contains the iframes instead of links to them.
const markChildFrames = async ({ frame, counter }) => {
  const children = [];

  const setPlaceholder = (node, frameId) => {
    // an iframe in a shadow root does not show up in the serialization of the
    // host document. thus anchor the placeholder to the outermost shadow host,
    // which keeps the content where it shows on the page.
    let anchor = node;
    for (
      let root = anchor.getRootNode();
      root && root.host;
      root = anchor.getRootNode()
    ) {
      anchor = root.host;
    }

    const placeholder = anchor.ownerDocument.createElement('cloak-iframe');
    placeholder.setAttribute('data-cloak-frame-id', frameId);

    if (anchor.parentNode) {
      anchor.after(placeholder);
    } else {
      anchor.ownerDocument.body.appendChild(placeholder);
    }
  };

  for (const childFrame of frame.childFrames()) {
    const id = counter.id++;
    try {
      const element = await childFrame.frameElement();
      await element.evaluate(setPlaceholder, String(id));
      children.push({ id, frame: childFrame });
    } catch (err) {
      // frame detached or navigated while we walked the frame tree
      log(`Skipping iframe ${childFrame.url()}: ${err.message}`);
    }
  }

  return children;
};

const getFrameHtmlWithIframes = async ({ frame, counter = { id: 0 } }) => {
  const children = await markChildFrames({ frame, counter });

  let html = await frame.content();

  for (const child of children) {
    let childHtml;
    try {
      childHtml = await getFrameHtmlWithIframes({
        frame: child.frame,
        counter,
      });
    } catch (err) {
      log(`Skipping iframe ${child.frame.url()}: ${err.message}`);
      continue;
    }

    const frameUrl = child.frame.url().replace(/"/g, '%22');
    const openTag = '<cloak-iframe data-cloak-frame-src="' + frameUrl + '">';
    const inlined = openTag + '\n' + childHtml + '\n</cloak-iframe>';

    // we made the placeholder ourselves, thus its attribute values cannot
    // contain a '>' and a match up to the first one is safe.
    const placeholderRe = new RegExp(
      '<cloak-iframe[^>]*data-cloak-frame-id="' +
        child.id +
        '"[^>]*>\\s*</cloak-iframe>',
      'i'
    );

    if (placeholderRe.test(html)) {
      html = html.replace(placeholderRe, () => inlined);
    } else {
      // the placeholder did not get into the serialized document, e.g. because
      // the page replaced that part of the dom. append the content, do not lose
      // it.
      log(`Appending iframe without placeholder: ${child.frame.url()}`);
      html += '\n' + inlined;
    }
  }

  return html;
};

// a bot wall answers 403/429/503, and the same request passes once the profile
// holds its cookies. the browser is shared between calls, thus each reload
// carries what the last one collected.
const gotoWithRetry = async ({ page, url, timeoutMs }) => {
  for (let attempt = 1; attempt <= MAX_GOTO_ATTEMPTS; attempt++) {
    // on a timeout we keep the page as far as it rendered, instead of a throw
    // that loses everything which did load. a timeout gives no response, thus
    // there is no status to judge and we take what we have.
    const response = await browserFactory.continueGoToAfterTimeout(
      page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs }),
      url
    );

    if (!response || !RETRY_STATUS_CODES.includes(response.status())) {
      return response;
    }

    log(
      `Blocked with status ${response.status()}, ` +
        `attempt ${attempt}/${MAX_GOTO_ATTEMPTS}: ${url}`
    );

    if (attempt < MAX_GOTO_ATTEMPTS) {
      await helpers.wait(RETRY_WAIT_MS);
    }
  }

  return null;
};

const getWebsiteContentWithCloak = async ({
  url,
  timeoutMs = CLOAK_TIMEOUT_MS,
  useProxy = false,
  acceptCookies = true,
}) => {
  const browser = await browserFactory.getBrowser({
    useProxy,
    useCloakBrowser: true,
    url,
  });

  const page = await getCloakPage(browser);

  try {
    await gotoWithRetry({ page, url, timeoutMs });

    if (acceptCookies) {
      const accepted = await acceptCookieBanner(page);

      if (accepted) {
        await page
          .waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS })
          .catch(() => {});
      }
    }

    await scrollToBottom(page);

    const html = await getFrameHtmlWithIframes({ frame: page.mainFrame() });

    return { finalUrl: page.url(), html };
  } finally {
    await page.close().catch(() => {});
  }
};
module.exports.getWebsiteContentWithCloak = getWebsiteContentWithCloak;

// -----------------------------
// cache
// -----------------------------

const writeCache = ({ url, html, text }) => {
  // macos and linux cap a file name at 255 bytes, and a url with a long query
  // string blows past that. cut the readable part and keep the hash of the full
  // url, so that the name stays unique.
  const urlEncoded = url
    .replace(/[^a-z0-9]/gi, '_')
    .toLowerCase()
    .slice(0, MAX_FILE_NAME_LENGTH);
  const timestamp = Date.now();
  const todayDate = new Date().toISOString().split('T')[0];
  // absolute path: on the stdio transport the parent app sets the cwd, thus a
  // relative path can point anywhere.
  const dir = CACHE_DIR + '/' + todayDate;
  const fileName =
    'website-content-' + urlEncoded + '-' + helpers.sha8(url) + '-' + timestamp;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    dir + '/' + fileName + '.html',
    typeof html === 'string' ? html : JSON.stringify(html, null, 2)
  );
  if (text) {
    fs.writeFileSync(dir + '/' + fileName + '.txt', text);
  }
};

// -----------------------------
// tools
// -----------------------------

const fetchWebsiteHandler = async ({ websiteUrl }) => {
  log(`Fetching website: ${websiteUrl}`);

  const response = await getWebsiteContent(websiteUrl);
  const dataOriginal = response.data;
  let data = '';
  // const htmlText = htmlToText(responseData);
  if (response.contentType === 'application/json') {
    data = JSON.stringify(dataOriginal, null, 2);
  } else {
    data = htmlToAscii.htmlToText(dataOriginal);
  }

  writeCache({ url: websiteUrl, html: dataOriginal, text: data });

  return {
    content: [
      {
        type: 'text',
        // text: content,
        text: data,
      },
    ],
    structuredContent: { content: data },
  };
};

const getWebsiteAsHtmlHandler = async ({ websiteUrl, timeoutMs, useProxy }) => {
  log(`Fetching website with cloak browser: ${websiteUrl}`);

  const { finalUrl, html } = await getWebsiteContentWithCloak({
    url: websiteUrl,
    timeoutMs,
    useProxy,
  });

  log(`Fetched ${finalUrl}. HTML length: ${html.length}`);

  const data = '<!-- url: ' + finalUrl + ' -->\n' + html;

  writeCache({ url: websiteUrl, html: data });

  return {
    content: [
      {
        type: 'text',
        text: data,
      },
    ],
    structuredContent: { content: data },
  };
};

const getWebsiteAsTextHandler = async ({ websiteUrl, timeoutMs, useProxy }) => {
  log(`Fetching website as text with cloak browser: ${websiteUrl}`);

  const { finalUrl, html } = await getWebsiteContentWithCloak({
    url: websiteUrl,
    timeoutMs,
    useProxy,
  });

  log(`Fetched ${finalUrl}. HTML length: ${html.length}`);

  const data = 'URL: ' + finalUrl + '\n' + htmlToAscii.htmlToText(html);

  writeCache({ url: websiteUrl, html, text: data });

  return {
    content: [
      {
        type: 'text',
        text: data,
      },
    ],
    structuredContent: { content: data },
  };
};

const fetchWebsiteTool = {
  name: 'fetch-website',
  config: {
    title: 'Fetch Website',
    description: 'Fetch a website and return its content.',
    inputSchema: z.object({
      websiteUrl: z.string().url(),
    }),
  },
  handler: fetchWebsiteHandler,
};

const getWebsiteAsHtmlTool = {
  name: 'get-website-as-html',
  config: {
    title: 'Get Website As HTML',
    description: `Fetch a website with the cloak browser, which is a stealth browser that runs JavaScript. The request goes out over the local IP. Set useProxy to true to send it through a rotating SOCKS5 proxy pool instead, e.g. when the site blocks the local IP. Returns the HTML of the page. The HTML of all iframes is part of the page HTML. Use this tool when fetch-website is blocked by bot detection, or when it returns an empty page. Use get-website-as-text if you do not need the HTML tags.`,
    inputSchema: z.object({
      websiteUrl: z.string().url(),
      timeoutMs: z.number().int().positive().optional(),
      useProxy: z.boolean().optional(),
    }),
  },
  handler: getWebsiteAsHtmlHandler,
};

const getWebsiteAsTextTool = {
  name: 'get-website-as-text',
  config: {
    title: 'Get Website As Text',
    description: `Fetch a website with the cloak browser, which is a stealth browser that runs JavaScript, and return the page as plain text. The request goes out over the local IP. Set useProxy to true to send it through a rotating SOCKS5 proxy pool instead, e.g. when the site blocks the local IP. The text of all iframes is part of the page text. Tables become ASCII tables, and links keep their target URL. Use this tool to read a page. Use get-website-as-html if you need the HTML tags.`,
    inputSchema: z.object({
      websiteUrl: z.string().url(),
      timeoutMs: z.number().int().positive().optional(),
      useProxy: z.boolean().optional(),
    }),
  },
  handler: getWebsiteAsTextHandler,
};

const tools = [
  //
  // fetchWebsiteTool, // legacy
  getWebsiteAsHtmlTool,
  getWebsiteAsTextTool,
];
module.exports.tools = tools;

const registerTools = (server) => {
  for (const tool of tools) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }
  return server;
};
module.exports.registerTools = registerTools;

//
//
//
const testRun = async () => {
  const url = 'https://www.congress.gov/bill/111th-congress/house-bill/4173';

  // const content = await getWebsiteContent(url);
  const content = await getWebsiteContentWithCloak({ url });

  log('Website content:', content);

  // write to ./output/website-content.txt
  fs.writeFileSync('./output/website-content.txt', content);
};

const main = async () => {
  await testRun();
};

if (require.main === module) {
  main();
}
