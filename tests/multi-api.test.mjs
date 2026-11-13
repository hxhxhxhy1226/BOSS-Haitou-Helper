/** Multi-API regression tests. All requests and storage are local fixtures. */
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const code = fs.readFileSync(SCRIPT, 'utf8');
const clone = (value) => value == null ? value : structuredClone(value);
const PRIMARY = 'https://primary.example/v1/chat/completions';
const BACKUP = 'https://backup.example/v1/chat/completions';
const BACKUP2 = 'https://backup2.example/v1/chat/completions';
const good = (match = true) => ({ choices: [{ message: { content: JSON.stringify({ match, score: 88, reason: match ? '技术方向匹配' : '岗位方向不匹配' }) } }] });
const job = (id = 'api-job') => ({ jobId: id, title: '嵌入式软件开发', company: '测试公司', salary: '15-25K', jd: '负责 STM32、FreeRTOS 固件研发和驱动开发。' });

async function fixture(t, { store = new Map(), cfg = {}, gm, fetch, clock } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://www.zhipin.com/web/geek/job?query=fixture', runScripts: 'outside-only',
    pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  const requests = [];
  const time = clock || { now: Date.parse('2026-11-10T04:00:00Z') };
  const NativeDate = win.Date;
  win.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [time.now])); }
    static now() { return time.now; }
  };
  win.GM_getValue = (key, fallback) => clone(store.has(key) ? store.get(key) : fallback);
  win.GM_setValue = (key, value) => store.set(key, clone(value));
  win.GM_addStyle = () => {};
  win.unsafeWindow = win;
  let handler = gm || ((o) => o.onload({ status: 200, responseText: JSON.stringify(good()) }));
  win.GM_xmlhttpRequest = (o) => {
    requests.push({ transport: 'gm', method: o.method, url: o.url, headers: clone(o.headers), body: o.data ? JSON.parse(o.data) : null });
    queueMicrotask(() => handler(o));
    return { abort() {} };
  };
  let fetchHandler = fetch || (async () => { throw new Error('fixture: fetch unavailable'); });
  win.fetch = async (url, o) => {
    requests.push({ transport: 'fetch', method: o.method, url, headers: clone(o.headers), body: o.body ? JSON.parse(o.body) : null });
    return fetchHandler(url, o);
  };
  win.eval(code);
  await delay(0);
  const BH = win.BH;
  BH.state.config = {
    ...BH.loadConfig(), aiEnabled: true, aiBaseUrl: PRIMARY, aiApiKey: 'sk-primary-fixture-secret',
    aiModel: 'primary-model', aiPrimaryEnabled: true, aiDailyLimit: 100, aiMaxRetries: 0,
    aiTimeoutMs: 3000, aiCacheEnabled: false, aiFallback: 'skip', aiUserPortrait: '寻找 STM32 嵌入式软件开发岗位',
    aiEndpoints: [{ id: 'backup', name: '备用服务', enabled: true, baseUrl: BACKUP, apiKey: 'sk-backup-fixture-secret', model: 'backup-model' }],
    ...cfg,
  };
  BH.state.stopFlag = false;
  t.after(() => { BH.state.stopFlag = true; BH.state.paused = false; dom.window.close(); });
  return {
    BH, win, store, requests, time,
    setGM(fn) { handler = fn; }, setFetch(fn) { fetchHandler = fn; },
    postURLs() { return requests.filter((r) => r.method === 'POST').map((r) => r.url); },
  };
}

const response = (o, status, data) => o.onload({ status, responseText: typeof data === 'string' ? data : JSON.stringify(data) });
async function until(predicate, description) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), description);
}

test('旧单 API 配置仍可调用，备用配置归一化且停用项不会调用', async (t) => {
  const f = await fixture(t, { cfg: { aiEndpoints: [{ id: 'off', enabled: false, name: '停用项', baseUrl: BACKUP, apiKey: 'secret', model: 'off-model' }] } });
  const r = await f.BH.aiScreen(job());
  assert.equal(r.ok, true);
  assert.deepEqual(f.postURLs(), [PRIMARY]);
  assert.equal(f.BH.getAIEndpoints(f.BH.state.config).length, 1);
  assert.equal(f.BH.getAIEndpoints(f.BH.state.config, true).length, 2);
  assert.equal(f.BH.loadStats().aiCalls, 1);
});

