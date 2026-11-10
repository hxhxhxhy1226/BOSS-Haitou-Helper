import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { createBossNativeBackground } = require('../extension/background.js');
const platformSource = fs.readFileSync(new URL('../extension/platform.js', import.meta.url), 'utf8');
const helperSource = fs.readFileSync(new URL('../extension/helper.js', import.meta.url), 'utf8');
const helperUrls = vm.createContext({ URL });
vm.runInContext(helperSource.slice(helperSource.indexOf('  function normalizeChatUrl('), helperSource.indexOf('  function aiRequestUrl('))
  + helperSource.slice(helperSource.indexOf('  function deriveModelsUrl('), helperSource.indexOf('  function httpGETJson(')), helperUrls);
const CONFIG = 'boss_helper_config_v1';
const STATS = 'boss_helper_stats_v1';
const EVENT = 'boss_helper_daily_event_v22_';
const FIXED_TIME = Date.parse('2026-11-10T04:00:00Z');
const clone = (value) => value == null ? value : structuredClone(value);
const sender = (id = 1, host = 'www.zhipin.com') => ({ id: 'native-fixture', url: `https://${host}/web/geek/job`, frameId: 0, tab: { id }, documentId: 'document-' + id });
function fixture(options = {}) {
  let time = options.time || FIXED_TIME, number = 0, failSet = false, silentSet = false, setGate = null;
  const data = clone({ [CONFIG]: { autoSend: true, dailyLimit: 2, aiDailyLimit: 2, aiBaseUrl: 'https://api.example/v1/chat/completions' }, ...options.values });
  const changes = new Set(), requests = [];
  const api = {
    runtime: { id: 'native-fixture', getURL: (path) => 'chrome-extension://native-fixture/' + path },
    permissions: { contains: async (query) => { options.onPermission?.(query); return options.permission !== false; } },
    storage: {
      onChanged: { addListener: (fn) => changes.add(fn) },
      local: {
        async get(keys) { return keys == null ? clone(data) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in data).map((key) => [key, clone(data[key])])); },
        async set(values) {
          if (setGate) await setGate;
          if (failSet) throw Error('Simulated extension storage unavailable');
          if (silentSet) return;
          const delta = {};
          for (const [key, value] of Object.entries(values)) { delta[key] = { oldValue: clone(data[key]), newValue: clone(value) }; data[key] = clone(value); }
          changes.forEach((fn) => fn(clone(delta), 'local'));
        },
        async remove(keys) { const delta = {}; for (const key of (Array.isArray(keys) ? keys : [keys])) { delta[key] = { oldValue: clone(data[key]) }; delete data[key]; } changes.forEach((fn) => fn(clone(delta), 'local')); },
      },
    },
  };
  const fetchImpl = options.fetch || (async (url, init) => { requests.push({ url, init }); return new Response('{"choices":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }); });
  const create = () => createBossNativeBackground(api, { fetch: fetchImpl, now: () => time, uuid: () => 'event-' + (++number),
    setTimeout: options.setTimeout, clearTimeout: options.clearTimeout });
  const worker = create();
  const handle = (action, payload = {}, from = sender()) => worker.handle({ type: 'BH_NATIVE', action, ...payload }, from);
  function platform(from = sender(), responseGate) {
    const context = vm.createContext({ console, URL, Headers, Response, AbortController, DOMException,
      setTimeout, clearTimeout, setInterval, clearInterval, crypto: { randomUUID: () => 'request-' + (++number) },
      chrome: { ...api, runtime: { ...api.runtime, sendMessage: async (message) => {
        const response = await worker.handle(message, from);
        return responseGate ? responseGate(message, response) : response;
      } } },
    });
    vm.runInContext(platformSource, context);
    return context.BHNative;
  }
  return { api, data, requests, worker, create, handle, platform,
    set time(value) { time = value; }, set failSet(value) { failSet = value; }, set silentSet(value) { silentSet = value; }, set setGate(value) { setGate = value; } };
}

test('native sender validation blocks unrelated sites, foreign extensions and child frames', async () => {
  const f = fixture();
  for (const from of [sender(1, 'evil.example'), { ...sender(), id: 'foreign-extension' }, { ...sender(), frameId: 2 }]) {
    assert.equal((await f.handle('storage.getAll', {}, from)).code, 'UNTRUSTED_SENDER');
    assert.equal((await f.handle('network.fetch', {}, from)).code, 'UNTRUSTED_SENDER');
  }
  assert.equal((await f.handle('storage.getAll', {}, { id: 'native-fixture', url: 'chrome-extension://native-fixture/popup.html' })).ok, true);
  assert.equal(f.requests.length, 0);
});

test('native mirrored saves are not durable until flush resolves, and snapshots reach the other tab', async () => {
  const f = fixture(), first = f.platform(), second = f.platform(sender(2, 'www.zhipin.cn'));
  await Promise.all([first.ready, second.ready]);
  let release;
  f.setGate = new Promise((resolve) => { release = resolve; });
  first.setValue(CONFIG, { ...first.getValue(CONFIG), dailyLimit: 150 });
  let completed = false;
  const flush = first.flush().then(() => { completed = true; });
  await delay(0);
  assert.equal(first.getValue(CONFIG).dailyLimit, 150);
  assert.equal(f.data[CONFIG].dailyLimit, 2);
  assert.equal(completed, false);
  release(); await flush;
  assert.equal(f.data[CONFIG].dailyLimit, 150);
  assert.equal(second.getValue(CONFIG).dailyLimit, 150);
  assert.equal(first.healthy, true);
});

test('failed native save rolls back the optimistic value, reports error and permits an explicit retry', async () => {
  const f = fixture(), native = f.platform(), errors = [];
  await native.ready;
  native.onError((err) => errors.push(err.code));
  f.failSet = true;
  native.setValue(CONFIG, { ...native.getValue(CONFIG), dailyLimit: 150 });
  await assert.rejects(native.flush());
  assert.equal(native.getValue(CONFIG).dailyLimit, 2);
  assert.equal(native.healthy, false);
  assert.equal(errors.length, 1);
  f.failSet = false;
  native.setValue(CONFIG, { ...native.getValue(CONFIG), dailyLimit: 120 });
  await native.flush();
  assert.equal(f.data[CONFIG].dailyLimit, 120);
  assert.equal(native.healthy, true);
});

test('an earlier queued save cannot replace a later local edit while it is waiting to persist', async () => {
  const f = fixture(), native = f.platform(); await native.ready;
  let release;
  f.setGate = new Promise((resolve) => { release = resolve; });
  native.setValue(CONFIG, { ...native.getValue(CONFIG), dailyLimit: 80 });
  native.setValue(CONFIG, { ...native.getValue(CONFIG), dailyLimit: 150 });
  assert.equal(native.getValue(CONFIG).dailyLimit, 150);
  release(); await native.flush();
  assert.equal(native.getValue(CONFIG).dailyLimit, 150);
  assert.equal(f.data[CONFIG].dailyLimit, 150);
});

test('a delayed full snapshot cannot revert newer config, dispatched quota or a newly added event', async () => {
  const f = fixture();
  let release, held;
  const responseHeld = new Promise((resolve) => { held = resolve; });
  const native = f.platform(sender(), (message, response) => {
    if (message.action !== 'storage.set') return response;
    held(); return new Promise((resolve) => { release = () => resolve(response); });
  });
  await native.ready;
  const reservation = (await f.handle('quota.reserve', { jobId: 'other-tab-job', limit: 2 }, sender(2))).value;
  native.setValue('boss_helper_ai_cache_v1', { fixture: 'cache' });
  await responseHeld;
  await f.handle('storage.set', { values: { [CONFIG]: { ...f.data[CONFIG], dailyLimit: 150 } } }, sender(2));
  assert.equal((await f.handle('quota.commit', { reservation, limit: 150 }, sender(2))).value, true);
  assert.equal((await f.handle('quota.consumeAI', { limit: 2 }, sender(2))).value, true);
  const newEvent = Object.keys(f.data).find((key) => key.startsWith(EVENT) && f.data[key].kind === 'ai');
  release(); await native.flush();
  assert.equal(native.getValue(CONFIG).dailyLimit, 150);
  assert.equal(native.getValue(reservation.key).status, 'dispatched');
  assert.equal(native.getValue(newEvent).status, 'dispatched');
});

test('a newer notification for a pending config key is applied when its older save reply finally arrives', async () => {
  const f = fixture();
  let release, held;
  const responseHeld = new Promise((resolve) => { held = resolve; });
  const native = f.platform(sender(), (message, response) => {
    if (message.action !== 'storage.set') return response;
    held(); return new Promise((resolve) => { release = () => resolve(response); });
  });
  await native.ready;
  native.setValue(CONFIG, { ...native.getValue(CONFIG), dailyLimit: 80 });
  await responseHeld;
  await f.handle('storage.set', { values: { [CONFIG]: { ...f.data[CONFIG], dailyLimit: 150 } } }, sender(2));
  assert.equal(native.getValue(CONFIG).dailyLimit, 80, 'Pending local edit stays stable until its save settles');
  release(); await native.flush();
  assert.equal(native.getValue(CONFIG).dailyLimit, 150);
  assert.equal(native.getValue(CONFIG)._configUpdatedAt, f.data[CONFIG]._configUpdatedAt);
});

test('a delayed snapshot cannot restore a cache deleted by another tab after that snapshot was taken', async () => {
  const CACHE = 'boss_helper_ai_cache_v1';
  const f = fixture({ values: { [CACHE]: { fixture: 'old-cache' } } });
  let release, held;
  const responseHeld = new Promise((resolve) => { held = resolve; });
  const native = f.platform(sender(), (message, response) => {
    if (message.action !== 'storage.set') return response;
    held(); return new Promise((resolve) => { release = () => resolve(response); });
  });
  await native.ready;
  native.setValue('boss_helper_ai_health_v1', { fixture: 'health' });
  await responseHeld;
  await f.handle('storage.remove', { keys: [CACHE] }, sender(2));
  assert.equal(native.getValue(CACHE, null), null);
  release(); await native.flush();
  assert.equal(native.getValue(CACHE, null), null);
  assert.equal(native.listValues().includes(CACHE), false);
});

test('worker serializes concurrent reservations across tabs and rechecks a lowered saved limit before commit', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => f.handle('quota.reserve', { jobId: 'job-' + index, limit: 50 }, sender(index + 1))));
  assert.equal(results.filter((result) => result.value).length, 2);
  assert.equal(f.worker.stats(f.data).pending, 2);
  assert.equal((await f.handle('quota.commit', { reservation: results[0].value, limit: 50 }, sender(8))).value, false, 'Another tab cannot commit a reservation');
  await f.handle('storage.set', { values: { [CONFIG]: { ...f.data[CONFIG], dailyLimit: 1 } } });
  assert.equal((await f.handle('quota.commit', { reservation: results[0].value, limit: 50 }, sender(1))).value, true);
  assert.equal((await f.handle('quota.commit', { reservation: results[1].value, limit: 50 }, sender(2))).value, false);
  await f.handle('quota.release', { reservation: results[1].value }, sender(2));
  assert.equal(f.worker.stats(f.data).sent, 1);
  assert.equal(f.worker.stats(f.data).pending, 0);
  assert.equal(f.create().stats(f.data).sent, 1, 'A new worker restores persisted quota');
});

