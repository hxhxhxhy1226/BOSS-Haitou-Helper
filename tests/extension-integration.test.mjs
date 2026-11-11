import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const require = createRequire(import.meta.url);
const { createBossNativeBackground } = require('../extension/background.js');
const sources = ['platform.js', 'helper.js', 'content.js'].map((name) => fs.readFileSync(new URL('../extension/' + name, import.meta.url), 'utf8'));
const extensionVersion = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8')).version;
const CONFIG = 'boss_helper_config_v1';
const STATS = 'boss_helper_stats_v1';
const ID = 'native-integration-fixture';
const BASE_CONFIG = {
  mustHave: [], mustNot: [], yearsMin: 0, eduMin: 0, salaryMin: 0, activeDays: 0,
  dailyLimit: 2, autoSend: true, autoScroll: false, minDelay: 0.5, maxDelay: 0.5,
  batchSize: 20, batchPauseSec: 0, maxRounds: 1,
  aiEnabled: false, aiPrimaryEnabled: true, aiBaseUrl: 'https://api.example/v1/chat/completions',
  aiApiKey: 'fixture-native-only-key', aiModel: 'fixture-model', aiDailyLimit: 10, aiMaxRetries: 0,
  aiFallback: 'skip', aiUserPortrait: '寻找 STM32、FreeRTOS 嵌入式软件研发岗位', aiEndpoints: [],
};
const DETAIL = `<section class="job-detail" data-jobid="202611">
  <header class="job-banner"><h1 class="job-name">嵌入式软件工程师</h1>
    <a class="company-name" href="/gongsi/fixture.html">测试研发公司</a><span class="salary">20-30K</span>
    <a class="job-detail-link" href="/job_detail/nativeFixture.html">查看职位</a>
    <a class="op-btn-chat" href="javascript:void(0)">立即沟通</a></header>
  <section class="job-detail-section"><h2>职位描述</h2>
    <div class="job-sec-text">负责 STM32 控制器固件研发、FreeRTOS 驱动调试和设备通信协议开发，参与产品量产维护和接口联调。</div></section>
  <div class="boss-info"><span class="active-time">今日活跃</span></div></section>`;
const clone = (value) => value == null ? value : structuredClone(value);
async function until(condition, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!condition()) { assert.ok(Date.now() < end, 'Native integration operation timed out'); await delay(10); }
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