for (const failure of [
  { label: '401 密钥失效', run: (o) => response(o, 401, { error: { message: 'invalid API key' } }) },
  { label: '429 限流', run: (o) => response(o, 429, { error: { message: 'rate limited' } }) },
  { label: '503 服务离线', run: (o) => response(o, 503, { error: { message: 'unavailable' } }) },
  { label: '网络断连', run: (o) => o.onerror() },
  { label: '请求超时', run: (o) => o.ontimeout() },
  { label: '响应空内容', run: (o) => response(o, 200, { choices: [] }) },
  { label: '无法解析判定', run: (o) => response(o, 200, { choices: [{ message: { content: '今天系统维护' } }] }) },
]) {
  test(`${failure.label}自动切到备用 API 并使用备用模型/密钥`, async (t) => {
    const f = await fixture(t, { gm: (o) => o.url === PRIMARY ? failure.run(o) : response(o, 200, good(false)) });
    const r = await f.BH.aiScreen(job());
    assert.equal(r.ok, true, r.err);
    assert.equal(r.match, false, '备用 AI 的不匹配结论必须保留');
    assert.equal(f.postURLs()[0], PRIMARY);
    assert.equal(f.postURLs().at(-1), BACKUP);
    const backupRequest = f.requests.find((req) => req.url === BACKUP);
    assert.equal(backupRequest.body.model, 'backup-model');
    assert.equal(backupRequest.headers.Authorization, 'Bearer sk-backup-fixture-secret');
    assert.equal(f.BH.loadStats().aiCalls, f.postURLs().length, '失败尝试也计入每日统计');
    const next = await f.BH.aiScreen(job('next-job'));
    assert.equal(next.ok, true);
    assert.equal(f.postURLs().at(-1), BACKUP);
    assert.equal(f.postURLs().filter((url) => url === PRIMARY).length, 2, '后续岗位仍从用户设置的第一项开始');
  });
}

test('首个备用也失败时继续调用下一项，禁用项绝不尝试', async (t) => {
  const f = await fixture(t, { cfg: { aiEndpoints: [
    { id: 'off', name: '停用服务', enabled: false, baseUrl: 'https://off.example/v1', apiKey: 'off-key', model: 'off' },
    { id: 'backup', name: '备用 1', enabled: true, baseUrl: BACKUP, apiKey: 'key-one', model: 'one' },
    { id: 'backup2', name: '备用 2', enabled: true, baseUrl: BACKUP2, apiKey: 'key-two', model: 'two' },
  ] }, gm: (o) => response(o, o.url === BACKUP2 ? 200 : 503, o.url === BACKUP2 ? good() : {}) });
  assert.equal((await f.BH.aiScreen(job())).ok, true);
  assert.deepEqual(f.postURLs(), [PRIMARY, BACKUP, BACKUP2]);
  assert.equal(f.BH.loadStats().aiCalls, 3);
});

test('所有服务失败返回一分钟后的重试时间，不假造匹配结论', async (t) => {
  const f = await fixture(t, { gm: (o) => response(o, 401, { error: { message: 'invalid key' } }) });
  const screen = await f.BH.aiScreen(job());
  assert.equal(screen.ok, false);
  assert.notEqual(screen.match, true);
  assert.equal(screen.apiUnavailable, true);
  assert.equal(screen.retryAt, f.time.now + 60000);
  assert.equal(screen.retryDelayMs, 60000);
  assert.equal(f.postURLs().length, 2);
  assert.equal(f.BH.loadStats().aiCalls, 2);
});

for (const transport of ['gm', 'fetch']) {
  test(`${transport} 服务商 HTTP 429/余额不足保留响应原因，并与本地存储和已取消的次数限制区分`, async (t) => {
    const details = { error: { message: 'insufficient_quota: account balance exhausted' } };
    const f = await fixture(t, { cfg: { aiDailyLimit: 0, aiEndpoints: [] },
      gm: (o) => response(o, 429, details),
      fetch: async () => ({ ok: false, status: 429, text: async () => JSON.stringify(details) }) });
    const r = await f.BH.aiScreen(job(), { transport });
    assert.equal(r.ok, false);
    assert.equal(r.apiUnavailable, true);
    assert.equal(r.storageFailure, undefined);
    assert.equal(r.quotaExceeded, undefined);
    assert.match(r.err, /HTTP 429.*insufficient_quota.*account balance exhausted/);
    assert.equal(r.retryDelayMs, 60000);
    assert.equal(f.requests.length, 1, 'Provider quota errors do not trigger immediate retries on the other transport');
    assert.equal(f.BH.loadStats().aiCalls, 1);
  });
}