test('native quota response is durable and locally visible before the caller can dispatch a click', async () => {
  const f = fixture(), native = f.platform();
  await native.ready;
  const reserved = await native.reserveDelivery('quota-fixture', 2);
  assert.ok(reserved);
  let release;
  f.setGate = new Promise((resolve) => { release = resolve; });
  let mayClick = false;
  const commit = native.commitDelivery(reserved, 2).then((result) => { mayClick = result; });
  await delay(0);
  assert.equal(mayClick, false);
  assert.equal(f.data[reserved.key].status, 'reserved');
  release(); await commit;
  assert.equal(mayClick, true);
  assert.equal(f.data[reserved.key].status, 'dispatched');
  assert.equal(native.getValue(reserved.key).status, 'dispatched');
  await native.releaseDelivery(reserved);
  assert.equal(f.data[reserved.key].status, 'dispatched', 'Post-click release never frees quota');
  assert.equal(await native.reserveDelivery('quota-fixture', 2), false, 'The same job cannot be sent twice');
});

test('failed or silently dropped quota persistence never authorizes dispatch', async () => {
  for (const mode of ['failSet', 'silentSet']) {
    const f = fixture(), native = f.platform(); await native.ready;
    const reservation = await native.reserveDelivery('job', 2);
    f[mode] = true;
    await assert.rejects(native.commitDelivery(reservation, 2));
    assert.equal(f.data[reservation.key].status, 'reserved');
    assert.equal(native.healthy, false);
  }
});

