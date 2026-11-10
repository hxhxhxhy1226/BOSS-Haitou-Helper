import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const code = fs.readFileSync(SCRIPT, 'utf8');
const STATS = 'boss_helper_stats_v1';
const clone = (v) => v == null ? v : JSON.parse(JSON.stringify(v));
const localStore = (map) => ({
  get length() { return map.size; },
  key(i) { return [...map.keys()][i] ?? null; },
  getItem(k) { return map.get(k) ?? null; },
  setItem(k, v) { map.set(k, String(v)); },
  removeItem(k) { map.delete(k); },
  clear() { map.clear(); },
});
function webLocks() {
  let tail = Promise.resolve();
  return { request(_name, fn) { const task = tail.then(fn); tail = task.catch(() => {}); return task; } };
}
function fixture(t, { gm = new Map(), local = new Map(), failGM = false, failLocal = false,
  listValues = true, locks = webLocks(), clock = {}, html = '', url = 'https://www.zhipin.com/web/geek/job?query=fixture' } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  const NativeDate = win.Date;
  win.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [Date.now() + (clock.offset || 0)])); }
    static now() { return Date.now() + (clock.offset || 0); }
  };
  win.GM_getValue = (k, d) => { if (failGM) throw Error('GM unavailable'); return gm.has(k) ? clone(gm.get(k)) : d; };
  win.GM_setValue = (k, v) => { if (failGM) throw Error('GM unavailable'); gm.set(k, clone(v)); };
  if (listValues) win.GM_listValues = () => [...gm.keys()];
  win.GM_deleteValue = (k) => { if (failGM) throw Error('GM unavailable'); gm.delete(k); };
  win.GM_addStyle = () => {};
  win.GM_xmlhttpRequest = () => assert.fail('Daily quota tests must never contact a server');
  win.fetch = () => assert.fail('Daily quota tests must never contact a server');
  win.unsafeWindow = win;
  Object.defineProperty(win, 'localStorage', { value: failLocal ? {
    getItem() { throw Error('local blocked'); }, setItem() { throw Error('local blocked'); },
    get length() { throw Error('local blocked'); },
  } : localStore(local) });
  if (locks) Object.defineProperty(win.navigator, 'locks', { value: locks });
  win.eval(code);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  t.after(() => dom.window.close());
  return { dom, win, BH: win.BH, gm, local, clock };
}
const seed = (f, value) => f.gm.set(STATS, { schema: 22, date: f.BH.todayKey(), sent: 0, processed: 0, skipped: 0, aiCalls: 0, aiHits: 0, ...value });

test('刷新和重新打开恢复今日投递与 AI 次数，重置只清诊断', async (t) => {
  const gm = new Map(), local = new Map();
  const a = fixture(t, { gm, local });
  seed(a, { sent: 30, aiCalls: 35, processed: 40, skipped: 10 });
  assert.equal(a.BH.loadStats().sent, 30);
  assert.equal(a.BH.resetStats().sent, 30);
  assert.equal(a.BH.loadStats().aiCalls, 35);
  assert.equal(a.BH.loadStats().processed, 0);
  a.dom.window.close();
  const b = fixture(t, { gm, local });
  assert.equal(b.BH.loadStats().sent, 30);
  assert.equal(b.BH.loadStats().aiCalls, 35);
  assert.equal(b.win.document.querySelector('[data-stat="sent"]').textContent, '30');
});

test('重新开始不会清零每日额度', async (t) => {
  const f = fixture(t);
  seed(f, { sent: 120, aiCalls: 80 });
  f.win.document.querySelector('[data-act="toggle"]').click();
  assert.equal(f.BH.loadStats().sent, 120);
  assert.equal(f.BH.loadStats().aiCalls, 80);
});

test('GM 异常时使用 localStorage，刷新后继续累计', async (t) => {
  const local = new Map();
  const a = fixture(t, { failGM: true, local });
  assert.equal(a.BH.saveStats({ ...a.BH.loadStats(), sent: 30, aiCalls: 31 }), true);
  const b = fixture(t, { failGM: true, local });
  assert.equal(b.BH.loadStats().sent, 30);
  assert.equal(await b.BH.consumeAIDailyQuota(32), true);
  const c = fixture(t, { failGM: true, local });
  assert.equal(c.BH.loadStats().aiCalls, 32);
  assert.equal(await c.BH.consumeAIDailyQuota(32), false);
});