test('失效诊断跨刷新保存，单轮巡检不漏掉任何启用接口', async (t) => {
  const store = new Map();
  const clock = { now: Date.parse('2026-11-10T04:00:00Z') };
  const f = await fixture(t, { store, clock, gm: (o) => response(o, 503, {}) });
  assert.equal((await f.BH.aiScreen(job())).ok, false);
  const health = f.BH.getAIEndpointHealth(f.BH.state.config);
  const retryAt = Math.max(...health.map((h) => h.retryAt || 0));
  assert.equal(retryAt, clock.now + 60000, '所有接口失败统一显示一分钟后重试');
  const refresh = await fixture(t, { store, clock });
  const refreshedHealth = refresh.BH.getAIEndpointHealth(refresh.BH.state.config);
  assert.ok(refreshedHealth.every((h) => h.status === 'cooldown'));
  assert.equal((await refresh.BH.aiScreen(job('refresh-before-retry'))).ok, true);
  assert.deepEqual(refresh.postURLs(), [PRIMARY], '独立巡检的有序列表不被历史冷却记录过滤');
  clock.now = retryAt + 1;
  assert.equal((await refresh.BH.aiScreen(job('refresh-after-retry'))).ok, true);
  assert.equal(refresh.postURLs().length, 2);
});

test('最后成功 API 不改变用户设置顺序，刷新后从第一项重试', async (t) => {
  const store = new Map();
  const f = await fixture(t, { store, gm: (o) => o.url === PRIMARY ? response(o, 401, {}) : response(o, 200, good()) });
  assert.equal((await f.BH.aiScreen(job())).ok, true);
  const refresh = await fixture(t, { store });
  assert.equal((await refresh.BH.aiScreen(job('after-refresh'))).ok, true);
  assert.deepEqual(refresh.postURLs(), [PRIMARY]);
  assert.equal(refresh.BH.loadStats().aiCalls, 3);
});

test('停用主 API 后仅调用备用，无主 API 密钥也正常运行', async (t) => {
  const f = await fixture(t, { cfg: { aiPrimaryEnabled: false, aiApiKey: '' } });
  assert.equal((await f.BH.aiScreen(job())).ok, true);
  assert.deepEqual(f.postURLs(), [BACKUP]);
});

test('主 API 配置不完整时使用可用备用，全部停用时禁止网络', async (t) => {
  const f = await fixture(t, { cfg: { aiApiKey: '' } });
  assert.equal((await f.BH.aiScreen(job())).ok, true);
  assert.deepEqual(f.postURLs(), [BACKUP]);
  f.BH.state.config.aiPrimaryEnabled = false;
  f.BH.state.config.aiEndpoints[0].enabled = false;
  assert.equal((await f.BH.aiScreen(job('disabled-all'))).ok, false);
  assert.deepEqual(f.postURLs(), [BACKUP]);
});

test('fetch 不响应且忽略 abort 时仍由超时看门狗切换 API', async (t) => {
  const f = await fixture(t, { cfg: { aiTimeoutMs: 30 },
    fetch: async (url) => url === PRIMARY ? new Promise(() => {}) : { ok: true, status: 200, text: async () => JSON.stringify(good()) } });
  const r = await f.BH.aiScreen(job(), { transport: 'fetch' });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(f.postURLs(), [PRIMARY, BACKUP]);
  assert.equal(f.BH.loadStats().aiCalls, 2);
});

test('服务端错误回显密钥时诊断结果仍脱敏', async (t) => {
  const f = await fixture(t, { gm: (o) => response(o, 401, { error: { message: `invalid ${o.headers.Authorization}` } }) });
  const r = await f.BH.aiScreen(job());
  assert.equal(r.ok, false);
  const diagnostics = r.err + JSON.stringify(f.BH.getAIEndpointHealth(f.BH.state.config));
  assert.ok(!diagnostics.includes('sk-primary-fixture-secret'));
  assert.ok(!diagnostics.includes('sk-backup-fixture-secret'));
});

