const config = require('../config');
const dns = require('node:dns');
const net = require('net');
const async = require('async');
const axios = require('axios');
const { LRUCache } = require('lru-cache');
const _ = require('lodash');
const helpers = require('./helpers');

const { log } = console;

const ATLAS_TAILSCALE_IP = '100.124.201.21';
const HETZNER_1_TAILSCALE_IP = '100.124.49.94';

// microsocks, one per egress address
const ATLAS_PORT_RANGE_V6_EGRESS = '1080:1089';
const ATLAS_PORT_RANGE_V4_EGRESS = '4080:4083';
const HETZNER_1_PORT_RANGE = '1080:1089';

// each proton container publishes three ports that share one index:
// control 1800N, socks 1838N+8, http 1888N+8. so a proxy port maps back to
// its control port by subtracting the range base and adding the control
// base. used to cycle the tunnel on the exact container whose egress just
// got flagged, instead of restarting all ten.
const ATLAS_PORT_RANGE_PROTON_SOCKS = '18388:18397';
const ATLAS_PORT_RANGE_PROTON_HTTP = '18888:18897';
const GLUETUN_CONTROL_PORT_BASE = 18000;
const PROTON_SOCKS_PORT_BASE = 18388;
const PROTON_HTTP_PORT_BASE = 18888;

// how long to wait after the stop call before starting again, and how long
// to poll for the tunnel to come back up before giving up on it.
const GLUETUN_STOP_WAIT_MS = 2_000;
const GLUETUN_READY_TIMEOUT_MS = 45_000;
const GLUETUN_READY_POLL_MS = 1_000;
const GLUETUN_REQUEST_TIMEOUT_MS = 10_000;

const SOCKS5_PROBE_TIMEOUT_MS = 3_500;
const DNS_TIMEOUT_MS = 1_500;
const DNS_SERVERS = ['8.8.4.4', '1.1.1.1', '8.8.8.8'];

const IP_CHECK_URL = 'https://ifconfig.co/json';
const IP_CHECK_TIMEOUT_MS = 20_000;
const IP_CHECK_CONCURRENCY = 5;

// a dns error that says nothing about the name: the resolver itself is out of
// reach. NXDOMAIN and ENODATA are answers and stay out of this list.
const RESOLVER_ERROR_CODES = [
  'ETIMEOUT',
  'ECONNREFUSED',
  'ESERVFAIL',
  'EREFUSED',
];

// in:  { ip: '100.124.201.21', portRange: '1080:1081' }
// out: ['socks5://100.124.201.21:1080', 'socks5://100.124.201.21:1081']
//
// chromium accepts socks5:// (and always resolves hostnames remotely for
// socks5 anyway — see net/socket/socks5_client_socket.cc). socks5h:// is a
// curl-only alias and triggers net::ERR_NO_SUPPORTED_PROXIES here.
const getIpRange = ({ ip, portRange, protocol = 'socks5' }) => {
  const [portStart, portEnd] = portRange.split(':').map(Number);

  return Array.from(
    { length: portEnd - portStart + 1 },
    (unused, i) => protocol + '://' + ip + ':' + (portStart + i)
  );
};

const SOCKS5_PROXIES_LOCAL_V6_EGRESS = getIpRange({
  ip: '127.0.0.1',
  portRange: ATLAS_PORT_RANGE_V6_EGRESS,
});
const SOCKS5_PROXIES_ATLAS_V6_EGRESS = getIpRange({
  ip: ATLAS_TAILSCALE_IP,
  portRange: ATLAS_PORT_RANGE_V6_EGRESS,
});
const SOCKS5_PROXIES_ATLAS_V4_EGRESS = getIpRange({
  ip: ATLAS_TAILSCALE_IP,
  portRange: ATLAS_PORT_RANGE_V4_EGRESS,
});
const SOCKS5_PROXIES_ATLAS_PROTON = getIpRange({
  ip: ATLAS_TAILSCALE_IP,
  portRange: ATLAS_PORT_RANGE_PROTON_SOCKS,
});
const HTTP_PROXIES_ATLAS_PROTON = getIpRange({
  ip: ATLAS_TAILSCALE_IP,
  portRange: ATLAS_PORT_RANGE_PROTON_HTTP,
  protocol: 'http',
});
// a second egress. youtube's bot wall works per egress ip, thus hetzner stays
// out of the normal rotation and keeps its clean reputation.
const SOCKS5_PROXIES_HETZNER_1 = getIpRange({
  ip: HETZNER_1_TAILSCALE_IP,
  portRange: HETZNER_1_PORT_RANGE,
});

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

