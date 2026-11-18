// Drives the real LCQ tablet script in headless Chrome against an in-process booth server: taps online, offline,
// with a lost answer, refused, signed out, and Pick a match search. Needs Chrome (set CHROME to its path); exits 2 if it cannot run.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Lcq } from '../src/lcq.js';
import { LeadStore } from '../src/leads.js';
import { createPortalServer } from '../src/web.js';
import { makeConfig } from '../test/helpers.js';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) {
  console.error(`tablet check could not run: no Chrome at ${CHROME}; set CHROME to its path`);
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` :: ${detail}`}`); };
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } return null; };

const store = new LeadStore(':memory:');
const lcq = new Lcq(store);
for (let i = 0; i < 4; i++) store.register({ name: `P${i + 1}`, phone: `+9198765${String(i).padStart(5, '0')}`, source: 'form', noticeVersion: 'v', bracket: 'lcq' });
const server = createPortalServer(makeConfig(), store, { laptopIp: 'booth.test', quiet: true, lcq });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://booth.test:${port}`;

const profile = mkdtempSync(join(tmpdir(), 'tablet-check-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  `--host-resolver-rules=MAP booth.test 127.0.0.1`, 'about:blank',
], { stdio: 'ignore' });
let exitCode = 1;
let connected = false;
try {
  const portFile = join(profile, 'DevToolsActivePort');
  if (!(await until(() => existsSync(portFile) && readFileSync(portFile, 'utf8').includes('\n')))) throw new Error('Chrome did not start');
  const devPort = readFileSync(portFile, 'utf8').split('\n')[0];
  const target = await (await fetch(`http://127.0.0.1:${devPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  connected = true;
  let seq = 0;
  const pending = new Map();
  const handlers = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.j(new Error(d.error.message)) : p.r(d.result); }
    else for (const h of handlers) h(d);
  };
  const send = (method, params = {}) => new Promise((r, j) => { const id = ++seq; pending.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(`${expression}: ${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`);
    return out.result.value;
  };
  const errors = [];
  handlers.push((d) => { if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description); });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  const go = async (url) => { await send('Page.navigate', { url }); await until(() => js('document.readyState === "complete"').catch(() => false)); };
  const barText = () => js('document.querySelector(".sync-row span")?.textContent ?? null');
  const outbox = () => js('JSON.parse(localStorage.getItem("lcq-outbox") || "[]").length');

  await go(`${base}/lcq`);
  check('precondition: the page is an insecure context, like http://100.64.0.2', (await js('isSecureContext')) === false);
  await js(`document.getElementById('pin').value = '${lcq.pin()}'; document.querySelector('form[action="/lcq/login"]').submit()`);
  await until(() => js('!!document.getElementById("version")').catch(() => false));
  await until(() => js('document.readyState === "complete"').catch(() => false));
  check('signed in and the runner script loaded its sync bar', !!(await until(() => barText())), await barText());

  // A: online tap goes through the queue with no page load.
  await js('window.__noReload = 1');
  await js('document.querySelector(\'form[action="/lcq/start"] button\').click()');
  const started = await until(() => lcq.state().open.length === 1);
  check('A: an online tap reaches the laptop', !!started);
  check('A: the page updated without a reload', !!(await until(() => js('window.__noReload === 1 && /Playing \\(1\\)/.test(document.querySelector("main").textContent)'))));
  check('A: the queue is empty afterwards', (await outbox()) === 0);

  // B: laptop unreachable: the tap waits on the tablet, then goes when the network is back.
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await js('document.querySelector(\'form[action="/lcq/result"] button\').click()');
  check('B: offline, the tap is kept on the tablet', !!(await until(async () => (await outbox()) === 1)));
  check('B: offline, the laptop has not seen it', lcq.state().decided.length === 0);
  check('B: the bar says it is waiting', /1 tap not on the laptop yet/.test((await until(async () => { const t = await barText(); return /not on the laptop/.test(t) && t; })) ?? ''), await barText());
  check('B: the tapped button is disabled against a double tap', await js('document.querySelector(\'form[action="/lcq/result"] button\').disabled'));
  check('B: the queue survives a storage read-back', (await js('localStorage.getItem("lcq-outbox")')).includes('"op"') === false && (await js('JSON.parse(localStorage.getItem("lcq-outbox"))[0].body')).includes('op='));
  await sleep(2500);
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  check('B: back online, the queued tap lands once', !!(await until(() => lcq.state().decided.length === 1)));
  check('B: queue drained and the page shows the Undo for it', !!(await until(async () => (await outbox()) === 0 && js('/beat/.test(document.querySelector("main").textContent)'))));
  check('B: the bar says up to date', !!(await until(async () => /^Up to date/.test(await barText()))), await barText());

  // C: the laptop applies a tap but the answer is lost; the tablet resends and it is applied only once.
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/lcq/undo*', requestStage: 'Response' }] });
  let failed = 0;
  handlers.push((d) => {
    if (d.method !== 'Fetch.requestPaused') return;
    if (failed++ === 0) send('Fetch.failRequest', { requestId: d.params.requestId, errorReason: 'ConnectionReset' });
    else send('Fetch.continueRequest', { requestId: d.params.requestId });
  });
  const opsBefore = store.db.prepare('SELECT COUNT(*) AS n FROM lcq_ops').get().n;
  await js('document.querySelector(\'.flash form[action="/lcq/undo"] button\').click()');
  check('C: the first answer was dropped and the tap resent', !!(await until(() => failed >= 2)), `pauses ${failed}`);
  check('C: the undo was applied', !!(await until(() => lcq.state().decided.length === 0 && lcq.state().open.length === 1)));
  check('C: the resend was answered, so the queue drained', !!(await until(async () => (await outbox()) === 0)), await barText());
  check('C: one op recorded for the two sends', store.db.prepare('SELECT COUNT(*) AS n FROM lcq_ops').get().n === opsBefore + 1);
  check('C: no refusal shown (a double apply would say "no result yet")', (await js('document.querySelectorAll(".sync .error").length')) === 0, await js('document.querySelector(".sync").textContent'));
  await send('Fetch.disable');

  // D: a refusal is shown with its reason and the queue moves on.
  const [m] = lcq.state().open;
  lcq.result(m.id, m.a); // decided behind the tablet's back, so its stale button is refused
  await js('document.querySelector(\'form[action="/lcq/result"] button\').click()');
  check('D: the refusal reason is shown in the bar', !!(await until(() => js('/already has a result/.test(document.querySelector(".sync").textContent)'))));
  check('D: the refused tap left the queue', (await outbox()) === 0);
  await js('[...document.querySelectorAll(".sync button")].find((b) => b.textContent === "OK").click()');
  check('D: OK clears it', (await js('document.querySelectorAll(".sync .error").length')) === 0);

  // E: signed out (laptop restarted): taps are kept and sent after the PIN.
  await send('Network.clearBrowserCookies');
  lcq.undo(m.id);
  await js('location.reload()');
  await sleep(500);
  await until(() => js('document.readyState === "complete"').catch(() => false));
  check('E: precondition: signed out shows the PIN page', await js('!!document.getElementById("pin")'));
  await js(`document.getElementById('pin').value = '${lcq.pin()}'; document.querySelector('form[action="/lcq/login"]').submit()`);
  await sleep(500);
  await until(() => js('!!document.querySelector(".sync-row span")').catch(() => false));
  await send('Network.clearBrowserCookies');
  await js('document.querySelector(\'form[action="/lcq/cancel"] button\').click()');
  check('E: a tap while signed out says so and keeps the tap', !!(await until(async () => /Signed out/.test(await barText()) && (await outbox()) === 1)), await barText());
  check('E: the Enter the PIN link shows', await js('!document.querySelector(".sync a").hidden'));
  check('E: nothing changed on the laptop', lcq.state().open.length === 1);
  await go(`${base}/lcq`);
  await js(`document.getElementById('pin').value = '${lcq.pin()}'; document.querySelector('form[action="/lcq/login"]').submit()`);
  check('E: after the PIN, the kept tap goes on page load', !!(await until(() => lcq.state().open.length === 0)));
  check('E: and the queue is empty', !!(await until(async () => (await outbox()) === 0)));

  // F: the Sync button pulls the laptop's state now, even while the page would hold updates.
  store.register({ name: 'Late Larry', phone: '+919999900000', source: 'desk', noticeVersion: 'v', bracket: 'lcq' });
  await js('document.querySelector("#pa")?.focus()');
  await js('[...document.querySelectorAll(".sync button")].find((b) => b.textContent === "Sync").click()');
  check('F: Sync shows a change made on the laptop', !!(await until(() => js('/Late Larry/.test(document.querySelector("main").textContent)'))));

  // G: Pick a match searches each list; a search that leaves one player picks them.
  const opts = (id) => js(`[...document.getElementById('${id}').options].slice(1).map((o) => o.textContent.replace(/ \\(.*/, ''))`);
  const picked = (id) => js(`{ const s = document.getElementById('${id}'); s.value ? s.selectedOptions[0].textContent.replace(/ \\(.*/, '') : ''; }`);
  const type = async (id, text) => { await js(`document.getElementById('${id}').focus()`); await send('Input.insertText', { text }); };
  await js('document.getElementById("lcq-pick").open = true');
  check('G: the search boxes show once the script runs', await js('[...document.querySelectorAll(".pick-q")].every((q) => !q.hidden)'));
  await type('pa-q', 'larry');
  check('G: the Player search narrows the list', JSON.stringify(await opts('pa')) === '["Late Larry"]', JSON.stringify(await opts('pa')));
  check('G: and one left is picked', (await picked('pa')) === 'Late Larry');
  check('G: Against lists the others on the same wins', JSON.stringify(await opts('pb')) === '["P1","P2","P3","P4"]', JSON.stringify(await opts('pb')));
  await type('pb-q', '+91987650000');
  check('G: Against searches by number too', JSON.stringify(await opts('pb')) === '["P1","P2","P3","P4"]', JSON.stringify(await opts('pb')));
  await type('pb-q', '2');
  check('G: a longer number leaves one, and it is picked', (await picked('pb')) === 'P3', `${JSON.stringify(await opts('pb'))} picked ${await picked('pb')}`);
  await js('document.querySelector(\'#lcq-pick button[type="submit"]\').click()');
  check('G: Start match starts the picked pair', !!(await until(() => lcq.state().open.some((m) => [m.aName, m.bName].sort().join() === 'Late Larry,P3'))));
  check('G: after the tap the pick starts afresh', !!(await until(() => js('document.getElementById("pa-q")?.value === "" && document.getElementById("pa")?.value === ""'))));

  // H: a half-made pick no longer freezes the page: a new sign-up shows up and the pick is kept.
  const choose = (id, name) => js(`{ const s = document.getElementById('${id}'); s.value = [...s.options].find((o) => o.textContent.startsWith('${name} ')).value;
    s.dispatchEvent(new Event('change', { bubbles: true })); }`);
  await js('document.activeElement.blur()');
  await choose('pa', 'P1');
  await choose('pb', 'P2');
  const p = (name) => lcq.state().players.find((x) => x.name === name);
  store.register({ name: 'Newcomer', phone: '+919999922222', source: 'desk', noticeVersion: 'v', bracket: 'lcq' });
  check('H: with a pick made, a new sign-up reaches Against without a reload', !!(await until(async () => (await opts('pb')).includes('Newcomer'), 10000)), JSON.stringify(await opts('pb')));
  check('H: and the pick is kept', (await picked('pa')) === 'P1' && (await picked('pb')) === 'P2', `${await picked('pa')} vs ${await picked('pb')}`);
  lcq.start(p('P2').id, p('P4').id);
  check('H: a picked player who is no longer free is dropped from the pick', !!(await until(async () => (await picked('pb')) === '' && !(await opts('pb')).includes('P2'), 10000)), JSON.stringify(await opts('pb')));
  check('H: the other half of the pick stays', (await picked('pa')) === 'P1');

  check('no script errors on the page', errors.length === 0, errors.join(' | '));
  ws.close();
  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  if (!connected) {
    console.error(`tablet check could not run: ${e.message}`);
    exitCode = 2;
  } else check('harness ran to the end', false, e.stack);
} finally {
  chrome.kill();
  server.close();
  server.closeAllConnections();
  store.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
  process.exit(exitCode);
}
