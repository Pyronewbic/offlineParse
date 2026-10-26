import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { CSV_RETRY_MS, SOURCE_LABELS, leadsCsv, toISTShort } from './files.js';
import { LcqError, splitsFor } from './lcq.js';
import { BRACKETS, NAME_MAX, ValidationError, cleanName, normalizePhone } from './leads.js';
import { themeCss } from './theme.js';

export const MAX_BODY = 8 * 1024;
const MAX_FIELDS = 20;
export const WHATSAPP_NOTICE = 'none (WhatsApp message)';
const TOO_MANY = 'Too many sign-ups from this phone just now. Please wait a minute and try again.';
const alreadyRegistered = (bracket) =>
  `This number is already registered for ${BRACKETS[bracket]}. Reach out to us at the desk if you need to change your details.`;
const TABS = ['all', ...Object.keys(BRACKETS)];
const tabOf = (value) => (TABS.includes(value) ? value : 'all');
const adminUrl = (tab, msg = '') =>
  `/admin${[tab !== 'all' && `tab=${tab}`, msg && `msg=${msg}`].filter(Boolean).map((x, i) => `${i ? '&' : '?'}${x}`).join('')}`;
export const BRAND_PATHS = { '/brand/logo-light.png': 'light', '/brand/logo-dark.png': 'dark' };
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Names the admin desk answers to. A loopback socket alone is not enough: a page the operator opens
// could rebind its own name to 127.0.0.1 (DNS rebinding) and read the desk as same-origin.
const ADMIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
// The LCQ runner page alone runs a script: its own, which reloads the page when something changes.
const RUNNER_CSP = CSP.replace("default-src 'none';", "default-src 'none'; script-src 'self'; connect-src 'self';");
const RUNNER_JS = `(() => {
  // Folded sections are remembered per tablet; storage can throw (private mode), so it is best effort.
  const KEY = 'lcq-open';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
  const apply = () => {
    const s = load();
    for (const d of document.querySelectorAll('details[id]')) if (d.id in s) d.open = s[d.id];
  };
  document.addEventListener('toggle', (e) => {
    if (e.target.id) save({ ...load(), [e.target.id]: e.target.open });
  }, true);
  // Each button press reloads the page; come back to the same place instead of the top.
  addEventListener('submit', () => { try { sessionStorage.setItem('lcq-y', String(scrollY)); } catch {} });
  try {
    const y = sessionStorage.getItem('lcq-y');
    sessionStorage.removeItem('lcq-y');
    if (y !== null) addEventListener('load', () => scrollTo(0, Number(y)));
  } catch {}
  let touching = false;
  addEventListener('touchstart', () => { touching = true; }, { passive: true });
  addEventListener('touchend', () => setTimeout(() => { touching = false; }, 400), { passive: true });
  const busy = () => touching || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName);
  let version = document.getElementById('version').dataset.version;
  apply();
  // Swap in the new page body when something changed, so the scroll position and folds stay put.
  setInterval(async () => {
    try {
      const r = await fetch('/lcq/version', { cache: 'no-store' });
      if (!r.ok || (await r.json()).v === version || busy()) return;
      const page = await fetch('/lcq', { cache: 'no-store' });
      const next = new DOMParser().parseFromString(await page.text(), 'text/html').querySelector('main');
      if (!page.ok || !next || !next.querySelector('#version') || busy()) return;
      next.querySelectorAll('script').forEach((s) => s.remove());
      document.querySelector('main').replaceWith(next);
      version = document.getElementById('version').dataset.version;
      apply();
    } catch {}
  }, 3000);
})();
`;
const SESSION_COOKIE = /(?:^|;\s*)lcq=([A-Za-z0-9_-]{43})(?:;|$)/;

