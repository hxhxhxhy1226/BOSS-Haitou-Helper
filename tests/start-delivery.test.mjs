import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const code = fs.readFileSync(SCRIPT, 'utf8');
const CONFIG = 'boss_helper_config_v1';
const STATS = 'boss_helper_stats_v1';
const OLD = { id: 'oldJobFixture', data: 'old01', title: '旧平台维护工程师', company: '旧测试公司' };
const JOB = { id: 'currentJobFixture', data: 'job02', title: '嵌入式软件工程师', company: '测试研发公司' };
const JD = '负责 STM32 产品软件研发、FreeRTOS 固件调试与产品功能维护，完成接口驱动及设备通信协议开发。';
function detail(job, text = JD) {
  return `<section class="job-detail" data-jobid="${job.data}"><header class="job-banner">
    <h1 class="job-name">${job.title}</h1><a class="company-name" href="/gongsi/fixture.html">${job.company}</a>
    <span class="salary">20-30K</span><a class="job-detail-link" href="/job_detail/${job.id}.html">查看职位</a>
    <a class="op-btn-chat" href="javascript:void(0)">立即沟通</a></header>
    <section class="job-detail-section"><h2>职位描述</h2><div class="job-sec-text">${text}</div></section>
    <div class="boss-info"><span class="active-time">今日活跃</span></div></section>`;
}

async function fixture(t, { sent = 30, dailyLimit = 120, aiEnabled = false, primaryFails = false,
  jobs = [JOB], onContact, onRequest, stopAfter = 1 } = {}) {
  const values = new Map();
  const requests = [], errors = [];
  const html = `<ul class="job-list-wrapper">${jobs.map((job) => `<li class="job-card-box" data-jobid="${job.data}" data-fixture-id="${job.id}">
    <a class="job-name" href="/job_detail/${job.id}.html">${job.title}</a><span class="job-salary">20-30K</span>
    <ul class="tag-list"><li>3-5年</li><li>本科</li><li>STM32开发</li></ul>
    <div class="job-info">负责产品固件开发。</div><a class="company-name" href="/gongsi/fixture.html">${job.company}</a>
    <div class="job-card-footer"><span class="time">刚刚活跃</span></div></li>`).join('')}</ul>
    <main id="detail-host">${detail(OLD, '负责旧型号设备维护与旧通信平台升级，完成既有产品问题排查。')}</main>`;
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(`<!doctype html><html><head><style>body * { opacity: 1; }</style></head><body>${html}</body></html>`, {
    url: 'https://www.zhipin.com/web/geek/job?query=fixture', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
  });
  const win = dom.window;
  win.GM_getValue = (k, fallback) => values.has(k) ? structuredClone(values.get(k)) : fallback;
  win.GM_setValue = (k, v) => values.set(k, structuredClone(v));
  win.GM_listValues = () => [...values.keys()];
  win.GM_deleteValue = (k) => values.delete(k);
  win.GM_addStyle = () => {};
  win.unsafeWindow = win;
  win.GM_xmlhttpRequest = (o) => {
    requests.push({ url: o.url, model: JSON.parse(o.data).model });
    if (onRequest) onRequest(win, o);
    setTimeout(() => o.onload({ status: primaryFails && o.url.includes('primary.example') ? 503 : 200,
      responseText: JSON.stringify({ choices: [{ message: { content: '{"match":true,"score":95,"reason":"岗位方向匹配"}' } }] }) }), 0);
    return { abort() {} };
  };
  win.fetch = () => assert.fail('Start tests forbid external requests');
  const hidden = (el) => !!el.closest('[hidden], [aria-hidden="true"], [style*="display:none"], [style*="display: none"]');
  Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { get() { return hidden(this) ? 0 : 600; } });
  Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { get() { return hidden(this) ? 0 : 300; } });
  win.Element.prototype.getBoundingClientRect = function () {
    const left = this.closest('.job-list-wrapper') ? 60 : 600, width = hidden(this) ? 0 : 600, height = hidden(this) ? 0 : 300;
    return { left, top: 180, width, height, right: left + width, bottom: 180 + height, x: left, y: 180 };
  };
  win.Element.prototype.getClientRects = function () { return hidden(this) ? [] : [this.getBoundingClientRect()]; };
  const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  values.set(STATS, { schema: 22, date, sent, aiCalls: 0, aiHits: 0, processed: 0, skipped: 0 });
  values.set(CONFIG, { mustHave: [], mustNot: [], activeDays: 0, yearsMin: 0, eduMin: 0, salaryMin: 0,
    autoSend: true, autoScroll: false, dailyLimit, minDelay: 0.5, maxDelay: 0.5, batchSize: 20, batchPauseSec: 0,
    aiEnabled, aiPrimaryEnabled: true, aiBaseUrl: 'https://primary.example/v1', aiApiKey: 'fixture-primary-key', aiModel: 'fixture-primary',
    aiMaxRetries: 0, aiDailyLimit: 100, aiFallback: 'skip', aiUserPortrait: '寻找 STM32、FreeRTOS 嵌入式软件研发岗位',
    aiEndpoints: primaryFails ? [{ id: 'backup', name: '备用', enabled: true, baseUrl: 'https://backup.example/v1', apiKey: 'fixture-backup-key', model: 'fixture-backup' }] : [],
  });
  let expands = 0, clicks = 0, countAtClick = 0;
  for (const card of win.document.querySelectorAll('.job-card-box')) card.addEventListener('click', (e) => {
    e.preventDefault(); expands++;
    const job = jobs.find((j) => j.id === card.dataset.fixtureId);
    win.document.getElementById('detail-host').innerHTML = detail(job, job.id === JOB.id ? JD
      : '负责下一型号 STM32 控制器固件设计，使用 FreeRTOS 开发驱动模块，并维护设备通信协议及量产测试软件。');
    win.document.querySelector('.op-btn-chat').addEventListener('click', (event) => {
      event.preventDefault(); clicks++; countAtClick = win.BH.loadStats().sent;
      if (onContact) onContact(win, { clicks, countAtClick, job });
      // Keep the mock operation on the same page and terminate immediately after observation.
      if (clicks >= stopAfter) win.BH.state.stopFlag = true;
      const stay = win.document.createElement('button');
      stay.className = 'default-btn cancel-btn'; stay.textContent = '留在此页';
      stay.addEventListener('click', () => stay.remove()); win.document.body.append(stay);
    });
  });
  win.eval(code);
  await delay(0);
  t.after(() => { win.BH.state.stopFlag = true; win.close(); });
  return { win, values, requests, errors, expandCount: () => expands, clickCount: () => clicks, countAtClick: () => countAtClick,
    logs: () => win.document.querySelector('.bh-log')?.textContent || '',
    // Start persists settings before marking the loop running; that pending save is not a stopped task.
    stopped: () => !win.BH.state.running && !win.BH.state._starting && !win.BH.state._loopActive,
    start: () => win.document.querySelector('[data-act="toggle"]').click() };
}