test('GM 与本地副本不一致时保留较大额度，旧快照不能覆盖新计数', async (t) => {
  const f = fixture(t);
  seed(f, { sent: 30, aiCalls: 40 });
  f.local.set(STATS, JSON.stringify({ date: f.BH.todayKey(), schema: 22, sent: 5, aiCalls: 3 }));
  assert.equal(f.BH.loadStats().sent, 30);
  assert.equal(f.BH.loadStats().aiCalls, 40);
  assert.equal(f.BH.saveStats({ ...f.BH.loadStats(), sent: 0, aiCalls: 0, processed: 1 }), true);
  assert.equal(f.BH.loadStats().sent, 30);
  assert.equal(f.BH.loadStats().aiCalls, 40);
});

test('北京时间零点换日，上午八点不重置', async (t) => {
  const clock = { offset: Date.parse('2026-11-10T15:59:00Z') - Date.now() };
  const f = fixture(t, { clock });
  seed(f, { sent: 30, aiCalls: 35 });
  assert.equal(f.BH.todayKey(), '2026-11-10');
  clock.offset = Date.parse('2026-11-10T16:01:00Z') - Date.now();
  assert.equal(f.BH.todayKey(), '2026-11-11');
  assert.equal(f.BH.loadStats().sent, 0);
  assert.equal(await f.BH.consumeAIDailyQuota(120), true);
  clock.offset = Date.parse('2026-11-11T00:01:00Z') - Date.now();
  assert.equal(f.BH.todayKey(), '2026-11-11');
  assert.equal(f.BH.loadStats().aiCalls, 1);
});

test('凌晨升级迁移旧 UTC 日期，换日后不再重复迁移', async (t) => {
  const clock = { offset: Date.parse('2026-11-10T17:00:00Z') - Date.now() };
  const f = fixture(t, { clock });
  f.gm.set(STATS, { date: '2026-11-10', sent: 30, aiCalls: 31 });
  assert.equal(f.BH.loadStats().date, '2026-11-11');
  assert.equal(f.BH.loadStats().sent, 30);
  clock.offset = Date.parse('2026-11-11T17:00:00Z') - Date.now();
  assert.equal(f.BH.loadStats().date, '2026-11-12');
  assert.equal(f.BH.loadStats().sent, 0);
});

test('第 120 次点击前持久化：弹窗等待或刷新都不会漏记，重复提交不加两次', async (t) => {
  const gm = new Map(), local = new Map();
  const a = fixture(t, { gm, local });
  seed(a, { sent: 119 });
  const slot = await a.BH.reserveDelivery('job-120', 120);
  assert.ok(slot);
  assert.equal(a.BH.loadStats().sent, 119);
  assert.equal(a.BH.loadStats().pending, 1);
  assert.equal(await a.BH.reserveDelivery('job-121', 120), false);
  assert.equal(a.BH.dispatchDelivery(slot), true);
  assert.equal(a.BH.dispatchDelivery(slot), true);
  a.BH.releaseDelivery(slot);
  assert.equal(a.BH.loadStats().sent, 120);
  a.dom.window.close();
  const b = fixture(t, { gm, local });
  assert.equal(b.BH.loadStats().sent, 120);
  assert.equal(await b.BH.reserveDelivery('job-121', 120), false);
});

test('点击前取消释放预留；已派发后停止仍保留额度', async (t) => {
  const f = fixture(t);
  const cancelled = await f.BH.reserveDelivery('cancelled-job', 1);
  assert.ok(cancelled);
  f.BH.releaseDelivery(cancelled);
  assert.equal(f.BH.loadStats().pending, 0);
  assert.equal(f.BH.loadStats().sent, 0);
  const dispatched = await f.BH.reserveDelivery('different-job', 1);
  assert.ok(dispatched);
  f.BH.dispatchDelivery(dispatched);
  f.BH.releaseDelivery(dispatched);
  assert.equal(f.BH.loadStats().sent, 1);
  assert.equal(await f.BH.reserveDelivery('third-job', 1), false);
});