const HEAVY = 'Impact,Haettenschweiler,"Arial Narrow Bold",system-ui,sans-serif';
const CSS = `${themeCss()}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:500 17px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:28rem;margin:0 auto;padding:14px 16px 40px}
main.admin{max-width:72rem;padding:16px 20px 48px}
html{scroll-padding-top:64px}
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
button.danger{color:var(--onDanger);background:var(--danger)}
.error{border:3px solid var(--error);background:var(--errorBg);color:var(--text);border-radius:10px;padding:.75rem;font-weight:600}
.confetti{position:absolute;pointer-events:none;overflow:visible}
.confetti path{fill:var(--pink);stroke:var(--line);stroke-width:2.5;stroke-linejoin:round}
.confetti.tr{top:-24px;right:-8px;width:58px}
.confetti.bl{bottom:-20px;left:-12px;width:38px}
form.inline{display:inline}
.plain{list-style:none;margin:.4rem 0 0;padding:0}
.plain > li{padding:.6rem 0;border-bottom:2px solid var(--line)}
.plain > li:last-child{border-bottom:0}
.plain h3{margin:0 0 .2rem;font-size:1rem}
.plain form.inline button{min-height:48px;margin:.25rem .5rem 0 0;padding:.5rem .9rem;box-shadow:none}
details.panel{margin:0 0 16px}
details.panel > summary{display:list-item;min-height:48px;padding:.4rem 0;cursor:pointer}
details.panel > summary h2{display:inline}
#lcq-older > summary,.plain details > summary{min-height:48px;padding:.6rem 0;cursor:pointer;font-weight:700}
.plain details > summary h3{display:inline}
.duo{display:grid;gap:0 16px}
@media (min-width: 1000px){.duo{grid-template-columns:1fr 1fr}}
.match{margin:0;overflow-wrap:anywhere}
.won{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:.6rem}
.won form.inline{display:block}
.won form.inline button{width:100%;min-height:56px;margin:0;font-size:1.05rem;overflow-wrap:anywhere}
@media (orientation: portrait){.won{grid-template-columns:1fr}}
.names{list-style:none;margin:.2rem 0 .4rem;padding:0;columns:2 14rem;column-gap:16px}
.names li{padding:.2rem 0;break-inside:avoid;overflow-wrap:anywhere}
.topbar{display:flex;align-items:center;gap:14px 18px;flex-wrap:wrap;padding:0 0 14px;margin:0 0 18px;border-bottom:3px solid var(--line)}
.topbar img{display:block;height:58px;width:auto}
.topbar .wordmark{margin:0;font-size:1.4rem}
.topbar h1{margin:0;font:900 1.6rem/1 ${HEAVY};text-transform:uppercase;letter-spacing:.02em}
.topbar .actions{margin-left:auto;display:flex;gap:14px;align-items:center}
.btn.secondary,button.secondary{color:var(--text);background:var(--surface);box-shadow:none}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 18px}
.stat{border:3px solid var(--line);border-radius:12px;background:var(--surface);padding:10px 14px}
.stat dt{font:900 .8rem/1.2 ${HEAVY};text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.stat dd{margin:4px 0 0;font-size:clamp(1.15rem,2.2vw,1.55rem);font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}
.flash{margin:0 0 16px;padding:.7rem .9rem;border:3px solid var(--line);border-left:12px solid var(--pink);border-radius:10px;background:var(--surface);font-weight:700}
.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin:0 0 22px}
.panel{border:3px solid var(--line);border-radius:14px;background:var(--surface);padding:14px 18px 18px}
.panel h2{margin:0 0 .2rem;font:900 1.1rem/1.2 ${HEAVY};text-transform:uppercase;letter-spacing:.03em}
.panel .fields{display:flex;gap:10px 12px;align-items:flex-end;flex-wrap:wrap}
.panel .fields > div{flex:1 1 170px}
.panel label{margin:.6rem 0 .3rem}
.panel input[type=text],.panel input[type=tel],.panel input[type=search],.panel select{min-height:46px;font-size:16px}
.panel input[type=search],.panel select{width:100%;padding:.6rem .85rem;font-family:inherit;color:var(--text);background:var(--surface);border:3px solid var(--line);border-radius:10px;-webkit-appearance:none;appearance:none}
.panel button,.panel .btn{min-height:46px}
.panel select{-webkit-appearance:auto;appearance:auto}
.showing{margin:0 0 8px;color:var(--muted);font-weight:600}
table.reg{width:100%;border-collapse:separate;border-spacing:0;font-size:15px;background:var(--surface);border:3px solid var(--line);border-radius:14px}
.reg th,.reg td{padding:10px 14px;text-align:left;vertical-align:middle;border-bottom:1px solid var(--rule)}
.reg thead th{position:sticky;top:0;z-index:1;background:var(--surface);border-bottom:3px solid var(--line);font:800 .78rem/1.2 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.reg thead th:first-child{border-top-left-radius:11px}
.reg thead th:last-child{border-top-right-radius:11px}
.reg tbody th{font-weight:700}
.reg tbody tr:hover{background:var(--hover)}
.reg tbody tr:last-child > *{border-bottom:0}
.reg .num{font-variant-numeric:tabular-nums;white-space:nowrap}
.reg .idx{color:var(--muted);width:3.5rem}
.reg .act{width:1%;text-align:right}
.chip{display:inline-block;padding:2px 10px;border:2px solid var(--line);border-radius:999px;font-size:.8rem;font-weight:700;white-space:nowrap}
.chip.whatsapp{background:var(--pink);color:var(--onPink)}
.toggle{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 16px;font-weight:800}
.toggle button{padding:.5rem 1rem;box-shadow:none}
.toggle button[aria-pressed=false]{color:var(--text);background:var(--surface)}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
.tabs a{padding:.4rem .9rem;border:3px solid var(--line);border-radius:999px;font-weight:800;text-decoration:none;background:var(--surface)}
.tabs a[aria-current=page]{background:var(--pink);color:var(--onPink)}
button.quiet{min-height:40px;padding:.4rem .8rem;font-size:.85rem;color:var(--error);background:transparent;border:2px solid var(--error);box-shadow:none}
.empty{padding:28px 14px;text-align:center;color:var(--muted)}
.confirm{max-width:36rem}
.confirm .buttons{display:flex;gap:14px;flex-wrap:wrap;margin-top:1.2rem}
@media (prefers-reduced-motion: reduce){button:active,.btn:active{transform:none}}
`;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
export const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
// Network-supplied text bound for the operator's terminal: printable ASCII only, and short.
export const printable = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
const firstName = (name) => name.split(' ')[0];
export const displayPhone = (phone) => phone.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2');

