import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { CSV_RETRY_MS, SOURCE_LABELS, leadsCsv, toISTShort } from './files.js';
import { LcqError, bracketGap } from './lcq.js';
import { BRACKETS, EMAIL_MAX, NAME_MAX, ValidationError, cleanEmail, cleanName, normalizePhone } from './leads.js';
import { themeCss } from './theme.js';

export const MAX_BODY = 8 * 1024;
// The desk form with every game ticked (12) and its other fields, with room to spare.
const MAX_FIELDS = 24;
const TOO_MANY = 'Too many sign-ups from this phone just now. Please wait a minute and try again.';
// "A", "A and B", "A, B and C".
const listText = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const inGames = (games) => (games.filter(Boolean).length ? ` in ${listText(games)}` : '');
const alreadyRegistered = (bracket, games) =>
  `This number is already registered for ${BRACKETS[bracket]}${inGames(games)}. Reach out to us at the desk if you need to change your details.`;

/**
 * The games ticked, in config order, or [''] when no games are set up. Throws when none is ticked;
 * null means a game this booth never offered (a tampered form).
 */
function gamesOf(cfg, posted) {
  const ticked = Array.isArray(posted) ? posted : [];
  if (!cfg.games.length) return ticked.length ? null : [''];
  if (ticked.some((g) => !cfg.games.includes(g))) return null;
  const games = cfg.games.filter((g) => ticked.includes(g));
  if (!games.length) throw new ValidationError('Pick at least one game.', 'game');
  return games;
}
const tickedOf = (posted) => (Array.isArray(posted) ? posted : []);
const TABS = ['all', ...Object.keys(BRACKETS)];
const tabOf = (value) => (TABS.includes(value) ? value : 'all');
const query = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  return s ? `?${s}` : '';
};
// What the admin page shows: a bracket tab, an event ('' is the current one), a game ('' is every game),
// and whether to list every row ('1') or only the newest LIST_MAX.
const LIST_MAX = 100;
const adminUrl = ({ tab = 'all', event = '', game = '', all = '' }, msg = '') =>
  `/admin${query({ tab: tab === 'all' ? '' : tab, event, game, all, msg })}`;
// A runner tab's address. With game tabs the game is always named, since '' (no game) is a tab of its own.
// Tabbed runners always name the game, as '' is the No game tab; an earlier event is named too.
const lcqUrl = (game, tabbed, event = '') => {
  const params = new URLSearchParams({ ...(event ? { event } : {}), ...(tabbed ? { game } : {}) }).toString();
  return params ? `/lcq?${params}` : '/lcq';
};
const viewFields = ({ tab = 'all', event = '', game = '', all = '' }) =>
  `<input type="hidden" name="tab" value="${esc(tab)}"><input type="hidden" name="event" value="${esc(event)}">` +
  `<input type="hidden" name="game" value="${esc(game)}"><input type="hidden" name="all" value="${esc(all)}">`;
export const BRAND_PATHS = { '/brand/logo-light.png': 'light', '/brand/logo-dark.png': 'dark' };
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Names the admin desk answers to. A loopback socket alone is not enough: a page the operator opens
// could rebind its own name to 127.0.0.1 (DNS rebinding) and read the desk as same-origin.
const ADMIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
// The LCQ runner page alone runs a script: its own, which reloads the page when something changes.
const RUNNER_CSP = CSP.replace("default-src 'none';", "default-src 'none'; script-src 'self'; connect-src 'self';");
const waitText = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 1 ? 'under 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
/** The Against choices for a Player: free players on the same wins, or anyone but them with Any wins. */
export const againstFor = (options, player, any) =>
  options.filter((o) => o.value !== player.value && (any || !player.value || o.dataset.w === player.dataset.w));