test('generic writes cannot overwrite quota journals or lower already consumed base counts', async () => {
  const f = fixture({ values: { [STATS]: { schema: 22, date: '2026-11-10', sent: 5, aiCalls: 8, processed: 10 } } });
  const protectedWrite = await f.handle('storage.set', { values: { [EVENT + '2026-11-10_forged']: { kind: 'sent', status: 'cancelled' } } });
  assert.equal(protectedWrite.ok, false);
  assert.equal((await f.handle('storage.remove', { keys: [STATS] })).ok, false);
  await f.handle('storage.set', { values: { [STATS]: { date: '2026-11-10', sent: 0, aiCalls: 0, processed: 0 } } });
  assert.equal(f.worker.stats(f.data).sent, 5);
  assert.equal(f.worker.stats(f.data).aiCalls, 8);
  assert.equal(f.worker.stats(f.data).processed, 0);
});

test('AI quota is atomic, follows the saved cap and resets only at the Beijing day boundary', async () => {
  const f = fixture({ time: Date.parse('2026-11-10T15:59:59Z') });
  const results = await Promise.all(Array.from({ length: 7 }, (_, index) => f.handle('quota.consumeAI', { limit: 100 }, sender(index + 1))));
  assert.equal(results.filter((result) => result.value).length, 2);
  assert.equal(f.create().stats(f.data).aiCalls, 2);
  f.time = Date.parse('2026-11-10T16:00:00Z');
  assert.equal((await f.handle('quota.consumeAI', { limit: 100 })).value, true);
  assert.equal(f.worker.stats(f.data).aiCalls, 1);
});

