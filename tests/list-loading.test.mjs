import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const source = fs.readFileSync(SCRIPT, 'utf8');
const CONFIG = 'boss_helper_config_v1';
const quick = { attempts: 3, waitMs: 40, pollMs: 5, settleMs: 5 };
const cardHTML = (id, className = 'job-card-box') => `<li class="${className}" data-jobid="${id}" data-fixture-id="${id}">
  <a class="job-name" href="/job_detail/${id}.html">嵌入式软件工程师 ${id}</a>
  <span class="job-salary">20-30K</span><a class="company-name" href="/gongsi/${id}.html">测试公司 ${id}</a>
</li>`;

async function fixture(t, { nested = false, cards = cardHTML('job-a') + cardHTML('job-b'), extra = '', more = false, processCard } = {}) {
  const errors = [], scrolls = [], sleepCalls = [], values = new Map();
  const console = new VirtualConsole();
  console.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(`<!doctype html><html><head><style>body * { opacity: 1; }</style></head><body>
    <div id="list-scroll" style="overflow-y:${nested ? 'auto' : 'visible'}"><ul id="jobs" class="job-list-wrapper">${cards}</ul>
    ${more ? '<button class="load-more">加载更多</button>' : ''}</div>${extra}</body></html>`, {
    url: 'https://www.zhipin.com/web/geek/job?query=list-fixture', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console,
  });
  const win = dom.window, doc = win.document, list = doc.getElementById('jobs'), scroller = doc.getElementById('list-scroll');
  values.set(CONFIG, { autoSend: false, autoScroll: false, aiEnabled: false, maxRounds: 0,
    minDelay: 0.5, maxDelay: 0.5, pageDelayMin: 0.5, pageDelayMax: 0.5, batchPauseSec: 0 });
  win.GM_getValue = (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback;
  win.GM_setValue = (key, value) => values.set(key, structuredClone(value));
  win.GM_listValues = () => [...values.keys()];
  win.GM_deleteValue = (key) => values.delete(key);
  win.GM_addStyle = () => {};
  win.unsafeWindow = win;
  let network = 0, moreClicks = 0, onScroll = null;
  const blocked = () => { network++; throw Error('列表加载回归禁止真实网络请求和投递'); };
  win.fetch = blocked; win.GM_xmlhttpRequest = blocked;
  const hidden = (el) => !!el.closest('[hidden], [aria-hidden="true"], [style*="display:none"], [style*="display: none"]');
  Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { get() { return hidden(this) ? 0 : 600; } });
  Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { get() { return hidden(this) ? 0 : 200; } });
  Object.defineProperty(win.HTMLElement.prototype, 'offsetParent', { get() { return hidden(this) ? null : doc.body; } });
  win.Element.prototype.getBoundingClientRect = function () {
    const width = hidden(this) ? 0 : 600, height = hidden(this) ? 0 : 200;
    return { x: 60, y: 180, left: 60, top: 180, width, height, right: 60 + width, bottom: 180 + height };
  };
  win.Element.prototype.getClientRects = function () { return hidden(this) ? [] : [this.getBoundingClientRect()]; };
  win.Element.prototype.scrollIntoView = () => {};
  let pageHeight = 2400, pageY = 1600, listHeight = nested ? 1800 : 400, listY = nested ? 1300 : 0;
  Object.defineProperty(win, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(win, 'scrollY', { get() { return pageY; } });
  Object.defineProperty(win, 'pageYOffset', { get() { return pageY; } });
  Object.defineProperty(doc, 'scrollingElement', { get() { return doc.documentElement; } });
  Object.defineProperty(doc.documentElement, 'scrollHeight', { get() { return pageHeight; } });
  Object.defineProperty(doc.body, 'scrollHeight', { get() { return pageHeight; } });
  Object.defineProperty(doc.documentElement, 'clientHeight', { get() { return 800; } });
  Object.defineProperty(scroller, 'scrollHeight', { get() { return listHeight; } });
  Object.defineProperty(scroller, 'clientHeight', { get() { return 500; } });
  Object.defineProperty(list, 'scrollHeight', { get() { return 400; } });
  Object.defineProperty(list, 'clientHeight', { get() { return 400; } });
  const record = (target, next, method) => {
    const from = target === 'window' ? pageY : listY;
    const maximum = target === 'window' ? pageHeight - 800 : Math.max(0, listHeight - 500);
    const to = Math.max(0, Math.min(maximum, Number(next) || 0));
    if (target === 'window') pageY = to; else listY = to;
    const operation = { target, from, to, maximum, method }; scrolls.push(operation);
    onScroll?.(operation);
  };
  const topArgument = (x, y) => typeof x === 'object' ? x.top : y;
  win.scrollTo = (x, y) => record('window', topArgument(x, y), 'scrollTo');
  win.scrollBy = (x, y) => record('window', pageY + Number(topArgument(x, y) || 0), 'scrollBy');
  scroller.scrollTo = (x, y) => record('list', topArgument(x, y), 'scrollTo');
  scroller.scrollBy = (x, y) => record('list', listY + Number(topArgument(x, y) || 0), 'scrollBy');
  Object.defineProperty(doc.documentElement, 'scrollTop', { get() { return pageY; }, set(value) { record('window', value, 'scrollTop'); } });
  Object.defineProperty(scroller, 'scrollTop', { get() { return listY; }, set(value) { record('list', value, 'scrollTop'); } });
  doc.querySelector('.load-more')?.addEventListener('click', (event) => { event.preventDefault(); moreClicks++; });
  // Keep existing core scheduling asynchronous while shortening unrelated simulated mouse waits.
  win.__listTestSleep = (ms) => { sleepCalls.push(ms); return new Promise((resolve) => win.setTimeout(resolve, Math.min(ms, 5))); };
  if (processCard) win.__listTestProcess = (card) => processCard(card, { win, doc });
  const instrumented = source.replace('const sleep = CLOCK.sleep;', 'const sleep = window.__listTestSleep;')
    .replace('state, loadConfig, loadStats,', 'state, loop, loadMore, findScrollContainer, tagCard, loadConfig, loadStats,')
    .replace('async function processOneInner(card) {', 'async function processOneInner(card) {\n    if (window.__listTestProcess) return window.__listTestProcess(card);');
  win.eval(instrumented);
  await delay(0);
  const BH = win.BH;
  BH.state.config = BH.loadConfig(); BH.state.stopFlag = false; BH.state.paused = false;
  t.after(() => { BH.state.stopFlag = true; win.close(); assert.equal(network, 0); assert.deepEqual(errors, []); });
  const append = (id) => { list.insertAdjacentHTML('beforeend', cardHTML(id)); return list.lastElementChild; };
  const markAll = () => {
    for (const card of list.querySelectorAll('.job-card-box, .job-card-wrap, .card-area')) {
      if (typeof BH.markJobCardProcessed === 'function') BH.markJobCardProcessed(card);
      else card.dataset.bhProcessed = '1';
    }
  };
  return { win, doc, BH, list, scroller, scrolls, sleepCalls, append, markAll,
    moreClicks: () => moreClicks,
    set onScroll(callback) { onScroll = callback; },
    get pageHeight() { return pageHeight; }, set pageHeight(value) { pageHeight = value; },
    get listHeight() { return listHeight; },
  };
}

