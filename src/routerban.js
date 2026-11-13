import { execFile } from 'node:child_process';
import https from 'node:https';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * Takes a registered phone off the booth Wi-Fi: after a sign-up the laptop finds the phone's Wi-Fi (MAC) address
 * in its own ARP table, then asks an OpenWrt router (hostapd over ubus, HTTPS with a pinned certificate) to
 * disconnect it and refuse it for a while. Off unless routerBan.enabled; a sign-up never waits on or fails
 * because of any of this.
 */

export class RouterError extends Error {}

const MAC = /^([0-9a-f]{1,2})([:-][0-9a-f]{1,2}){5}$/i;
const REPLY_MAX = 64 * 1024;
const REAPPLY_MS = 5 * 60_000;
const SCHEMA = 'CREATE TABLE IF NOT EXISTS wifi_bans (mac TEXT NOT NULL, phone TEXT NOT NULL, eventCode TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (mac, eventCode));';

/** "A4-83-E7-1-2-3" -> "a4:83:e7:01:02:03"; null for anything that is not one unicast device address. */
export function cleanMac(raw) {
  if (typeof raw !== 'string' || !MAC.test(raw)) return null;
  const parts = raw.toLowerCase().split(/[:-]/).map((p) => p.padStart(2, '0'));
  const mac = parts.join(':');
  // Multicast (and so broadcast) has the low bit of the first octet set; all zeros is no device.
  if (Number.parseInt(parts[0], 16) & 1 || mac === '00:00:00:00:00:00') return null;
  return mac;
}

/** Whether ip is a dotted IPv4 address in the same /24 as the router: the only guests this ever looks up. */
export const onBoothNet = (ip, router) => isIPv4(ip) && isIPv4(router) && ip.split('.').slice(0, 3).join('.') === router.split('.').slice(0, 3).join('.');

const ARP = {
  darwin: (ip) => ['arp', ['-n', ip]],
  win32: (ip) => ['arp', ['-a', ip]],
  linux: (ip) => ['ip', ['neigh', 'show', ip]],
};

/** The MAC this laptop has on record for ip, read from the line naming exactly that address; null if none. */
export function macFromArp(output, ip) {
  for (const line of String(output).split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    if (!tokens.some((t) => t === ip || t === `(${ip})`)) continue;
    for (const t of tokens) {
      const mac = cleanMac(t);
      if (mac) return mac;
    }
  }
  return null;
}

const runFile = (cmd, args) => new Promise((resolvePromise, reject) => {
  execFile(cmd, args, { timeout: 2000, maxBuffer: REPLY_MAX, windowsHide: true }, (e, stdout) => (e ? reject(e) : resolvePromise(stdout)));
});

/** The Wi-Fi address behind a guest's IP, from the laptop's own ARP table; only ever for an address on the booth net. */
export async function macOf(ip, { router, platform = process.platform, run = runFile }) {
  if (!onBoothNet(ip, router)) return null;
  const how = ARP[platform] ?? ARP.linux;
  const [cmd, args] = how(ip);
  return macFromArp(await run(cmd, args), ip);
}

/** This laptop's own adapters, never to be banned. */
export const laptopMacs = () => Object.values(networkInterfaces()).flat().map((a) => cleanMac(a?.mac)).filter(Boolean);

/**
 * One JSON-RPC call to the router's /ubus over HTTPS. The certificate is checked against the pinned SHA-256
 * before a byte of the body (which carries the password or session) is sent; no redirect is followed.
 */