test('saved zero limits stay zero and a pending configuration save finishes before native quota is requested', async () => {
  const f = fixture(), native = f.platform(); await native.ready;
  native.setValue(CONFIG, { ...native.getValue(CONFIG), aiDailyLimit: 0, dailyLimit: 0 });
  assert.equal(await native.consumeAIDailyQuota(100), false);
  assert.equal(await native.reserveDelivery('zero-limit', 500), false);
  assert.equal(f.data[CONFIG].aiDailyLimit, 0);
  assert.equal(f.worker.stats(f.data).aiCalls, 0);
  native.setValue(CONFIG, { ...native.getValue(CONFIG), dailyLimit: 2, autoSend: false });
  assert.equal(await native.reserveDelivery('auto-send-disabled', 500), false);
});

test('configured and explicit draft AI endpoints use authorized exact URLs with no page cookies or redirects', async () => {
  const origins = [], f = fixture({ onPermission: (query) => origins.push(query.origins[0]) });
  const post = await f.handle('network.fetch', { requestId: 'post', method: 'POST', url: 'https://api.example/v1/chat/completions', headers: { Authorization: 'Bearer fixture-key' }, body: '{}' });
  assert.equal(post.value.status, 200);
  const get = await f.handle('network.fetch', { requestId: 'draft-get', method: 'GET', url: 'http://localhost:4321/v1/models', endpoint: { baseUrl: 'http://localhost:4321/v1' } });
  assert.equal(get.value.status, 200);
  assert.deepEqual(origins, ['https://api.example/*', 'http://localhost/*']);
  assert.ok(f.requests.every((request) => request.init.credentials === 'omit' && request.init.redirect === 'error'));
  const mismatch = await f.handle('network.fetch', { requestId: 'mismatch', method: 'POST', url: 'https://evil.example/collect', endpoint: { baseUrl: 'https://api.example/v1' } });
  assert.equal(mismatch.ok, false);
  assert.equal(f.requests.length, 2);
});