// a proton container leaves through a vpn exit node and carries no ipv6
// egress, thus one pool serves both families. a microsocks pool binds one port
// per egress address, thus it differs per family.
//
// proton gets the http ports: the socks port of gluetun accepts a tcp
// connection but fails the socks5 CONNECT, while the http port works. chromium
// takes an http proxy as well, and it sends CONNECT for every https target.
const store = {
  proxySource: 'atlasProton',
  proxyIndexIpV6: 0,
  proxyIndexIpV4: 0,
  protonSocksIndex: 0,
  protonHttpIndex: 0,
  fallbackIndex: 0,
  proxiesIpV6: {
    local: SOCKS5_PROXIES_LOCAL_V6_EGRESS,
    atlasTailscale: SOCKS5_PROXIES_ATLAS_V6_EGRESS,
    atlasProton: HTTP_PROXIES_ATLAS_PROTON,
    hetzner1: SOCKS5_PROXIES_HETZNER_1,
  },
  proxiesIpV4: {
    local: [],
    atlasTailscale: SOCKS5_PROXIES_ATLAS_V4_EGRESS,
    atlasProton: HTTP_PROXIES_ATLAS_PROTON,
    hetzner1: SOCKS5_PROXIES_HETZNER_1,
  },
};

const getProxySource = () => {
  return store.proxySource;
};
module.exports.getProxySource = getProxySource;

// 'atlasProton' | 'atlasTailscale' | 'local' | 'hetzner1'
const setProxySource = (proxySource) => {
  if (!store.proxiesIpV6[proxySource]) {
    throw new Error('Unknown proxy source: ' + proxySource);
  }
  store.proxySource = proxySource;
};
module.exports.setProxySource = setProxySource;

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
module.exports.getAllProxies = getAllProxies;

const getProxyIndex = (egressIpFamily) => {
  if (egressIpFamily === 6) {
    return store.proxyIndexIpV6;
  }
  if (egressIpFamily === 4) {
    return store.proxyIndexIpV4;
  }
  throw new Error('Unknown egress IP family');
};

const getPoolSize = (egressIpFamily = 6) => {
  return getAllProxies(egressIpFamily).length;
};
module.exports.getPoolSize = getPoolSize;

const getCurrentProxy = (egressIpFamily = 6) => {
  const proxies = getAllProxies(egressIpFamily);
  const proxyIndex = getProxyIndex(egressIpFamily);
  return proxies[proxyIndex];
};
module.exports.getCurrentProxy = getCurrentProxy;

const incrementProxyIndex = (egressIpFamily = 6) => {
  const proxies = getAllProxies(egressIpFamily);
  const proxyIndex = getProxyIndex(egressIpFamily);

  if (egressIpFamily === 6) {
    store.proxyIndexIpV6 = (proxyIndex + 1) % proxies.length;
  }
  if (egressIpFamily === 4) {
    store.proxyIndexIpV4 = (proxyIndex + 1) % proxies.length;
  }
};

// out: { url, index }. the index comes back, because the browser factory pins
// one xvfb display per proxy slot.
const getNextProxy = (egressIpFamily = 6) => {
  const proxies = getAllProxies(egressIpFamily);
  const index = getProxyIndex(egressIpFamily);

  incrementProxyIndex(egressIpFamily);

  return { url: proxies[index], index };
};
module.exports.getNextProxy = getNextProxy;

