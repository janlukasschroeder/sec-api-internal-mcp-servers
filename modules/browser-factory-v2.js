require('../config'); // needed to load DISPLAY=:99
const fs = require('fs');
const fsp = require('fs/promises');
const dns = require('node:dns');
const net = require('net');
const path = require('path');
const async = require('async');
const puppeteer = require('puppeteer');
const { LRUCache } = require('lru-cache');
const _ = require('lodash');
const helpers = require('./helpers');
const fileIo = require('./file-io-v2');

const { log } = console;

// const RUNTIME_CACHE_DIR = '/dev/shm/webcast-transcriber-v1/';
const RUNTIME_CACHE_DIR = '/tmp/webcast-transcriber-v1/';
const CHROME_BINARY_PATH =
  // '/home/js/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome';
  '/Users/jan/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const MAX_PAGES_PER_BROWSER = 20;
// on cap-hit, the browser is retired: cache slots are cleared immediately so
// the next getBrowser() returns a fresh browser without waiting, then the old
// browser is closed once its in-flight pages drain — or after this timeout,
// whichever comes first. covers pathological cases where a page's task hangs
// and would otherwise leave the retired browser alive forever.
const RETIREMENT_TIMEOUT_MS = 2 * 60 * 1000;

// per-hostname reachability cache. avoids a socks5 handshake on every retry
// of the same dead host. bounded LRU so a long-running worker probing many
// unique hostnames doesn't grow the map forever. ttl expiry handled by the
// cache itself (ttlAutopurge keeps memory tight even without access).
const hostReachabilityCache = new LRUCache({
  max: 500_000,
  ttl: 5 * 60 * 1000,
  ttlAutopurge: true,
}); // hostname -> boolean (ok)

const dnsCache = new LRUCache({
  max: 500_000,
  ttl: 60 * 60 * 1000, // 1 hr
  ttlAutopurge: true,
});

const dnsResolverCache = new LRUCache({
  max: 1,
  ttl: 60 * 60 * 1000, // 1 hr
  ttlAutopurge: true,
});

// chromium accepts socks5:// (and always resolves hostnames remotely for
// socks5 anyway — see net/socket/socks5_client_socket.cc). socks5h:// is a
// curl-only alias and triggers net::ERR_NO_SUPPORTED_PROXIES here.
const SOCKS5_PROXIES_LOCAL_IPV6_EGRESS = [
  'socks5://127.0.0.1:1080',
  'socks5://127.0.0.1:1081',
  'socks5://127.0.0.1:1082',
  'socks5://127.0.0.1:1083',
  'socks5://127.0.0.1:1084',
  'socks5://127.0.0.1:1085',
  'socks5://127.0.0.1:1086',
  'socks5://127.0.0.1:1087',
  'socks5://127.0.0.1:1088',
  'socks5://127.0.0.1:1089',
];

const ATLAS_TAILSCALE_IP = '100.124.201.21';
const ATLAS_PORT_RANGE_V6_EGRESS = '1080:1089';
// const ATLAS_PORT_RANGE_V6_EGRESS = '1080:1081';
const ATLAS_PORT_RANGE_V4_EGRESS = '4080:4083';

const [ATLAS_PORT_START_IPV6, ATLAS_PORT_END_IPV6] =
  ATLAS_PORT_RANGE_V6_EGRESS.split(':').map(Number);

const [ATLAS_PORT_START_IPV4, ATLAS_PORT_END_IPV4] =
  ATLAS_PORT_RANGE_V4_EGRESS.split(':').map(Number);

const SOCKS5_PROXIES_ATLAS_TAILSCALE_IPV6_EGRESS = Array.from(
  { length: ATLAS_PORT_END_IPV6 - ATLAS_PORT_START_IPV6 + 1 },
  (_, i) => 'socks5://' + ATLAS_TAILSCALE_IP + ':' + (ATLAS_PORT_START_IPV6 + i)
);
const SOCKS5_PROXIES_ATLAS_TAILSCALE_IPV4_EGRESS = Array.from(
  { length: ATLAS_PORT_END_IPV4 - ATLAS_PORT_START_IPV4 + 1 },
  (_, i) => 'socks5://' + ATLAS_TAILSCALE_IP + ':' + (ATLAS_PORT_START_IPV4 + i)
);