test('valid endpoint host normalization does not reject uppercase hostnames', async () => {
  const f = fixture();
  const response = await f.handle('network.fetch', { requestId: 'normalized-host', method: 'POST',
    url: 'https://API.EXAMPLE/v1/chat/completions', endpoint: { baseUrl: 'https://API.EXAMPLE/v1' } });
  assert.equal(response.value.status, 200);
  assert.equal(f.requests[0].url, 'https://api.example/v1/chat/completions');
});

test('worker accepts exactly the helper URL contract for root, v1, full, custom and query endpoints', async () => {
  const f = fixture();
  const bases = ['https://api.example', 'https://api.example/', 'https://api.example/v1', 'https://api.example/openai/',
    'https://api.example/v1/chat/completions', 'https://api.example/custom/chat', 'https://api.example/custom/chat?api-version=fixture',
    'https://api.example/v1?token=fixture'];
  for (const [index, baseUrl] of bases.entries()) {
    for (const method of ['GET', 'POST']) {
      const url = method === 'GET' ? helperUrls.deriveModelsUrl(baseUrl) : helperUrls.normalizeChatUrl(baseUrl);
      const response = await f.handle('network.fetch', { requestId: `contract-${index}-${method}`, method, url, endpoint: { baseUrl } });
      assert.equal(response.value?.status, 200, `${method} ${baseUrl}: ${JSON.stringify(response)}`);
    }
  }
});

test('missing host permission gives an actionable response without making an external request', async () => {
  const f = fixture({ permission: false }), native = f.platform(); await native.ready;
  const response = await native.fetch('https://api.example/v1/chat/completions', { method: 'POST', body: '{}', endpoint: { baseUrl: 'https://api.example/v1' } });
  assert.equal(response.status, 403);
  assert.match(await response.text(), /授权 AI 服务/);
  assert.equal(f.requests.length, 0);
});

test('native request cancellation reaches the worker, rejects fetch and never calls success', async () => {
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  const f = fixture({ fetch: (_url, init) => new Promise((_resolve, reject) => {
    started(); init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }) });
  const native = f.platform(); await native.ready;
  const controller = new AbortController();
  const result = native.fetch('https://api.example/v1/chat/completions', { method: 'POST', body: '{}', signal: controller.signal });
  await pending; controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});

test('cancellation during permission validation stops the request before fetch begins', async () => {
  let release, began;
  const started = new Promise((resolve) => { began = resolve; });
  const f = fixture();
  f.api.permissions.contains = () => { began(); return new Promise((resolve) => { release = resolve; }); };
  const pending = f.handle('network.fetch', { requestId: 'during-permission', method: 'POST', url: 'https://api.example/v1/chat/completions' });
  await started;
  assert.equal((await f.handle('network.abort', { requestId: 'during-permission' })).value, true);
  release(true);
  assert.equal((await pending).code, 'ABORTED');
  assert.equal(f.requests.length, 0);
});

test('worker timeout aborts the fetch and reports TIMEOUT rather than a false HTTP success', async () => {
  const f = fixture({ setTimeout: (fn) => setTimeout(fn, 5), fetch: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }) });
  const result = await f.handle('network.fetch', { requestId: 'timeout', method: 'POST', url: 'https://api.example/v1/chat/completions', timeout: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TIMEOUT');
});

test('requests cannot use arbitrary methods, cookie headers or embedded URL passwords', async () => {
  const f = fixture();
  for (const payload of [
    { method: 'DELETE', url: 'https://api.example/v1/chat/completions' },
    { method: 'POST', url: 'https://api.example/v1/chat/completions', headers: { Cookie: 'fixture-cookie' } },
    { method: 'POST', url: 'https://user:password@api.example/v1/chat/completions', endpoint: { baseUrl: 'https://user:password@api.example/v1' } },
  ]) assert.equal((await f.handle('network.fetch', { requestId: 'invalid', ...payload })).ok, false);
  assert.equal(f.requests.length, 0);
});
