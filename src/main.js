import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { BrandError, loadBrand } from './brand.js';
import { ConfigError, loadConfig } from './config.js';
import { startCatchAllDns } from './dns.js';
import { LeadFiles } from './files.js';
import { LeadStore } from './leads.js';
import { AddressError, addressFollower, detectAddress } from './netaddr.js';
import { createPortalServer } from './web.js';

const ADDRESS_CHECK_MS = 5000;

function listen(server, port, host) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
}

// Bind DNS to the booth address itself: on a laptop with a second address, a wildcard socket can
// answer from the other one, and phones drop replies from an address they did not ask. This also
// sidesteps systemd-resolved, which holds 127.0.0.53:53 on Linux.
async function startDns(ip, port) {
  return { sock: await startCatchAllDns({ answerIp: ip, host: ip, port }), host: ip };
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', default: 'config.json' },
      ip: { type: 'string' },
      'no-dns': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
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
  const store = new LeadStore(cfg.dbPath, { files });
  const server = createPortalServer(cfg, store, { laptopIp: address.ip, quiet: values.quiet, brand });
  let dns = null;
  try {
    await listen(server, cfg.httpPort, '0.0.0.0');
    if (!values['no-dns']) dns = await startDns(address.ip, cfg.dnsPort);
  } catch (e) {
    console.error(`cannot open port: ${e.message}`);
    server.close();
    store.close();
    files.close();
    return 1;
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
          dns = await startDns(next.ip, cfg.dnsPort);
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

  console.log(`Laptop address:      ${address.ip} (${address.how})`);
  console.log(`Sign-up form:        ${server.portalUrl()}`);
  console.log(`Admin (laptop only): http://localhost${port === 80 ? '' : `:${port}`}/admin`);
  console.log(`DNS:                 ${dnsLine()}`);
  console.log(`Leads database:      ${cfg.dbPath}`);
  console.log(`Synced spreadsheet:  ${files.csvPath}`);
  console.log(`Append-only log:     ${files.logPath}`);

  const stop = () => {
    clearInterval(timer);
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