// protocol: 'http' | 'socks5'
const getNextProtonProxy = ({ protocol = 'http' } = {}) => {
  const isHttp = protocol === 'http';
  const proxies = isHttp
    ? HTTP_PROXIES_ATLAS_PROTON
    : SOCKS5_PROXIES_ATLAS_PROTON;
  const index = isHttp ? store.protonHttpIndex : store.protonSocksIndex;

  if (isHttp) {
    store.protonHttpIndex = (index + 1) % proxies.length;
  } else {
    store.protonSocksIndex = (index + 1) % proxies.length;
  }

  return { url: proxies[index], index };
};
module.exports.getNextProtonProxy = getNextProtonProxy;

const getNextFallbackProxy = () => {
  const index = store.fallbackIndex;
  store.fallbackIndex = (index + 1) % SOCKS5_PROXIES_HETZNER_1.length;
  return { url: SOCKS5_PROXIES_HETZNER_1[index], index };
};
module.exports.getNextFallbackProxy = getNextFallbackProxy;

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
  timeoutMs = SOCKS5_PROBE_TIMEOUT_MS,
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
module.exports.probeHostViaSocks5 = probeHostViaSocks5;

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
  const resolver = new dns.promises.Resolver({
    timeout: DNS_TIMEOUT_MS,
    tries: 1,
  });

  resolver.setServers(DNS_SERVERS);

  dnsResolverCache.set('resolver', resolver);

  return resolver;
};

// in:  https://www.intc.com/path/1/2
// in:  intc.com
// out: { host, anyDnsEntryAvailable, v4, v6 }
const getDnsEntries = async (url) => {
  const host = urlToHost(url);

  if (dnsCache.has(host)) {
    return dnsCache.get(host);
  }

  const resolver = getDnsResolver();

  // allSettled, not all: hosts commonly have A but no AAAA (or vice versa),
  // and resolve4/resolve6 reject with ENODATA when their record type is
  // missing. Promise.all would surface that as the whole call throwing even
  // though the other lookup succeeded. the downstream `r.status`/`r.reason`
  // reads already assume allSettled shape.
  let [v4, v6] = await Promise.allSettled([
    resolver.resolve4(host),
    resolver.resolve6(host),
  ]);

  const isResolverError = (vX) => {
    return (
      vX?.status === 'rejected' &&
      RESOLVER_ERROR_CODES.includes(_.get(vX, 'reason.code'))
    );
  };

  // docker desktop drops udp 53 to a public resolver, thus the fixed servers
  // time out in a container.
  if (isResolverError(v4) && isResolverError(v6)) {
    log('dns servers unreachable, using the local resolver:', host);
    [v4, v6] = await Promise.allSettled([
      dns.promises.resolve4(host),
      dns.promises.resolve6(host),
    ]);
  }

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

// in:  https://www.intc.com/path
// out: { egressIpFamily, host }
const getEgressIpFamily = async (url) => {
  const dnsResult = await getDnsEntries(url);

  if (!dnsResult.anyDnsEntryAvailable) {
    throw new Error('host unreachable via socks5: ' + dnsResult.host);
  }

  return {
    egressIpFamily: dnsResult.v6.isResolved ? 6 : 4,
    host: dnsResult.host,
  };
};
module.exports.getEgressIpFamily = getEgressIpFamily;

// returns null for a proxy outside the two proton ranges (microsocks,
// hetzner), because those have no control server and must not be rotated.
const getGluetunControlPort = (proxyUrl) => {
  let port;
  try {
    port = Number(new URL(proxyUrl).port);
  } catch (err) {
    return null;
  }
  if (!Number.isFinite(port)) {
    return null;
  }
  for (const base of [PROTON_HTTP_PORT_BASE, PROTON_SOCKS_PORT_BASE]) {
    const index = port - base;
    if (index >= 0 && index <= 9) {
      return GLUETUN_CONTROL_PORT_BASE + index;
    }
  }
  return null;
};
module.exports.getGluetunControlPort = getGluetunControlPort;

const putVpnStatus = async ({ controlPort, status }) => {
  const url = config.gluetun.host + ':' + controlPort + '/v1/vpn/status';
  await axios.put(
    url,
    { status },
    {
      timeout: GLUETUN_REQUEST_TIMEOUT_MS,
      headers: { 'X-API-Key': config.gluetun.apiKey },
    }
  );
};

// poll until the tunnel reports running again. a stopped tunnel answers the
// status endpoint immediately, so we cannot just wait a fixed interval and
// assume the exit node is reachable.
const waitForVpnRunning = async ({ controlPort }) => {
  const url = config.gluetun.host + ':' + controlPort + '/v1/vpn/status';
  const deadline = Date.now() + GLUETUN_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await axios.get(url, {
        timeout: GLUETUN_REQUEST_TIMEOUT_MS,
        headers: { 'X-API-Key': config.gluetun.apiKey },
      });
      if (res.data && res.data.status === 'running') {
        return true;
      }
    } catch (err) {}
    await helpers.wait(GLUETUN_READY_POLL_MS);
  }
  return false;
};

