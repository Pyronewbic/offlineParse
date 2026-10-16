// Gives this laptop the fixed booth address from config.json (laptopIp), so the router's DNS setting
// points at it whoever's laptop runs the booth. `--undo` takes it away again (needed on macOS and Windows).
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { BoothIpError, applyBoothIp, parseServiceOrder, planBoothIp } from '../src/boothip.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { localAddresses } from '../src/netaddr.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'config.json' },
    undo: { type: 'boolean', default: false },
    ip: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    gateway: { type: 'string' },
    prefix: { type: 'string', default: '24' },
  },
});

function fail(message, code = 1) {
  console.error(`booth-ip: ${message}`);
  process.exit(code);
}

let cfg;
try {
  cfg = loadConfig(values.config);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  fail(`config error: ${e.message}`, 2);
}

// --ip names a different address, e.g. to undo an old booth address after config.json changed.
const boothIp = values.ip ?? cfg.laptopIp;
let plan;
try {
  plan = planBoothIp({
    platform: process.platform, addresses: localAddresses(), boothIp,
    undo: values.undo, prefix: Number(values.prefix), gateway: values.gateway, ports: { http: cfg.httpPort, dns: cfg.dnsPort },
    services: process.platform === 'darwin'
      ? parseServiceOrder(spawnSync('networksetup', ['-listnetworkserviceorder'], { encoding: 'utf8' }).stdout ?? '')
      : undefined,
  });
} catch (e) {
  if (!(e instanceof BoothIpError)) throw e;
  fail(e.message, 2);
}
if (plan.note) console.log(plan.note);
if (plan.steps.length === 0) process.exit(0);

if (values['dry-run']) {
  console.log(`Would run on ${plan.iface}:`);
  for (const [cmd, args] of plan.steps) console.log(`  ${cmd} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  process.exit(0);
}

if (process.platform === 'win32' && spawnSync('net', ['session'], { stdio: 'ignore' }).status !== 0) {
  fail('Windows needs an administrator terminal: right-click Terminal or PowerShell, choose "Run as administrator", and run this again.', 2);
}

console.log(plan.firewallOnly ? 'Removing the booth firewall rules.' : values.undo
  ? `Removing ${boothIp} from ${plan.iface}.`
  : `Giving ${plan.iface} the booth address ${boothIp}${process.platform === 'win32' ? '' : ' (asks for your password)'}.`);
try {
  await applyBoothIp({
    plan, boothIp, undo: values.undo,
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { stdio: 'inherit' });
      return r.error ? -1 : r.status;
    },
    hasAddress: () => localAddresses().some((a) => a.address === boothIp),
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
} catch (e) {
  if (!(e instanceof BoothIpError)) throw e;
  fail(e.message);
}

if (plan.firewallOnly) {
  console.log('Done: firewall rules removed.');
} else if (values.undo) {
  console.log(`Done: ${boothIp} removed.`);
} else if (process.platform === 'win32' || process.platform === 'darwin') {
  console.log(`Done: ${plan.iface} now uses ${boothIp}${process.platform === 'win32' ? ' and the firewall lets the booth network in' : ''}. Run npm start.`);
  console.log(`After the event run "npm run booth-ip:undo"${process.platform === 'win32' ? ' (as administrator)' : ''}, ` +
    'or this laptop stays on the booth address on every network.');
} else {
  console.log(`Done: ${boothIp} added. Run npm start. It goes away by itself on reboot or Wi-Fi reconnect.`);
}