const RUNNER_JS = `(() => {
  // Waiting times count up from the server's figure, so the tablet's own clock does not matter.
  const waitText = ${waitText};
  let loadedAt = Date.now();
  setInterval(() => {
    for (const s of document.querySelectorAll('[data-wait]')) s.textContent = waitText(Number(s.dataset.wait) + Date.now() - loadedAt);
  }, 30000);
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
  // A jump link opens the folded section it points at.
  addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#lcq-"]');
    const d = a && document.querySelector(a.hash);
    if (d && d.tagName === 'DETAILS') d.open = true;
  });
  let touching = false;
  addEventListener('touchstart', () => { touching = true; }, { passive: true });
  addEventListener('touchend', () => setTimeout(() => { touching = false; }, 400), { passive: true });
  // Against lists only the Player's wins unless Any wins is ticked; rebuilt, since iOS ignores hidden options.
  const againstFor = ${againstFor};
  const everyone = new WeakMap();
  let pickedAt = 0;
  addEventListener('change', (e) => {
    const a = document.getElementById('pa');
    const b = document.getElementById('pb');
    const any = document.getElementById('lcq-any');
    if (!a || !b || !any || ![a, any].includes(e.target)) return;
    pickedAt = Date.now();
    if (!everyone.has(b)) everyone.set(b, [...b.options].slice(1));
    const keep = againstFor(everyone.get(b), a.selectedOptions[0], any.checked);
    const was = b.value;
    const blank = b.options[0];
    blank.textContent = keep.length || !a.value ? 'Choose player' : 'Nobody else free on ' + a.selectedOptions[0].dataset.w + 'W; tick Any wins';
    b.replaceChildren(blank, ...keep);
    b.value = keep.some((o) => o.value === was) ? was : '';
  });
  // A half-done pick holds off updates for a minute, so the refresh does not wipe it.
  const picking = () => Date.now() - pickedAt < 60000 && !!(document.getElementById('pa') || {}).value;
  const busy = () => touching || picking() || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName);
  let version = document.getElementById('version').dataset.version;
  apply();
  // Swap in the new page body when something changed, so the scroll position and folds stay put.
  setInterval(async () => {
    try {
      const r = await fetch('/lcq/version' + location.search, { cache: 'no-store' });
      if (!r.ok || (await r.json()).v === version || busy()) return;
      const page = await fetch(location.pathname + location.search, { cache: 'no-store' });
      const next = new DOMParser().parseFromString(await page.text(), 'text/html').querySelector('main');
      if (!page.ok || !next || !next.querySelector('#version') || busy()) return;
      next.querySelectorAll('script').forEach((s) => s.remove());
      document.querySelector('main').replaceWith(next);
      version = document.getElementById('version').dataset.version;
      loadedAt = Date.now();
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
html{scroll-padding-top:84px}
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
input[type=text],input[type=tel],input[type=email]{width:100%;min-height:52px;padding:.7rem .85rem;font-size:17px;font-family:inherit;color:var(--text);background:var(--surface);border:3px solid var(--line);border-radius:10px;-webkit-appearance:none;appearance:none}
input[aria-invalid=true]{border-color:var(--error)}
:focus-visible,input:focus{outline:3px solid var(--focus);outline-offset:2px}
.hint{margin:.35rem 0 0;font-size:.9rem;color:var(--muted)}
.field-error{margin:.45rem 0 0;font-weight:700;color:var(--error)}
.field-error::before{content:"!";display:inline-block;width:1.25em;height:1.25em;margin-right:.4em;border-radius:50%;background:var(--error);color:var(--surface);text-align:center;line-height:1.25em;font-weight:900}
.check{display:flex;gap:.75rem;align-items:flex-start;font-weight:500;margin-top:1.2rem;cursor:pointer}
.check input{flex:none;width:28px;height:28px;margin:0;accent-color:var(--pink)}
.check input:disabled+span{color:var(--muted)}
fieldset.games{border:0;margin:1rem 0 0;padding:0;min-width:0}
fieldset.games legend{font-weight:700;padding:0}
fieldset.games .hint{margin:.1rem 0 0}
fieldset.games .check{margin-top:.8rem}
.panel .fields > fieldset.games{flex:1 1 100%;margin:0}
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
.names details[open]{padding-bottom:.8rem}
.jump{position:sticky;top:0;z-index:2;display:flex;gap:8px;overflow-x:auto;margin:0 -20px 16px;padding:8px 20px;background:var(--bg);border-bottom:2px solid var(--line)}
.jump a{flex:none;display:flex;align-items:center;min-height:48px;padding:0 14px;border:2px solid var(--line);border-radius:999px;background:var(--surface);font-weight:700;text-decoration:none;white-space:nowrap}
.attention{margin:0 0 16px;padding:.6rem .9rem;border:3px solid var(--line);border-left:12px solid var(--error);border-radius:10px;background:var(--errorBg)}
.attention h2{margin:0;font-size:1rem}
.attention ul{list-style:none;margin:0;padding:0}
.attention a{display:block;padding:12px 0;font-weight:700}
.attention form.inline{display:block}
.attention form.inline button{display:block;width:100%;min-height:56px;margin:8px 0 12px}
.side{display:inline-block;min-width:1.6em;margin-right:.35em;padding:0 .3em;border:2px solid currentColor;border-radius:6px;font-weight:900;text-align:center}
#lcq-ready-more > summary,#lcq-pick > summary{min-height:48px;padding:.7rem 0;font-weight:700;cursor:pointer}
.calloff{margin-top:20px;padding-top:12px;border-top:1px dashed var(--rule)}
.ready > li{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap}
.ready > li > span.pair{flex:1 1 12rem}
.ready > li form.inline{margin-left:auto}
.runner .match strong,.runner .ready .pair strong{font-size:1.2rem}
.runner .match .hint,.runner .names .hint,.runner .ready .hint{font-size:1rem}
.runner .names summary{font-size:1.1rem}
.runner .danger-zone{margin-top:24px}
.runner .check input{width:32px;height:32px}
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
.panel .fields > label.check{flex:1 1 100%;margin-top:.4rem}
.panel label{margin:.6rem 0 .3rem}
.panel input[type=text],.panel input[type=tel],.panel input[type=email],.panel input[type=search],.panel select{min-height:46px;font-size:16px}
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
.chip.desk{background:var(--pink);color:var(--onPink)}
.toggle{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 16px;font-weight:800}
.toggle button{padding:.5rem 1rem;box-shadow:none}
.toggle button[aria-pressed=false]{color:var(--text);background:var(--surface)}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
.tabs a{padding:.4rem .9rem;border:3px solid var(--line);border-radius:999px;font-weight:800;text-decoration:none;background:var(--surface)}
.tabs a[aria-current=page]{background:var(--pink);color:var(--onPink)}
.tabs.events{align-items:center}
.tabs.events > span{font-weight:800;margin-right:4px}
.new-event{margin:0 0 16px}
.new-event > summary{min-height:44px;padding:.5rem 0;cursor:pointer;font-weight:800}
.new-event form{max-width:36rem}
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

const FIELDS = ['name', 'phone', 'email', 'game', 'consent'];

/** A checkbox per game; with one game it is ticked already. A game whose LCQ has ended cannot be ticked. */
const gameBoxes = (cfg, ticked, extra = '', ended = []) => cfg.games.map((g) => `<label class="check"><input type="checkbox" name="games" value="${esc(g)}"` +
  `${ended.includes(g) ? ' disabled' : cfg.games.length === 1 || ticked.includes(g) ? ' checked' : ''}${extra}>` +
  `<span>${esc(g)}${ended.includes(g) ? ' (LCQ ended)' : ''}</span></label>`).join('');

export function formPage(cfg, {
  error = '', field = null, name = '', phone = '', email = '', consent = false, bracket = 'normal', games = [], ended = [],
} = {}, brand = NO_BRAND) {
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
${ended.includes('') ? '<p>The LCQ has ended, so it is closed to new sign-ups. Ask at the desk.</p>' : ''}
${inline ? '' : errorBlock(error)}
<form method="post" action="/submit">
  <label for="name">Your name</label>
  <input id="name" name="name" type="text" autocomplete="name" autocapitalize="words" maxlength="${NAME_MAX}" required value="${esc(name)}"${attrs('name')}>
  ${fieldError('name')}
  <label for="phone">Mobile number</label>
  <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="98765 43210" required value="${esc(phone)}"${attrs('phone', 'phone-hint')}>
  <p class="hint" id="phone-hint">10-digit mobile number, or start with + and your country code.</p>
  ${fieldError('phone')}
  <label for="email">Email</label>
  <input id="email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" maxlength="${EMAIL_MAX}" placeholder="name@example.com" required value="${esc(email)}"${attrs('email')}>
  ${fieldError('email')}
  ${cfg.games.length ? `<fieldset class="games"${attrs('game')}><legend>Games</legend><p class="hint">Tick every game you want to play.</p>` +
    `${gameBoxes(cfg, games, '', ended)}</fieldset>${fieldError('game')}` : ''}
  <label class="check"><input type="checkbox" name="consent" value="yes" required${consent ? ' checked' : ''}${attrs('consent')}>
    <span>I agree to ${esc(cfg.orgName)} keeping my name, number and email for this event's registration.</span></label>
  ${fieldError('consent')}
  <button class="primary" type="submit">Register</button>
</form>`, `
<p class="notice">${esc(cfg.orgName)} uses your name, number and email only for this event's registration.
Reach out to us at the desk any time to have your details deleted.</p>`);
}