test('旧 AI 上限为 1 时仍能完整尝试备用服务和下一轮', async (t) => {
  const f = await fixture(t, { cfg: { aiDailyLimit: 1, aiMaxRetries: 3 }, gm: (o) => response(o, 503, {}) });
  const r = await f.BH.aiScreen(job());
  assert.equal(r.ok, false);
  assert.match(r.err, /HTTP 503/);
  assert.equal(r.quotaExceeded, undefined);
  assert.deepEqual(f.postURLs(), [PRIMARY, BACKUP]);
  assert.equal(f.BH.loadStats().aiCalls, 2);
  assert.equal((await f.BH.aiScreen(job('budget-exhausted'))).ok, false);
  assert.equal(f.postURLs().length, 4);
});

test('旧上限不再阻止每分钟网络重试，恢复后仍从首项判断', async (t) => {
  const f = await fixture(t, { cfg: { aiDailyLimit: 1 }, gm: (o) => response(o, 503, {}) });
  const waiting = f.BH.runAIGate(null, job());
  await until(() => f.BH.state._aiFailStreak >= 1, '真实 HTTP 故障进入等待');
  assert.deepEqual(f.postURLs(), [PRIMARY, BACKUP]);
  assert.equal(f.BH.state.paused, false);
  f.setGM((o) => response(o, 200, good()));
  f.time.now += 60001;
  const gate = await waiting;
  assert.equal(gate.action, 'accept');
  assert.deepEqual(f.postURLs(), [PRIMARY, BACKUP, PRIMARY]);
  assert.equal(f.BH.loadStats().aiCalls, 3);
});

test('单 API GM 超时后 fetch 独立计数，旧限额为 1 不再阻断备用通道', async (t) => {
  const f = await fixture(t, { cfg: { aiDailyLimit: 1, aiEndpoints: [] }, gm: (o) => o.ontimeout(),
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(good()) }) });
  const r = await f.BH.aiScreen(job());
  assert.equal(r.ok, true);
  assert.equal(f.requests.filter((req) => req.transport === 'fetch').length, 1);
  assert.equal(f.BH.loadStats().aiCalls, 2);
});

test('单 API GM 到 fetch 成功时两个 POST 都保留尝试统计', async (t) => {
  const f = await fixture(t, { cfg: { aiDailyLimit: 2, aiEndpoints: [] }, gm: (o) => o.ontimeout(),
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(good()) }) });
  const r = await f.BH.aiScreen(job());
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(f.requests.map((req) => req.transport), ['gm', 'fetch']);
  assert.equal(f.BH.loadStats().aiCalls, 2);
});

test('AI 缓存不受运行中服务切换影响，修改备用模型则失效', async (t) => {
  const f = await fixture(t, { cfg: { aiCacheEnabled: true }, gm: (o) => o.url === PRIMARY ? response(o, 401, {}) : response(o, 200, good()) });
  const r = await f.BH.aiScreen(job());
  assert.equal(r.ok, true);
  const cached = await f.BH.aiScreen(job());
  assert.equal(cached.cached, true);
  assert.equal(f.postURLs().length, 2);
  const fingerprint = f.BH.aiCacheFingerprint(f.BH.state.config);
  f.BH.state.config.aiEndpoints[0].model = 'new-backup-model';
  assert.notEqual(f.BH.aiCacheFingerprint(f.BH.state.config), fingerprint);
  const changed = await f.BH.aiScreen(job());
  assert.equal(changed.cached, false);
  assert.equal(f.postURLs().at(-1), BACKUP);
  assert.equal(f.requests.at(-1).body.model, 'new-backup-model');
});

