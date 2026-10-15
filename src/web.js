import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { SOURCE_LABELS, leadsCsv, toIST } from './files.js';
import { NAME_MAX, ValidationError, cleanName, normalizePhone } from './leads.js';
import { themeCss } from './theme.js';

export const MAX_BODY = 8 * 1024;
const MAX_FIELDS = 20;
const ALREADY_REGISTERED = 'This number is already registered. Reach out to us at the desk if you need to change your details.';
export const BRAND_PATHS = { '/brand/logo-light.png': 'light', '/brand/logo-dark.png': 'dark' };
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const HEAVY = 'Impact,Haettenschweiler,"Arial Narrow Bold",system-ui,sans-serif';
const CSS = `${themeCss()}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:500 17px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:28rem;margin:0 auto;padding:14px 16px 40px}
main.wide{max-width:64rem}
a{color:inherit}
.brand{margin:0 0 14px}
.brand img{display:block;width:100%;max-width:250px;height:auto;margin:0 auto}
.wordmark{margin:8px 0 0;text-align:center;font:900 2.2rem/1 ${HEAVY};text-transform:uppercase}
.card{position:relative;background:var(--surface);border:3px solid var(--line);border-radius:14px;box-shadow:6px 6px 0 var(--pink);padding:20px 18px 24px}
.card h1{margin:0 0 .35rem;font:900 1.7rem/1.1 ${HEAVY};text-transform:uppercase;letter-spacing:.02em}
.lede{margin:0 0 .5rem;color:var(--muted)}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.card form > label:first-of-type{margin-top:0}
label{display:block;font-weight:700;margin:1rem 0 .35rem}
input[type=text],input[type=tel]{width:100%;min-height:52px;padding:.7rem .85rem;font-size:17px;font-family:inherit;color:var(--text);background:var(--surface);border:3px solid var(--line);border-radius:10px;-webkit-appearance:none;appearance:none}
input[aria-invalid=true]{border-color:var(--error)}
:focus-visible,input:focus{outline:3px solid var(--focus);outline-offset:2px}
.hint{margin:.35rem 0 0;font-size:.9rem;color:var(--muted)}
.field-error{margin:.45rem 0 0;font-weight:700;color:var(--error)}
.field-error::before{content:"!";display:inline-block;width:1.25em;height:1.25em;margin-right:.4em;border-radius:50%;background:var(--error);color:var(--surface);text-align:center;line-height:1.25em;font-weight:900}
.check{display:flex;gap:.75rem;align-items:flex-start;font-weight:500;margin-top:1.2rem;cursor:pointer}
.check input{flex:none;width:28px;height:28px;margin:0;accent-color:var(--pink)}
button,.btn{display:inline-block;padding:.75rem 1.1rem;font:800 1rem/1.1 system-ui,sans-serif;color:var(--onPink);background:var(--pink);border:3px solid var(--line);border-radius:12px;box-shadow:4px 4px 0 var(--shadow);text-decoration:none;cursor:pointer}
button:active,.btn:active{transform:translate(3px,3px);box-shadow:1px 1px 0 var(--shadow)}
form:not(.inline) > button:not(.primary){margin-top:1rem}
.primary{display:block;width:100%;min-height:58px;margin-top:1.3rem;font:900 1.25rem/1 ${HEAVY};text-transform:uppercase;letter-spacing:.04em}
.notice{margin:1.4rem 4px 0;font-size:.85rem;color:var(--muted)}
.small{font-size:.85rem;color:var(--muted)}
.nowrap{white-space:nowrap}
.error{border:3px solid var(--error);background:var(--errorBg);color:var(--text);border-radius:10px;padding:.75rem;font-weight:600}
.confetti{position:absolute;pointer-events:none;overflow:visible}
.confetti path{fill:var(--pink);stroke:var(--line);stroke-width:2.5;stroke-linejoin:round}
.confetti.tr{top:-24px;right:-8px;width:58px}
.confetti.bl{bottom:-20px;left:-12px;width:38px}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:.5rem;border-bottom:1px solid var(--muted);vertical-align:top}
td button,td .btn{margin:0;padding:.4rem .7rem;font-size:.85rem;box-shadow:2px 2px 0 var(--shadow)}
form.inline{display:inline}
textarea{width:100%;min-height:9rem;font:inherit;padding:.5rem;color:var(--text);background:var(--surface);border:2px solid var(--line);border-radius:8px}
@media (prefers-reduced-motion: reduce){button:active,.btn:active{transform:none}}
`;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
export const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
const firstName = (name) => name.split(' ')[0];
export const displayPhone = (phone) => phone.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2');