function environment(t, options = {}) {
  const data = { [CONFIG]: clone({ ...BASE_CONFIG, ...options.config }) };
  const storageListeners = new Set(), requests = [], messages = [], pages = [];
  let number = 0, hydrateGate = null, configGate = null, deliveryGate = null, clickMarkGate = null, diagnosticGate = null, networkGate = null;
  let failConfig = false, configAttempts = 0, deliveryAttempts = 0, diagnosticAttempts = 0;
  const api = {
    runtime: { id: ID, getURL: (resource) => `chrome-extension://${ID}/${resource}` },
    permissions: { contains: async () => options.permission !== false },
    storage: {
      onChanged: { addListener: (listener) => storageListeners.add(listener) },
      local: {
        async get(keys) {
          if (hydrateGate) await hydrateGate;
          const names = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((key) => Object.hasOwn(data, key)).map((key) => [key, clone(data[key])]));
        },
        async set(values) {
          if (Object.hasOwn(values, CONFIG)) {
            configAttempts++;
            if (configGate) await configGate;
            if (failConfig) throw Error('Simulated configuration persistence failure');
          }
          if (Object.values(values).some((value) => value?.kind === 'sent' && value?.status === 'dispatched')) {
            deliveryAttempts++;
            if (deliveryGate) await deliveryGate;
            if (clickMarkGate && Object.values(values).some((value) => value?.clickPending === false)) await clickMarkGate;
          }
          if (Object.hasOwn(values, STATS)) {
            diagnosticAttempts++;
            if (diagnosticGate) await diagnosticGate;
          }
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
            data[key] = clone(value);
          }
          for (const listener of storageListeners) listener(clone(changes), 'local');
        },
        async remove(keys) {
          const changes = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) { changes[key] = { oldValue: clone(data[key]) }; delete data[key]; }
          for (const listener of storageListeners) listener(clone(changes), 'local');
        },
      },
    },
  };
  const worker = createBossNativeBackground(api, { uuid: () => 'event-' + (++number),
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (networkGate) await networkGate;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"match":true,"score":95,"reason":"岗位方向匹配"}' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  function page({ url = 'https://www.zhipin.com/web/geek/job', html = DETAIL } = {}) {
    const errors = [], listeners = [], tabId = pages.length + 1;
    const console = new VirtualConsole();
    console.on('jsdomError', (error) => errors.push(error.message));
    const dom = new JSDOM(`<!doctype html><html><head><style>body * { opacity: 1; }</style></head><body>${html}</body></html>`, {
      url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console,
    });
    const win = dom.window, doc = win.document;
    let clicks = 0, historyBack = 0;
    win.fetch = () => assert.fail('AI network must use the native extension worker, never window.fetch');
    win.Headers = Headers;
    win.Response = Response;
    win.AbortController = AbortController;
    win.chrome = { ...api, runtime: { ...api.runtime,
      getManifest: () => ({ version: extensionVersion }),
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage(message) {
        messages.push({ tabId, action: message.action });
        return worker.handle(message, { id: ID, url: win.location.href, frameId: 0, tab: { id: tabId }, documentId: 'document-' + tabId });
      },
      connect: () => ({ onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} }),
    } };
    win.history.back = () => { historyBack++; };
    doc.querySelector('.op-btn-chat')?.addEventListener('click', (event) => { event.preventDefault(); clicks++; });
    const hidden = (el) => !!el.closest('[hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"]');
    Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { get() { return hidden(this) ? 0 : 600; } });
    Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { get() { return hidden(this) ? 0 : 300; } });
    win.Element.prototype.getBoundingClientRect = function () { const width = hidden(this) ? 0 : 600; return { left: 600, top: 180, width, height: width / 2, right: 600 + width, bottom: 180 + width / 2 }; };
    win.Element.prototype.getClientRects = function () { return hidden(this) ? [] : [this.getBoundingClientRect()]; };
    const result = { win, doc, errors, clicks: () => clicks, historyBack: () => historyBack,
      field: (name) => doc.querySelector('#boss-helper-panel [data-cfg="' + name + '"]'),
      action: (name) => doc.querySelector('[data-act="' + name + '"]').click(),
      logs: () => doc.querySelector('.bh-log')?.textContent || '',
      toolbar: (action) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('Toolbar message timed out')), 1000);
        for (const listener of listeners) listener({ type: 'BH_UI', action }, { id: ID, url: `chrome-extension://${ID}/popup.html` }, (response) => {
          clearTimeout(timeout); resolve(response);
        });
      }),
    };
    pages.push(result);
    for (const source of sources) win.eval(source);
    result.ready = until(() => win.BH && doc.getElementById('boss-helper-panel'));
    return result;
  }
  t.after(() => { storageListeners.clear(); for (const page of pages) { if (page.win.BH) page.win.BH.state.stopFlag = true; page.win.close(); } });
  return { data, requests, messages, worker, page,
    get configAttempts() { return configAttempts; },
    get deliveryAttempts() { return deliveryAttempts; },
    get diagnosticAttempts() { return diagnosticAttempts; },
    set hydrateGate(value) { hydrateGate = value; }, set configGate(value) { configGate = value; }, set failConfig(value) { failConfig = value; },
    set deliveryGate(value) { deliveryGate = value; },
    set clickMarkGate(value) { clickMarkGate = value; },
    set diagnosticGate(value) { diagnosticGate = value; }, set networkGate(value) { networkGate = value; },
  };
}

test('native scripts await hydration, keep credentials out of page storage and do not auto-contact on detail load', { timeout: 7000 }, async (t) => {
  const f = environment(t), gate = deferred();
  f.hydrateGate = gate.promise;
  const page = f.page({ url: 'https://www.zhipin.com/job_detail/nativeFixture.html' });
  await delay(20);
  assert.equal(page.win.BH, undefined);
  assert.equal(page.clicks(), 0);
  gate.resolve(); f.hydrateGate = null; await page.ready;
  assert.equal(page.win.BH.loadConfig().aiApiKey, BASE_CONFIG.aiApiKey);
  assert.equal(page.win.localStorage.length, 0);
  assert.equal(page.win.BH.state.running, false);
  assert.equal(page.win.BH.state.stopFlag, true);
  await delay(2150);
  assert.equal(page.clicks(), 0);
  assert.equal(f.requests.length, 0);
  assert.equal(page.win.BH.loadStats().sent, 0);
  assert.equal(page.historyBack(), 0);
  assert.deepEqual(page.errors, []);
});