test('已有未处理岗位时立即继续，不先滚动或点击加载更多', async (t) => {
  const f = await fixture(t, { more: true });
  assert.equal(await f.BH.loadMore(quick), true);
  assert.equal(f.scrolls.length, 0);
  assert.equal(f.moreClicks(), 0);
});

test('合并不同卡片结构、排除详情并去掉嵌套重复卡片', async (t) => {
  const f = await fixture(t, {
    cards: cardHTML('job-a') + `<li class="job-card-wrap" data-jobid="job-b" data-fixture-id="job-b"><div class="card-area">`
      + '<a class="job-name" href="/job_detail/job-b.html">岗位 B</a></div></li>'
      + cardHTML('job-c', 'card-area'),
    extra: '<section class="job-detail" data-jobid="detail-only"><h1 class="job-name">右侧详情</h1></section>',
  });
  const cards = f.BH.getUnprocessedJobCards();
  assert.deepEqual(Array.from(cards, (card) => card.dataset.fixtureId), ['job-a', 'job-b', 'job-c']);
  assert.equal(new Set(cards.map((card) => f.BH.jobCardKey(card))).size, 3);
});

test('同岗位重建仍已处理，旧节点换成新岗位时解除旧处理标记', async (t) => {
  const f = await fixture(t); f.markAll();
  const original = f.list.firstElementChild, originalKey = f.BH.jobCardKey(original);
  const replacement = original.cloneNode(true);
  replacement.removeAttribute('data-bh-processed'); replacement.removeAttribute('data-bh-processed-key');
  original.replaceWith(replacement);
  assert.equal(f.BH.getUnprocessedJobCards().length, 0, '同 ID 重建不能重复处理');
  replacement.dataset.bhProcessed = '1';
  replacement.dataset.jobid = 'new-job';
  replacement.querySelector('.job-name').href = '/job_detail/new-job.html';
  replacement.querySelector('.job-name').textContent = '新岗位';
  assert.notEqual(f.BH.jobCardKey(replacement), originalKey);
  const remaining = f.BH.getUnprocessedJobCards();
  assert.deepEqual(Array.from(remaining), [replacement]);
  assert.ok(!replacement.dataset.bhProcessed, '复用节点上的旧 processed 标记必须失效');
});