function page(title, body, wide = false) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${esc(title)}</title><style>${CSS}</style></head>` +
    `<body><main${wide ? ' class="wide"' : ''}>${body}</main></body></html>`;
}

const errorBlock = (error) => (error ? `<p class="error" role="alert">${esc(error)}</p>` : '');

const CONFETTI =
  '<svg class="confetti tr" viewBox="0 0 60 44" aria-hidden="true" focusable="false">' +
  '<path d="M3 13 L19 3 L23 25 Z"/><path d="M31 7 L57 17 L37 41 Z"/></svg>' +
  '<svg class="confetti bl" viewBox="0 0 40 40" aria-hidden="true" focusable="false">' +
  '<path d="M3 5 L33 3 L11 33 Z"/></svg>';

function logoMarkup(cfg, brand) {
  const img = (src, logo) =>
    `<img src="${src}" alt="${esc(cfg.orgName)}" width="${logo.width}" height="${logo.height}">`;
  if (brand.light && brand.dark) {
    return '<picture><source srcset="/brand/logo-dark.png" media="(prefers-color-scheme: dark)">' +
      `${img('/brand/logo-light.png', brand.light)}</picture>`;
  }
  if (brand.light) return img('/brand/logo-light.png', brand.light);
  if (brand.dark) return img('/brand/logo-dark.png', brand.dark);
  return `<p class="wordmark">${esc(cfg.orgName)}</p>`;
}

const NO_BRAND = { light: null, dark: null };

function portalPage(cfg, brand, title, card, after = '') {
  return page(title, `<header class="brand">${logoMarkup(cfg, brand)}</header>` +
    `<section class="card">${CONFETTI}${card}</section>${after}`);
}

const FIELDS = ['name', 'phone', 'consent'];

export function formPage(cfg, { error = '', field = null, name = '', phone = '', consent = false } = {}, brand = NO_BRAND) {
  const inline = error && FIELDS.includes(field);
  const fieldError = (id) => (inline && field === id
    ? `<p class="field-error" id="${id}-error" role="alert">${esc(error)}</p>` : '');
  const attrs = (id, hint = '') => {
    const describedBy = [inline && field === id ? `${id}-error` : '', hint].filter(Boolean).join(' ');
    return (describedBy ? ` aria-describedby="${describedBy}"` : '') +
      (inline && field === id ? ' aria-invalid="true" autofocus' : '');
  };
  return portalPage(cfg, brand, `${cfg.orgName} registration`, `
<h1 class="sr-only">Register for ${esc(cfg.orgName)}</h1>
${inline ? '' : errorBlock(error)}
<form method="post" action="/submit">
  <label for="name">Your name</label>
  <input id="name" name="name" type="text" autocomplete="name" autocapitalize="words" maxlength="${NAME_MAX}" required value="${esc(name)}"${attrs('name')}>
  ${fieldError('name')}
  <label for="phone">Mobile number</label>
  <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="98765 43210" required value="${esc(phone)}"${attrs('phone', 'phone-hint')}>
  <p class="hint" id="phone-hint">10-digit mobile number, or start with + and your country code.</p>
  ${fieldError('phone')}
  <label class="check"><input type="checkbox" name="consent" value="yes" required${consent ? ' checked' : ''}${attrs('consent')}>
    <span>I agree to ${esc(cfg.orgName)} keeping my name and number for this event's registration.</span></label>
  ${fieldError('consent')}
  <button class="primary" type="submit">Register</button>