test('升级后不沿用 v21 的旧拒绝缓存，重新取得当前 AI 结论', async (t) => {
  const f = await fixture(t, { cfg: { aiCacheEnabled: true } });
  const target = job('old-refusal-cache');
  f.BH.setAICache(target.jobId, { match: false, score: 0, reason: '旧版本错误拒绝' }, target);
  const cached = f.store.get('boss_helper_ai_cache_v1');
  cached[target.jobId].pf = cached[target.jobId].pf.replace(/^v\d+\|/, 'v21|');
  f.store.set('boss_helper_ai_cache_v1', cached);
  f.win.localStorage.setItem('boss_helper_ai_cache_v1', JSON.stringify(cached));
  const result = await f.BH.aiScreen(target);
  assert.equal(result.ok, true);
  assert.equal(result.match, true);
  assert.equal(result.cached, false);
  assert.deepEqual(f.postURLs(), [PRIMARY]);
});

test('等待响应期间修改 API 设置使旧结论作废，不写缓存', async (t) => {
  let pending;
  const f = await fixture(t, { cfg: { aiCacheEnabled: true }, gm: (o) => { pending = o; } });
  const run = f.BH.aiScreen(job());
  while (!pending) await delay(0);
  f.BH.state.config.aiEndpoints[0].model = 'changed-model';
  response(pending, 200, good());
  const r = await run;
  assert.equal(r.ok, false);
  assert.equal(r.policyChanged, true);
  assert.equal(f.BH.getAICache(job().jobId), null);
});

test('停止标志在响应后生效且禁止切换下一 API', async (t) => {
  let pending;
  const f = await fixture(t, { gm: (o) => { pending = o; } });
  const run = f.BH.aiScreen(job());
  while (!pending) await delay(0);
  f.BH.state.stopFlag = true;
  response(pending, 503, {});
  const r = await run;
  assert.equal(r.ok, false);
  assert.deepEqual(f.postURLs(), [PRIMARY]);
});

test('连接测试可指定备用 API，健康诊断和错误不泄露密钥', async (t) => {
  const f = await fixture(t);
  await f.BH.testAIConnection({ endpointId: 'backup' });
  assert.deepEqual(f.postURLs(), [BACKUP]);
  const health = JSON.stringify(f.BH.getAIEndpointHealth(f.BH.state.config));
  assert.ok(!health.includes('sk-primary-fixture-secret'));
  assert.ok(!health.includes('sk-backup-fixture-secret'));
  const text = f.win.document.body.textContent;
  assert.ok(!text.includes('sk-primary-fixture-secret'));
  assert.ok(!text.includes('sk-backup-fixture-secret'));
});

test('指定停用 API 的连接测试不调用其他服务', async (t) => {
  const f = await fixture(t);
  f.BH.state.config.aiEndpoints[0].enabled = false;
  const r = await f.BH.testAIConnection({ endpointId: 'backup' });
  assert.equal(r.ok, false);
  assert.equal(f.postURLs().length, 0);
});

test('连接测试自动切换后显示实际成功备用的地址与模型', async (t) => {
  const f = await fixture(t, { gm: (o) => o.url === PRIMARY ? response(o, 401, {}) : response(o, 200, good()) });
  const r = await f.BH.testAIConnection();
  assert.equal(r.ok, true);
  assert.equal(r.endpointId, 'backup');
  const text = f.win.document.body.textContent;
  assert.ok(text.includes(BACKUP), text);
  assert.ok(text.includes('backup-model'), text);
  assert.ok(!text.includes('sk-backup-fixture-secret'));
});

test('拉取备用模型列表的 HTTP 错误回显 Authorization 也会脱敏', async (t) => {
  const f = await fixture(t, { gm: (o) => response(o, 401, { error: { message: `invalid ${o.headers.Authorization}` } }) });
  await f.BH.fetchAIModelList('backup');
  const text = f.win.document.body.textContent;
  assert.ok(/401/.test(text));
  assert.ok(!text.includes('sk-backup-fixture-secret'), text);
  assert.equal(f.postURLs().length, 0, '拉模型只做 GET');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://backup.example/v1/models');
});