export function ubusPost({ host, port = 443, certSha256, timeoutMs = 3000 }, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolvePromise, reject) => {
    const fail = (e) => reject(e instanceof RouterError ? e : new RouterError(`cannot reach the router: ${e.message}`));
    const req = https.request({
      host, port, path: '/ubus', method: 'POST', agent: false, rejectUnauthorized: false, timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return fail(new RouterError(`the router answered HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > REPLY_MAX) req.destroy(new RouterError('the router reply was too large'));
        else chunks.push(c);
      });
      res.on('end', () => {
        try {
          resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          fail(new RouterError('the router reply was not JSON'));
        }
      });
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new RouterError('the router did not answer in time')));
    req.on('error', fail);
    req.on('socket', (socket) => socket.once('secureConnect', () => {
      const seen = socket.getPeerCertificate()?.fingerprint256?.replaceAll(':', '').toLowerCase();
      if (seen !== certSha256) return req.destroy(new RouterError('the router certificate does not match routerBan.certSha256'));
      req.end(body);
    }));
  });
}

const NO_SESSION = '00000000000000000000000000000000';
const DENIED = Symbol('denied');

/** The few ubus calls this needs, with one fresh login when the router has forgotten the session. */
export class Router {
  constructor({ host, port = 443, certSha256, password, username = 'booth', post = ubusPost, timeoutMs = 3000 }) {
    this.target = { host, port, certSha256, timeoutMs };
    this.username = username;
    this.password = password;
    this.post = post;
    this.session = null;
    this.id = 0;
  }

  /** One JSON-RPC round trip; DENIED when the session is not (or no longer) allowed. */
  async rpc(method, params) {
    const reply = await this.post(this.target, { jsonrpc: '2.0', id: ++this.id, method, params });
    if (!reply || typeof reply !== 'object') throw new RouterError('the router reply had an unexpected shape');
    // uhttpd-mod-ubus says "Access denied" (-32002) for a bad session; a ubus call says status 6.
    if (reply.error?.code === -32002 || (Array.isArray(reply.result) && reply.result[0] === 6)) return DENIED;
    if (reply.error) throw new RouterError(`the router refused: ${String(reply.error.message ?? 'error').slice(0, 80)}`);
    return reply.result;
  }

  async login() {
    const result = await this.rpc('call', [NO_SESSION, 'session', 'login', { username: this.username, password: this.password }]);
    const session = Array.isArray(result) && result[0] === 0 ? result[1]?.ubus_rpc_session : null;
    if (typeof session !== 'string' || !/^[0-9a-f]{32}$/.test(session)) throw new RouterError('the router refused the routerBan login');
    this.session = session;
  }

  /** A call made with the session; a session the router has forgotten gets one fresh login, then gives up. */
  async authed(method, params) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.session) await this.login();
      const result = await this.rpc(method, params(this.session));
      if (result !== DENIED) return result;
      this.session = null;
    }
    throw new RouterError(`the router refused ${method} for the routerBan login (check its ACL)`);
  }

  async call(object, method, args = {}) {
    const result = await this.authed('call', (session) => [session, object, method, args]);
    if (!Array.isArray(result) || typeof result[0] !== 'number') throw new RouterError('the router reply had an unexpected shape');
    if (result[0] !== 0) throw new RouterError(`the router refused ${object} ${method} (ubus status ${result[0]})`);
    return result[1] ?? {};
  }

  /** The hostapd objects (one per Wi-Fi network), e.g. hostapd.wlan0 or hostapd.phy0-ap0. */
  async radios() {
    const result = await this.authed('list', (session) => [session, 'hostapd.*']);
    const names = Object.keys(result && typeof result === 'object' && !Array.isArray(result) ? result : {});
    return names.filter((n) => /^hostapd\.[A-Za-z0-9_.-]{1,32}$/.test(n));
  }

  /** Which radios have this MAC connected right now. */
  async holding(mac) {
    const found = [];
    for (const radio of await this.radios()) {
      const { clients } = await this.call(radio, 'get_clients');
      if (clients && typeof clients === 'object' && Object.keys(clients).some((m) => cleanMac(m) === mac)) found.push(radio);
    }
    return found;
  }

  /** Disconnect mac and refuse it for ms milliseconds on each radio; 0 lifts a ban. */
  async ban(mac, ms, radios) {
    for (const radio of radios ?? await this.radios()) {
      await this.call(radio, 'del_client', { addr: mac, reason: 5, deauth: true, ban_time: ms });
    }
  }
}

/**
 * The policy: who is dropped, when, and for how long. A registration on the form queues the phone's MAC; it is
 * dropped afterMin later (a second sign-up from it pushes that back), and only if it is on the Wi-Fi then, so a
 * forged ARP answer cannot ban a phone that is not here. Bans are kept with the registration's number and event
 * and applied again every few minutes, as the router forgets them when it restarts.
 */
export class WifiBan {
  constructor(settings, store, { router, lookup, clock = () => Date.now(), ownMacs = laptopMacs, log = () => {} }) {
    this.settings = settings;
    this.store = store;
    this.router = router;
    this.lookup = lookup;
    this.clock = clock;
    this.ownMacs = ownMacs;
    this.log = log;
    this.never = new Set(settings.never.map(cleanMac));
    // The tablet's Wi-Fi address, taken once when it enters the PIN: a later forged ARP answer cannot move it.
    this.tablets = new Set();
    this.queued = new Map();
    this.failures = 0;
    this.lastError = '';
    this.reappliedAt = -Infinity;
    this.busy = false;
    store.db.exec(SCHEMA);
  }

  fail(message) {
    this.failures++;
    this.lastError = message;
    this.log(`WARNING Wi-Fi drop: ${message}`);
  }

  /** After a sign-up on the form. Never throws and never delays the reply. */
  queue({ ip, phone, eventCode }) {
    Promise.resolve().then(() => this.lookup(ip)).then((mac) => {
      if (!mac) return this.fail('could not find a phone\'s Wi-Fi address after its sign-up');
      this.queued.set(mac, { mac, phone, eventCode, dueAt: this.clock() + this.settings.afterMin * 60_000 });
    }).catch((e) => this.fail(`could not look up a phone's Wi-Fi address (${e.message})`));
  }

  /** When the LCQ tablet signs in: never drop the device at ip. Never throws. */
  protect(ip) {
    Promise.resolve().then(() => this.lookup(ip)).then((mac) => {
      if (mac) this.tablets.add(mac);
      else this.fail('could not find the LCQ tablet\'s Wi-Fi address; add it to routerBan.never');
    }).catch((e) => this.fail(`could not look up the LCQ tablet's Wi-Fi address (${e.message}); add it to routerBan.never`));
  }

  shielded() {
    return new Set([...this.never, ...this.ownMacs(), ...this.tablets]);
  }

  /** Run from a timer: drop the phones that are due, and every few minutes apply the kept bans again. */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.clock();
      if (now - this.reappliedAt >= REAPPLY_MS) await this.reapply(now);
      const due = [...this.queued.values()].filter((q) => q.dueAt <= now);
      if (due.length) {
        const shield = this.shielded();
        for (const q of due) {
          this.queued.delete(q.mac);
          if (shield.has(q.mac)) continue;
          try {
            const radios = await this.router.holding(q.mac);
            if (!radios.length) continue;
            await this.router.ban(q.mac, this.settings.hours * 3_600_000, radios);
            this.store.db.prepare('INSERT INTO wifi_bans (mac, phone, eventCode, at) VALUES (?, ?, ?, ?) ON CONFLICT (mac, eventCode) DO UPDATE SET phone = excluded.phone, at = excluded.at')
              .run(q.mac, q.phone, q.eventCode, new Date(now).toISOString());
          } catch (e) {
            this.fail(e.message);
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async reapply(now) {
    this.reappliedAt = now;
    const left = (at) => Date.parse(at) + this.settings.hours * 3_600_000 - now;
    // A ban past its time is forgotten, so no Wi-Fi address is kept longer than it is used.
    for (const { mac, eventCode, at } of this.store.db.prepare('SELECT mac, eventCode, at FROM wifi_bans').all()) {
      if (!(left(at) > 0)) this.store.db.prepare('DELETE FROM wifi_bans WHERE mac = ? AND eventCode = ?').run(mac, eventCode);
    }
    const kept = this.store.db.prepare('SELECT mac, at FROM wifi_bans WHERE eventCode = ?').all(this.store.currentEvent().code);
    if (!kept.length) return;
    const shield = this.shielded();
    try {
      for (const { mac, at } of kept) if (!shield.has(mac)) await this.router.ban(mac, left(at));
    } catch (e) {
      this.fail(e.message);
    }
  }

  /** Let a number's phone back on: its bans in that event are lifted and forgotten, and a pending drop is cancelled. */
  async lift({ phone, eventCode }) {
    for (const [mac, q] of this.queued) if (q.phone === phone && q.eventCode === eventCode) this.queued.delete(mac);
    const rows = this.store.db.prepare('SELECT mac FROM wifi_bans WHERE phone = ? AND eventCode = ?').all(phone, eventCode);
    this.store.db.prepare('DELETE FROM wifi_bans WHERE phone = ? AND eventCode = ?').run(phone, eventCode);
    try {
      for (const { mac } of rows) await this.router.ban(mac, 0);
      return true;
    } catch (e) {
      this.fail(`could not lift a ban on the router (${e.message}); it ends by itself within ${this.settings.hours} h`);
      return false;
    }
  }

  /** For the admin page: numbers whose phone is kept off in an event, and how the drops are going. */
  status(eventCode) {
    const rows = this.store.db.prepare('SELECT phone FROM wifi_bans WHERE eventCode = ?').all(eventCode);
    return {
      banned: new Set(rows.map((r) => r.phone)), pending: [...this.queued.values()].filter((q) => q.eventCode === eventCode).length,
      failures: this.failures, lastError: this.lastError, afterMin: this.settings.afterMin, hours: this.settings.hours,
    };
  }
}