test('native save announces success and changes active configuration only after the worker persists it', async (t) => {
  const f = environment(t), page = f.page(); await page.ready;
  const gate = deferred(); f.configGate = gate.promise;
  page.field('dailyLimit').value = '150';
  page.field('dailyLimit').dispatchEvent(new page.win.Event('input', { bubbles: true }));
  page.action('save'); await until(() => f.configAttempts === 1);
  assert.equal(f.data[CONFIG].dailyLimit, 2);
  assert.notEqual(page.win.BH.state.config?.dailyLimit, 150);
  assert.doesNotMatch(page.logs(), /配置已保存/);
  gate.resolve(); f.configGate = null;
  await until(() => /配置已保存/.test(page.logs()));
  assert.equal(f.data[CONFIG].dailyLimit, 150);
  assert.equal(page.win.BH.state.config.dailyLimit, 150);
  assert.equal(page.doc.querySelector('[data-stat="limit"]').textContent, '150');
  assert.equal(page.win.localStorage.getItem(CONFIG), null);
});

test('failed native persistence cannot announce success or start a delivery task', async (t) => {
  const f = environment(t), page = f.page(); await page.ready;
  f.failConfig = true;
  page.field('dailyLimit').value = '150';
  page.action('save'); await until(() => /配置保存失败/.test(page.logs()));
  assert.equal(f.data[CONFIG].dailyLimit, 2);
  assert.doesNotMatch(page.logs(), /配置已保存/);
  page.action('toggle'); await until(() => /启动失败/.test(page.logs()));
  assert.equal(page.win.BH.state.running, false);
  assert.equal(page.win.BH.state.stopFlag, true);
  assert.equal(page.clicks(), 0);
  assert.equal(f.requests.length, 0);
  assert.equal(page.win.localStorage.length, 0);
});

test('toolbar visibility messages work and stopping while a start is awaiting storage prevents later execution', async (t) => {
  const f = environment(t), page = f.page(); await page.ready;
  assert.equal((await page.toolbar('status')).visible, true);
  assert.equal((await page.toolbar('toggle-panel')).visible, false);
  assert.equal(page.doc.getElementById('boss-helper-panel').hidden, true);
  assert.equal((await page.toolbar('toggle-panel')).visible, true);
  const gate = deferred(); f.configGate = gate.promise;
  page.action('toggle'); await until(() => f.configAttempts === 1);
  const stopped = await page.toolbar('stop');
  assert.equal(stopped.ok, true);
  assert.equal(stopped.running, false);
  gate.resolve(); f.configGate = null; await page.win.BHNative.flush(); await delay(20);
  assert.equal(page.win.BH.state.running, false);
  assert.equal(page.win.BH.state.stopFlag, true);
  assert.equal(page.clicks(), 0);
  assert.equal(f.requests.length, 0);
});

test('idle AI connection test reaches the native background and does not start delivery or expose credentials to the page', async (t) => {
  const f = environment(t), page = f.page(); await page.ready;
  page.action('aiopen');
  const result = await page.win.BH.testAIConnection();
  assert.equal(result.ok, true, result.err);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, BASE_CONFIG.aiBaseUrl);
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer ' + BASE_CONFIG.aiApiKey);
  assert.equal(f.requests[0].init.credentials, 'omit');
  assert.ok(f.messages.some((message) => message.action === 'network.fetch'));
  assert.equal(page.win.BH.state.running, false);
  assert.equal(page.win.BH.state.stopFlag, true);
  assert.equal(page.clicks(), 0);
  assert.equal(page.win.localStorage.length, 0);
  assert.doesNotMatch(page.logs(), /fixture-native-only-key/);
});

test('missing AI host permission is visible through the complete native helper test flow and sends no network request', async (t) => {
  const f = environment(t, { permission: false }), page = f.page(); await page.ready;
  page.action('aiopen');
  const result = await page.win.BH.testAIConnection();
  assert.equal(result.ok, false);
  assert.match(result.err, /授权/);
  assert.ok(f.messages.some((message) => message.action === 'network.fetch'));
  assert.equal(f.requests.length, 0);
  assert.equal(page.win.BH.state.running, false);
  assert.equal(page.win.BH.state.stopFlag, true);
  assert.equal(page.clicks(), 0);
});

test('two native helper tabs share saved rules and a single remaining delivery reservation', async (t) => {
  const f = environment(t), first = f.page(), second = f.page({ url: 'https://www.zhipin.cn/web/geek/job' });
  await Promise.all([first.ready, second.ready]);
  first.field('dailyLimit').value = '1';
  first.action('save'); await until(() => /配置已保存/.test(first.logs()));
  assert.equal(second.field('dailyLimit').value, '1');
  assert.equal(second.win.BH.loadConfig().dailyLimit, 1);
  second.field('dailyLimit').value = '17';
  second.field('dailyLimit').dispatchEvent(new second.win.Event('input', { bubbles: true }));
  first.field('mustNot').value = '客户销售';
  first.action('save'); await first.win.BHNative.flush();
  assert.equal(second.win.BH.loadConfig().mustNot[0], '客户销售');
  assert.equal(second.field('dailyLimit').value, '17', 'Another tab save must not discard a local unsaved draft');
  const reservations = await Promise.all([
    first.win.BH.reserveDelivery('native-tab-one', 1),
    second.win.BH.reserveDelivery('native-tab-two', 1),
  ]);
  assert.equal(reservations.filter(Boolean).length, 1);
  assert.equal(first.win.BH.loadStats().pending, 1);
  assert.equal(second.win.BH.loadStats().pending, 1);
  assert.equal(first.win.localStorage.length, 0);
  assert.equal(second.win.localStorage.length, 0);
});