test('跨标签并发争抢最后一个名额时仅一个成功', async (t) => {
  const gm = new Map(), local = new Map(), locks = webLocks();
  const a = fixture(t, { gm, local, locks }), b = fixture(t, { gm, local, locks });
  seed(a, { sent: 119 });
  const results = await Promise.all([a.BH.reserveDelivery('job-a', 120), b.BH.reserveDelivery('job-b', 120)]);
  assert.equal(results.filter(Boolean).length, 1);
  const slot = results.find(Boolean);
  (results[0] ? a : b).BH.dispatchDelivery(slot);
  assert.equal(a.BH.loadStats().sent, 120);
  assert.equal(b.BH.loadStats().sent, 120);
});

test('跨 .com/.cn GM 共享额度，不依赖同域 localStorage', async (t) => {
  const gm = new Map();
  const a = fixture(t, { gm, locks: null }), b = fixture(t, { gm, locks: null, url: 'https://www.zhipin.cn/web/geek/job' });
  seed(a, { sent: 119 });
  const slots = await Promise.all([a.BH.reserveDelivery('job-a', 120), b.BH.reserveDelivery('job-b', 120)]);
  assert.equal(slots.filter(Boolean).length, 1);
  (slots[0] ? a : b).BH.dispatchDelivery(slots.find(Boolean));
  assert.equal(a.BH.loadStats().sent, 120);
  assert.equal(b.BH.loadStats().sent, 120);
});

test('多个已预留名额同时提交时日记条目不会互相覆盖', async (t) => {
  const gm = new Map(), local = new Map(), locks = webLocks();
  const a = fixture(t, { gm, local, locks }), b = fixture(t, { gm, local, locks });
  const [sa, sb] = await Promise.all([a.BH.reserveDelivery('job-a', 120), b.BH.reserveDelivery('job-b', 120)]);
  assert.ok(sa); assert.ok(sb);
  a.BH.dispatchDelivery(sa); b.BH.dispatchDelivery(sb);
  assert.equal(a.BH.loadStats().sent, 2);
  assert.equal(b.BH.loadStats().sent, 2);
});

test('同一职位当日防重复；未点击预留过期后可重试', async (t) => {
  const clock = {};
  const f = fixture(t, { clock });
  const s = await f.BH.reserveDelivery('same-job', 120);
  assert.equal(await f.BH.reserveDelivery('same-job', 120), false);
  clock.offset = 61000;
  const retry = await f.BH.reserveDelivery('same-job', 120);
  assert.ok(retry);
  assert.equal(f.BH.dispatchDelivery(s), false);
  f.BH.dispatchDelivery(retry);
  assert.equal(await f.BH.reserveDelivery('same-job', 120), false);
  assert.equal(f.BH.loadStats().sent, 1);
});

test('每次 AI 实际请求都占额度，并发不会超限', async (t) => {
  const gm = new Map(), local = new Map(), locks = webLocks();
  const a = fixture(t, { gm, local, locks }), b = fixture(t, { gm, local, locks });
  seed(a, { aiCalls: 119 });
  const result = await Promise.all([a.BH.consumeAIDailyQuota(120), b.BH.consumeAIDailyQuota(120)]);
  assert.deepEqual(result.sort(), [false, true]);
  assert.equal(a.BH.loadStats().aiCalls, 120);
  assert.equal(b.BH.resetStats().aiCalls, 120);
});

test('没有 GM_listValues 的兼容环境仍通过持久化索引恢复条目', async (t) => {
  const gm = new Map();
  const a = fixture(t, { gm, failLocal: true, listValues: false });
  assert.equal(await a.BH.consumeAIDailyQuota(120), true);
  const slot = await a.BH.reserveDelivery('only-gm-job', 120);
  a.BH.dispatchDelivery(slot);
  const b = fixture(t, { gm, failLocal: true, listValues: false });
  assert.equal(b.BH.loadStats().sent, 1);
  assert.equal(b.BH.loadStats().aiCalls, 1);
});

test('GM 与 localStorage 均不可写时禁止投递和 AI 付费请求', async (t) => {
  const f = fixture(t, { failGM: true, failLocal: true });
  assert.equal(f.BH.statsPersistenceAvailable(), false);
  assert.equal(await f.BH.reserveDelivery('job', 120), false);
  assert.equal(await f.BH.consumeAIDailyQuota(120), false);
  assert.equal(f.BH.loadStats().sent, 0);
});

