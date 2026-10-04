require('../config'); // needed to load DISPLAY=:99
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const async = require('async');
const helpers = require('./helpers');
const fileIo = require('./file-io-v2');
const proxyFactory = require('./proxy-factory');

const { log } = console;

// check if we run on Mac or Linux.
// linux: /dev/shm, a ram disk
// mac: /tmp on disk (doesn't have in-mem tmp)
const RUNTIME_CACHE_DIR =
  process.platform === 'linux'
    ? '/dev/shm/sec-api-internal-mcp-servers/'
    : path.join(os.tmpdir(), 'sec-api-internal-mcp-servers/') + path.sep;
const MAX_PAGES_PER_BROWSER = 20;
const MAX_PAGE_ATTEMPTS = 3;

// a fleet of browsers that all report the same window is a fingerprint of its
// own, thus every browser takes a random width. the value stays out of the
// args hash, or each call would launch a new browser.
const MIN_WINDOW_WIDTH = 1020;
const MAX_WINDOW_WIDTH = 1700;
const WINDOW_HEIGHT = 900;
// the window holds the tab strip and the address bar above the page, thus the
// window is taller than the viewport
const CHROME_UI_HEIGHT = 85;
// on cap-hit, the browser is retired: cache slots are cleared immediately so
// the next getBrowser() returns a fresh browser without waiting, then the old
// browser is closed once its in-flight pages drain — or after this timeout,
// whichever comes first. covers pathological cases where a page's task hangs
// and would otherwise leave the retired browser alive forever.
const RETIREMENT_TIMEOUT_MS = 2 * 60 * 1000;

// round-robin across N Xvfb virtual displays so a single Xvfb's maxclients
// cap (chrome opens ~5-10 X connections per process) doesn't bottleneck the
// fleet. keep in sync with ecosystem.cloakbrowser.config.js.
// const DISPLAYS = Array.from({ length: 10 }, (_, i) => ':' + (99 + i));
const DISPLAYS = Array.from(
  { length: proxyFactory.getPoolSize(6) },
  (unused, i) => ':' + (99 + i)
);
// const DISPLAYS = Array.from({ length: 1 }, (_, i) => ':' + (99 + i));
// const DISPLAYS = Array.from({ length: 2 }, (_, i) => ':' + (99 + i));

const store = {
  isInited: false,
  argsHashToBrowserId: {},
  browserIdToBrowser: {},
  browserIdToOpeningBrowser: {}, // deferred promises
  launchers: {
    cloakBrowser: null, // async loaded because of ESM mod only
  },
  displayIndex: 0,
};

// for cloakbrowser
// goToFunction = page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
// for puppeteer
// goToFunction = page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
const continueGoToAfterTimeout = async (goToFunction, url = '') => {
  try {
    // await goToFunction(); // DO NOT call the function. it's already been called by parent.
    // return the resolved value so callers that use page.goto's Response
    // (e.g. detectOfflineByStatus on 404/410) still get it on success.
    return await goToFunction;
  } catch (err) {
    const isTimeout =
      err.name === 'TimeoutError' || /Timeout .*ms exceeded/i.test(err.message);
    if (!isTimeout) {
      throw err;
    }
    log('page.goto timeout, proceeding with partial load', url);
    // on timeout there is no Response object — caller must handle undefined.
    return undefined;
  }
};
module.exports.continueGoToAfterTimeout = continueGoToAfterTimeout;

// round-robin across the Xvfb display pool so parallel chrome launches spread
// across all X servers instead of saturating one server's maxclients cap.
// one display per proxy slot, so that the browsers of one egress share an x
// server. without a proxy there is no slot, thus count on.
const getNextDisplay = (proxyIndex) => {
  if (Number.isFinite(proxyIndex)) {
    return DISPLAYS[proxyIndex % DISPLAYS.length];
  }

  const display = DISPLAYS[store.displayIndex % DISPLAYS.length];
  store.displayIndex = (store.displayIndex + 1) % DISPLAYS.length;
  return display;
};

const objToHash = (...params) => {
  const jsonStr = helpers.stableStringify(params);
  // return 1;
  return helpers.sha256(jsonStr);
};