async function waitUntil(condition, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (condition()) return; await delay(25); }
}

for (const scenario of [
  { label: '本地筛选', aiEnabled: false },
  { label: 'AI 匹配', aiEnabled: true },
  { label: '主 API 故障自动切换备用', aiEnabled: true, primaryFails: true },
]) {
  test(`列表点开始完整流程：${scenario.label}，保留30次历史并发起第31次沟通`, { timeout: 20000 }, async (t) => {
    const f = await fixture(t, scenario); f.start();
    await waitUntil(() => f.clickCount() > 0 || /主循环异常/.test(f.logs()));
    assert.equal(f.expandCount(), 1, f.logs());
    assert.equal(f.clickCount(), 1, f.logs());
    assert.equal(f.countAtClick(), 31, f.logs());
    assert.equal(f.win.BH.loadStats().sent, 31);
    assert.equal(f.errors.length, 0, f.errors.join('\n'));
    if (scenario.aiEnabled && !scenario.primaryFails) {
      await waitUntil(() => f.win.document.querySelector('.job-card-box')?.dataset.bhProcessed === '1');
      const card = f.win.document.querySelector('.job-card-box');
      assert.match(card.querySelector('.bh-tag')?.textContent || '', /待确认/);
      assert.equal(card.querySelector('.bh-tag-skip'), null, '已经激活但尚无官方回执不能显示为跳过');
      assert.equal(card.querySelector('.bh-tag-ai-pass'), null, '投递阶段应替换临时 AI 通过标签');
    }
    if (scenario.primaryFails) assert.deepEqual(f.requests.map((r) => r.model), ['fixture-primary', 'fixture-backup']);
  });
}

test('列表点开始最后一个名额：119→120，点击前已记录且没有被额度校验误拦截', { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { sent: 119 }); f.start();
  await waitUntil(() => f.clickCount() > 0 || /主循环异常/.test(f.logs()));
  assert.equal(f.clickCount(), 1, f.logs());
  assert.equal(f.countAtClick(), 120, f.logs());
});

test('列表点开始已经达到120：不展开岗位、不请求 AI、不沟通', { timeout: 4000 }, async (t) => {
  const f = await fixture(t, { sent: 120, aiEnabled: true }); f.start();
  await waitUntil(() => f.stopped(), 1500);
  assert.equal(f.expandCount(), 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.clickCount(), 0);
  assert.match(f.logs(), /已达每日上限/);
});

