import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { LeadStore } from '../src/leads.js';
import { createPortalServer } from '../src/web.js';
import { makeConfig, postForm, request } from './helpers.js';

describe('a long admin list', () => {
  let store;
  let server;
  let port;
  const cfg = makeConfig();

  before(async () => {
    store = new LeadStore(':memory:', { firstEvent: { code: cfg.eventCode, name: cfg.eventName } });
    server = createPortalServer(cfg, store, { laptopIp: '127.0.0.1', quiet: true });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => {
    server.close();
    server.closeAllConnections();
    store.close();
  });
  beforeEach(() => store.db.exec('DELETE FROM leads'));

  const signUp = (count) => {
    for (let i = 1; i <= count; i++) {
      store.register({ name: `Player ${i}`, phone: `+9198765${String(i).padStart(5, '0')}`, source: 'form', noticeVersion: 'v' });
    }
  };
  const page = async (path = '/admin') => (await request({ port, path })).body;
  const rowCount = (body) => (body.match(/<tr><td class="num idx">/g) ?? []).length;

  test('shows the newest 100 with a link to all of them; Refresh and the way back keep the choice', async () => {
    signUp(101);
    const capped = await page();
    assert.equal(rowCount(capped), 100);
    assert.match(capped, /Showing the newest 100 of 101\. <a href="\/admin\?all=1">Show all 101<\/a>/);
    assert.ok(capped.includes('>Player 101</th>') && !capped.includes('>Player 1</th>'), 'the oldest one is the one left out');

    const all = await page('/admin?all=1');
    assert.equal(rowCount(all), 101);
    assert.match(all, /Showing all 101, newest first\. <a href="\/admin">Show the newest 100<\/a>/);
    assert.match(all, /<a href="\/admin\?all=1">Refresh<\/a>/);
    assert.match(all, /<input type="hidden" name="all" value="1">/, 'forms carry it, so a delete comes back to the full list');
    assert.equal(rowCount(await page('/admin?all=yes')), 100, 'anything but 1 means the newest 100');
  });

  test('search is never capped, and a list of exactly 100 shows no link', async () => {
    signUp(101);
    assert.equal(rowCount(await page('/admin?q=Player')), 101);
    store.db.exec('DELETE FROM leads WHERE id = (SELECT MIN(id) FROM leads)');
    const hundred = await page();
    assert.equal(rowCount(hundred), 100);
    assert.match(hundred, /Showing all 100, newest first\.<\/p>/);
  });

  test('deleting from the full list comes back to the full list', async () => {
    signUp(101);
    const token = (await page()).match(/name="token" value="([^"]+)"/)[1];
    const id = store.list()[0].id;
    const res = await postForm(port, '/admin/delete', { token, id: String(id), confirm: 'yes', all: '1' });
    assert.equal(res.headers.location, '/admin?all=1&msg=deleted');
    assert.equal(store.list().length, 100);
  });
});
