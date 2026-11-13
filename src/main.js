import { dirname, join } from 'node:path';
import { isIPv4 } from 'node:net';
import { parseArgs } from 'node:util';
import { excludeFromBackups } from './backup.js';
import { BrandError, loadBrand } from './brand.js';
import { ConfigError, loadConfig } from './config.js';
import { explainPortError, rivalAddresses, startDnsOn as startDns, startRefusers } from './dnsbind.js';
import { CSV_RETRY_MS, LeadFiles } from './files.js';
import { Lcq } from './lcq.js';
import { LeadStore } from './leads.js';
import { AddressError, addressFollower, detectAddress, localAddresses } from './netaddr.js';
import { Router, WifiBan, macOf } from './routerban.js';
import { createPortalServer, printable } from './web.js';

const ADDRESS_CHECK_MS = 5000;
const WIFI_BAN_MS = 15_000;

function listen(server, port, host) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', default: 'config.json' },
      ip: { type: 'string' },
      db: { type: 'string' },
      'dns-port': { type: 'string' },
      'no-dns': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
  });

  let cfg;
  try {
    cfg = loadConfig(values.config);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`config error: ${e.message}`);
    return 2;
  }
  if (values.db) cfg = Object.freeze({ ...cfg, dbPath: values.db });
  if (values['dns-port'] !== undefined) {
    const dnsPort = Number(values['dns-port']);
    if (!Number.isInteger(dnsPort) || dnsPort < 1 || dnsPort > 65535) {
      console.error('--dns-port must be a whole number 1-65535');
      return 2;
    }
    cfg = Object.freeze({ ...cfg, dnsPort });
  }
  let brand;
  try {
    brand = loadBrand(cfg);
  } catch (e) {
    if (!(e instanceof BrandError)) throw e;
    console.error(`config error: ${e.message}`);
    return 2;
  }
  const configured = values.ip ?? cfg.laptopIp;
  let address;
  try {
    address = await detectAddress(configured);
  } catch (e) {
    if (!(e instanceof AddressError)) throw e;
    console.error(`laptop address: ${e.message}`);
    if (isIPv4(configured)) console.error(`If ${configured} is the booth address, run "npm run booth-ip" first.`);
    return 2;
  }

  // The router password stays out of config.json, which is committed.
  const routerPassword = process.env.BOOTH_ROUTER_PASSWORD ?? '';
  if (cfg.routerBan.enabled && !routerPassword) {
    console.error('config error: routerBan.enabled needs the router password in the BOOTH_ROUTER_PASSWORD environment variable');
    return 2;
  }
  if (cfg.routerBan.enabled && cfg.routerBan.host === address.ip) {
    console.error(`config error: routerBan.host ${cfg.routerBan.host} is this laptop; it must be the router`);
    return 2;
  }

  // Everything under data/ holds guests' names and numbers: owner-only.
  process.umask(0o077);
  const dataDir = dirname(cfg.dbPath);
  let files;
  try {
    files = new LeadFiles({ csvPath: join(dataDir, 'leads.csv'), logPath: join(dataDir, 'leads.log') });
  } catch (e) {
    console.error(`cannot open the lead log: ${e.message}`);
    return 1;
  }
  const store = new LeadStore(cfg.dbPath, { files, firstEvent: { code: cfg.eventCode, name: cfg.eventName } });
  const backupWarning = excludeFromBackups(dataDir);
  if (backupWarning) console.error(`WARNING ${printable(backupWarning)}`);
  const trace = values.verbose ? (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`) : null;
  const onQuery = trace && ((name, from, answered) => trace(`dns  ${printable(from)} asked ${printable(name ?? '(malformed)')}${answered ? '' : ' (no answer)'}`));
  const onRequest = trace && ((from, method, host, url) => trace(`http ${printable(from)} ${printable(method)} ${printable(host)}${printable(url)}`));
  const lcq = new Lcq(store);
  const wifiBan = cfg.routerBan.enabled ? new WifiBan(cfg.routerBan, store, {
    router: new Router({ host: cfg.routerBan.host, certSha256: cfg.routerBan.certSha256, password: routerPassword }),
    lookup: (ip) => macOf(ip, { router: cfg.routerBan.host }),
    protectedIps: () => server.tabletIps(),
    log: (line) => console.error(`${new Date().toISOString()} ${line}`),
  }) : null;
  const server = createPortalServer(cfg, store, { laptopIp: address.ip, quiet: values.quiet, brand, onRequest, lcq, wifiBan });
  let dns = null;
  try {
    await listen(server, cfg.httpPort, '0.0.0.0').catch((e) => {
      throw explainPortError(e, cfg.httpPort, 'TCP');
    });
    if (!values['no-dns']) dns = await startDns(address.ip, cfg.dnsPort, undefined, onQuery);
  } catch (e) {
    console.error(`cannot open port: ${e.message}`);
    server.close();
    store.close();
    files.close();
    return 1;
  }
  // Only phones that use this laptop as DNS knock on these, and the booth works without them.
  const refusers = dns ? await startRefusers() : { servers: [], failed: [] };
  for (const { message } of refusers.failed) {
    console.error(`WARNING ${message} Phones may wait longer before showing the sign-in page.`);
  }

  const { port } = server.address();
  const dnsLine = () => (dns ? `answering every name with ${follower.current.ip} on ${dns.host}:${cfg.dnsPort}` : 'off');
  const follower = addressFollower({
    initial: address,
    detect: () => detectAddress(configured),
    onProblem: (msg) => console.error(`WARNING laptop address: ${msg}. Phones cannot reach the form until this is fixed.`),
    onRecovered: (ip) => console.log(`Laptop address OK again: ${ip}`),
    onChange: async (next, previous) => {
      server.setLaptopIp(next.ip);
      if (dns) {
        dns.sock.close();
        try {
          dns = await startDns(next.ip, cfg.dnsPort, undefined, onQuery);
        } catch (e) {
          dns = null;
          console.error(`WARNING DNS could not move to ${next.ip}: ${e.message}`);
        }
      }
      console.log(`Laptop address changed from ${previous.ip} to ${next.ip} (${next.how}).`);
      console.log(`Sign-up form is now ${server.portalUrl()}; DNS ${dnsLine()}. Reprint the poster URL if it shows the old one.`);
    },
  });
  const timer = setInterval(() => follower.check().catch((e) => console.error(`address check failed: ${e.message}`)), ADDRESS_CHECK_MS);
  const fileRetry = setInterval(() => files.retry(), CSV_RETRY_MS);
  const wifiTimer = wifiBan && setInterval(() => wifiBan.tick().catch((e) => console.error(`Wi-Fi drop failed: ${e.message}`)), WIFI_BAN_MS);

  console.log(`Laptop address:      ${address.ip} (${address.how})`);
  console.log(`Sign-up form:        ${server.portalUrl()}`);
  console.log(`Admin (laptop only): http://localhost${port === 80 ? '' : `:${port}`}/admin`);
  console.log(`LCQ runner (tablet): ${server.portalUrl()}lcq  PIN ${lcq.pin()}`);
  console.log(`DNS:                 ${dnsLine()}`);
  console.log(`Wi-Fi drop:          ${wifiBan ? `on: a phone leaves ${cfg.routerBan.afterMin} min after signing up, kept off for ${cfg.routerBan.hours} h (router ${cfg.routerBan.host})` : 'off'}`);
  if (refusers.servers.length) {
    console.log(`Refusing at once:    ${refusers.servers.map((r) => r.address().port).join(', ')} (HTTPS, private DNS)`);
  }
  const rivals = dns?.host === '0.0.0.0' ? rivalAddresses(address.ip, localAddresses()) : [];
  if (rivals.length) {
    console.error(`WARNING ${rivals.map((r) => r.address).join(', ')} is also on the booth network, so DNS replies may leave ` +
      `from it and phones will ignore them. Run "npm run booth-ip" so ${address.ip} is the only address.`);
  }
  console.log(`Current event:       ${printable(store.currentEvent().name)} (change it on the admin page)`);
  console.log(`Leads database:      ${cfg.dbPath}`);
  console.log(`Synced spreadsheet:  ${files.csvPath}`);
  console.log(`Append-only log:     ${files.logPath}`);

  const stop = () => {
    clearInterval(timer);
    clearInterval(fileRetry);
    if (wifiTimer) clearInterval(wifiTimer);
    for (const r of refusers.servers) r.close();
    server.close();
    server.closeAllConnections();
    dns?.sock.close();
    store.close();
    files.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return null;
}

const code = await main(process.argv.slice(2));
if (code !== null) process.exitCode = code;