test('每日清理只移除七天前的额度日记，保留今日、近期与其他配置', async (t) => {
  const clock = { offset: Date.parse('2026-11-10T12:00:00Z') - Date.now() };
  const f = fixture(t, { clock });
  const old = 'boss_helper_daily_event_v22_2026-11-01_old';
  const recent = 'boss_helper_daily_event_v22_2026-11-09_recent';
  const index = 'boss_helper_daily_index_v22_2026-11-01';
  for (const k of [old, recent, index, 'boss_helper_config_v1']) {
    f.gm.set(k, { fixture: true }); f.local.set(k, JSON.stringify({ fixture: true }));
  }
  assert.equal(await f.BH.consumeAIDailyQuota(120), true);
  assert.equal(f.gm.has(old), false); assert.equal(f.local.has(old), false);
  assert.equal(f.gm.has(index), false); assert.equal(f.local.has(index), false);
  assert.equal(f.gm.has(recent), true); assert.equal(f.local.has(recent), true);
  assert.equal(f.gm.has('boss_helper_config_v1'), true);
  assert.equal(f.BH.loadStats().aiCalls, 1);
});

test('无 Web Locks 时多个跨域标签反复并发消费仍不会超出最后四个 AI 名额', async (t) => {
  const gm = new Map();
  const tabs = Array.from({ length: 6 }, (_, i) => fixture(t, {
    gm, locks: null, url: `https://www.zhipin.${i % 2 ? 'cn' : 'com'}/web/geek/job`,
  }));
  seed(tabs[0], { aiCalls: 116 });
  const rounds = await Promise.all(tabs.map(async (tab) => {
    let used = 0;
    for (let i = 0; i < 3; i++) if (await tab.BH.consumeAIDailyQuota(120)) used++;
    return used;
  }));
  assert.equal(rounds.reduce((a, b) => a + b, 0), 4);
  for (const tab of tabs) assert.equal(tab.BH.loadStats().aiCalls, 120);
});

test('真实详情流程：119→120 在最后一次点击前持久化，重新打开和第二标签均被日限拦截', { timeout: 10000 }, async (t) => {
  const gm = new Map(), local = new Map(), locks = webLocks();
  const id = 'dailyFinalJob';
  const html = `<section class="job-detail" data-jobid="12000">
    <header class="job-banner"><h1 class="job-name">嵌入式软件工程师</h1>
    <a class="company-name" href="/gongsi/fixture.html">测试研发公司</a><span class="salary">20-30K</span>
    <a class="job-detail-link" href="/job_detail/${id}.html">查看职位</a><a class="op-btn-chat" href="javascript:void(0)">立即沟通</a></header>
    <section class="job-detail-section"><h2>职位描述</h2><div class="job-sec-text">负责 STM32 软件研发、FreeRTOS 固件调试与产品功能维护，完成接口驱动及设备通信协议开发。</div></section>
    <div class="boss-info"><span class="active-time">今日活跃</span></div></section>`;
  const options = { gm, local, locks, html, url: `https://www.zhipin.com/job_detail/${id}.html` };
  const a = fixture(t, options);
  seed(a, { sent: 119 });
  a.BH.state.config = { ...a.BH.loadConfig(), aiEnabled: false, autoSend: true,
    mustHave: [], mustNot: [], activeDays: 0, yearsMin: 0, eduMin: 0, dailyLimit: 120 };
  Object.defineProperty(a.win.HTMLElement.prototype, 'offsetWidth', { get() { return 600; } });
  Object.defineProperty(a.win.HTMLElement.prototype, 'offsetHeight', { get() { return 300; } });
  a.win.Element.prototype.getBoundingClientRect = () => ({ left: 600, top: 180, width: 600, height: 300, right: 1200, bottom: 480 });
  a.win.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  let clicks = 0;
  a.win.document.querySelector('.op-btn-chat').addEventListener('click', (e) => {
    e.preventDefault(); clicks++;
    assert.equal(a.BH.loadStats().sent, 120, '额度在事件交给站点前已持久化');
  });
  assert.equal(await a.BH.autoChatOnDetail(), true);
  assert.equal(clicks, 1);
  assert.equal(a.BH.loadStats().sent, 120);
  a.dom.window.close();
  const b = fixture(t, options);
  b.BH.state.config = { ...a.BH.state.config };
  assert.equal(b.BH.loadStats().sent, 120);
  assert.equal(await b.BH.autoChatOnDetail(), 'skipped');
  assert.equal(await b.BH.reserveDelivery('second-tab-job', 120), false);
});