export function thanksPage(cfg, name, phone, brand = NO_BRAND, bracket = 'normal', games = [], already = [], full = [], email = '') {
  const strong = (list) => listText(list.map((g) => `<strong>${esc(g)}</strong>`));
  const named = full.filter(Boolean);
  return portalPage(cfg, brand, "You're registered", `
<h1>You're registered, ${esc(firstName(name))}!</h1>
<p class="lede">We've got you down for <strong>${esc(BRACKETS[bracket])}</strong>${games.filter(Boolean).length ? ` in ${strong(games)}` : ''} as <strong>${esc(name)}</strong> on <strong class="nowrap">${esc(displayPhone(phone))}</strong>${email ? `, <strong>${esc(email)}</strong>` : ''}.</p>
${already.length ? `<p>You were already registered for ${strong(already)}.</p>` : ''}
${full.length ? `<p>The ${named.length ? `${strong(named)} ` : ''}LCQ bracket${full.length > 1 ? 's are' : ' is'} full; staff may still add you.</p>` : ''}
<p>You can leave this Wi-Fi now.</p>
<p><strong>iPhone:</strong> tap <strong>Cancel</strong> at the top of this screen. To stop it joining again, go to Settings, Wi-Fi, tap (i) next to this network, then <strong>Forget This Network</strong>.</p>
<p><strong>Android:</strong> in Wi-Fi settings, tap this network, then <strong>Forget</strong>.</p>`, `
<p class="notice">Changed your mind? Reach out to us at the desk and we'll delete your details.</p>`);
}

const FLASH = {
  added: 'Registration added.',
  'added-some': 'Added for the games they were not in yet; they were already registered for the others.',
  deleted: 'Registration deleted from the database, the spreadsheet and the log.',
  'deleted-partial': 'Registration deleted from the database. The spreadsheet or the log still has it (see the warning above); ' +
    `that is retried every ${CSV_RETRY_MS / 1000} seconds.`,
};

const hidden = (token, id, view) =>
  `<input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="id" value="${esc(id)}">${viewFields(view)}`;

const phoneDigits = (phone) => phone.replace(/\D/g, '');

/** Case-insensitive name or email match, or 3+ digits found anywhere in the stored +91 number (a leading 0 is dropped). */
export function matchesSearch(lead, q) {
  const query = q.trim().toLocaleLowerCase();
  if (!query) return true;
  if (lead.name.toLocaleLowerCase().includes(query) || (lead.email ?? '').includes(query)) return true;
  let digits = query.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits.length >= 3 && phoneDigits(lead.phone).includes(digits);
}

function adminHeader(cfg, brand, title, actions = '') {
  return `<header class="topbar">${logoMarkup(cfg, brand)}<h1>${esc(title)}</h1>` +
    (actions ? `<div class="actions">${actions}</div>` : '') + '</header>';
}