test('同岗位重新渲染恢复绿色完成及原因，复用为新岗位时清除旧结果', async (t) => {
  const f = await fixture(t, { cards: cardHTML('job-a') });
  const original = f.list.firstElementChild;
  f.BH.tagCard(original, 'pass', 'BOSS 已确认消息发送');
  f.BH.markJobCardProcessed(original);
  f.list.innerHTML = cardHTML('job-a');
  const replacement = f.list.firstElementChild;
  assert.equal(replacement.querySelector('.bh-tag'), null);
  assert.equal(f.BH.getUnprocessedJobCards().length, 0);
  const restored = replacement.querySelector('.bh-tag-pass');
  assert.ok(restored, '已经完成的岗位重绘后仍应显示原终态');
  assert.match(restored.textContent, /完成/);
  assert.equal(restored.querySelector('.bh-tag-reason').textContent, 'BOSS 已确认消息发送');
  assert.equal(replacement.dataset.bhProcessed, '1');

  replacement.dataset.jobid = 'new-after-complete';
  replacement.querySelector('.job-name').href = '/job_detail/new-after-complete.html';
  replacement.querySelector('.job-name').textContent = '新的未处理岗位';
  assert.deepEqual(Array.from(f.BH.getUnprocessedJobCards()), [replacement]);
  assert.ok(!replacement.dataset.bhProcessed);
  assert.ok(!replacement.dataset.bhProcessedKey);
  assert.equal(replacement.querySelector('.bh-tag'), null, '新岗位不能继承上一个岗位的绿色完成标签');
});

test('页面高度不变但异步追加岗位，仍识别为加载成功', async (t) => {
  const f = await fixture(t); f.markAll();
  const height = f.pageHeight;
  let queued = false;
  f.onScroll = ({ to, maximum }) => {
    if (!queued && to === maximum) { queued = true; f.win.setTimeout(() => f.append('appended-job'), 8); }
  };
  assert.equal(await f.BH.loadMore(quick), true);
  assert.equal(f.pageHeight, height);
  assert.equal(f.list.children.length, 3);
  assert.equal(f.BH.getUnprocessedJobCards().length, 1);
});