test('explicit native detail start waits for durable quota commit before dispatching the official click', { timeout: 20000 }, async (t) => {
  const f = environment(t), page = f.page({ url: 'https://www.zhipin.com/job_detail/nativeFixture.html' });
  await page.ready;
  const gate = deferred(); f.deliveryGate = gate.promise;
  let atClick;
  page.doc.querySelector('.op-btn-chat').addEventListener('click', () => {
    atClick = f.worker.stats(f.data);
    const dialog = page.doc.createElement('div');
    dialog.className = 'boss-dialog';
    dialog.innerHTML = '<h2 class="dialog-title">已向BOSS发送消息</h2><button>留在此页</button>';
    page.doc.body.append(dialog);
    page.win.BH.stop('Fixture observed one official click');
  });
  page.action('toggle');
  await until(() => f.deliveryAttempts === 1 || /异常|启动失败/.test(page.logs()), 12000);
  assert.equal(f.deliveryAttempts, 1, page.logs());
  assert.equal(page.clicks(), 0);
  assert.equal(f.worker.stats(f.data).sent, 0);
  assert.equal(f.worker.stats(f.data).pending, 1);
  gate.resolve(); f.deliveryGate = null;
  await until(() => page.clicks() === 1, 4000);
  assert.equal(atClick.sent, 1, 'The quota record must already be durable at the actual click');
  assert.equal(atClick.pending, 0);
  assert.equal(page.win.BH.loadStats().sent, 1);
  assert.equal(f.requests.length, 0);
  assert.equal(page.win.localStorage.length, 0);
});

for (const change of ['stop', 'replace-button', 'change-job']) {
  test(`native AI delivery handles ${change} while quota persistence is pending`, { timeout: 20000 }, async (t) => {
    const f = environment(t, { config: { aiEnabled: true } });
    const page = f.page({ url: 'https://www.zhipin.com/job_detail/nativeFixture.html' });
    await page.ready;
    const gate = deferred(); f.deliveryGate = gate.promise;
    page.action('toggle');
    await until(() => f.deliveryAttempts === 1, 12000);
    assert.match(page.logs(), /AI 通过/);
    assert.equal(page.clicks(), 0);
    assert.equal(f.worker.stats(f.data).sent, 0);
    let replacementClicks = 0;
    if (change === 'stop') page.win.BH.stop('fixture stop before activation');
    if (change === 'change-job') page.doc.querySelector('.job-sec-text').textContent = '此职位已更新为销售岗位，与刚才的研发职位不同。';
    if (change === 'replace-button') {
      const original = page.doc.querySelector('.op-btn-chat');
      const replacement = original.cloneNode(true);
      replacement.addEventListener('click', (event) => {
        event.preventDefault(); replacementClicks++;
        assert.equal(f.worker.stats(f.data).sent, 1, 'Quota must be durable before the latest button is activated');
        page.doc.body.insertAdjacentHTML('beforeend', '<div class="boss-dialog">已向BOSS发送消息</div>');
        page.win.BH.stop('fixture activated latest button');
      });
      original.replaceWith(replacement);
    }
    gate.resolve(); f.deliveryGate = null;
    await until(() => page.win.BH.state._loopActive === false);
    const records = Object.values(f.data).filter((event) => event?.kind === 'sent');
    assert.equal(records.length, 1);
    assert.equal(page.clicks(), 0, 'A detached old button must never receive the click');
    assert.equal(f.requests.length, 1, 'Recovering an equivalent button must reuse the completed AI decision');
    if (change === 'replace-button') {
      assert.equal(replacementClicks, 1);
      assert.equal(f.worker.stats(f.data).sent, 1);
      assert.equal(records[0].clickPending, false);
      assert.ok(records[0].clickedAt);
      assert.match(page.logs(), /官方已确认沟通/);
      assert.equal(await page.win.BH.reserveDelivery('nativeFixture', 2), false);
    } else {
      assert.equal(replacementClicks, 0);
      assert.equal(f.worker.stats(f.data).sent, 0);
      assert.equal(f.worker.stats(f.data).pending, 0);
      assert.equal(records[0].status, 'cancelled');
      assert.doesNotMatch(page.logs(), /已发起沟通，待确认/);
      const retry = await page.win.BH.reserveDelivery('nativeFixture', 2);
      assert.ok(retry, 'An activation that never happened must not permanently block this job');
      await page.win.BH.releaseDelivery(retry);
    }
    assert.equal(page.win.localStorage.length, 0);
    assert.deepEqual(page.errors, []);
  });
}

