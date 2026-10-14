import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config.js';
import { startCatchAllDns } from './dns.js';
import { LeadFiles } from './files.js';
import { LeadStore } from './leads.js';
import { createPortalServer } from './web.js';

function localIPv4s() {
  return Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4').map((a) => a.address);
}

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
  const local = localIPv4s();
  if (!local.includes(cfg.laptopIp)) {
    console.error(`laptopIp ${cfg.laptopIp} is not an address of this machine (have: ${local.join(', ')}); ` +
      'phones would be sent to the wrong place. Join the event Wi-Fi and set laptopIp to `ipconfig getifaddr en0`.');
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
  const server = createPortalServer(cfg, store, { quiet: values.quiet });
  let dns = null;
  try {
    await listen(server, cfg.httpPort, '0.0.0.0');
    if (!values['no-dns']) dns = await startCatchAllDns({ answerIp: cfg.laptopIp, port: cfg.dnsPort });
  } catch (e) {
    console.error(`cannot open port: ${e.message}`);
    server.close();
    store.close();
    files.close();
    return 1;
  }

  const { port } = server.address();
  console.log(`Sign-up form:        ${server.portalUrl()}`);
  console.log(`Admin (laptop only): http://localhost${port === 80 ? '' : `:${port}`}/admin`);
  console.log(`DNS: ${dns ? `answering every name with ${cfg.laptopIp} on port ${dns.address().port}` : 'off'}`);
  console.log(`Leads database:      ${cfg.dbPath}`);
  console.log(`Synced spreadsheet:  ${files.csvPath}`);
  console.log(`Append-only log:     ${files.logPath}`);

  const stop = () => {
    server.close();
    server.closeAllConnections();
    dns?.close();
    store.close();
    files.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return null;
}

const code = await main(process.argv.slice(2));
if (code !== null) process.exitCode = code;