export function adminPage(cfg, {
  leads: everyone, token, brand = NO_BRAND, q = '', msg = '', error = '', warnings = [], form = {}, view = { tab: 'all', event: '' },
  active = 'normal', runner = null, events, current, eventError = '', eventName = '',
}) {
  const { tab } = view;
  const shownEvent = events.find((e) => e.code === view.event) ?? current;
  const atEvent = everyone.filter((l) => l.eventCode === shownEvent.code);
  const all = view.game ? atEvent.filter((l) => l.game === view.game) : atEvent;
  const gameCol = cfg.games.length > 0 || atEvent.some((l) => l.game);
  const leads = tab === 'all' ? all : all.filter((l) => l.bracket === tab);
  const newestFirst = [...leads].reverse();
  const shown = newestFirst.filter((lead) => matchesSearch(lead, q));
  const bySource = (source) => leads.filter((l) => l.source === source).length;
  const last = newestFirst[0];
  // A long list shows its newest rows; search, tabs and filters reach the rest, or Show all lists everything.
  const capped = !q.trim() && !view.all && shown.length > LIST_MAX;
  const rows = (capped ? shown.slice(0, LIST_MAX) : shown).map((lead) => {
    const n = leads.length - newestFirst.indexOf(lead);
    return `<tr><td class="num idx">${n}</td><th scope="row">${esc(lead.name)}</th>` +
      `<td><span class="chip">${esc(BRACKETS[lead.bracket] ?? lead.bracket)}</span></td>` +
      `${gameCol ? `<td>${lead.game ? esc(lead.game) : '-'}</td>` : ''}` +
      `<td class="num">${esc(displayPhone(lead.phone))}</td><td>${lead.email ? esc(lead.email) : '-'}</td>` +
      `<td><span class="chip ${lead.source === 'desk' ? 'desk' : 'form'}">${esc(SOURCE_LABELS[lead.source] ?? lead.source)}</span></td>` +
      `<td class="num">${esc(toISTShort(lead.createdAt))}</td>` +
      `<td class="act"><form class="inline" method="post" action="/admin/delete">${hidden(token, lead.id, view)}` +
      `<button class="quiet" aria-label="Delete ${esc(lead.name)}">Delete</button></form></td></tr>`;
  });
  const empty = leads.length === 0
    ? 'No registrations yet. They will appear here as people sign up.'
    : `No matches for "${esc(q.trim())}".`;
  const showing = q.trim()
    ? `${shown.length} ${shown.length === 1 ? 'match' : 'matches'} for "${esc(q.trim())}" out of ${leads.length}. <a href="${esc(adminUrl(view))}">Clear search</a>`
    : capped ? `Showing the newest ${LIST_MAX} of ${leads.length}. <a href="${esc(adminUrl({ ...view, all: '1' }))}">Show all ${leads.length}</a>`
    : view.all && leads.length > LIST_MAX
      ? `Showing all ${leads.length}, newest first. <a href="${esc(adminUrl({ ...view, all: '' }))}">Show the newest ${LIST_MAX}</a>`
      : `Showing all ${leads.length}, newest first.`;
  const label = (b) => esc(BRACKETS[b]);
  const flash = msg === 'bracket' ? `New sign-ups now go to ${label(active)}.`
    : msg === 'event' ? `New sign-ups now go to ${esc(current.name)}.` : Object.hasOwn(FLASH, msg) ? FLASH[msg] : '';
  const exportUrl = `/admin/export.csv${query({ tab: tab === 'all' ? '' : tab, event: view.event, game: view.game })}`;
  const tabs = TABS.map((t) => {
    const count = t === 'all' ? all.length : all.filter((l) => l.bracket === t).length;
    return `<a href="${esc(adminUrl({ ...view, tab: t }))}"${t === tab ? ' aria-current="page"' : ''}>${t === 'all' ? 'All' : label(t)} (${count})</a>`;
  }).join('');
  // Game names in this event that are no longer configured still get a filter, so their rows stay reachable.
  const gameNames = [...new Set([...cfg.games, ...atEvent.map((l) => l.game).filter(Boolean)])];
  const gameLinks = gameNames.length ? [['', 'All games', atEvent.length], ...gameNames.map((g) => [g, g, atEvent.filter((l) => l.game === g).length])]
    .map(([g, text, n]) => `<a href="${esc(adminUrl({ ...view, game: g }))}"${g === view.game ? ' aria-current="page"' : ''}>${esc(text)} (${n})</a>`).join('') : '';
  const eventLinks = events.map((e) => `<a href="${esc(adminUrl({ tab, event: e.code === current.code ? '' : e.code }))}"` +
    `${e.code === shownEvent.code ? ' aria-current="page"' : ''}>${esc(e.name)}${e.code === current.code ? ' (now)' : ''}</a>`).join('');
  const past = shownEvent.code !== current.code
    ? `<p class="flash" role="status">You are looking at ${esc(shownEvent.name)}. New sign-ups go to ${esc(current.name)}.</p>` : '';
  const newEvent = `<details class="new-event"${eventError ? ' open' : ''}><summary>Start a new event</summary>
<form method="post" action="/admin/event" class="fields">
  <input type="hidden" name="token" value="${esc(token)}">${viewFields(view)}
  ${errorBlock(eventError)}
  <div><label for="event-name">Event name</label><input id="event-name" name="name" type="text" maxlength="60" required value="${esc(eventName)}"></div>
  <p class="hint">New sign-ups go to it straight away, and the LCQ runner starts fresh. Earlier events stay here to view and download.</p>
  <button type="submit">Start event</button>
</form></details>`;
  const toggle = Object.keys(BRACKETS).map((b) =>
    `<button type="submit" name="bracket" value="${b}" aria-pressed="${b === active}">${label(b)}</button>`).join('');
  const addTo = form.bracket ?? (tab === 'all' ? active : tab);
  return page('Registrations', `
${adminHeader(cfg, brand, 'Registrations',
    `<a href="${esc(adminUrl(view))}">Refresh</a><a class="btn secondary" href="${esc(exportUrl)}">Download CSV</a>`)}
${warnings.map((w) => `<p class="error" role="alert">${esc(w)}</p>`).join('')}
${flash ? `<p class="flash" role="status">${flash}</p>` : ''}
<nav class="tabs events" aria-label="Events"><span>Event</span>${eventLinks}</nav>
${newEvent}
${past}
<form method="post" action="/admin/bracket" class="toggle">
  <input type="hidden" name="token" value="${esc(token)}">${viewFields(view)}
  <span>New sign-ups go to</span>${toggle}
</form>
<nav class="tabs" aria-label="Brackets">${tabs}</nav>
${gameLinks ? `<nav class="tabs" aria-label="Games">${gameLinks}</nav>` : ''}
${runner ? `<p class="hint">LCQ runner for a tablet on the booth Wi-Fi: <strong>${esc(runner.url)}</strong>, PIN <strong>${esc(runner.pin)}</strong></p>` : ''}
<dl class="stats">
  <div class="stat"><dt>Total</dt><dd>${leads.length}</dd></div>
  <div class="stat"><dt>Wi-Fi form</dt><dd>${bySource('form')}</dd></div>
  <div class="stat"><dt>At the desk</dt><dd>${bySource('desk')}</dd></div>
  <div class="stat"><dt>Last sign-up</dt><dd>${last ? esc(toISTShort(last.createdAt)) : '-'}</dd></div>
</dl>
<div class="panels">
  <section class="panel" aria-labelledby="add-title">
    <h2 id="add-title">Add a registration</h2>
    <p class="hint">For on-spot registrations entered by staff.</p>
    ${errorBlock(error)}
    <form method="post" action="/admin/add" class="fields">
      <input type="hidden" name="token" value="${esc(token)}">${viewFields(view)}
      <div><label for="add-bracket">Bracket</label><select id="add-bracket" name="bracket">${Object.keys(BRACKETS).map((b) =>
    `<option value="${b}"${b === addTo ? ' selected' : ''}>${label(b)}</option>`).join('')}</select></div>
      <div><label for="name">Name</label><input id="name" name="name" type="text" maxlength="${NAME_MAX}" required value="${esc(form.name ?? '')}"></div>
      <div><label for="phone">Mobile number</label><input id="phone" name="phone" type="tel" maxlength="20" required value="${esc(form.phone ?? '')}"></div>
      <div><label for="email">Email</label><input id="email" name="email" type="email" maxlength="${EMAIL_MAX}" autocapitalize="off" spellcheck="false" required value="${esc(form.email ?? '')}"></div>
      ${cfg.games.length ? `<fieldset class="games"><legend>Games</legend>${gameBoxes(cfg, form.games ?? (view.game ? [view.game] : []))}</fieldset>` : ''}
      <label class="check"><input type="checkbox" name="consent" value="yes" required${form.consent ? ' checked' : ''}>
        <span>They agreed to ${esc(cfg.orgName)} keeping their name, number and email for this event's registration (read it to them).</span></label>
      <button type="submit">Add registration</button>
    </form>
  </section>
  <section class="panel" aria-labelledby="find-title">
    <h2 id="find-title">Find someone</h2>
    <p class="hint">Search by name, email or any part of the number.</p>
    <form method="get" action="/admin" class="fields" role="search">
      ${tab === 'all' ? '' : `<input type="hidden" name="tab" value="${esc(tab)}">`}${view.event ? `<input type="hidden" name="event" value="${esc(view.event)}">` : ''}${view.game ? `<input type="hidden" name="game" value="${esc(view.game)}">` : ''}
      <div><label for="q">Name, email or number</label><input id="q" name="q" type="search" maxlength="60" value="${esc(q)}"></div>
      <button class="secondary" type="submit">Search</button>
    </form>
  </section>
</div>
<p class="showing">${showing}</p>
<table class="reg">
<caption class="sr-only">Registrations, newest first</caption>
<thead><tr><th scope="col">#</th><th scope="col">Name</th><th scope="col">Bracket</th>${gameCol ? '<th scope="col">Game</th>' : ''}<th scope="col">Mobile</th><th scope="col">Email</th><th scope="col">Came in via</th><th scope="col">Signed up (IST)</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
<tbody>${rows.join('') || `<tr><td colspan="${gameCol ? 9 : 8}" class="empty">${empty}</td></tr>`}</tbody>
</table>`, 'admin');
}

