import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const code = fs.readFileSync(SCRIPT, 'utf8');
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const reverseObjectKeys = (value) => {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseObjectKeys(value[key])]));
};

function fixture(t, { reordered = false, enumeration = 'working' } = {}) {
  const gm = new Map();
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://www.zhipin.com/web/geek/job?query=fixture',
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  win.GM_getValue = (key, fallback) => {
    const value = gm.has(key) ? clone(gm.get(key)) : fallback;
    return reordered ? reverseObjectKeys(value) : value;
  };
  win.GM_setValue = (key, value) => gm.set(key, clone(value));
  if (enumeration === 'working') win.GM_listValues = () => [...gm.keys()];
  if (enumeration === 'throws') win.GM_listValues = () => { throw Error('GM enumeration unavailable'); };
  win.GM_deleteValue = (key) => gm.delete(key);
  win.GM_addStyle = () => {};
  win.GM_xmlhttpRequest = () => assert.fail('Compatibility tests must never contact a server');
  win.fetch = () => assert.fail('Compatibility tests must never contact a server');
  win.unsafeWindow = win;
  Object.defineProperty(win, 'localStorage', { value: {
    getItem() { throw Error('Site storage blocked'); },
    setItem() { throw Error('Site storage blocked'); },
    get length() { throw Error('Site storage blocked'); },
  } });
  win.eval(code);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  t.after(() => dom.window.close());
  return { win, BH: win.BH, gm };
}

test('GM-only storage: a semantic round trip permits counters regardless of property order', async (t) => {
  const f = fixture(t, { reordered: true });
  assert.equal(f.BH.statsPersistenceAvailable(), true, 'The GM store is writable');
  assert.equal(f.BH.saveStats({ ...f.BH.loadStats(), sent: 30 }), true,
    'A manager returning the same data with reordered object keys must remain usable');
  assert.equal(f.BH.loadStats().sent, 30);
  assert.equal(await f.BH.consumeAIDailyQuota(120), true);
  assert.equal(f.BH.loadStats().aiCalls, 1);
  const reservation = await f.BH.reserveDelivery('compat-job', 120);
  assert.ok(reservation);
  assert.equal(f.BH.dispatchDelivery(reservation), true);
  assert.equal(f.BH.loadStats().sent, 31);
});

test('GM-only storage: absent enumeration can use the bounded compatibility lock', async (t) => {
  const f = fixture(t, { enumeration: 'missing' });
  assert.equal(await f.BH.consumeAIDailyQuota(120), true);
  assert.equal(f.BH.loadStats().aiCalls, 1);
  const reservation = await f.BH.reserveDelivery('compat-no-enumeration', 120);
  assert.ok(reservation);
  assert.equal(f.BH.dispatchDelivery(reservation), true);
  assert.equal(f.BH.loadStats().sent, 1);
});

test('GM-only storage: a present but unavailable enumeration API does not reject all valid quotas', async (t) => {
  const f = fixture(t, { enumeration: 'throws' });
  assert.equal(f.BH.statsPersistenceAvailable(), true);
  assert.equal(await f.BH.consumeAIDailyQuota(120), true,
    'Choose the compatibility lock when enumeration itself is unavailable');
  assert.equal(f.BH.loadStats().aiCalls, 1);
});