function page(title, body, mainClass = '') {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${esc(title)}</title><style>${CSS}</style></head>` +
    `<body><main${mainClass ? ` class="${mainClass}"` : ''}>${body}</main></body></html>`;
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

export function formPage(cfg, { error = '', field = null, name = '', phone = '', consent = false, bracket = 'normal' } = {}, brand = NO_BRAND) {
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
<p class="lede">Registering for <strong>${esc(BRACKETS[bracket])}</strong></p>
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

export function thanksPage(cfg, name, phone, brand = NO_BRAND, bracket = 'normal') {
  return portalPage(cfg, brand, "You're registered", `
<h1>You're registered, ${esc(firstName(name))}!</h1>
<p class="lede">We've got you down for <strong>${esc(BRACKETS[bracket])}</strong> as <strong>${esc(name)}</strong> on <strong class="nowrap">${esc(displayPhone(phone))}</strong>.</p>
<p>You can leave this Wi-Fi now.</p>
<p><strong>iPhone:</strong> tap <strong>Cancel</strong> at the top of this screen. To stop it joining again, go to Settings, Wi-Fi, tap (i) next to this network, then <strong>Forget This Network</strong>.</p>
<p><strong>Android:</strong> in Wi-Fi settings, tap this network, then <strong>Forget</strong>.</p>`, `
<p class="notice">Changed your mind? Reach out to us at the desk and we'll delete your details.</p>`);
}

const FLASH = {
  added: 'Registration added.',
  deleted: 'Registration deleted from the database, the spreadsheet and the log.',
  'deleted-partial': 'Registration deleted from the database. The spreadsheet or the log still has it (see the warning above); ' +
    `that is retried every ${CSV_RETRY_MS / 1000} seconds.`,
};

const hidden = (token, id, tab = 'all') =>
  `<input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="id" value="${esc(id)}">` +
  `<input type="hidden" name="tab" value="${esc(tab)}">`;

const phoneDigits = (phone) => phone.replace(/\D/g, '');

/** Case-insensitive name match, or 3+ digits found anywhere in the stored +91 number (a leading 0 is dropped). */
export function matchesSearch(lead, q) {
  const query = q.trim().toLocaleLowerCase();
  if (!query) return true;
  if (lead.name.toLocaleLowerCase().includes(query)) return true;
  let digits = query.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits.length >= 3 && phoneDigits(lead.phone).includes(digits);
}

function adminHeader(cfg, brand, title, actions = '') {
  return `<header class="topbar">${logoMarkup(cfg, brand)}<h1>${esc(title)}</h1>` +
    (actions ? `<div class="actions">${actions}</div>` : '') + '</header>';
}

