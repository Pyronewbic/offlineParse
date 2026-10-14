import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { COLUMNS, NAME_MAX, ValidationError, cleanName, normalizePhone } from './leads.js';
import { socialsText, whatsappLink } from './payloads.js';

export const MAX_BODY = 8 * 1024;
const MAX_FIELDS = 20;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const CSV_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#f6f5f2;color:#1d1d1f;font:16px/1.5 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif}
main{max-width:30rem;margin:0 auto;padding:24px 16px}
main.wide{max-width:64rem}
h1{font-size:1.5rem;margin:0 0 .25rem}
label{display:block;font-weight:600;margin:1rem 0 .25rem}
input[type=text],input[type=tel]{width:100%;padding:.75rem;font-size:1rem;border:1px solid #b9b6ae;border-radius:8px;background:#fff;color:inherit}
.check{display:flex;gap:.5rem;align-items:flex-start;font-weight:400}
.check input{margin-top:.3rem;width:1.1rem;height:1.1rem}
button,.btn{display:inline-block;margin-top:1.25rem;padding:.8rem 1.2rem;font-size:1rem;font-weight:600;border:0;border-radius:8px;background:#1f6f4a;color:#fff;text-decoration:none;cursor:pointer}
.small{font-size:.85rem;color:#5b5953}
.error{background:#fde8e6;color:#8a1c12;padding:.75rem;border-radius:8px}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:.5rem;border-bottom:1px solid #dedad2;vertical-align:top}
td button,td .btn{margin:0;padding:.4rem .7rem;font-size:.85rem}
form.inline{display:inline}
textarea{width:100%;min-height:9rem;font:inherit;padding:.5rem}
@media (prefers-color-scheme: dark){
body{background:#17171a;color:#ecebe8}
input[type=text],input[type=tel],textarea{background:#232327;border-color:#4a4943;color:#ecebe8}
.small{color:#a9a69e}
.error{background:#4a1d18;color:#ffd9d3}
th,td{border-color:#36352f}
}`;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
export const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
const firstName = (name) => name.split(' ')[0];

function page(title, body, wide = false) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${esc(title)}</title><style>${CSS}</style></head>` +
    `<body><main${wide ? ' class="wide"' : ''}>${body}</main></body></html>`;
}

const errorBlock = (error) => (error ? `<p class="error" role="alert">${esc(error)}</p>` : '');

export function formPage(cfg, { error = '', name = '', phone = '' } = {}) {
  return page(`${cfg.orgName} sign-up`, `
<h1>Hi from ${esc(cfg.orgName)}!</h1>
<p>Leave your name and WhatsApp number and we'll send you our Instagram, YouTube and Discord.</p>
${errorBlock(error)}
<form method="post" action="/submit">
  <label for="name">Your name</label>
  <input id="name" name="name" type="text" autocomplete="name" maxlength="${NAME_MAX}" required value="${esc(name)}">
  <label for="phone">WhatsApp number</label>
  <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="98765 43210" required value="${esc(phone)}">
  <label class="check"><input type="checkbox" name="consent" value="yes" required>
    <span>I agree to get WhatsApp messages from ${esc(cfg.orgName)}.</span></label>
  <button type="submit">Send me the links</button>
</form>
<p class="small">${esc(cfg.orgName)} uses your name and number only to send you our social links and news about
our events. Reply STOP on WhatsApp any time to opt out or have your details deleted.</p>`);
}

export function thanksPage(cfg, name, phone) {
  return page('Thanks!', `
<h1>You're on the list, ${esc(firstName(name))}!</h1>
<p>We'll send our Instagram, YouTube and Discord links to WhatsApp <strong>${esc(phone)}</strong> soon.</p>
<p>You can disconnect from this Wi-Fi now so your phone goes back to mobile data.</p>
<p class="small">Changed your mind? Reply STOP on WhatsApp and we'll delete your details.</p>`);
}

export function adminPage(cfg, leads, token, error = '') {
  const pending = leads.filter((l) => !l.socialsSentAt).length;
  const rows = leads.map((lead) => {
    let action;
    if (lead.socialsSentAt) {
      action = `sent ${esc(lead.socialsSentAt)}`;
    } else {
      const link = whatsappLink(lead.phone.replace(/^\+/, ''), socialsText(cfg, firstName(lead.name)));
      action =
        `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open WhatsApp</a> ` +
        '<form class="inline" method="post" action="/admin/mark-sent">' +
        `<input type="hidden" name="token" value="${esc(token)}">` +
        `<input type="hidden" name="id" value="${esc(lead.id)}"><button>Mark sent</button></form>`;
    }
    return `<tr><td>${esc(lead.name)}</td><td>${esc(lead.phone)}</td><td>${esc(lead.source)}</td>` +
      `<td>${esc(lead.createdAt)}</td><td>${action}</td></tr>`;
  });
  return page('Leads admin', `
<h1>Leads: ${leads.length} total, ${pending} waiting for socials</h1>
<p><a href="/admin/export.csv">Download CSV</a></p>
<div class="scroll"><table><thead><tr><th>Name</th><th>Phone</th><th>Source</th><th>Added (UTC)</th><th>Socials</th></tr></thead>
<tbody>${rows.join('') || '<tr><td colspan="5">No leads yet.</td></tr>'}</tbody></table></div>
<h2>Add someone who messaged us on WhatsApp</h2>
${errorBlock(error)}
<form method="post" action="/admin/add">
  <input type="hidden" name="token" value="${esc(token)}">
  <label for="name">Name</label><input id="name" name="name" type="text" maxlength="${NAME_MAX}" required>
  <label for="phone">WhatsApp number</label><input id="phone" name="phone" type="tel" maxlength="20" required>
  <button type="submit">Add lead</button>
</form>
<h2>Socials message to paste into WhatsApp replies</h2>
<textarea readonly>${esc(socialsText(cfg, 'there'))}</textarea>`, true);
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function leadsCsv(leads) {
  const lines = [COLUMNS.join(',')];
  for (const lead of leads) {
    lines.push(COLUMNS.map((c) => {
      const v = lead[c];
      const guarded = c !== 'phone' && typeof v === 'string' && CSV_FORMULA_PREFIXES.some((p) => v.startsWith(p));
      return csvCell(guarded ? `'${v}` : v);
    }).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

function send(res, status, type, body, extra = {}) {
  const buf = Buffer.from(body, 'utf8');
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

export function createPortalServer(cfg, store, { quiet = false } = {}) {
  const adminToken = randomBytes(32).toString('base64url');
  const portalHosts = new Set([cfg.laptopIp, 'localhost', '127.0.0.1']);
  let portalUrl = `http://${cfg.laptopIp}/`;
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
      if (fields.consent !== 'yes') throw new ValidationError("Please tick the box so we're allowed to message you.");
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      return html(res, 400, formPage(cfg, { error: e.message, name: rawName.slice(0, NAME_MAX), phone: rawPhone.slice(0, 20) }));
    }
    const created = store.upsert({ name, phone, source: 'form', eventCode: cfg.eventCode, noticeVersion: cfg.noticeVersion });
    log(`lead ${created ? 'added' : 'updated'} via form`);
    html(res, 200, thanksPage(cfg, name, phone));
  }

  async function adminPost(req, res, path) {
    const fields = await readForm(req);
    if (!tokenMatches(fields.token, adminToken)) return plain(res, 403, 'bad or missing admin token; reload /admin');
    if (path === '/admin/mark-sent') {
      const id = Number(fields.id);
      if (!Number.isSafeInteger(id)) return plain(res, 400, 'bad id');
      store.markSent(id);
      return redirect(res, '/admin', 303);
    }
    if (path === '/admin/add') {
      let name;
      let phone;
      try {
        name = cleanName(fields.name);
        phone = normalizePhone(fields.phone);
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        return html(res, 400, adminPage(cfg, store.list(), adminToken, e.message));
      }
      store.upsert({ name, phone, source: 'whatsapp', eventCode: cfg.eventCode, noticeVersion: cfg.noticeVersion });
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
      if (method === 'GET' && path === '/admin') return html(res, 200, adminPage(cfg, store.list(), adminToken));
      if (method === 'GET' && path === '/admin/export.csv') {
        return send(res, 200, 'text/csv; charset=utf-8', leadsCsv(store.list()),
          { 'Content-Disposition': 'attachment; filename="leads.csv"' });
      }
      if (method === 'POST') return adminPost(req, res, path);
      return plain(res, 404, 'not found');
    }
    if (method === 'POST' && path === '/submit') return submit(req, res);
    if (method === 'GET' && path === '/' && portalHosts.has(hostOf(req))) return html(res, 200, formPage(cfg));
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
  server.on('listening', () => {
    const { port } = server.address();
    portalUrl = `http://${cfg.laptopIp}${port === 80 ? '' : `:${port}`}/`;
  });
  server.portalUrl = () => portalUrl;
  return server;
}