</form>`, `
<p class="notice">${esc(cfg.orgName)} uses your name and number only for this event's registration.
Reach out to us at the desk any time to have your details deleted.</p>`);
}

export function thanksPage(cfg, name, phone, brand = NO_BRAND) {
  return portalPage(cfg, brand, "You're registered", `
<h1>You're registered, ${esc(firstName(name))}!</h1>
<p class="lede">We've got you down as <strong>${esc(name)}</strong> on <strong class="nowrap">${esc(displayPhone(phone))}</strong>.</p>
<p>You can disconnect from this Wi-Fi now so your phone goes back to mobile data.</p>`, `
<p class="notice">Changed your mind? Reach out to us at the desk and we'll delete your details.</p>`);
}

export function adminPage(cfg, leads, token, error = '', warnings = []) {
  const rows = leads.map((lead) =>
    `<tr><td>${esc(lead.name)}</td><td class="nowrap">${esc(displayPhone(lead.phone))}</td>` +
    `<td>${esc(SOURCE_LABELS[lead.source] ?? lead.source)}</td><td class="nowrap">${esc(toIST(lead.createdAt))}</td></tr>`);
  return page('Registrations', `
${warnings.map((w) => `<p class="error" role="alert">${esc(w)}</p>`).join('')}
<h1>Registrations: ${leads.length}</h1>
<p><a href="/admin/export.csv">Download CSV</a></p>
<div class="scroll"><table><thead><tr><th>Name</th><th>Phone</th><th>Came in via</th><th>Signed up (IST)</th></tr></thead>
<tbody>${rows.join('') || '<tr><td colspan="4">No registrations yet.</td></tr>'}</tbody></table></div>
<h2>Add someone who messaged us on WhatsApp</h2>
${errorBlock(error)}
<form method="post" action="/admin/add">
  <input type="hidden" name="token" value="${esc(token)}">
  <label for="name">Name</label><input id="name" name="name" type="text" maxlength="${NAME_MAX}" required>
  <label for="phone">Mobile number</label><input id="phone" name="phone" type="tel" maxlength="20" required>
  <button type="submit">Add registration</button>
</form>`, true);
}

const warningsOf = (store) => store.files?.warnings() ?? [];

function send(res, status, type, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
    ...extra,
  });
  res.end(buf);
}

const html = (res, status, body) => send(res, status, 'text/html; charset=utf-8', body);
const plain = (res, status, text, extra) => send(res, status, 'text/plain; charset=utf-8', text, extra);
const redirect = (res, location, status = 302) =>
  send(res, status, 'text/html; charset=utf-8', `<a href="${esc(location)}">Continue</a>`, { Location: location });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readForm(req) {
  return new Promise((resolvePromise, reject) => {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const declared = Number(req.headers['content-length']);
    if (req.headers['content-length'] === undefined || !Number.isInteger(declared) || declared < 0) {
      return reject(new HttpError(411, 'length required'));
    }
    if (declared > MAX_BODY) return reject(new HttpError(413, 'request too large'));
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'request too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('error', reject);
    req.on('end', () => {
      if (type !== 'application/x-www-form-urlencoded') return reject(new HttpError(415, 'unsupported content type'));
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        return reject(new HttpError(400, 'malformed form'));
      }
      const params = new URLSearchParams(text);
      if ([...params.keys()].length > MAX_FIELDS) return reject(new HttpError(400, 'too many fields'));
      const fields = {};
      for (const [key, value] of params) if (!(key in fields)) fields[key] = value;
      resolvePromise(fields);
    });
  });
}

function hostOf(req) {
  const host = (req.headers.host || '').trim().toLowerCase();
  if (host.startsWith('[')) return host.split(']')[0] + ']';
  return host.replace(/:\d*$/, '');
}

