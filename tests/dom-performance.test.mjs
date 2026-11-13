import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const code = fs.readFileSync(SCRIPT, 'utf8');
const job = (i) => ({ jobId: 'performance-' + i, dataJobId: String(1000 + i), title: '固件研发岗位' + i, company: '研发公司' + i });
const bodyText = '负责 STM32 和 FreeRTOS 固件研发，完成驱动、通信协议与设备调试。';

async function fixture(t, count = 160) {
  const jobs = Array.from({ length: count }, (_, i) => job(i));
  const card = (item, i) => `<li class="job-card-wrap ${i === 0 ? 'active' : ''}" data-jobid="${item.dataJobId}"><div class="card-area"><div class="job-card-body"><a class="job-name" href="/job_detail/${item.jobId}.html">${item.title}</a><span class="job-salary">20-30K</span><ul class="tag-list"><li>本科</li><li>3-5年</li></ul><a class="company-name" href="/gongsi/${i}.html">${item.company}</a></div></div></li>`;
  const markup = `<ul class="job-list-wrapper">${jobs.map(card).join('')}</ul><section class="job-detail" data-jobid="${jobs[0].dataJobId}"><header class="job-banner"><h1 class="job-name">${jobs[0].title}</h1><a class="company-name">${jobs[0].company}</a><a class="job-detail-link" href="/job_detail/${jobs[0].jobId}.html">职位</a><span class="salary">20-30K</span><a class="op-btn-chat">立即沟通</a></header><div class="job-sec-text">${Array.from({ length: 20 }, () => `<p>${bodyText}</p>`).join('')}</div></section>`;
  const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
    url: 'https://www.zhipin.com/web/geek/job', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window, values = new Map(), intervals = [];
  t.after(() => { if (win.BH) win.BH.state.stopFlag = true; win.close(); });
  win.GM_getValue = (key, fallback) => values.has(key) ? values.get(key) : fallback;
  win.GM_setValue = (key, value) => values.set(key, value);
  win.GM_addStyle = () => {};
  win.GM_xmlhttpRequest = win.fetch = () => assert.fail('性能回归禁止网络或沟通');
  win.unsafeWindow = win;
  win.setInterval = (callback, ms) => { intervals.push({ callback, ms }); return intervals.length; };
  win.clearInterval = () => {};
  Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { get() { return 600; } });
  Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { get() { return 300; } });
  win.Element.prototype.getBoundingClientRect = function () { return { left: 600, top: 180, width: 600, height: 300, right: 1200, bottom: 480 }; };
  let styleReads = 0;
  const readStyle = win.getComputedStyle.bind(win);
  win.getComputedStyle = (el) => { styleReads++; return readStyle(el); };
  win.eval(code);
  await delay(0);
  const tick = intervals.find((entry) => entry.ms === 500)?.callback;
  assert.ok(tick, '应保留URL变更轮询');
  let now = Date.now();
  win.Date.now = () => now;
  return { win, jobs, tick: () => { now += 1000; tick(); }, reset: () => { styleReads = 0; }, reads: () => styleReads,
    measure(fn) { styleReads = 0; const started = performance.now(); const result = fn(); return { result, styleReads, ms: performance.now() - started }; } };
}

test('大列表的单次详情核验仅读取选中卡片和当前详情的样式', async (t) => {
  const f = await fixture(t);
  const measured = f.measure(() => f.win.BH.extractJobSnapshot(f.jobs[0]));
  t.diagnostic(JSON.stringify({ cards: f.jobs.length, styleReads: measured.styleReads, snapshotMs: Math.round(measured.ms) }));
  assert.equal(measured.result.ok, true, measured.result.reason);
  assert.equal(measured.result.jobId, f.jobs[0].jobId);
  assert.ok(measured.result.description.includes(bodyText));
  assert.ok(measured.styleReads < 250, '每次核验不应对160张未选中卡片或同一祖先反复读取样式：' + measured.styleReads);
  const card = f.win.document.querySelector('.job-card-wrap');
  card.hidden = true;
  const hidden = f.win.BH.extractJobSnapshot(f.jobs[0]);
  assert.equal(hidden.selectedIdentity, null, '下一次核验必须立即看到DOM变化，不能跨调用缓存可见性');
});

test('空闲网页与大量助手日志变化不重复执行全页详情扫描，真实换岗仍立即读取', async (t) => {
  const f = await fixture(t, 80);
  f.tick(); f.tick(); // 首次采集及正文稳定确认。
  f.reset();
  for (let i = 0; i < 5; i++) f.tick();
  assert.equal(f.reads(), 0, '网页未变时URL轮询无需重新读取岗位样式');
  for (let i = 0; i < 30; i++) f.win.BH.addLog('测试日志更新 ' + i);
  f.tick();
  assert.equal(f.reads(), 0, '助手日志/计数更新不能使空闲详情重新扫描');
  const card = f.win.document.querySelector('.job-card-wrap');
  const badge = f.win.document.createElement('div'); badge.className = 'bh-tag'; badge.textContent = '读取中'; card.append(badge);
  f.tick();
  assert.equal(f.reads(), 0, '助手自己的卡片标签不是职位变更');
  const next = f.jobs[1], root = f.win.document.querySelector('.job-detail');
  card.classList.remove('active'); f.win.document.querySelectorAll('.job-card-wrap')[1].classList.add('active');
  root.dataset.jobid = next.dataJobId;
  root.querySelector('.job-name').textContent = next.title;
  root.querySelector('.company-name').textContent = next.company;
  root.querySelector('.job-detail-link').href = '/job_detail/' + next.jobId + '.html';
  root.querySelector('.job-sec-text').textContent = '新岗位负责 DSP 高速数据采集与实时处理。';
  f.tick();
  assert.ok(f.reads() > 0, '真实岗位DOM变更后必须重新确认');
  const current = f.win.BH.extractJobSnapshot(next);
  assert.equal(current.ok, true, current.reason);
  assert.equal(current.jobId, next.jobId);
  assert.match(current.description, /DSP/);
});