const overrideBrowserNewPage = (browser) => {
  const originalNewPage = browser.newPage.bind(browser);

  browser.newPage = async (...newPageArgs) => {
    browser._totalPages++;
    browser._livePages++;
    browser.maxPagesExceeded = browser._totalPages > MAX_PAGES_PER_BROWSER;

    // log(` ✅ browser pages`, browser._totalPages);

    let page;
    try {
      page = await originalNewPage(...newPageArgs);
    } catch (err) {
      browser._livePages--;
      throw err;
    }
    page.on('close', () => {
      browser._livePages--;
    });
    return page;
  };
};

// const overrideBrowserOnClose = (browser) => {
//   const originalClose = browser.close.bind(browser);

//   browser.close = async () => {
//     log(` ⚠️ Closing browser`, browser._id);
//     if (browser.isClosing) {
//       return;
//     }
//     browser.isClosing = true;

//     await waitForAllPagesToClose(browser);

//     const response = await originalClose();

//     await fileIo.deleteDir(browser._userDataDir);

//     log(` ⚠️ Closed browser and deleted`, browser._userDataDir);

//     delete store.browserIdToBrowser[browser._id];
//     delete store.browserIdToOpeningBrowser[browser._id];

//     return response;
//   };
// };

const getNewBrowserId = () => {
  return helpers.uuidV6();
};

const getBrowserArgs = ({
  egressIpFamily = 6, // 6 = IPv6 egress, 4 = IPv4 egress
  useProxy,
}) => {
  const args = [
    // '--no-sandbox',
    '--disable-setuid-sandbox',
    '--lang=en-US',
    '--autoplay-policy=no-user-gesture-required',
    // prevent chrome from touching GPUs
    '--disable-gpu',
    '--disable-component-update',
    // prevent chome from exhausting dbus
    '--disable-features=DBus',
    '--disable-dbus',
    // disable crashpad
    '--disable-breakpad',
    '--disable-features=Crashpad',
  ];

  let proxyIndex = null;

  if (useProxy) {
    const proxy = proxyFactory.getNextProxy(egressIpFamily);
    proxyIndex = proxy.index;
    args.push('--proxy-server=' + proxy.url);
  }

  args.push('--display=' + getNextDisplay(proxyIndex));

  return args;
};

const getRandomWindowWidth = () => {
  const span = MAX_WINDOW_WIDTH - MIN_WINDOW_WIDTH + 1;
  return MIN_WINDOW_WIDTH + Math.floor(Math.random() * span);
};

const getBrowserParams = ({ args, browserId }) => {
  const pid = String(process.pid);
  const dirName = pid + browserId;

  const userDataDir = path.join(RUNTIME_CACHE_DIR, dirName);

  if (!args) {
    throw new Error('No args provided');
  }

  const width = getRandomWindowWidth();

  // the cloak browser must run headed, or every bot wall sees it
  const browserParams = {
    headless: false,
    humanize: true,
    viewport: { width, height: WINDOW_HEIGHT },
    args: [
      ...args,
      '--window-size=' + width + ',' + (WINDOW_HEIGHT + CHROME_UI_HEIGHT),
    ],
    userDataDir,
  };

  return browserParams;
};

const getNewBrowser = async ({ args, browserId }) => {
  // npm install cloakbrowser playwright-core
  const launcher = store.launchers.cloakBrowser;

  const browserParams = getBrowserParams({ args, browserId });

  log('launching a browser with width ' + browserParams.viewport.width);

  let browser;

  await fileIo.ensureDirExists(browserParams.userDataDir);

  try {
    browser = await launcher.launchPersistentContext(browserParams);
  } catch (e) {
    await fileIo.deleteDir(browserParams.userDataDir);
    throw e;
  }

  browser._id = browserId;
  browser._userDataDir = browserParams.userDataDir;
  browser._totalPages = 0;
  browser._livePages = 0;

  overrideBrowserNewPage(browser); // increment _totalPages and _livePages
  // overrideBrowserOnClose(browser); // on browser.close(), remove tmp dir from /dev/shm

  // If chrome crashes mid-run (SIGSEGV, killed by OOM, X server drops it), nothing fires.
  // store.paramsToBrowser[browserKey] still points at a dead browser instance.
  // Every subsequent getBrowser() returns it → newPage() throws with "Target ... has been closed"
  // → PEL error → no self-heal until MAX pages are eventually reached
  // (which won't happen because every newPage fails).
  // below code solves this.
  // playwright's 'close' fires with the BrowserContext. taking the browser as
  // an argument to the listener would therefore break, so we close over the
  // browser reference explicitly and return a bound handler.
  const onBrowserClose = (browser) => async () => {
    await closeBrowser(browser);
  };

  browser.on('close', onBrowserClose(browser)); // playwright BrowserContext

  return browser;
};