// cycle one proton container's tunnel so it reconnects through a different
// exit node. a bot wall works per egress ip, so a fresh ip is usually enough
// to clear it without touching the other nine containers.
//
// returns true only when the tunnel came back up. a false return means the
// caller should not bother retrying — the egress is worse off than before.
const rotateProtonIp = async ({ proxyUrl }) => {
  const controlPort = getGluetunControlPort(proxyUrl);
  if (!controlPort) {
    return false;
  }
  if (!config.gluetun.apiKey) {
    log('gluetun rotate skipped: config.gluetun.apiKey is not set');
    return false;
  }
  try {
    log('rotating proton ip for ' + proxyUrl + ' via control ' + controlPort);
    await putVpnStatus({ controlPort, status: 'stopped' });
    await helpers.wait(GLUETUN_STOP_WAIT_MS);
    await putVpnStatus({ controlPort, status: 'running' });
  } catch (err) {
    log('gluetun rotate failed on control ' + controlPort + ': ' + err.message);
    return false;
  }
  const isRunning = await waitForVpnRunning({ controlPort });
  if (!isRunning) {
    log('gluetun tunnel did not come back up on control ' + controlPort);
    return false;
  }
  log('proton ip rotated on control ' + controlPort);
  return true;
};
module.exports.rotateProtonIp = rotateProtonIp;

// axios speaks http proxies only, thus this takes the http port of a proton
// container. socks and http of one container share the tunnel, so the exit ip
// equals the one the browser gets over socks5.
const getEgressIp = async (proxyUrl) => {
  const { hostname, port } = new URL(proxyUrl);

  const response = await axios.get(IP_CHECK_URL, {
    timeout: IP_CHECK_TIMEOUT_MS,
    proxy: { protocol: 'http', host: hostname, port: Number(port) },
    headers: { 'User-Agent': 'curl/8' },
  });

  return response.data;
};
module.exports.getEgressIp = getEgressIp;

//
//
//
const testRun = async () => {
  log('proxy source:', getProxySource());
  log('pool size: v6', getPoolSize(6), '| v4', getPoolSize(4));
  log('next proxy:', getNextProxy(6).url);

  const direct = await axios.get(IP_CHECK_URL, {
    timeout: IP_CHECK_TIMEOUT_MS,
    headers: { 'User-Agent': 'curl/8' },
  });
  log('no proxy'.padEnd(36), direct.data.ip, '|', direct.data.country);

  const tasks = HTTP_PROXIES_ATLAS_PROTON.map((proxyUrl) => async () => {
    try {
      const data = await getEgressIp(proxyUrl);
      log(proxyUrl.padEnd(36), data.ip, '|', data.country, '|', data.asn_org);
    } catch (err) {
      log(proxyUrl.padEnd(36), 'failed:', err.message);
    }
  });

  await async.parallelLimit(tasks, IP_CHECK_CONCURRENCY);
};

if (require.main === module) {
  testRun();
}