export function confirmDeletePage(cfg, lead, token, brand = NO_BRAND, view = { tab: 'all', event: '' }) {
  return page('Delete registration', `
${adminHeader(cfg, brand, 'Delete registration')}
<section class="panel confirm">
<h2>Delete this registration?</h2>
<p><strong>${esc(lead.name)}</strong>, <span class="nowrap">${esc(displayPhone(lead.phone))}</span>${lead.email ? `, ${esc(lead.email)}` : ''}, ${esc(BRACKETS[lead.bracket] ?? lead.bracket)}${lead.game ? `, ${esc(lead.game)}` : ''}, signed up ${esc(toISTShort(lead.createdAt))} IST.</p>
<p>This removes them from the database, the spreadsheet and the log. It cannot be undone. Spreadsheets you
already downloaded or copied, and backups of this laptop, are not changed.</p>
<form method="post" action="/admin/delete">${hidden(token, lead.id, view)}<input type="hidden" name="confirm" value="yes">
<div class="buttons"><a class="btn secondary" href="${esc(adminUrl(view))}" autofocus>Cancel</a>
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

const gapText = (count) => {
  const { size, more } = bracketGap(count);
  return more ? `need ${more} more for a full bracket of ${size}` : 'a full bracket';
};

/** Players waiting and matches running past the config limits, longest first. */
export function overdue(cfg, { players, open }, now = Date.now()) {
  const since = (iso) => now - Date.parse(iso);
  return {
    waiting: players.filter((p) => p.status === 'free' && p.freeSince && since(p.freeSince) >= cfg.lcqWaitAlertMin * 60_000)
      .sort((x, y) => x.freeSince.localeCompare(y.freeSince)),
    long: open.filter((m) => since(m.createdAt) >= cfg.lcqMatchAlertMin * 60_000),
  };
}
// The tablet reloads when the data changes or someone newly crosses a time limit.
export const runnerVersion = (cfg, lcq, state, now = Date.now()) => {
  const { waiting, long } = overdue(cfg, state, now);
  return `${lcq.version()}-${waiting.length}-${long.length}`;
};

export function runnerPage(cfg, state, {
  brand = NO_BRAND, error = '', notice = '', undo = null, version = '', now = Date.now(), q = '', game = '', tabs = [], events = [], event = null,
} = {}) {
  const { players, proposals, open, decided, finalizedAt, endedAt, late, bye, winners } = state;
  // An earlier event is for viewing; only the current one can be run.
  const current = events.find((e) => e.current);
  const past = !!(event && current && event.code !== current.code);
  const eventParam = past ? event.code : '';
  // An ended or earlier LCQ is read-only: no Start, results, Undo, Drop or Bye.
  const live = !endedAt && !past;
  // Every form says which game it came from, so the tablet comes back to that tab.
  const btn = (action, fields, label, cls) => runnerButton(action, { ...fields, game }, label, cls);
  const gameField = fieldsOf({ game });
  const tabbed = tabs.some((t) => t.game);
  const record = (p) => `${p.wins}W ${p.losses}L`;
  const none = (text) => `<li class="hint">${text}</li>`;
  // Native folding; the script remembers each section's state by id across updates.
  const section = (id, title, count, body, isOpen) =>
    `<details class="panel" id="${id}"${isOpen ? ' open' : ''}><summary><h2>${title}${count === null ? '' : ` (${count})`}</h2></summary>${body}</details>`;
  const choose = (list, id, name, label) => `<div><label for="${id}">${label}</label><select id="${id}" name="${name}" required>` +
    `<option value="">Choose player</option>${list.map((p) => `<option value="${p.id}" data-w="${p.wins}">${esc(p.name)} (${record(p)})</option>`).join('')}</select></div>`;

  const elapsed = (iso) => `<span data-wait="${now - Date.parse(iso)}">${waitText(now - Date.parse(iso))}</span>`;
  const byId = new Map(players.map((p) => [p.id, p]));
  // A and B tell the two players and their winner buttons apart without relying on colour.
  const side = (s) => `<span class="side" aria-hidden="true">${s}</span>`;
  const who = (id, name, s) => `${side(s)}<strong>${esc(name)}</strong>${byId.has(id) ? ` <span class="hint">${record(byId.get(id))}</span>` : ''}`;
  const playing = open.map((m) => `<li><p class="match">${who(m.a, m.aName, 'A')} vs ${who(m.b, m.bName, 'B')} <span class="hint">running ${elapsed(m.createdAt)}</span></p><div class="won">` +
    `${btn('result', { match: m.id, winner: m.a }, `${side('A')}${esc(m.aName)} won`)}` +
    `${btn('result', { match: m.id, winner: m.b }, `${side('B')}${esc(m.bName)} won`)}</div>` +
    `<div class="calloff">${btn('cancel', { match: m.id }, 'Call off', 'quiet')}</div></li>`).join('') || none('No matches in progress.');

  const free = players.filter((p) => p.status === 'free');
  // The pair that has waited longest comes first; the first few are shown, the rest fold away.
  const READY_MAX = 3;
  const since = (p) => [p.a.freeSince, p.b.freeSince].sort()[0];
  const byWait = [...proposals].sort((x, y) => since(x).localeCompare(since(y)));
  const readyRow = (p) => `<li><span class="pair"><strong>${esc(p.a.name)}</strong> vs <strong>${esc(p.b.name)}</strong> ` +
    `<span class="chip">${p.wins}W</span> <span class="hint">waiting ${elapsed(since(p))}</span></span>` +
    `${btn('start', { a: p.a.id, b: p.b.id }, 'Start', 'secondary')}</li>`;
  const readyRest = byWait.slice(READY_MAX);
  const ready = `<ul class="plain ready">${byWait.slice(0, READY_MAX).map(readyRow).join('') || none('Nobody to pair yet.')}</ul>` +
    (readyRest.length ? `<details id="lcq-ready-more"><summary>Show all (${byWait.length})</summary><ul class="plain ready">${readyRest.map(readyRow).join('')}</ul></details>` : '');
  const manual = free.length < 2 ? '' : `<details id="lcq-pick"><summary>Pick a match</summary><form method="post" action="/lcq/start" class="fields">${gameField}
  ${choose(free, 'pa', 'a', 'Player')}${choose(free, 'pb', 'b', 'Against')}
  <label class="check"><input type="checkbox" id="lcq-any"><span>Any wins (Against lists only the Player's wins)</span></label>
  <button class="secondary" type="submit">Start match</button></form></details>`;

  const resultRow = (m) => {
    const [winner, loser] = m.winner === m.a ? [m.aName, m.bName] : [m.bName, m.aName];
    return `<li>${esc(winner)} ${m.a === m.b ? 'had a bye' : `beat ${esc(loser)}`}${live ? ` ${btn('undo', { match: m.id }, 'Undo', 'quiet')}` : ''}</li>`;
  };
  const older = decided.slice(5);
  const results = `<ul class="plain">${decided.slice(0, 5).map(resultRow).join('') || none('No results yet.')}</ul>` +
    (older.length ? `<details id="lcq-older"><summary>Older results (${older.length})</summary><ul class="plain">${older.map(resultRow).join('')}</ul></details>` : '');

  const waited = (p) => (p.status === 'free' && p.freeSince ? `, waiting ${elapsed(p.freeSince)}` : '');
  // A required tick stands in for "are you sure", so a stray tap cannot drop anyone.
  const dropOne = (p) => (live && ['free', 'playing'].includes(p.status) ? `<form method="post" action="/lcq/drop" class="fields">${fieldsOf({ player: p.id, game })}` +
    `<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>${esc(p.name)} is not here` +
    `${p.status === 'playing' ? '; their match goes to the opponent' : ''}</span></label><button class="danger" type="submit">Drop ${esc(p.name)}</button></form>` : '');
  const STATUS = { playing: 'playing', out: 'eliminated', dropped: 'dropped' };
  // Tap a name for the number, to call someone who has wandered off, and to drop them.
  const nameRows = (list, found = false) => `<ul class="names">${list.map((p) => `<li><details${found ? ' open' : ''}><summary>${esc(p.name)} ` +
    `<span class="hint">${record(p)}${(found || p.status === 'playing') && STATUS[p.status] ? `, ${STATUS[p.status]}` : ''}${waited(p)}</span></summary>` +
    `<span class="nowrap">${esc(displayPhone(p.phone))}</span>${dropOne(p)}</details></li>`).join('')}</ul>`;
  // Each bucket folds on its own, by a stable id; only the ones still in play start open.
  const bucket = (key, title, list, isOpen) => (list.length ? `<li><details id="lcq-b-${key}"${isOpen ? ' open' : ''}>` +
    `<summary><h3>${title} (${list.length})</h3></summary>${nameRows(list)}</details></li>` : '');
  const active = players.filter((p) => ['playing', 'free'].includes(p.status));
  const count = (...statuses) => players.filter((p) => statuses.includes(p.status)).length;
  const stats = `<dl class="stats">${[['Matches on', open.length], ['Waiting for a match', count('free')],
    ['Eliminated', count('out')], ['Dropped', count('dropped')]]
    .map(([k, v]) => `<div class="stat"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  const standings = [...new Set(active.map((p) => p.wins))].sort((x, y) => y - x)
      .map((w) => bucket(`w${w}`, `${w}W`, active.filter((p) => p.wins === w), true)).join('') +
    bucket('out', 'Eliminated', players.filter((p) => p.status === 'out'), false) +
    bucket('dropped', 'Dropped', players.filter((p) => p.status === 'dropped'), false) || none('No LCQ registrations yet.');

  // Finalize fixes who plays; a bracket short of a power of 2 needs a tick, as some players will need a Bye.
  const short = bracketGap(players.length).more;
  const stillIn = free.length;
  const winnerText = winners.length ? `${winners.length > 1 ? 'Winners' : 'Winner'}: <strong>${listText(winners.map((p) => esc(p.name)))}</strong> (${winners[0].wins}W)` : 'No winner';
  const bracket = endedAt
    ? `<div class="panel" id="lcq-bracket"><p class="flash" role="status">Ended ${esc(toISTShort(endedAt))}. ${winnerText}.</p>` +
      (past ? '' : `<form method="post" action="/lcq/reopen" class="fields">${gameField}<label class="check"><input type="checkbox" name="confirm" value="yes" required>` +
      '<span>This LCQ ended by mistake</span></label><button class="secondary" type="submit">Reopen</button></form>') + '</div>'
    : finalizedAt
    ? `<div class="panel" id="lcq-bracket"><div class="hint">Finalized ${esc(toISTShort(finalizedAt))}, ${players.length} in the bracket.${past ? '' : ` ${late
      ? `${late} signed up since; Unfinalize to add them (${players.length + late} in, ${gapText(players.length + late)}).`
      : 'Nobody has signed up since.'}`}${past ? '' : ` ${btn('unfinalize', {}, 'LCQ Unfinalize', 'quiet')}`}</div></div>`
    : past ? (players.length ? `<div class="panel" id="lcq-bracket"><p class="hint">${players.length} in the bracket; it was never ended.</p></div>` : '')
    : players.length ? `<div class="panel" id="lcq-bracket"><p class="hint">${players.length} in the bracket: ${gapText(players.length)}.</p>` +
      `<form method="post" action="/lcq/finalize" class="fields">${gameField}${short ? `<label class="check"><input type="checkbox" name="confirm" value="yes" required>` +
      `<span>${players.length} in: ${short} short of ${players.length + short}; some players will need a Bye</span></label>` : ''}` +
      `<button class="secondary" type="submit">LCQ Finalize</button></form></div>`
    : '';

  const { waiting, long } = overdue(cfg, state, now);
  const MAX = 5;
  const more = (list) => (list.length > MAX ? `<li>and ${list.length - MAX} more</li>` : '');
  const flags = !live ? '' : [
    bye ? `<li>${esc(bye.name)} is the only one on ${bye.wins}W, and nobody can catch up.${btn('bye', { player: bye.id }, `Give ${esc(bye.name)} a Bye`)}</li>` : '',
    ...waiting.slice(0, MAX).map((p) => `<li><a href="#lcq-ready">${esc(p.name)} waiting ${elapsed(p.freeSince)}</a></li>`), more(waiting),
    ...long.slice(0, MAX).map((m) => `<li><a href="#lcq-playing">${esc(m.aName)} vs ${esc(m.bName)} running ${elapsed(m.createdAt)}</a></li>`), more(long),
  ].join('');
  const attention = flags ? `<section class="attention" aria-labelledby="lcq-attention"><h2 id="lcq-attention">Needs attention</h2><ul>${flags}</ul></section>` : '';
  // Only the two sections the operator keeps going back to; everything else is a short scroll.
  const jumps = live ? `<nav class="jump" aria-label="Sections"><a href="#lcq-playing">Playing (${open.length})</a>` +
    `<a href="#lcq-ready">Ready (${proposals.length})</a></nav>` : '';
  const wanted = q.trim();
  const found = wanted ? players.filter((p) => matchesSearch(p, wanted)) : [];
  const FOUND_MAX = 20;
  const foundRows = !wanted ? ''
    : !found.length ? `<p class="hint">Nobody matches "${esc(wanted)}".</p>`
    : `<p class="hint">${found.length > FOUND_MAX ? `First ${FOUND_MAX} of ${found.length}; type more of the name.` : `${found.length} found.`}</p>${nameRows(found.slice(0, FOUND_MAX), true)}`;
  const search = `<section class="panel" id="lcq-find" aria-labelledby="lcq-find-title"><h2 id="lcq-find-title" class="sr-only">Find a player</h2>` +
    `<form method="get" action="/lcq" class="fields" role="search">${past ? fieldsOf({ event: event.code }) : ''}${tabbed ? gameField : ''}<div><label for="lcq-q">Find a player, by name or number</label>` +
    `<input id="lcq-q" name="q" type="search" maxlength="60" value="${esc(q)}"></div><button class="secondary" type="submit">Find</button>` +
    `${wanted ? `<a class="btn secondary" href="${esc(lcqUrl(game, tabbed, eventParam))}">Clear</a>` : ''}</form>${foundRows}</section>`;
  const gameTabs = tabbed ? `<nav class="tabs" aria-label="Games">${tabs.map((t) =>
    `<a href="${esc(lcqUrl(t.game, tabbed, eventParam))}"${t.game === game ? ' aria-current="page"' : ''}>${t.game ? esc(t.game) : 'No game'} (${t.players})` +
    `${t.ended ? ', ended' : t.ready ? `, ${t.ready} ready` : ''}</a>`).join('')}</nav>` : '';

  const eventLinks = events.length > 1 ? `<nav class="tabs events" aria-label="Events"><span>Event</span>${events.map((e) =>
    `<a href="${esc(lcqUrl(game, tabbed, e.current ? '' : e.code))}"${e.code === event?.code ? ' aria-current="page"' : ''}>${esc(e.name)}${e.current ? ' (now)' : ''}</a>`).join('')}</nav>` : '';
  const pastNote = past ? `<p class="flash" role="status">You are looking at ${esc(event.name)}. Only ${esc(current.name)} can be run.</p>` : '';

  // End sits apart from Unfinalize, at the bottom, so a stray tap near the top cannot end the LCQ.
  const end = !live || !finalizedAt ? '' : `<section class="panel danger-zone" id="lcq-end" aria-labelledby="lcq-end-title"><h2 id="lcq-end-title">End this LCQ</h2>` +
    (open.length ? '<p class="hint">A match is still on: record its winner or call it off first.</p>'
      : `<p class="hint">${winnerText}. Ending shows the final standings and closes LCQ sign-ups for this game.</p>` +
        `<form method="post" action="/lcq/end" class="fields">${gameField}${stillIn > 1 ? `<label class="check"><input type="checkbox" name="confirm" value="yes" required>` +
        `<span>${stillIn} players still in; they will not play again</span></label>` : ''}<button class="danger" type="submit">LCQ End</button></form>`) +
    '</section>';

  // The last result, with Undo right where the operator is looking, until the next change.
  // A div, not a p: a form inside a p is pushed out of it by the browser.
  const undoLine = live && undo ? `<div class="flash" role="status">${esc(undo.text)} ${btn('undo', { match: undo.id }, 'Undo', 'quiet')}</div>` : '';

  // Feedback, then the bracket's state (Finalize before play, the Winner at the end), then the matches.
  return page('LCQ runner', `<div id="version" data-version="${esc(version)}" hidden></div>
<div class="runner">
${adminHeader(cfg, brand, 'LCQ runner')}
${eventLinks}
${pastNote}
${gameTabs}
${jumps}
${errorBlock(error)}${notice ? `<p class="flash" role="status">${esc(notice)}</p>` : ''}${undoLine}
${bracket}
${attention}
${live ? `<div class="duo">
${section('lcq-playing', 'Playing', open.length, `<ul class="plain">${playing}</ul>`, true)}
${section('lcq-ready', 'Ready to play', proposals.length, `${ready}${manual}`, true)}
</div>` : ''}
${section('lcq-results', 'Results', decided.length, results, true)}
${section('lcq-standings', 'Standings', players.length, `${stats}<p class="hint">Tap a name for their number${live ? ', or to drop a no-show' : ''}.</p><ul class="plain">${standings}</ul>`, !live)}
${search}
${end}
</div>
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
      // Ticking several games sends "games" once per tick; every other field keeps its first value.
      const fields = {};
      for (const [key, value] of params) {
        if (key === 'games') (fields.games ??= []).push(value);
        else if (!(key in fields)) fields[key] = value;
      }
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
  // The runner's game tabs: the configured games, then any other game the event's LCQ players are in.
  const runnerGames = (view = lcq) => [...new Set([...cfg.games, ...view.games()])];
  const gameOf = (value, view = lcq) => {
    const games = runnerGames(view);
    return games.includes(value) ? value : games[0] ?? '';
  };
  // A tab and event from the URL or a form; anything unknown means the default.
  const viewOf = (params) => {
    const { game } = params;
    return {
      tab: tabOf(params.tab),
      event: typeof params.event === 'string' && store.event(params.event) ? params.event : '',
      // Any game a row carries is a valid filter, so a game dropped from the config stays reachable.
      game: typeof game === 'string' && game && (cfg.games.includes(game) || store.list().some((l) => l.game === game)) ? game : '',
      all: params.all === '1' ? '1' : '',
    };
  };
  const adminData = () => ({
    leads: store.list(), token: adminToken, brand, warnings: warningsOf(store), active: store.bracket(), runner: runnerInfo(),
    events: store.events(), current: store.currentEvent(),
  });

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
      const game = gameOf(fields.game);
      const n = (key) => Number(fields[key]);
      try {
        if (path === '/lcq/start') lcq.start(n('a'), n('b'));
        else if (path === '/lcq/result') {
          lcq.result(n('match'), n('winner'));
          const m = lcq.match(n('match'));
          const text = `${lcq.nameOf(m.winner)} beat ${lcq.nameOf(m.winner === m.a ? m.b : m.a)}.`;
          flashes.set(session, { undo: { id: m.id, text } });
        }
        else if (path === '/lcq/undo') {
          const cancelled = lcq.undo(n('match'));
          flashes.set(session, { notice: `Result undone.${cancelled.length ? ` Also called off ${cancelled.join(', ')}, which depended on it.` : ''}` });
        } else if (path === '/lcq/cancel') lcq.cancel(n('match'));
        else if (path === '/lcq/finalize') lcq.finalize(game, fields.confirm === 'yes');
        else if (path === '/lcq/unfinalize') lcq.unfinalize(game);
        else if (path === '/lcq/bye') lcq.bye(n('player'));
        else if (path === '/lcq/end') lcq.end(game, fields.confirm === 'yes');
        else if (path === '/lcq/reopen') lcq.reopen(game, fields.confirm === 'yes');
        else if (path === '/lcq/drop') {
          if (fields.confirm === 'yes') lcq.drop(n('player'));
          else flashes.set(session, { error: 'Tick that they are not here, then tap Drop.' });
        }
        else return plain(res, 404, 'not found');
      } catch (e) {
        if (!(e instanceof LcqError)) throw e;
        flashes.set(session, { error: e.message });
      }
      return redirect(res, lcqUrl(game, runnerGames().some(Boolean)), 303);
    }
    if (method !== 'GET' || (path !== '/lcq' && path !== '/lcq/version')) return plain(res, 404, 'not found');
    if (!session) return path === '/lcq' ? html(res, 200, pinPage(cfg, brand)) : plain(res, 401, 'enter the PIN at /lcq');
    const params = new URL(req.url, 'http://x').searchParams;
    // An earlier event, picked by its code, is shown read-only; anything else is the current event.
    const current = store.currentEvent();
    const shown = store.event(params.get('event') ?? '') ?? current;
    const view = shown.code === current.code ? lcq : lcq.at(shown.code);
    const game = gameOf(params.get('game'), view);
    const state = view.state(game);
    const now = Date.now();
    const version = runnerVersion(cfg, view, state, now);
    if (path === '/lcq/version') return send(res, 200, 'application/json', JSON.stringify({ v: version }));
    const { error = '', notice = '', undo = null } = flashes.get(session) ?? {};
    flashes.delete(session);
    const q = (params.get('q') ?? '').slice(0, 60);
    // An earlier event has nothing to start, so its tabs show no ready count.
    const tabs = runnerGames(view).map((g) => ({
      game: g, players: view.leads(g).length, ready: view === lcq ? view.state(g).proposals.length : 0, ended: !!view.phase(g).endedAt,
    }));
    const events = store.events().map((e) => ({ ...e, current: e.code === current.code }));
    return send(res, 200, 'text/html; charset=utf-8', runnerPage(cfg, state, { brand, error, notice, undo: shown.code === current.code ? undo : null, version, now, q, game, tabs, events, event: shown }),
      { 'Content-Security-Policy': RUNNER_CSP });
  }

  // Games whose LCQ has ended take no new LCQ sign-ups; '' is the no-game LCQ.
  const endedFor = (bracket) => (bracket === 'lcq' && lcq ? (cfg.games.length ? cfg.games : ['']).filter((g) => lcq.phase(g).endedAt) : []);

  async function submit(req, res) {
    const fields = await readForm(req);
    const rawName = typeof fields.name === 'string' ? fields.name : '';
    const rawPhone = typeof fields.phone === 'string' ? fields.phone : '';
    const rawEmail = typeof fields.email === 'string' ? fields.email : '';
    // The bracket staff have on now, read once so the stored row and the reply agree.
    const bracket = store.bracket();
    const ended = endedFor(bracket);
    const again = { name: rawName.slice(0, NAME_MAX), phone: rawPhone.slice(0, 20), email: rawEmail.slice(0, EMAIL_MAX), consent: fields.consent === 'yes', bracket, games: tickedOf(fields.games), ended };
    if (overLimit(req.socket.remoteAddress)) return html(res, 429, formPage(cfg, { ...again, error: TOO_MANY }, brand));
    let name;
    let phone;
    let email;
    let games;
    try {
      name = cleanName(rawName);
      phone = normalizePhone(rawPhone);
      email = cleanEmail(rawEmail);
      games = gamesOf(cfg, fields.games);
      if (fields.consent !== 'yes') throw new ValidationError('Please tick the box to register.', 'consent');
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      return html(res, 400, formPage(cfg, { ...again, error: e.message, field: e.field }, brand));
    }
    if (!games) return plain(res, 400, 'unknown game');
    // A form loaded before End can still post an ended game.
    const shut = games.filter((g) => ended.includes(g));
    if (shut.length) {
      const named = shut.filter(Boolean);
      return html(res, 409, formPage(cfg, { ...again, games: again.games.filter((g) => !shut.includes(g)), field: named.length ? 'game' : null,
        error: named.length ? `The ${listText(named)} LCQ has ended; untick it to register for the rest.` : 'The LCQ has ended, so it is closed to new sign-ups.' }, brand));
    }
    const created = [];
    const already = [];
    for (const game of games) {
      (store.register({ name, phone, email, source: 'form', noticeVersion: cfg.noticeVersion, bracket, game }).created ? created : already).push(game);
    }
    if (!created.length) {
      log('duplicate registration refused');
      return html(res, 409, formPage(cfg, { ...again, error: alreadyRegistered(bracket, already), field: 'phone' }, brand));
    }
    log(`registration added via form (${BRACKETS[bracket]}${inGames(created)})`);
    const full = bracket === 'lcq' && lcq ? created.filter((g) => lcq.phase(g).finalizedAt) : [];
    html(res, 200, thanksPage(cfg, name, phone, brand, bracket, created, already, full, email));
  }

  async function adminPost(req, res, path) {
    const fields = await readForm(req);
    if (!tokenMatches(fields.token, adminToken)) return plain(res, 403, 'bad or missing admin token; reload /admin');
    const view = viewOf(fields);
    const adminReply = (status, extra) => html(res, status, adminPage(cfg, { ...adminData(), view, ...extra }));
    if (path === '/admin/bracket') {
      if (!Object.hasOwn(BRACKETS, fields.bracket)) return plain(res, 400, 'unknown bracket');
      store.setBracket(fields.bracket);
      log(`new sign-ups now go to ${BRACKETS[fields.bracket]}`);
      return redirect(res, adminUrl(view, 'bracket'), 303);
    }
    if (path === '/admin/delete') {
      const id = Number(fields.id);
      const lead = Number.isSafeInteger(id) ? store.get(id) : null;
      if (!lead) return plain(res, 404, 'registration not found; it may already be deleted');
      if (fields.confirm !== 'yes') return html(res, 200, confirmDeletePage(cfg, lead, adminToken, brand, view));
      store.remove(id);
      const partial = store.files?.stillHolds(lead) ?? false;
      log(partial ? 'registration deleted from the database; files pending' : 'registration deleted');
      return redirect(res, adminUrl(view, partial ? 'deleted-partial' : 'deleted'), 303);
    }
    if (path === '/admin/add') {
      const bracket = Object.hasOwn(BRACKETS, fields.bracket) ? fields.bracket : store.bracket();
      const consent = fields.consent === 'yes';
      const form = {
        name: String(fields.name ?? '').slice(0, NAME_MAX), phone: String(fields.phone ?? '').slice(0, 20), email: String(fields.email ?? '').slice(0, EMAIL_MAX),
        bracket, consent, games: tickedOf(fields.games),
      };
      let name;
      let phone;
      let email;
      let games;
      try {
        name = cleanName(fields.name);
        phone = normalizePhone(fields.phone);
        email = cleanEmail(fields.email);
        games = gamesOf(cfg, fields.games);
        if (!consent) throw new ValidationError('Tick that they agreed before adding them.');
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        return adminReply(400, { error: e.message, form });
      }
      if (!games) return plain(res, 400, 'unknown game');
      // Staff read the same notice and ticked that the person agreed; source 'desk' tells these rows apart.
      const results = games.map((game) => [game, store.register({ name, phone, email, source: 'desk', noticeVersion: cfg.noticeVersion, bracket, game })]);
      const already = results.filter(([, r]) => !r.created);
      if (already.length === results.length) {
        return adminReply(409, {
          error: `${displayPhone(phone)} is already registered for ${BRACKETS[bracket]}${inGames(games)}, as ${already[0][1].existing.name}.`, form,
        });
      }
      // Desk entries always join the current event, so show that one.
      return redirect(res, adminUrl({ ...view, event: '' }, already.length ? 'added-some' : 'added'), 303);
    }
    if (path === '/admin/event') {
      let event;
      try {
        event = store.startEvent(fields.name);
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        return adminReply(400, { eventError: e.message, eventName: String(fields.name ?? '').slice(0, 60) });
      }
      log(`new sign-ups now go to event ${event.code}`);
      return redirect(res, adminUrl({ ...view, event: '' }, 'event'), 303);
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
        const params = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
        return html(res, 200, adminPage(cfg, {
          ...adminData(), q: (params.q ?? '').slice(0, 60), msg: params.msg ?? '', view: viewOf(params),
        }));
      }
      if (method === 'GET' && path === '/admin/export.csv') {
        const { tab, event, game } = viewOf(Object.fromEntries(new URL(req.url, 'http://x').searchParams));
        const code = event || store.currentEvent().code;
        const leads = store.list().filter((l) => l.eventCode === code && (tab === 'all' || l.bracket === tab) && (!game || l.game === game));
        // Game names may hold spaces or quotes; the file name keeps letters and digits only.
        const name = ['leads', code, tab === 'all' ? '' : tab, game.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')].filter(Boolean).join('-');
        return send(res, 200, 'text/csv; charset=utf-8', leadsCsv(leads), { 'Content-Disposition': `attachment; filename="${name}.csv"` });
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
    if (method === 'GET' && path === '/' && portalHosts.has(hostOf(req))) return html(res, 200, formPage(cfg, { bracket: store.bracket(), ended: endedFor(store.bracket()) }, brand));
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