test('前两轮没有新增，第三轮上回再到底才刷出岗位时继续处理', async (t) => {
  const f = await fixture(t); f.markAll();
  let armed = false, cycles = 0;
  f.onScroll = ({ from, to, maximum }) => {
    if (to < from) armed = true;
    if (armed && to === maximum) {
      armed = false; cycles++;
      if (cycles === 2) f.win.setTimeout(() => f.append('third-round-job'), 8);
    }
  };
  assert.equal(await f.BH.loadMore(quick), true);
  assert.equal(cycles, 2, '至少做完两次上回、再次触底');
  assert.ok(f.BH.getUnprocessedJobCards().some((card) => card.dataset.jobid === 'third-round-job'));
});

test('长页面内仍优先滚动真正承载岗位列表的独立容器', async (t) => {
  const f = await fixture(t, { nested: true }); f.markAll();
  const container = f.BH.findScrollContainer();
  assert.equal(container.el, f.scroller);
  assert.equal(container.win, false);
  let queued = false;
  f.onScroll = ({ target, to, maximum }) => {
    if (target === 'list' && to === maximum && !queued) { queued = true; f.win.setTimeout(() => f.append('inner-job'), 8); }
  };
  assert.equal(await f.BH.loadMore(quick), true);
  assert.ok(f.scrolls.some((item) => item.target === 'list'));
  assert.ok(f.scrolls.every((item) => item.target === 'list'), '不可因整页较长而滚错容器');
});

test('同数量和高度的虚拟列表复用卡片为新 ID，也算加载成功', async (t) => {
  const f = await fixture(t); f.markAll();
  const original = f.list.firstElementChild;
  let queued = false;
  f.onScroll = ({ to, maximum }) => {
    if (queued || to !== maximum) return;
    queued = true;
    f.win.setTimeout(() => {
      original.dataset.jobid = 'virtual-next';
      original.querySelector('.job-name').href = '/job_detail/virtual-next.html';
      original.querySelector('.job-name').textContent = '虚拟列表新岗位';
    }, 8);
  };
  assert.equal(await f.BH.loadMore(quick), true);
  assert.equal(f.list.children.length, 2);
  assert.equal(f.BH.getUnprocessedJobCards()[0], original);
});

test('仅页面高度变化而无新岗位，不能伪装成加载成功', async (t) => {
  const f = await fixture(t); f.markAll();
  f.onScroll = ({ from, to }) => { if (to >= from) f.pageHeight += 100; };
  assert.equal(await f.BH.loadMore(quick), false);
  assert.equal(f.list.children.length, 2);
  assert.equal(f.BH.getUnprocessedJobCards().length, 0);
});

test('真正没有更多时，连续三轮无新增才返回结束', async (t) => {
  const f = await fixture(t); f.markAll();
  assert.equal(await f.BH.loadMore(quick), false);
  const bottoms = f.scrolls.filter((item) => item.to === item.maximum);
  assert.ok(bottoms.length >= 3, '至少再次确认三轮列表末尾');
  assert.ok(f.scrolls.filter((item) => item.to < item.from).length >= 2, '结束前应实际回滚重试');
});

test('加载期间停止后不再滚动，也不点击加载更多', async (t) => {
  const f = await fixture(t, { more: true }); f.markAll();
  let atStop = 0;
  f.onScroll = () => {
    if (atStop) return;
    atStop = f.scrolls.length;
    f.BH.stop('fixture stop during loading');
  };
  assert.equal(await f.BH.loadMore(quick), false);
  await delay(25);
  assert.ok(atStop > 0);
  assert.equal(f.scrolls.length, atStop);
  assert.equal(f.moreClicks(), 0);
});