export function adminPage(cfg, {
  leads: all, token, brand = NO_BRAND, q = '', msg = '', error = '', warnings = [], form = {}, tab = 'all', active = 'normal', runner = null,
}) {
  const leads = tab === 'all' ? all : all.filter((l) => l.bracket === tab);
  const newestFirst = [...leads].reverse();
  const shown = newestFirst.filter((lead) => matchesSearch(lead, q));
  const bySource = (source) => leads.filter((l) => l.source === source).length;
  const last = newestFirst[0];
  const rows = shown.map((lead) => {
    const n = leads.length - newestFirst.indexOf(lead);
    return `<tr><td class="num idx">${n}</td><th scope="row">${esc(lead.name)}</th>` +
      `<td><span class="chip">${esc(BRACKETS[lead.bracket] ?? lead.bracket)}</span></td>` +
      `<td class="num">${esc(displayPhone(lead.phone))}</td>` +
      `<td><span class="chip ${lead.source === 'whatsapp' ? 'whatsapp' : 'form'}">${esc(SOURCE_LABELS[lead.source] ?? lead.source)}</span></td>` +
      `<td class="num">${esc(toISTShort(lead.createdAt))}</td>` +
      `<td class="act"><form class="inline" method="post" action="/admin/delete">${hidden(token, lead.id, tab)}` +
      `<button class="quiet" aria-label="Delete ${esc(lead.name)}">Delete</button></form></td></tr>`;
  });
  const empty = leads.length === 0
    ? 'No registrations yet. They will appear here as people sign up.'
    : `No matches for "${esc(q.trim())}".`;
  const showing = q.trim()
    ? `${shown.length} ${shown.length === 1 ? 'match' : 'matches'} for "${esc(q.trim())}" out of ${leads.length}. <a href="${adminUrl(tab)}">Clear search</a>`
    : `Showing all ${leads.length}, newest first.`;
  const label = (b) => esc(BRACKETS[b]);
  const flash = msg === 'bracket' ? `New sign-ups now go to ${label(active)}.` : Object.hasOwn(FLASH, msg) ? FLASH[msg] : '';
  const exportUrl = `/admin/export.csv${tab === 'all' ? '' : `?tab=${tab}`}`;
  const tabs = TABS.map((t) => {
    const count = t === 'all' ? all.length : all.filter((l) => l.bracket === t).length;
    return `<a href="${adminUrl(t)}"${t === tab ? ' aria-current="page"' : ''}>${t === 'all' ? 'All' : label(t)} (${count})</a>`;
  }).join('');
  const toggle = Object.keys(BRACKETS).map((b) =>
    `<button type="submit" name="bracket" value="${b}" aria-pressed="${b === active}">${label(b)}</button>`).join('');
  const addTo = form.bracket ?? (tab === 'all' ? active : tab);
  return page('Registrations', `
${adminHeader(cfg, brand, 'Registrations',
    `<a href="${adminUrl(tab)}">Refresh</a><a class="btn secondary" href="${exportUrl}">Download CSV</a>`)}
${warnings.map((w) => `<p class="error" role="alert">${esc(w)}</p>`).join('')}
${flash ? `<p class="flash" role="status">${flash}</p>` : ''}
<form method="post" action="/admin/bracket" class="toggle">
  <input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="tab" value="${esc(tab)}">
  <span>New sign-ups go to</span>${toggle}
</form>
<nav class="tabs" aria-label="Brackets">${tabs}</nav>
${runner ? `<p class="hint">LCQ runner for a tablet on the booth Wi-Fi: <strong>${esc(runner.url)}</strong>, PIN <strong>${esc(runner.pin)}</strong></p>` : ''}
<dl class="stats">
  <div class="stat"><dt>Total</dt><dd>${leads.length}</dd></div>
  <div class="stat"><dt>Wi-Fi form</dt><dd>${bySource('form')}</dd></div>
  <div class="stat"><dt>WhatsApp</dt><dd>${bySource('whatsapp')}</dd></div>
  <div class="stat"><dt>Last sign-up</dt><dd>${last ? esc(toISTShort(last.createdAt)) : '-'}</dd></div>
</dl>
<div class="panels">
  <section class="panel" aria-labelledby="add-title">
    <h2 id="add-title">Add a registration</h2>
    <p class="hint">For people who registered by WhatsApp message.</p>
    ${errorBlock(error)}
    <form method="post" action="/admin/add" class="fields">
      <input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="tab" value="${esc(tab)}">
      <div><label for="add-bracket">Bracket</label><select id="add-bracket" name="bracket">${Object.keys(BRACKETS).map((b) =>
    `<option value="${b}"${b === addTo ? ' selected' : ''}>${label(b)}</option>`).join('')}</select></div>
      <div><label for="name">Name</label><input id="name" name="name" type="text" maxlength="${NAME_MAX}" required value="${esc(form.name ?? '')}"></div>
      <div><label for="phone">Mobile number</label><input id="phone" name="phone" type="tel" maxlength="20" required value="${esc(form.phone ?? '')}"></div>
      <button type="submit">Add registration</button>
    </form>
  </section>
  <section class="panel" aria-labelledby="find-title">
    <h2 id="find-title">Find someone</h2>
    <p class="hint">Search by name or any part of the number.</p>
    <form method="get" action="/admin" class="fields" role="search">
      ${tab === 'all' ? '' : `<input type="hidden" name="tab" value="${esc(tab)}">`}
      <div><label for="q">Name or number</label><input id="q" name="q" type="search" maxlength="60" value="${esc(q)}"></div>
      <button class="secondary" type="submit">Search</button>
    </form>
  </section>
</div>
<p class="showing">${showing}</p>
<table class="reg">
<caption class="sr-only">Registrations, newest first</caption>
<thead><tr><th scope="col">#</th><th scope="col">Name</th><th scope="col">Bracket</th><th scope="col">Mobile</th><th scope="col">Came in via</th><th scope="col">Signed up (IST)</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
<tbody>${rows.join('') || `<tr><td colspan="7" class="empty">${empty}</td></tr>`}</tbody>
</table>`, 'admin');
}

export function confirmDeletePage(cfg, lead, token, brand = NO_BRAND, tab = 'all') {
  return page('Delete registration', `
${adminHeader(cfg, brand, 'Delete registration')}
<section class="panel confirm">
<h2>Delete this registration?</h2>
<p><strong>${esc(lead.name)}</strong>, <span class="nowrap">${esc(displayPhone(lead.phone))}</span>, ${esc(BRACKETS[lead.bracket] ?? lead.bracket)}, signed up ${esc(toISTShort(lead.createdAt))} IST.</p>
<p>This removes them from the database, the spreadsheet and the log. It cannot be undone. Spreadsheets you
already downloaded or copied, and backups of this laptop, are not changed.</p>
<form method="post" action="/admin/delete">${hidden(token, lead.id, tab)}<input type="hidden" name="confirm" value="yes">
<div class="buttons"><a class="btn secondary" href="${adminUrl(tab)}" autofocus>Cancel</a>
<button class="danger" type="submit">Delete registration</button></div></form>
</section>`, 'admin');
}