for (const fallback of ['local', 'skip', 'pause']) {
  test(`全部 API 断连时 ${fallback} 旧策略均等一分钟后重试完整列表`, async (t) => {
    const f = await fixture(t, { cfg: { aiFallback: fallback }, gm: (o) => response(o, 401, {}) });
    const waiting = f.BH.runAIGate(null, job());
    await until(() => f.postURLs().length === 2, '应先尝试所有接口');
    await delay(350);
    assert.equal(f.postURLs().length, 2, '一分钟内不重复发送请求');
    assert.equal(f.BH.state.paused, false, '临时故障自动等待，不要求人工恢复');
    f.setGM((o) => o.url === PRIMARY ? response(o, 401, {}) : response(o, 200, good()));
    f.time.now += 60001;
    const gate = await waiting;
    assert.equal(gate.action, 'accept');
    assert.deepEqual(f.postURLs(), [PRIMARY, BACKUP, PRIMARY, BACKUP]);
    assert.equal(gate.endpointId, 'backup');
    assert.equal(f.BH.loadStats().aiCalls, 4);
  });
}

test('一分钟等待中停止立即结束且不消耗该职位', async (t) => {
  const f = await fixture(t, { gm: (o) => response(o, 503, {}) });
  const waiting = f.BH.runAIGate(null, job());
  await until(() => f.postURLs().length === 2, '完整尝试后开始等待');
  f.BH.state.stopFlag = true;
  const gate = await waiting;
  assert.equal(gate.action, 'stop');
  assert.deepEqual(f.postURLs(), [PRIMARY, BACKUP]);
});

test('暂停期间即使已到重试时间也不发送请求，继续后重新巡检', async (t) => {
  const f = await fixture(t, { gm: (o) => response(o, 503, {}) });
  const waiting = f.BH.runAIGate(null, job());
  await until(() => f.postURLs().length === 2, '全部接口已尝试');
  f.BH.state.paused = true;
  f.time.now += 60001;
  f.setGM((o) => response(o, 200, good()));
  await delay(350);
  assert.equal(f.postURLs().length, 2, '人工暂停优先于自动重试');
  f.BH.state.paused = false;
  const gate = await waiting;
  assert.equal(gate.action, 'accept');
  assert.deepEqual(f.postURLs(), [PRIMARY, BACKUP, PRIMARY]);
});

test('单接口失败每轮只试一次，不沿用秒级重试', async (t) => {
  const f = await fixture(t, { cfg: { aiEndpoints: [], aiMaxRetries: 3 }, gm: (o) => response(o, 503, {}) });
  const result = await f.BH.aiScreen(job());
  assert.equal(result.apiUnavailable, true);
  assert.equal(result.retryDelayMs, 60000);
  assert.deepEqual(f.postURLs(), [PRIMARY]);
});

test('排队结束后岗位输入已变时不发送冻结旧 JD', async (t) => {
  let held;
  const f = await fixture(t, { gm: (o) => { held = o; } });
  const first = f.BH.aiScreen(job('first-in-queue'));
  await until(() => !!held, '第一份请求应占用串行锁');
  let current = true;
  const queued = f.BH.aiScreen(job('stale-queued-job'), { isCurrentInput: () => current });
  current = false;
  response(held, 200, good());
  const [firstResult, staleResult] = await Promise.all([first, queued]);
  assert.equal(firstResult.ok, true);
  assert.equal(staleResult.inputChanged, true);
  assert.equal(staleResult.ok, false);
  assert.deepEqual(f.postURLs(), [PRIMARY]);
  assert.equal(f.BH.loadStats().aiCalls, 1, '过期的排队输入不领取请求额度');
});

test('领取请求额度期间岗位输入改变也不发送，已领取额度保守保留', async (t) => {
  const f = await fixture(t);
  let current = true;
  const setValue = f.win.GM_setValue;
  f.win.GM_setValue = (key, value) => {
    setValue(key, value);
    if (key.startsWith('boss_helper_daily_event_v22_') && value.kind === 'ai') current = false;
  };
  const result = await f.BH.aiScreen(job(), { isCurrentInput: () => current });
  assert.equal(result.inputChanged, true);
  assert.equal(result.ok, false);
  assert.deepEqual(f.postURLs(), []);
  assert.equal(f.BH.loadStats().aiCalls, 1);
});

test('首接口返回时岗位已改变则交回重读，不尝试备用也不记 API 连续失败', async (t) => {
  let current = true;
  const f = await fixture(t, { gm: (o) => { current = false; response(o, 503, {}); } });
  f.BH.state._aiFailStreak = 0;
  const gate = await f.BH.runAIGate(null, job(), { isCurrentInput: () => current });
  assert.equal(gate.action, 'retry');
  assert.equal(gate.inputChanged, true);
  assert.deepEqual(f.postURLs(), [PRIMARY]);
  assert.equal(f.BH.state._aiFailStreak, 0);
});