function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createPortalServer(cfg, store, { laptopIp, quiet = false, brand = { light: null, dark: null } }) {
  const adminToken = randomBytes(32).toString('base64url');
  let portalHosts;
  let portalUrl;
  const setLaptopIp = (ip) => {
    laptopIp = ip;
    portalHosts = new Set([ip, 'localhost', '127.0.0.1']);
    const port = server.address()?.port ?? cfg.httpPort;
    portalUrl = `http://${ip}${port === 80 ? '' : `:${port}`}/`;
  };
  const log = quiet ? () => {} : (...args) => console.log(new Date().toISOString(), ...args);

  async function submit(req, res) {
    const fields = await readForm(req);
    const rawName = fields.name ?? '';
    const rawPhone = fields.phone ?? '';
    let name;
    let phone;
    try {
      name = cleanName(rawName);
      phone = normalizePhone(rawPhone);
      if (fields.consent !== 'yes') throw new ValidationError('Please tick the box to register.', 'consent');
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      return html(res, 400, formPage(cfg, {
        error: e.message, field: e.field, name: rawName.slice(0, NAME_MAX), phone: rawPhone.slice(0, 20), consent: fields.consent === 'yes',
      }, brand));
    }
    const { created } = store.register({ name, phone, source: 'form', eventCode: cfg.eventCode, noticeVersion: cfg.noticeVersion });
    if (!created) {
      log('duplicate registration refused');
      return html(res, 409, formPage(cfg, {
        error: ALREADY_REGISTERED, field: 'phone', name: rawName.slice(0, NAME_MAX), phone: rawPhone.slice(0, 20), consent: true,
      }, brand));
    }
    log('registration added via form');
    html(res, 200, thanksPage(cfg, name, phone, brand));
  }

  async function adminPost(req, res, path) {
    const fields = await readForm(req);
    if (!tokenMatches(fields.token, adminToken)) return plain(res, 403, 'bad or missing admin token; reload /admin');
    if (path === '/admin/add') {
      let name;
      let phone;
      try {
        name = cleanName(fields.name);
        phone = normalizePhone(fields.phone);
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        return html(res, 400, adminPage(cfg, store.list(), adminToken, e.message, warningsOf(store)));
      }
      const result = store.register({ name, phone, source: 'whatsapp', eventCode: cfg.eventCode, noticeVersion: cfg.noticeVersion });
      if (!result.created) {
        const message = `${displayPhone(phone)} is already registered, as ${result.existing.name}.`;
        return html(res, 409, adminPage(cfg, store.list(), adminToken, message, warningsOf(store)));
      }
      return redirect(res, '/admin', 303);
    }
    plain(res, 404, 'not found');
  }

  async function handle(req, res) {
    let path;
    try {
      path = new URL(req.url, 'http://x').pathname;
    } catch {
      return plain(res, 400, 'bad request');
    }
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const isAdmin = path === '/admin' || path.startsWith('/admin/');

    if (isAdmin) {
      if (!LOOPBACK.has(req.socket.remoteAddress)) return plain(res, 404, 'not found', { Connection: 'close' });
      if (method === 'GET' && path === '/admin') return html(res, 200, adminPage(cfg, store.list(), adminToken, '', warningsOf(store)));
      if (method === 'GET' && path === '/admin/export.csv') {
        return send(res, 200, 'text/csv; charset=utf-8', leadsCsv(store.list()),
          { 'Content-Disposition': 'attachment; filename="leads.csv"' });
      }
      if (method === 'POST') return adminPost(req, res, path);
      return plain(res, 404, 'not found');
    }
    if (method === 'POST' && path === '/submit') return submit(req, res);
    const logo = method === 'GET' && BRAND_PATHS[path];
    if (logo && brand[logo]) {
      return send(res, 200, 'image/png', brand[logo].bytes, { 'Cache-Control': 'public, max-age=86400' });
    }
    if (method === 'GET' && path === '/' && portalHosts.has(hostOf(req))) return html(res, 200, formPage(cfg, {}, brand));
    // Every other URL, including the OS captive-portal probes, goes to the form.
    redirect(res, portalUrl, method === 'GET' ? 302 : 303);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return plain(res, e.status, e.message, { Connection: 'close' });
      console.error(e);
      plain(res, 500, 'internal error');
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  setLaptopIp(laptopIp);
  server.on('listening', () => setLaptopIp(laptopIp));
  server.portalUrl = () => portalUrl;
  server.setLaptopIp = setLaptopIp;
  return server;
}