const closeBrowser = async (browser) => {
  // log(
  //   ` ⚠️  Closing browser ${browser._id}. Live pages: ${browser._livePages}. ` +
  //     `Page count: ${browser._totalPages}. browser.isClosing: ${browser.isClosing}`
  // );

  if (browser.isClosing) {
    return;
  }
  browser.isClosing = true;

  // if pages are still open, wait 500 ms and check again
  // wait max 120 seconds
  let waitedFor = 0;
  while (browser._livePages !== 0 && waitedFor < RETIREMENT_TIMEOUT_MS) {
    await helpers.wait(500);
    waitedFor += 500;
  }

  let closeTimer;
  try {
    const timeout = new Promise((resolve) => {
      closeTimer = setTimeout(resolve, RETIREMENT_TIMEOUT_MS);
    });
    await Promise.race([browser.close(), timeout]);
  } catch (e) {
    log('Error closing browser', e);
  } finally {
    clearTimeout(closeTimer);
  }

  // probe if browser is closed
  // let browserClosed = browser.isConnected();
  // let waitedForBrowserClosed = 0;

  // while (isConnected && waitedForBrowserClosed < 2_000) {
  //   await helpers.wait(500);
  //   waitedForBrowserClosed += 500;
  //   browserClosed = browser.isConnected();
  // }
  await helpers.wait(1000);

  try {
    await fileIo.deleteDir(browser._userDataDir);
  } catch (e) {
    log(e);
  }

  log(
    ` ⚠️  Closed browser. Deleted ${browser._userDataDir}. Page count: ${browser._totalPages}`
  );

  delete store.browserIdToBrowser[browser._id];
  delete store.browserIdToOpeningBrowser[browser._id];
};

const getBrowser = async ({
  useProxy = true,
  egressIpFamily = 6, // 6 = IPv6 egress, 4 = IPv4 egress
  url,
} = {}) => {
  if (!store.isInited) {
    await initFactory();
    store.isInited = true;
  }

  if (url) {
    const egress = await proxyFactory.getEgressIpFamily(url);

    egressIpFamily = egress.egressIpFamily;

    log(`egressIpFamily: ${egressIpFamily}. host: ${egress.host}`);
  }

  const args = getBrowserArgs({ egressIpFamily, useProxy });

  const argsHash = objToHash(args);

  const browserId = store.argsHashToBrowserId[argsHash];
  const browser = store.browserIdToBrowser[browserId];

  // if browser is set and NOT closing, AND max pages not exceeded:
  if (browser && !browser.isClosing && !browser.maxPagesExceeded) {
    return browser;
  }

  // browser is starting
  if (store.browserIdToOpeningBrowser[browserId]) {
    return store.browserIdToOpeningBrowser[browserId];
  }

  // need fresh browser. close old one if there is one.
  if (browser) {
    // browser.close().catch(() => {}); // sets browser.isClosing = true
    closeBrowser(browser).catch(() => {});
  }

  store.argsHashToBrowserId[argsHash] = getNewBrowserId();
  const newBrowserId = store.argsHashToBrowserId[argsHash];

  const proxyUrl = args.find((a) => a.startsWith('--proxy'));
  const display = args.find((a) => a.startsWith('--display'));
  // log(' 🚀 Launching new browser', newBrowserId, proxyUrl, display);

  let deferredResolve, deferredReject;

  // deferredPromise.catch(() => {}); // avoid unhandledRejection before a consumer attaches
  store.browserIdToOpeningBrowser[newBrowserId] = new Promise((res, rej) => {
    deferredResolve = res;
    deferredReject = rej;
  });

  try {
    const newBrowser = await getNewBrowser({
      args,
      browserId: newBrowserId,
    });

    store.browserIdToBrowser[newBrowserId] = newBrowser;
    deferredResolve(newBrowser);
    return newBrowser;
  } catch (err) {
    // roll back so next call retries cleanly instead of wedging
    deferredReject(err);
    if (store.argsHashToBrowserId[argsHash] === newBrowserId) {
      delete store.argsHashToBrowserId[argsHash];
    }
    delete store.browserIdToBrowser[newBrowserId];
    throw err;
  } finally {
    delete store.browserIdToOpeningBrowser[newBrowserId];
  }
};
module.exports.getBrowser = getBrowser;