const SECOND = { ...JOB, id: 'nextJobFixture', data: 'job03', title: 'STM32 固件开发工程师' };
for (const saveVia of ['主面板', 'AI 设置']) {
  test(`运行中通过${saveVia}保存每日上限80→150，立即同步面板并允许第81次沟通`, { timeout: 35000 }, async (t) => {
    let observed;
    const f = await fixture(t, { sent: 79, dailyLimit: 80, jobs: [JOB, SECOND], stopAfter: 2,
      onContact(win, { clicks }) {
        if (clicks !== 1) return;
        if (saveVia === 'AI 设置') win.document.querySelector('[data-act="aiopen"]').click();
        win.document.querySelector('[data-cfg="dailyLimit"]').value = '150';
        win.document.querySelector(saveVia === '主面板' ? '[data-act="save"]' : '#bh-ai-modal [data-act="aisave"]').click();
        observed = { live: win.BH.state.config.dailyLimit, shown: win.document.querySelector('[data-stat="limit"]').textContent,
          sent: win.BH.loadStats().sent, saved: win.BH.loadConfig().dailyLimit };
      } });
    f.start();
    await waitUntil(() => f.clickCount() >= 2 || /主循环异常/.test(f.logs()) || f.stopped(), 28000);
    assert.deepEqual(observed, { live: 150, shown: '150', sent: 80, saved: 150 }, f.logs());
    assert.equal(f.clickCount(), 2, f.logs());
    assert.equal(f.countAtClick(), 81, f.logs());
    assert.equal(f.win.BH.loadStats().sent, 81);
  });
}

test('运行中降低每日上限立即阻止后续沟通，保存不会清掉已经投递的数量', { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { sent: 79, dailyLimit: 150, jobs: [JOB, SECOND], stopAfter: 2,
    onContact(win, { clicks }) {
      if (clicks !== 1) return;
      win.document.querySelector('[data-cfg="dailyLimit"]').value = '80';
      win.document.querySelector('[data-act="save"]').click();
    } });
  f.start();
  await waitUntil(() => f.stopped() || f.clickCount() >= 2 || /主循环异常/.test(f.logs()), 25000);
  assert.equal(f.win.BH.state.config.dailyLimit, 80, f.logs());
  assert.equal(f.clickCount(), 1, f.logs());
  assert.equal(f.win.BH.loadStats().sent, 80);
  assert.match(f.logs(), /已达每日上限/);
});

test('手动停止后修改并保存上限不会自动重新开始，也不会清零历史额度', { timeout: 4000 }, async (t) => {
  const f = await fixture(t, { sent: 80, dailyLimit: 80 });
  f.win.BH.state.stopFlag = true;
  f.win.BH.state.running = false;
  f.win.document.querySelector('[data-cfg="dailyLimit"]').value = '150';
  f.win.document.querySelector('[data-act="save"]').click();
  await delay(150);
  assert.equal(f.win.BH.state.running, false);
  assert.equal(f.win.BH.state.stopFlag, true);
  assert.equal(f.clickCount(), 0);
  assert.equal(f.win.BH.loadConfig().dailyLimit, 150);
  assert.equal(f.win.BH.loadStats().sent, 80);
});

test('名额已预留但模拟点击尚未派发时150→80，重新检查最新上限并取消第81次沟通', { timeout: 22000 }, async (t) => {
  const f = await fixture(t, { sent: 80, dailyLimit: 150 });
  let savedDuringReservation = false;
  f.win.document.addEventListener('mousemove', (e) => {
    if (savedDuringReservation || e.clientX <= 600 || f.win.BH.loadStats().pending === 0) return;
    savedDuringReservation = true;
    f.win.document.querySelector('[data-cfg="dailyLimit"]').value = '80';
    f.win.document.querySelector('[data-act="save"]').click();
  });
  f.start();
  await waitUntil(() => f.stopped() || f.clickCount() > 0 || /主循环异常/.test(f.logs()), 18000);
  assert.equal(savedDuringReservation, true, f.logs());
  assert.equal(f.win.BH.state.config.dailyLimit, 80, f.logs());
  assert.equal(f.clickCount(), 0, f.logs());
  assert.equal(f.win.BH.loadStats().sent, 80);
  assert.equal(f.win.BH.loadStats().pending, 0);
});