export function pinPage(cfg, brand = NO_BRAND, error = '') {
  return page('LCQ runner', `
${adminHeader(cfg, brand, 'LCQ runner')}
<section class="panel confirm">
<h2>Enter the PIN</h2>
<p class="hint">It is on the booth laptop's admin page and in its terminal.</p>
${errorBlock(error)}
<form method="post" action="/lcq/login" class="fields">
  <div><label for="pin">PIN</label><input id="pin" name="pin" type="text" inputmode="numeric" autocomplete="off" maxlength="6" required autofocus></div>
  <button type="submit">Open</button>
</form>
</section>`, 'admin');
}

const fieldsOf = (fields) => Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('');
// `label` is HTML: callers escape what they put in it.
const runnerButton = (action, fields, label, cls = '') =>
  `<form class="inline" method="post" action="/lcq/${action}">${fieldsOf(fields)}<button type="submit"${cls ? ` class="${cls}"` : ''}>${label}</button></form>`;

export function runnerPage(cfg, state, { brand = NO_BRAND, error = '', version = '' } = {}) {
  const { rules, players, groups, proposals, open, decided } = state;
  const record = (p) => `${p.wins}W ${p.losses}L`;
  const none = (text) => `<li class="hint">${text}</li>`;
  // Native folding; the script remembers each section's state by id across updates.
  const section = (id, title, count, body, isOpen) =>
    `<details class="panel" id="${id}"${isOpen ? ' open' : ''}><summary><h2>${title}${count === null ? '' : ` (${count})`}</h2></summary>${body}</details>`;
  const choose = (list, id, name, label) => `<div><label for="${id}">${label}</label><select id="${id}" name="${name}" required>` +
    `<option value="">Choose player</option>${list.map((p) => `<option value="${p.id}">${esc(p.name)} (${record(p)})</option>`).join('')}</select></div>`;

  const fresh = groups.filter((g) => !g.seen);
  const banner = fresh.length
    ? `<div class="flash" role="status">New group${fresh.length > 1 ? 's' : ''}: ${fresh.map((g) =>
      `#${g.id} (${g.seats.map((x) => esc(x.name)).join(', ')})`).join('; ')} ${runnerButton('seen', {}, 'Got it', 'secondary')}</div>`
    : '';

  const toPair = groups.filter((g) => !g.started).map((g) => {
    const radios = splitsFor(g.seats.length).map((split, i) => `<label class="check"><input type="radio" name="split" value="${i}" required>` +
      `<span>${split.map(([x, y]) => `${esc(g.seats[x]?.name ?? '?')} vs ${esc(g.seats[y]?.name ?? '?')}`).join(' and ')}` +
      `${g.seats.length === 3 ? `; ${esc(g.seats[3 - split[0][0] - split[0][1]].name)} sits out` : ''}</span></label>`).join('');
    // A paired group folds to one line; it can still be changed until a result is in. No id: not remembered.
    return `<li><details${g.paired ? '' : ' open'}><summary><h3>Group ${g.id}${g.paired ? ': paired, tap to change' : ''}</h3></summary>` +
      `<form method="post" action="/lcq/pair">${fieldsOf({ group: g.id })}${radios}<button class="secondary" type="submit">Set pairing</button></form>` +
      `${runnerButton('randomize', { group: g.id }, 'Randomize', 'secondary')}</details></li>`;
  });
  const unpaired = groups.filter((g) => !g.paired).length;

  const playing = open.map((m) => `<li><p class="match"><strong>${esc(m.aName)}</strong> vs <strong>${esc(m.bName)}</strong>` +
    `${m.groupId ? ` <span class="chip">Group ${m.groupId}</span>` : ''}</p><div class="won">` +
    `${runnerButton('result', { match: m.id, winner: m.a }, `${esc(m.aName)} won`)}` +
    `${runnerButton('result', { match: m.id, winner: m.b }, `${esc(m.bName)} won`)}</div></li>`).join('') || none('No matches in progress.');

  const free = players.filter((p) => p.status === 'free');
  const ready = proposals.map((p) => `<li>${esc(p.a.name)} vs ${esc(p.b.name)} <span class="chip">${p.wins}W</span> ` +
    `${runnerButton('start', { a: p.a.id, b: p.b.id }, 'Start', 'secondary')}</li>`).join('') || none('Nobody to pair yet.');
  const manual = free.length < 2 ? '' : `<form method="post" action="/lcq/start" class="fields">
  ${choose(free, 'pa', 'a', 'Player')}${choose(free, 'pb', 'b', 'Against')}
  <button class="secondary" type="submit">Start match</button></form>`;

  const resultRow = (m) => {
    const [winner, loser] = m.winner === m.a ? [m.aName, m.bName] : [m.bName, m.aName];
    return `<li>${esc(winner)} beat ${esc(loser)} ${runnerButton('undo', { match: m.id }, 'Undo', 'quiet')}</li>`;
  };
  const older = decided.slice(5);
  const results = `<ul class="plain">${decided.slice(0, 5).map(resultRow).join('') || none('No results yet.')}</ul>` +
    (older.length ? `<details id="lcq-older"><summary>Older results (${older.length})</summary><ul class="plain">${older.map(resultRow).join('')}</ul></details>` : '');

  const nameRows = (list) => `<ul class="names">${list.map((p) =>
    `<li>${esc(p.name)} <span class="hint">${record(p)}${p.status === 'playing' ? ', playing' : ''}</span></li>`).join('')}</ul>`;
  const bucket = (title, list, extra = '') => (list.length ? `<li><h3>${title} (${list.length})</h3>${nameRows(list)}${extra}</li>` : '');
  const active = players.filter((p) => ['grouped', 'playing', 'free'].includes(p.status));
  const queued = players.filter((p) => p.status === 'queued');
  const closeGroup = queued.length >= 2 ? runnerButton('close', {}, `Make a group of these ${queued.length}`, 'secondary') : '';
  const standings = bucket(`Qualified, ${rules.winsToQualify}W`, players.filter((p) => p.status === 'qualified')) +
    [...new Set(active.map((p) => p.wins))].sort((x, y) => y - x).map((w) => bucket(`${w}W`, active.filter((p) => p.wins === w))).join('') +
    bucket(`Out, ${rules.lossesOut}L`, players.filter((p) => p.status === 'out')) +
    bucket('Dropped', players.filter((p) => p.status === 'dropped')) +
    bucket(`Waiting for a group, ${queued.length}/4`, queued, closeGroup) || none('No LCQ registrations yet.');
  const droppable = players.filter((p) => ['free', 'playing'].includes(p.status));
  const dropForm = droppable.length ? `<p class="hint">Their match, if any, goes to the opponent.</p>
<form method="post" action="/lcq/drop" class="fields">${choose(droppable, 'drop', 'player', 'Player')}
  <button class="secondary" type="submit">Drop</button></form>` : '<p class="hint">Nobody to drop.</p>';

  return page('LCQ runner', `<div id="version" data-version="${esc(version)}" hidden></div>
${adminHeader(cfg, brand, 'LCQ runner', `<span>Qualify at ${rules.winsToQualify} wins, out at ${rules.lossesOut} losses</span>`)}
${errorBlock(error)}${banner}
${toPair.length ? section('lcq-pair', 'Groups to pair', unpaired, `<ul class="plain">${toPair.join('')}</ul>`, true) : ''}
<div class="duo">
${section('lcq-playing', 'Playing', open.length, `<ul class="plain">${playing}</ul>`, true)}
${section('lcq-ready', 'Ready to play', proposals.length, `<ul class="plain">${ready}</ul>${manual}`, true)}
</div>
${section('lcq-results', 'Results', decided.length, results, true)}
${section('lcq-standings', 'Standings', players.length, `<p class="hint">Group matches count toward wins and losses.</p><ul class="plain">${standings}</ul>`, false)}
${section('lcq-drop', 'Drop a no-show', null, dropForm, false)}
<script src="/lcq/app.js"></script>`, 'admin');
}

