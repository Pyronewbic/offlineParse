// Walks the booth flow against a running `npm run try`: DNS as a phone sees it, the sign-in probes,
// a sign-up, the desk and the LCQ tablet, then deletes its own test sign-up.
// Exit 0: every step passed. 1: a step failed. 2: the check could not run (no server, bad config).
import { Resolver } from 'node:dns/promises';
import http from 'node:http';
import { connect } from 'node:net';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../src/config.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'config.json' },
    ip: { type: 'string', default: '127.0.0.1' },
    'dns-port': { type: 'string', default: '5300' },
    'refused-ports': { type: 'string', default: '443,853' },
  },
});

let cfg;
try {
  cfg = loadConfig(values.config);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(`config error: ${e.message}`);
  process.exit(2);
}
const { ip } = values;
const dnsPort = Number(values['dns-port']);
const port = cfg.httpPort;
const at = (host) => (port === 80 ? host : `${host}:${port}`);
const portal = at(ip);
const desk = at('localhost');

function request({ host, path = '/', method = 'GET', fields = null, headers = {} }) {
  const body = fields ? new URLSearchParams(fields).toString() : '';
  return new Promise((resolvePromise, reject) => {
    const req = http.request({
      host: ip, port, method, path, timeout: 5000,
      headers: {
        Host: host, ...(fields ? {
          'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Origin: `http://${host}`,
        } : {}), ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('no answer within 5 seconds')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Resolves to how a connection to `p` ended: 'refused' (at once) or 'open' (still up after 2 seconds). */
function knock(p) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: ip, port: p });
    const timer = setTimeout(() => {
      socket.destroy();
      resolvePromise('open');
    }, 2000);
    const done = () => {
      clearTimeout(timer);
      resolvePromise('refused');
    };
    socket.on('error', done);
    socket.on('close', done);
  });
}

const results = [];
async function step(name, fn) {
  try {
    const detail = await fn();
    results.push(true);
    console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`);
    return true;
  } catch (e) {
    results.push(false);
    console.log(`FAIL ${name}: ${e.message}`);
    return false;
  }
}
const expect = (ok, message) => {
  if (!ok) throw new Error(message);
};

try {
  await request({ host: portal });
} catch (e) {
  console.error(`Nothing answers at http://${portal}/ (${e.message}). Start it with "npm run try" first.`);
  process.exit(2);
}

// The phone: it asks the booth's DNS for the probe names, and every answer is the laptop.
const resolver = new Resolver({ timeout: 2000, tries: 1 });
resolver.setServers([`${ip}:${dnsPort}`]);
let dnsUp = true;
for (const name of ['captive.apple.com', 'connectivitycheck.gstatic.com']) {
  dnsUp = (await step(`DNS answers ${name} with ${ip}`, async () => {
    const answers = await resolver.resolve4(name);
    expect(answers.includes(ip), `got ${answers.join(', ') || 'nothing'}`);
  })) && dnsUp;
}
for (const [phone, host, path] of [['iPhone', 'captive.apple.com', '/hotspot-detect.html'], ['Android', 'connectivitycheck.gstatic.com', '/generate_204']]) {
  await step(`${phone} sign-in check is sent to the form`, async () => {
    const res = await request({ host, path });
    expect(res.status === 302 && res.headers.location === `http://${portal}/`, `got ${res.status} to ${res.headers.location ?? 'nowhere'}`);
  });
}
for (const p of values['refused-ports'].split(',').map(Number)) {
  await step(`port ${p} is refused at once, so phones do not wait`, async () => expect(await knock(p) === 'refused', 'the connection stayed open'));
}

// The rest writes to whatever is running. The booth's own DNS is on port 53, so only a practice run reaches here.
if (!dnsUp) {
  console.log(`SKIP sign-up, desk and tablet: DNS did not answer on port ${dnsPort}, so this may not be "npm run try"`);
} else {
  const name = `Try Check ${Date.now().toString(36)}`;
  const phone = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
  const games = cfg.games.slice(0, 2);
  const deskPage = async (path = '/admin') => (await request({ host: desk, path })).body;
  let token;
  let pin;
  let bracket;
  try {
    await step('the desk page opens and shows the tablet PIN', async () => {
      const page = await deskPage();
      token = page.match(/name="token" value="([^"]+)"/)?.[1];
      pin = page.match(/PIN <strong>(\d{6})<\/strong>/)?.[1];
      bracket = page.match(/name="bracket" value="(\w+)" aria-pressed="true"/)?.[1];
      expect(token && pin && bracket, 'token, PIN or bracket switch not found');
      return `bracket is ${bracket}`;
    });
    // Sign up into LCQ so the tablet has something to show; the switch is put back afterwards.
    if (token) await step('the desk switches new sign-ups to LCQ', async () => {
      const res = await request({ host: desk, path: '/admin/bracket', method: 'POST', fields: { token, bracket: 'lcq' } });
      expect(res.status === 303, `got ${res.status}`);
    });
    const signUp = () => {
      const fields = new URLSearchParams({ name, phone, email: 'try-check@example.com', consent: 'yes' });
      for (const g of games) fields.append('games', g);
      return request({ host: portal, path: '/submit', method: 'POST', fields });
    };
    await step(`a phone signs up${games.length ? ` for ${games.join(' and ')}` : ''}`, async () => {
      const res = await signUp();
      expect(res.status === 200 && /You're registered/.test(res.body), `got ${res.status}`);
      for (const g of games) expect(res.body.includes(g), `the thank-you page does not name ${g}`);
    });
    await step('the same number again is refused', async () => {
      const res = await signUp();
      expect(res.status === 409, `got ${res.status}`);
    });
    await step('the desk lists the sign-up', async () => {
      const rows = (await deskPage()).split('<tr>').filter((r) => r.includes(`>${name}</th>`)).length;
      expect(rows === Math.max(games.length, 1), `found ${rows} rows`);
    });
    if (pin) await step('the tablet signs in and shows the player', async () => {
      const login = await request({ host: portal, path: '/lcq/login', method: 'POST', fields: { pin } });
      const cookie = login.headers['set-cookie']?.[0]?.split(';')[0];
      expect(login.status === 303 && cookie, `sign-in got ${login.status}`);
      const tab = games.length ? `?${new URLSearchParams({ game: games[0] })}` : '';
      const page = await request({ host: portal, path: `/lcq${tab}`, headers: { Cookie: cookie } });
      expect(page.body.includes(name), `not on the runner${games.length ? ` tab ${games[0]}` : ''}`);
      const v = JSON.parse((await request({ host: portal, path: `/lcq/version${tab}`, headers: { Cookie: cookie } })).body).v;
      expect(page.body.includes(`data-version="${v}"`), 'the page and its refresh check disagree, so the tablet would reload forever');
    });
  } finally {
    if (token && bracket) await step(`the desk switch is put back to ${bracket}`, async () => {
      const res = await request({ host: desk, path: '/admin/bracket', method: 'POST', fields: { token, bracket } });
      expect(res.status === 303, `got ${res.status}`);
    });
    if (token) await step('the test sign-up is deleted', async () => {
      const ids = (await deskPage()).split('<tr>').filter((r) => r.includes(`>${name}</th>`)).map((r) => r.match(/name="id" value="(\d+)"/)?.[1]);
      for (const id of ids) await request({ host: desk, path: '/admin/delete', method: 'POST', fields: { token, id, confirm: 'yes' } });
      expect(!(await deskPage()).includes(name), 'still listed');
      return `${ids.length} removed`;
    });
  }
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