test('主循环在加载阶段被停止，不误报已无更多职位', async (t) => {
  const f = await fixture(t, { more: true }); f.markAll();
  f.BH.state.running = true;
  f.onScroll = () => f.BH.stop('fixture stopped by user');
  await f.BH.loop();
  assert.equal(f.BH.state.stopFlag, true);
  assert.equal(f.moreClicks(), 0);
  assert.doesNotMatch(f.doc.querySelector('.bh-log').textContent, /已无更多职位/);
  assert.doesNotMatch(f.doc.querySelector('.bh-reason').textContent, /已无更多职位/);
});

test('主循环首次无终态标签不会提前记账，下一轮就绪才标已处理', async (t) => {
  let attempts = 0;
  const f = await fixture(t, { cards: cardHTML('job-a'),
    processCard(card, { win }) {
      attempts++;
      assert.ok(!card.dataset.bhProcessed, '每次进入实际处理前均不能沿用提前写入的标记');
      assert.equal(win.BH.state._processedJobs.has(win.BH.jobCardKey(card)), false);
      if (attempts === 2) card.insertAdjacentHTML('beforeend', '<div class="bh-tag bh-tag-matched">筛选通过</div>');
    },
  });
  f.BH.state.config.maxRounds = 2;
  f.BH.state.running = true;
  await f.BH.loop();
  assert.equal(attempts, 2);
  const card = f.list.firstElementChild;
  assert.equal(card.dataset.bhProcessed, '1');
  assert.ok(card.querySelector('.bh-tag-matched'));
  assert.equal(f.BH.getUnprocessedJobCards().length, 0);
  assert.equal(f.scrolls.length, 0, '尚可重试的现有卡片不应被误当列表结束而滚动');
});

test('主循环连续三次未就绪后保留明确未投递标签，不静默遗漏或无限重试', async (t) => {
  let attempts = 0;
  const f = await fixture(t, { cards: cardHTML('job-a'), processCard() { attempts++; } });
  f.BH.state.config.maxRounds = 3;
  f.BH.state.running = true;
  await f.BH.loop();
  assert.equal(attempts, 3);
  const card = f.list.firstElementChild, tag = card.querySelector('.bh-tag-not-sent');
  assert.ok(tag, '重试耗尽仍要给用户可见的处理结果');
  assert.match(tag.textContent, /未投递/);
  assert.match(tag.textContent, /连续.*未就绪|重试/);
  assert.equal(card.dataset.bhProcessed, '1');
  assert.equal(f.BH.getUnprocessedJobCards().length, 0);
});

test('处理等待期间原节点换了岗位 ID，下一轮仍处理新岗位而不沿用旧结果', async (t) => {
  const seen = [];
  const f = await fixture(t, { cards: cardHTML('job-a'),
    async processCard(card, { win }) {
      seen.push(card.dataset.jobid);
      assert.ok(!card.dataset.bhProcessed);
      assert.equal(win.BH.state._processedJobs.has(win.BH.jobCardKey(card)), false);
      if (seen.length === 1) {
        await delay(0);
        card.dataset.jobid = 'reused-new-job';
        card.querySelector('.job-name').href = '/job_detail/reused-new-job.html';
        card.querySelector('.job-name').textContent = '节点复用后的新岗位';
        card.insertAdjacentHTML('beforeend', '<div class="bh-tag bh-tag-matched">旧岗位迟到的结果</div>');
      } else {
        assert.equal(card.querySelector('.bh-tag'), null, '旧岗位的终态标签不能显示在新岗位上');
        card.insertAdjacentHTML('beforeend', '<div class="bh-tag bh-tag-matched">新岗位筛选通过</div>');
      }
    },
  });
  f.BH.state.config.maxRounds = 2;
  f.BH.state.running = true;
  await f.BH.loop();
  assert.deepEqual(seen, ['job-a', 'reused-new-job']);
  assert.equal(f.list.firstElementChild.dataset.bhProcessed, '1');
  assert.match(f.list.querySelector('.bh-tag').textContent, /新岗位筛选通过/);
  assert.equal(f.BH.getUnprocessedJobCards().length, 0);
});