const warningsOf = (store) => store.files?.warnings() ?? [];

function send(res, status, type, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': res.getHeader('Referrer-Policy') ?? 'no-referrer',
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

/**
 * A browser POST from the admin page itself: no cross-site fetch metadata, and an Origin (if sent) equal
 * to the Host. "null" passes only with Sec-Fetch-Site same-origin, which pages cannot forge.
 */
function sameOriginPost(req) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === 'null') return site === 'same-origin';
  return origin === undefined || origin.toLowerCase() === `http://${String(req.headers.host).toLowerCase()}`;
}

function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createPortalServer(cfg, store, {
  laptopIp, quiet = false, brand = { light: null, dark: null }, onRequest = null, idleTimeoutMs = 20_000, maxConnectionsPerAddress = 32,
  submitLimit = { max: 10, windowMs: 60_000 }, clock = () => Date.now(), lcq = null,
}) {
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
  const warn = quiet ? () => {} : (...args) => console.error(new Date().toISOString(), ...args);

  // Attempts per guest address in the current window, so one device cannot flood the list or guess the PIN.
  function limiter({ max, windowMs }, what) {
    const attempts = new Map();
    return (addr) => {
      const t = clock();
      const recent = (attempts.get(addr) ?? []).filter((at) => t - at < windowMs);
      recent.push(t);
      attempts.set(addr, recent);
      if (recent.length === max + 1) warn(`WARNING ${printable(addr)} sent more than ${max} ${what} in a minute; further ones are refused for now`);
      return recent.length > max;
    };
  }
  const overLimit = limiter(submitLimit, 'sign-ups');
  const pinOverLimit = limiter({ max: 5, windowMs: 60_000 }, 'LCQ PIN tries');
  const runnerInfo = () => (lcq ? { url: `${portalUrl}lcq`, pin: lcq.pin() } : null);

  // Signed-in tablets. Kept in memory: after a restart the tablet enters the PIN again.
  const sessions = new Set();
  const flashes = new Map();
  const sessionOf = (req) => {
    const token = SESSION_COOKIE.exec(req.headers.cookie ?? '')?.[1];
    return token && sessions.has(token) ? token : null;
  };

  async function runner(req, res, path, method) {
    if (!lcq || !portalHosts.has(hostOf(req))) return plain(res, 404, 'not found');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (method === 'GET' && path === '/lcq/app.js') return send(res, 200, 'text/javascript; charset=utf-8', RUNNER_JS);
    const session = sessionOf(req);
    if (method === 'POST') {
      if (!sameOriginPost(req)) return plain(res, 403, 'cross-site request refused', { Connection: 'close' });
      const fields = await readForm(req);
      if (path === '/lcq/login') {
        if (pinOverLimit(req.socket.remoteAddress)) return html(res, 429, pinPage(cfg, brand, 'Too many tries. Wait a minute.'));
        if (!tokenMatches(fields.pin, lcq.pin())) return html(res, 401, pinPage(cfg, brand, 'That PIN is not right.'));
        const token = randomBytes(32).toString('base64url');
        sessions.add(token);
        log(`LCQ runner opened from ${printable(req.socket.remoteAddress)}`);
        return send(res, 303, 'text/html; charset=utf-8', '<a href="/lcq">Continue</a>', {
          Location: '/lcq', 'Set-Cookie': `lcq=${token}; Path=/lcq; HttpOnly; SameSite=Strict; Max-Age=86400`,
        });
      }
      if (!session) return redirect(res, '/lcq', 303);
      const n = (key) => Number(fields[key]);
      try {
        if (path === '/lcq/pair') lcq.pairGroup(n('group'), n('split'));
        else if (path === '/lcq/randomize') lcq.randomize(n('group'));
        else if (path === '/lcq/start') lcq.start(n('a'), n('b'));
        else if (path === '/lcq/result') lcq.result(n('match'), n('winner'));
        else if (path === '/lcq/undo') lcq.undo(n('match'));
        else if (path === '/lcq/seen') lcq.markSeen();
        else if (path === '/lcq/close') lcq.closeGroup();
        else if (path === '/lcq/drop') lcq.drop(n('player'));
        else return plain(res, 404, 'not found');
      } catch (e) {
        if (!(e instanceof LcqError)) throw e;
        flashes.set(session, e.message);
      }
      return redirect(res, '/lcq', 303);
    }
    if (method !== 'GET' || (path !== '/lcq' && path !== '/lcq/version')) return plain(res, 404, 'not found');
    if (!session) return path === '/lcq' ? html(res, 200, pinPage(cfg, brand)) : plain(res, 401, 'enter the PIN at /lcq');
    lcq.syncGroups();
    if (path === '/lcq/version') return send(res, 200, 'application/json', JSON.stringify({ v: lcq.version() }));
    const error = flashes.get(session) ?? '';
    flashes.delete(session);
    return send(res, 200, 'text/html; charset=utf-8', runnerPage(cfg, lcq.state(), { brand, error, version: lcq.version() }),
      { 'Content-Security-Policy': RUNNER_CSP });
  }

  async function submit(req, res) {
    const fields = await readForm(req);
    const rawName = fields.name ?? '';
    const rawPhone = fields.phone ?? '';
    // The bracket staff have on now, read once so the stored row and the reply agree.
    const bracket = store.bracket();
    if (overLimit(req.socket.remoteAddress)) {
      return html(res, 429, formPage(cfg, {
        error: TOO_MANY, name: rawName.slice(0, NAME_MAX), phone: rawPhone.slice(0, 20), consent: fields.consent === 'yes', bracket,
      }, brand));
    }
    let name;
    let phone;
    try {
      name = cleanName(rawName);
      phone = normalizePhone(rawPhone);
      if (fields.consent !== 'yes') throw new ValidationError('Please tick the box to register.', 'consent');
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      return html(res, 400, formPage(cfg, {
        error: e.message, field: e.field, name: rawName.slice(0, NAME_MAX), phone: rawPhone.slice(0, 20), consent: fields.consent === 'yes', bracket,
      }, brand));
    }
    const { created } = store.register({ name, phone, source: 'form', eventCode: cfg.eventCode, noticeVersion: cfg.noticeVersion, bracket });
    if (!created) {
      log('duplicate registration refused');
      return html(res, 409, formPage(cfg, {
        error: alreadyRegistered(bracket), field: 'phone', name: rawName.slice(0, NAME_MAX), phone: rawPhone.slice(0, 20), consent: true, bracket,
      }, brand));
    }
    log(`registration added via form (${BRACKETS[bracket]})`);
    html(res, 200, thanksPage(cfg, name, phone, brand, bracket));
  }

  async function adminPost(req, res, path) {
    const fields = await readForm(req);
    if (!tokenMatches(fields.token, adminToken)) return plain(res, 403, 'bad or missing admin token; reload /admin');
    const tab = tabOf(fields.tab);
    const adminReply = (status, extra) => html(res, status, adminPage(cfg, {
      leads: store.list(), token: adminToken, brand, warnings: warningsOf(store), tab, active: store.bracket(), runner: runnerInfo(), ...extra,
    }));
    if (path === '/admin/bracket') {
      if (!Object.hasOwn(BRACKETS, fields.bracket)) return plain(res, 400, 'unknown bracket');
      store.setBracket(fields.bracket);
      log(`new sign-ups now go to ${BRACKETS[fields.bracket]}`);
      return redirect(res, adminUrl(tab, 'bracket'), 303);
    }
    if (path === '/admin/delete') {
      const id = Number(fields.id);
      const lead = Number.isSafeInteger(id) ? store.get(id) : null;
      if (!lead) return plain(res, 404, 'registration not found; it may already be deleted');
      if (fields.confirm !== 'yes') return html(res, 200, confirmDeletePage(cfg, lead, adminToken, brand, tab));
      store.remove(id);
      const partial = store.files?.stillHolds(lead) ?? false;
      log(partial ? 'registration deleted from the database; files pending' : 'registration deleted');
      return redirect(res, adminUrl(tab, partial ? 'deleted-partial' : 'deleted'), 303);
    }
    if (path === '/admin/add') {
      const bracket = Object.hasOwn(BRACKETS, fields.bracket) ? fields.bracket : store.bracket();
      const form = { name: String(fields.name ?? '').slice(0, NAME_MAX), phone: String(fields.phone ?? '').slice(0, 20), bracket };
      let name;
      let phone;
      try {
        name = cleanName(fields.name);
        phone = normalizePhone(fields.phone);
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        return adminReply(400, { error: e.message, form });
      }
      // They sent the prefilled WhatsApp text and never saw the form's notice, so do not record that one.
      const result = store.register({ name, phone, source: 'whatsapp', eventCode: cfg.eventCode, noticeVersion: WHATSAPP_NOTICE, bracket });
      if (!result.created) {
        return adminReply(409, { error: `${displayPhone(phone)} is already registered for ${BRACKETS[bracket]}, as ${result.existing.name}.`, form });
      }
      return redirect(res, adminUrl(tab, 'added'), 303);
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
      if (!LOOPBACK.has(req.socket.remoteAddress) || !ADMIN_HOSTS.has(hostOf(req))) {
        return plain(res, 404, 'not found', { Connection: 'close' });
      }
      // With no-referrer, browsers send "Origin: null" even on the desk's own form posts.
      res.setHeader('Referrer-Policy', 'same-origin');
      if (method === 'GET' && path === '/admin') {
        const params = new URL(req.url, 'http://x').searchParams;
        return html(res, 200, adminPage(cfg, {
          leads: store.list(), token: adminToken, brand, warnings: warningsOf(store),
          q: (params.get('q') ?? '').slice(0, 60), msg: params.get('msg') ?? '', tab: tabOf(params.get('tab')), active: store.bracket(),
          runner: runnerInfo(),
        }));
      }
      if (method === 'GET' && path === '/admin/export.csv') {
        const tab = tabOf(new URL(req.url, 'http://x').searchParams.get('tab'));
        const leads = store.list().filter((l) => tab === 'all' || l.bracket === tab);
        return send(res, 200, 'text/csv; charset=utf-8', leadsCsv(leads),
          { 'Content-Disposition': `attachment; filename="leads${tab === 'all' ? '' : `-${tab}`}.csv"` });
      }
      if (method === 'POST') {
        if (!sameOriginPost(req)) return plain(res, 403, 'cross-site request refused; use the admin page itself', { Connection: 'close' });
        return adminPost(req, res, path);
      }
      return plain(res, 404, 'not found');
    }
    if (path === '/lcq' || path.startsWith('/lcq/')) return runner(req, res, path, method);
    if (method === 'POST' && path === '/submit') return submit(req, res);
    const logo = method === 'GET' && BRAND_PATHS[path];
    if (logo && brand[logo]) {
      return send(res, 200, 'image/png', brand[logo].bytes, { 'Cache-Control': 'public, max-age=86400' });
    }
    if (method === 'GET' && path === '/' && portalHosts.has(hostOf(req))) return html(res, 200, formPage(cfg, { bracket: store.bracket() }, brand));
    // Every other URL, including the OS captive-portal probes, goes to the form.
    redirect(res, portalUrl, method === 'GET' ? 302 : 303);
  }

  const server = http.createServer((req, res) => {
    if (onRequest) onRequest(req.socket.remoteAddress, req.method, req.headers.host ?? '', req.url);
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return plain(res, e.status, e.message, { Connection: 'close' });
      console.error(e);
      plain(res, 500, 'internal error');
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  // A guest holding many silent sockets must not starve everyone else: idle ones close, and each
  // address gets a bounded share.
  server.timeout = idleTimeoutMs;
  server.maxConnections = 1024;
  const open = new Map();
  server.on('connection', (socket) => {
    const addr = socket.remoteAddress;
    const count = (open.get(addr) ?? 0) + 1;
    if (count > maxConnectionsPerAddress) return socket.destroy();
    open.set(addr, count);
    socket.once('close', () => {
      const left = open.get(addr) - 1;
      if (left > 0) open.set(addr, left);
      else open.delete(addr);
    });
  });
  setLaptopIp(laptopIp);
  server.on('listening', () => setLaptopIp(laptopIp));
  server.portalUrl = () => portalUrl;
  server.setLaptopIp = setLaptopIp;
  return server;
}