test('a brief official success notice is captured while marking the click is blocked on storage', { timeout: 12000 }, async (t) => {
  const f = environment(t), page = f.page({ url: 'https://www.zhipin.com/job_detail/nativeFixture.html' });
  await page.ready;
  const gate = deferred(); f.clickMarkGate = gate.promise;
  let notice;
  page.doc.querySelector('.op-btn-chat').addEventListener('click', () => {
    notice = page.doc.createElement('div'); notice.className = 'toast'; notice.textContent = '招呼已发送';
    page.doc.body.append(notice);
  });
  page.action('toggle');
  await until(() => f.deliveryAttempts === 2, 7000);
  assert.equal(page.clicks(), 1);
  assert.equal(f.worker.stats(f.data).sent, 1);
  notice.remove();
  gate.resolve(); f.clickMarkGate = null;
  await until(() => page.win.BH.state._loopActive === false);
  assert.match(page.logs(), /官方已确认沟通/);
  assert.doesNotMatch(page.logs(), /已发起沟通，待确认/);
  assert.equal(page.clicks(), 1);
});

test('stopping cancels an AI connection test already queued behind another test before it can send a second request', async (t) => {
  const f = environment(t), page = f.page(); await page.ready;
  page.action('aiopen');
  const gate = deferred(); f.networkGate = gate.promise;
  const first = page.win.BH.testAIConnection();
  const queued = page.win.BH.testAIConnection();
  await until(() => f.requests.length === 1);
  assert.equal((await page.toolbar('stop')).ok, true);
  gate.resolve(); f.networkGate = null;
  const results = await Promise.all([first, queued]);
  assert.ok(results.every((result) => result.ok === false && /已停止/.test(result.err)));
  assert.equal(f.requests.length, 1, 'The queued test must retain the generation from when it was requested');
  assert.equal(f.messages.filter((message) => message.action === 'network.fetch').length, 1);
  assert.equal(f.worker.stats(f.data).aiCalls, 1);
  assert.equal(page.win.BH.state.running, false);
  assert.equal(page.win.BH.state.stopFlag, true);
});

test('another tab diagnostic event cannot apply an optimistic configuration before its pending save is durable', async (t) => {
  const f = environment(t), page = f.page(), other = f.page({ url: 'https://www.zhipin.cn/web/geek/job' });
  await Promise.all([page.ready, other.ready]);
  await page.win.BH.applyConfig(page.win.BH.loadConfig());
  assert.equal(page.win.BH.state.config.dailyLimit, 2);
  const configBaseline = f.configAttempts;
  const diagnosticGate = deferred(), configGate = deferred();
  f.diagnosticGate = diagnosticGate.promise;
  f.configGate = configGate.promise;
  other.win.BHNative.setValue(STATS, { ...other.win.BH.loadStats(), processed: 1 });
  await until(() => f.diagnosticAttempts > 0);
  page.field('dailyLimit').value = '150';
  page.field('dailyLimit').dispatchEvent(new page.win.Event('input', { bubbles: true }));
  page.action('save');
  await until(() => page.win.BHNative.getValue(CONFIG).dailyLimit === 150);
  assert.equal(page.win.BH.state.config.dailyLimit, 2);
  diagnosticGate.resolve(); f.diagnosticGate = null;
  await until(() => f.configAttempts > configBaseline && page.win.BH.loadStats().processed === 1);
  assert.equal(f.data[CONFIG].dailyLimit, 2, 'Configuration storage is still blocked');
  assert.equal(page.win.BHNative.getValue(CONFIG).dailyLimit, 150, 'The platform has a pending optimistic mirror');
  assert.equal(page.win.BH.state.config.dailyLimit, 2, 'Diagnostic changes must not apply the optimistic mirror');
  assert.doesNotMatch(page.logs(), /配置已保存/);
  configGate.resolve(); f.configGate = null;
  await until(() => /配置已保存/.test(page.logs()));
  assert.equal(f.data[CONFIG].dailyLimit, 150);
  assert.equal(page.win.BH.state.config.dailyLimit, 150);
});