test('等待 AI 判定时150→80，返回的通过结论不能再投第81次', { timeout: 16000 }, async (t) => {
  const f = await fixture(t, { sent: 80, dailyLimit: 150, aiEnabled: true,
    onRequest(win) {
      win.document.querySelector('[data-cfg="dailyLimit"]').value = '80';
      win.document.querySelector('[data-act="save"]').click();
    } });
  f.start();
  await waitUntil(() => f.stopped() || f.clickCount() > 0 || /主循环异常/.test(f.logs()), 12000);
  assert.equal(f.requests.length, 1, f.logs());
  assert.equal(f.win.BH.state.config.dailyLimit, 80, f.logs());
  assert.equal(f.clickCount(), 0, f.logs());
  assert.equal(f.win.BH.loadStats().sent, 80);
});

test('AI 通过后同岗位已被另一标签预留，显示未投递原因而非残留 AI 通过', { timeout: 16000 }, async (t) => {
  const f = await fixture(t, { aiEnabled: true });
  const occupied = await f.win.BH.reserveDelivery(JOB.id, 120);
  assert.ok(occupied);
  f.win.document.querySelector('[data-cfg="maxRounds"]').value = '1';
  f.start();
  await waitUntil(() => f.win.document.querySelector('.job-card-box')?.dataset.bhProcessed === '1' || f.stopped(), 14000);
  const card = f.win.document.querySelector('.job-card-box');
  assert.equal(f.requests.length, 1, f.logs());
  assert.equal(f.clickCount(), 0, f.logs());
  assert.equal(f.win.BH.loadStats().sent, 30);
  assert.equal(card.querySelector('.bh-tag-ai-pass'), null, f.logs());
  assert.match(card.querySelector('.bh-tag')?.textContent || '', /未投递/);
  assert.match(card.querySelector('.bh-tag-reason')?.textContent || '', /标签|预留|占用|发起|已投|额度/);
  await f.win.BH.releaseDelivery(occupied);
});

test('AI 通过后岗位正文更新，零投递并显示未投递，不重复请求 AI', { timeout: 16000 }, async (t) => {
  const f = await fixture(t, { aiEnabled: true });
  let changed = false;
  const observer = new f.win.MutationObserver(() => {
    if (changed || !f.win.document.querySelector('.bh-tag-ai-pass')) return;
    changed = true;
    f.win.document.querySelector('.job-sec-text').textContent = '新的岗位职责已变更为销售支持与客户沟通，与先前研发职责不同，需要重新判断。';
  });
  observer.observe(f.win.document.querySelector('.job-list-wrapper'), { childList: true, subtree: true });
  t.after(() => observer.disconnect());
  f.win.document.querySelector('[data-cfg="maxRounds"]').value = '1';
  f.start();
  await waitUntil(() => f.win.document.querySelector('.job-card-box')?.dataset.bhProcessed === '1' || f.stopped(), 14000);
  const card = f.win.document.querySelector('.job-card-box');
  assert.equal(changed, true, f.logs());
  assert.equal(f.requests.length, 1, f.logs());
  assert.equal(f.clickCount(), 0, f.logs());
  assert.equal(f.win.BH.loadStats().sent, 30);
  assert.equal(f.win.BH.loadStats().pending, 0);
  assert.equal(card.querySelector('.bh-tag-ai-pass'), null, f.logs());
  assert.match(card.querySelector('.bh-tag')?.textContent || '', /未投递/);
  assert.match(card.querySelector('.bh-tag-reason')?.textContent || '', /改变|变化|更新|正文|岗位|内容/);
});

test('已到80限额自然停止后保存150，不刷新即同步剩余70并再次开始投第81次', { timeout: 22000 }, async (t) => {
  const f = await fixture(t, { sent: 80, dailyLimit: 80 });
  f.start();
  await waitUntil(() => f.stopped(), 1500);
  assert.equal(f.clickCount(), 0);
  assert.match(f.logs(), /已达每日上限 80/);
  f.win.document.querySelector('[data-cfg="dailyLimit"]').value = '150';
  f.win.document.querySelector('[data-act="save"]').click();
  assert.equal(f.win.document.querySelector('[data-stat="limit"]').textContent, '150', f.logs());
  assert.equal(f.win.document.querySelector('[data-stat="remaining"]').textContent, '70', f.logs());
  assert.equal(f.win.BH.loadStats().sent, 80);
  assert.equal(f.win.BH.state.running, false, '保存配置本身不自动重启任务');
  f.start();
  await waitUntil(() => f.clickCount() > 0 || /主循环异常/.test(f.logs()), 17000);
  assert.equal(f.clickCount(), 1, f.logs());
  assert.equal(f.countAtClick(), 81);
  assert.equal(f.win.BH.loadStats().sent, 81);
});