// round-robin across N Xvfb virtual displays so a single Xvfb's maxclients
// cap (chrome opens ~5-10 X connections per process) doesn't bottleneck the
// fleet. keep in sync with ecosystem.cloakbrowser.config.js.
// const DISPLAYS = Array.from({ length: 10 }, (_, i) => ':' + (99 + i));
const DISPLAYS = Array.from(
  { length: SOCKS5_PROXIES_ATLAS_TAILSCALE_IPV6_EGRESS.length },
  (_, i) => ':' + (99 + i)
);
// const DISPLAYS = Array.from({ length: 1 }, (_, i) => ':' + (99 + i));
// const DISPLAYS = Array.from({ length: 2 }, (_, i) => ':' + (99 + i));

const store = {
  isInited: false,
  argsHashToBrowserId: {},
  browserIdToBrowser: {},
  browserIdToOpeningBrowser: {}, // deferred promises
  launchers: {
    puppeteer,
    cloakBrowser: null, // async loaded because of ESM mod only
  },
  /////////////
  proxySource: 'atlasTailscale',
  proxyIndexIpV6: 0,
  proxyIndexIpV4: 0,
  proxiesIpV6: {
    local: SOCKS5_PROXIES_LOCAL_IPV6_EGRESS,
    atlasTailscale: SOCKS5_PROXIES_ATLAS_TAILSCALE_IPV6_EGRESS,
  },
  proxiesIpV4: {
    local: [],
    atlasTailscale: SOCKS5_PROXIES_ATLAS_TAILSCALE_IPV4_EGRESS,
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

// cheap DNS-lookup-via-socks5: open the socks5 handshake with the target
// host as an ATYP=3 (DOMAINNAME) CONNECT, and close immediately once the
// server reports success. this uses the socks server's own resolver + a
// single TCP connect through the same tunnel chrome will later use — so a
// pass here strongly implies chrome will at least reach the host.
const probeHostViaSocks5 = ({
  proxyHost,
  proxyPort,
  hostname,
  port = 443,
  timeoutMs = 3500,
}) => {
  return new Promise((resolve) => {
    const socket = net.connect(proxyPort, proxyHost);
    let done = false;
    const finish = (ok) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('error', () => finish(false));
    socket.once('connect', () => {
      // greeting: ver=5, nmethods=1, method=0 (no auth)
      socket.write(Buffer.from([5, 1, 0]));
      socket.once('data', (greet) => {
        if (greet[0] !== 5 || greet[1] !== 0) {
          return finish(false);
        }
        // CONNECT request: ver=5, cmd=1, rsv=0, atyp=3 (domain), len, name, port
        const nameBuf = Buffer.from(hostname, 'ascii');
        const req = Buffer.concat([
          Buffer.from([5, 1, 0, 3, nameBuf.length]),
          nameBuf,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]);
        socket.write(req);
        socket.once('data', (resp) => finish(resp[0] === 5 && resp[1] === 0));
      });
    });
  });
};

// in:  https://investor.cvs.com
// out: true | false
const isHostReachable = async (hostname) => {
  if (hostReachabilityCache.has(hostname)) {
    return hostReachabilityCache.get(hostname);
  }

  let ok = false;
  try {
    const u = new URL(getCurrentProxy());
    ok = await probeHostViaSocks5({
      proxyHost: u.hostname,
      proxyPort: Number(u.port),
      hostname,
    });
  } catch (err) {
    ok = false;
  }
  hostReachabilityCache.set(hostname, ok);
  return ok;
};
module.exports.isHostReachable = isHostReachable;

// in:  https://www.intc.com/path
// in:  www.intc.com
// out: www.intc.com
const urlToHost = (url) => {
  if (!url || typeof url !== 'string') {
    return null;
  }
  const withScheme = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch (err) {
    return null;
  }
};
module.exports.urlToHost = urlToHost;

const getDnsResolver = () => {
  if (dnsResolverCache.has('resolver')) {
    return dnsResolverCache.get('resolver');
  }
  const resolver = new dns.promises.Resolver({ timeout: 1500, tries: 1 });

  resolver.setServers(['8.8.4.4', '1.1.1.1', '8.8.8.8']);

  dnsResolverCache.set('resolver', resolver);

  return resolver;
};

// const getDnsEntries = async ({ host, url }) => {
// in:  https://www.intc.com/path/1/2
// in:  intc.com
// out: { host, anyDnsEntryAvailable, v4, v6 }
const getDnsEntries = async (url) => {
  // if (!host && url) {
  const host = urlToHost(url);
  // }

  if (dnsCache.has(host)) {
    return dnsCache.get(host);
  }

  const resolver = getDnsResolver();

  // allSettled, not all: hosts commonly have A but no AAAA (or vice versa),
  // and resolve4/resolve6 reject with ENODATA when their record type is
  // missing. Promise.all would surface that as the whole call throwing even
  // though the other lookup succeeded. the downstream `r.status`/`r.reason`
  // reads already assume allSettled shape.
  const [v4, v6] = await Promise.allSettled([
    resolver.resolve4(host),
    resolver.resolve6(host),
  ]);

  // log('v4', v4);
  // log('v6', v6);

  // vX = { status: 'fulfilled', value: [ '192.198.165.191' ] }
  // vX = { status: 'rejected', reason: Error: queryAaaa ENODATA intc.com { code: 'ENODATA', syscall: 'queryAaaa' } }
  const hasEntry = (vX) => vX?.status === 'fulfilled' && vX?.value?.length > 0;
  const getAddresses = (vX) => (hasEntry(vX) ? vX.value : []);

  const anyDnsEntryAvailable = [v4, v6].some(hasEntry);

  // error codes
  // NXDOMAIN / no-such-record = authoritative answer about the name
  // SERVFAIL / TIMEOUT / REFUSED = your resolver, not their domain
  const result = {
    host,
    anyDnsEntryAvailable,
    v4: {
      isResolved: hasEntry(v4),
      addresses: getAddresses(v4),
      errorCode: _.get(v4, 'reason.code'),
    },
    v6: {
      isResolved: hasEntry(v6),
      addresses: getAddresses(v6),
      errorCode: _.get(v6, 'reason.code'), // eg 'ENOTFOUND', 'ENODATA'
    },
  };

  dnsCache.set(host, result);

  return result;
};
module.exports.getDnsEntries = getDnsEntries;

// egressIpFamily: 4 | 6
const getAllProxies = (egressIpFamily = 6) => {
  if (egressIpFamily === 6) {
    return store.proxiesIpV6[store.proxySource];
  }
  if (egressIpFamily === 4) {
    return store.proxiesIpV4[store.proxySource];
  }
  throw new Error('Unknown egress IP family');
};

const getProxyIndex = (egressIpFamily) => {
  if (egressIpFamily === 6) {
    return store.proxyIndexIpV6;
  }
  if (egressIpFamily === 4) {
    return store.proxyIndexIpV4;
  }
  throw new Error('Unknown egress IP family');
};

const getCurrentProxy = (
  egressIpFamily = 6 // 6 = IPv6 egress, 4 = IPv4 egress
) => {
  const proxies = getAllProxies(egressIpFamily);
  const proxyIndex = getProxyIndex(egressIpFamily);
  return proxies[proxyIndex];
};

const incrementProxyIndex = (
  egressIpFamily = 6 // 6 = IPv6 egress, 4 = IPv4 egress
) => {
  const proxies = getAllProxies(egressIpFamily);
  const proxyIndex = getProxyIndex(egressIpFamily);

  if (egressIpFamily === 6) {
    store.proxyIndexIpV6 = (proxyIndex + 1) % proxies.length;
  }
  if (egressIpFamily === 4) {
    store.proxyIndexIpV4 = (proxyIndex + 1) % proxies.length;
  }
};

const getNextProxy = (
  egressIpFamily = 6 // 6 = IPv6 egress, 4 = IPv4 egress
) => {
  const proxies = getAllProxies(egressIpFamily);
  const proxyIndex = getProxyIndex(egressIpFamily);
  // log(proxies, proxyIndex);
  const proxyUrl = proxies[proxyIndex];
  incrementProxyIndex(egressIpFamily);
  return proxyUrl;
};
module.exports.getNextProxy = getNextProxy;
module.exports.getCurrentProxy = getCurrentProxy;

// round-robin across the Xvfb display pool so parallel chrome launches spread
// across all X servers instead of saturating one server's maxclients cap.
const getNextDisplay = () => {
  //   const display = DISPLAYS[store.displayIndex];
  //   store.displayIndex = (store.displayIndex + 1) % DISPLAYS.length;
  //   return display;
  // return DISPLAYS[store.proxyIndex % DISPLAYS.length];
  return DISPLAYS[store.proxyIndexIpV6 % DISPLAYS.length];
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
  useCloakBrowser,
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

  if (useProxy) {
    const proxyUrl = getNextProxy(egressIpFamily);
    args.push('--proxy-server=' + proxyUrl);
  }

  if (useCloakBrowser) {
    const display = getNextDisplay();
    args.push('--display=' + display);
  }

  return args;
};

const getBrowserParams = ({ args, browserId, useProxy, useCloakBrowser }) => {
  const pid = String(process.pid);
  const dirName = pid + browserId;

  const userDataDir = path.join(RUNTIME_CACHE_DIR, dirName);

  // const args = getBrowserArgs({ useProxy, useCloakBrowser });
  if (!args) {
    // args = getBrowserArgs({ useProxy, useCloakBrowser });
    throw new Error('No args provided');
  }

  const browserParams = {
    headless: true,
    args,
    userDataDir,
  };

  if (useCloakBrowser) {
    browserParams.headless = false;
    browserParams.humanize = true;
  } else {
    browserParams.executablePath = CHROME_BINARY_PATH;
  }

  return browserParams;
};

const getNewBrowser = async ({
  args,
  browserId,
  useProxy,
  useCloakBrowser,
}) => {
  const launcher = useCloakBrowser
    ? // npm install cloakbrowser playwright-core
      store.launchers.cloakBrowser
    : store.launchers.puppeteer;

  const browserParams = getBrowserParams({
    args,
    browserId,
    useProxy,
    useCloakBrowser,
  });

  let browser;

  await fileIo.ensureDirExists(browserParams.userDataDir);

  try {
    if (useCloakBrowser) {
      browser = await launcher.launchPersistentContext(browserParams);
    } else {
      browser = await launcher.launch(browserParams);
    }
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
  // event handler factory for browser.on('close') or browser.on('disconnected').
  // puppeteer's 'disconnected' fires with NO arguments; playwright's 'close'
  // fires with the BrowserContext. taking the browser as an argument to the
  // listener therefore breaks on puppeteer (browser === undefined) — so we
  // close over the browser reference explicitly and return a bound handler.
  const onBrowserClose = (browser) => async () => {
    await closeBrowser(browser);
  };

  if (useCloakBrowser) {
    browser.on('close', onBrowserClose(browser)); // playwright BrowserContext
  } else {
    browser.on('disconnected', onBrowserClose(browser)); // puppeteer Browser
  }

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
  useCloakBrowser = false,
  egressIpFamily = 6, // 6 = IPv6 egress, 4 = IPv4 egress
  url,
} = {}) => {
  if (!store.isInited) {
    await initFactory();
    store.isInited = true;
  }

  if (url) {
    const dnsResult = await getDnsEntries(url);

    if (!dnsResult.anyDnsEntryAvailable) {
      throw new Error('host unreachable via socks5: ' + dnsResult.host);
    }

    egressIpFamily = dnsResult.v6.isResolved ? 6 : 4;

    log(`egressIpFamily: ${egressIpFamily}. host: ${dnsResult.host}`);
  }

  const args = getBrowserArgs({ egressIpFamily, useProxy, useCloakBrowser });

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
      useProxy,
      useCloakBrowser,
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
      useCloakBrowser: true,
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
      useCloakBrowser: true,
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
    log(await getDnsEntries(i));
    log('-'.repeat(80));
  }
};

if (require.main === module) {
  testRun();
  // testRun2();
}