// launchPersistentContext comes up with an about:blank page already open, so
// newPage() would always leave that idle tab behind. take over the blank page
// when it is there, and open a new one only if it is not. pages() and the
// _claimed flag are both synchronous, so two parallel requests can never claim
// the same page.
const claimPage = async (browser) => {
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

// a browser can retire between getBrowser and the page: another call hits the
// page cap, or chromium dies. the page would then open against a closing
// context. take the next browser in that case, which getBrowser launches
// because it skips a browser that closes.
const getPage = async ({ useProxy, egressIpFamily, url } = {}) => {
  let lastError;

  for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt++) {
    const browser = await getBrowser({ useProxy, egressIpFamily, url });

    try {
      return await claimPage(browser);
    } catch (err) {
      if (!/closed/i.test(err.message)) {
        throw err;
      }
      lastError = err;
      log(
        `browser closed before the page, attempt ${attempt}/${MAX_PAGE_ATTEMPTS}`
      );
    }
  }

  throw lastError;
};
module.exports.getPage = getPage;

const closeBrowserAndCleanUp = async () => {
  log('calling closeBrowserAndCleanUp');
  const browsers = Object.values(store.browserIdToBrowser);
  const tasks = browsers.map((browser) => async () => {
    // await browser.close();
    await closeBrowser(browser);
  });
  await async.parallelLimit(tasks, 10);
  log(`all browsers closed`);
};
module.exports.closeBrowserAndCleanUp = closeBrowserAndCleanUp;

const initFactory = async () => {
  store.launchers.cloakBrowser = await import('cloakbrowser');
};
module.exports.initFactory = initFactory;

//
//
//
const testRun = async () => {
  const argsHashToBrowserId = { arg1: 'b1' };
  const browserIdToBrowser = { b1: { isClosing: false } };

  const browserId = argsHashToBrowserId.arg1;
  const browser = browserIdToBrowser[browserId];

  log(`browserId`, browserId);
  log('browser', browser);

  const newBrowserId = getNewBrowserId();
  browser.isClosing = true;

  log('---');
  log(browser);
  log(browserIdToBrowser.b1);

  const pages = [];

  try {
    const browser1 = await getBrowser({
      egressIpFamily: 4,
      useProxy: true,
    });

    log('browser 1 id:', browser1._id);
    log('_totalPages', browser1._totalPages);
    const page1 = await browser1.newPage();
    // await page.setUserAgent(
    //   'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    // );
    pages.push(page1);

    log('_totalPages', browser1._totalPages);

    const url = 'https://ifconfig.co/json';
    const response1 = await page1.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    log(await response1.json());
    await page1.close();

    const browser2 = await getBrowser({
      useProxy: true,
    });
    const page2 = await browser2.newPage();

    log('browser 2 id:', browser2._id);

    const response2 = await page2.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    pages.push(page2);

    log(browser2._totalPages);

    log(await response2.json());
    await page2.close();
  } catch (e) {
    log('Error', e);
  } finally {
    // if (page) {
    //   await page.close().catch(() => {});
    // }
    await closeBrowserAndCleanUp();
  }
};

const testRun2 = async () => {
  // ----

  const toTest = [
    //
    'intc.com',
    'www.intc.com',
    'ir.sequentialbrandsgroup.com',
    'investors.centurybank.com',
    'investors.tyco.com',
    'ir.windriver.com',
    'https://investor.atmeta.com/home/default.aspx',
    // 'adviserinfo.sec.gov',
    'ir.vbivaccines.com',
    'lehman.com',
    'https://ir.checkpointsystems.com',
    'https://ir.shufflemaster.com',
    'https://ir.net.com',
    'morganstanley.com',
    'nokia.com',
    'investor.mckesson.com',
    'news.fedex.com',
    'investors.globalcrossing.com',
    'https://ge.com/',
  ];

  for (const i of toTest) {
    log(await proxyFactory.getDnsEntries(i));
    log('-'.repeat(80));
  }
};

if (require.main === module) {
  testRun();
  // testRun2();
}