test('记录首接口故障后岗位改变，备用接口发送前再次核验输入', async (t) => {
  const f = await fixture(t, { gm: (o) => response(o, 503, {}) });
  let current = true;
  const setValue = f.win.GM_setValue;
  f.win.GM_setValue = (key, value) => {
    setValue(key, value);
    if (key === 'boss_helper_ai_health_v1') current = false;
  };
  const result = await f.BH.aiScreen(job(), { isCurrentInput: () => current });
  assert.equal(result.inputChanged, true);
  assert.deepEqual(f.postURLs(), [PRIMARY]);
  assert.equal(f.BH.loadStats().aiCalls, 1);
});

test('成功响应属于已变更输入时不缓存且不返回可投递结论', async (t) => {
  let held, current = true;
  const f = await fixture(t, { cfg: { aiCacheEnabled: true }, gm: (o) => { held = o; } });
  const waiting = f.BH.runAIGate(null, job(), { isCurrentInput: () => current });
  await until(() => !!held, '请求应已发出');
  current = false;
  response(held, 200, good());
  const gate = await waiting;
  assert.equal(gate.action, 'retry');
  assert.equal(f.BH.getAICache(job().jobId), null);
  assert.deepEqual(f.postURLs(), [PRIMARY]);
});

test('一分钟重试等待中岗位输入改变及时交回重读，不重复发送旧 JD', async (t) => {
  let current = true;
  const f = await fixture(t, { gm: (o) => response(o, 503, {}) });
  f.BH.state._aiFailStreak = 0;
  const waiting = f.BH.runAIGate(null, job(), { isCurrentInput: () => current });
  await until(() => f.BH.state._aiFailStreak === 1, '完整接口轮已失败并进入等待');
  current = false;
  const gate = await waiting;
  assert.equal(gate.action, 'retry');
  assert.deepEqual(f.postURLs(), [PRIMARY, BACKUP]);
  assert.equal(f.BH.state._aiFailStreak, 1, '输入变化不额外计入 API 失败');
});

test('领取额度后暂停时不调用输入 guard，恢复后同一岗位继续请求', async (t) => {
  const f = await fixture(t);
  let pausedDuringQuota = false, settled = false;
  const setValue = f.win.GM_setValue;
  f.win.GM_setValue = (key, value) => {
    setValue(key, value);
    if (!pausedDuringQuota && key.startsWith('boss_helper_daily_event_v22_') && value.kind === 'ai') {
      pausedDuringQuota = true;
      f.BH.state.paused = true;
    }
  };
  const waiting = f.BH.runAIGate(null, job(), { isCurrentInput: () => {
    assert.equal(f.BH.state.paused, false, '暂停不能被误判成岗位输入变化');
    return true;
  } }).then((gate) => { settled = true; return gate; });
  await until(() => pausedDuringQuota, '领取额度应触发暂停');
  await delay(350);
  assert.equal(settled, false);
  assert.deepEqual(f.postURLs(), []);
  f.BH.state.paused = false;
  const gate = await waiting;
  assert.equal(gate.action, 'accept');
  assert.deepEqual(f.postURLs(), [PRIMARY]);
});

test('自动重试的人工暂停期间不读取 input guard，恢复同岗后正常继续', async (t) => {
  const f = await fixture(t, { gm: (o) => response(o, 503, {}) });
  const waiting = f.BH.runAIGate(null, job(), { isCurrentInput: () => {
    assert.equal(f.BH.state.paused, false);
    return true;
  } });
  await until(() => f.BH.state._aiFailStreak === 1, '应进入自动重试等待');
  f.BH.state.paused = true;
  f.time.now += 60001;
  f.setGM((o) => response(o, 200, good()));
  await delay(350);
  assert.deepEqual(f.postURLs(), [PRIMARY, BACKUP]);
  f.BH.state.paused = false;
  const gate = await waiting;
  assert.equal(gate.action, 'accept');
  assert.deepEqual(f.postURLs(), [PRIMARY, BACKUP, PRIMARY]);
});
