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
const MIXED_JOB = { ...JOB, title: '【27届校招】嵌入式软件工程师', company: '阿费卡科技', jd: `【岗位介绍】
参与机器人及智能硬件产品研发，负责 Linux/RTOS 系统软件、设备驱动、传感器接入、软硬件联调及性能优化；
入职后可重点向系统与驱动、MCU/RTOS、机器人传感器或 SoC 性能方向发展。
【岗位职责】
1.参与 BSP、设备驱动、通信协议和嵌入式应用的设计、开发与调试；
2.参与 Linux/RTOS 系统移植、裁剪、模块开发及性能和稳定性优化；
3.完成摄像头、3D-ToF、IMU、电机等设备接入和软硬件联调；
4.配合硬件、算法和测试团队定位问题，完成必要的设计、测试和调试文档。
【任职要求】
1.本科及以上学历，计算机、电子信息、自动化、通信、软件工程等相关专业；
2.具备扎实的 C/C++ 基础，理解指针、内存管理、数据结构和并发编程。` };
function detail(job, text = JD) {
  return `<section class="job-detail" data-jobid="${job.data}"><header class="job-banner">
    <h1 class="job-name">${job.title}</h1><a class="company-name" href="/gongsi/fixture.html">${job.company}</a>
    <span class="salary">20-30K</span><a class="job-detail-link" href="/job_detail/${job.id}.html">查看职位</a>
    <a class="op-btn-chat" href="javascript:void(0)">立即沟通</a></header>
    <section class="job-detail-section"><h2>职位描述</h2><div class="job-sec-text">${text}</div></section>
    <div class="boss-info"><span class="active-time">今日活跃</span></div></section>`;
}

async function fixture(t, { sent = 30, dailyLimit = 120, aiEnabled = false, primaryFails = false,
  jobs = [JOB], onContact, onRequest, onExpand, innerSelection = false, initialJob = null,
  selectionDelegated = false, cardBodyRole = false, titleNewTab = false,
  selectionPreventDefault = true, selectionStopPropagation = false,
  snapshotWait = null, officialSuccess = false, stopAfter = 1, settings = {} } = {}) {
  const values = new Map();
  const requests = [], errors = [], selectionDefaultStates = [];
  const html = `<ul class="job-list-wrapper">${jobs.map((job) => `<li class="job-card-box" data-jobid="${job.data}" data-fixture-id="${job.id}">
    ${innerSelection ? '<div class="card-area"' + (cardBodyRole ? ' role="button"' : '') + '>' : ''}
    <a class="job-name" ${titleNewTab ? 'target="_blank"' : ''} href="/job_detail/${job.id}.html">${job.title}</a><span class="job-salary">20-30K</span>
    <ul class="tag-list"><li>3-5年</li><li>本科</li><li>STM32开发</li></ul>
    <div class="job-info">负责产品固件开发。</div><a class="company-name" href="/gongsi/fixture.html">${job.company}</a>
    <div class="job-card-footer"><span class="time">刚刚活跃</span></div>${innerSelection ? '</div>' : ''}</li>`).join('')}</ul>
    <main id="detail-host">${initialJob ? detail(initialJob, initialJob.jd || JD)
      : detail(OLD, '负责旧型号设备维护与旧通信平台升级，完成既有产品问题排查。')}</main>`;
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
    const requestBody = JSON.parse(o.data);
    requests.push({ url: o.url, model: requestBody.model, messages: requestBody.messages });
    if (onRequest && onRequest(win, o) === false) return { abort() {} };
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
    ...settings,
  });
  let expands = 0, clicks = 0, countAtClick = 0;
  for (const card of win.document.querySelectorAll('.job-card-box')) {
    if (initialJob?.id === card.dataset.fixtureId) card.classList.add('active');
    const selectionTarget = selectionDelegated ? win.document.querySelector('.job-list-wrapper')
      : innerSelection ? card.querySelector('.card-area') : card;
    selectionTarget.addEventListener('click', (e) => {
    if (!card.contains(e.target)) return;
    if (selectionDelegated) {
      selectionDefaultStates.push(e.defaultPrevented);
      if (e.defaultPrevented) return; // Mimic a site delegated handler's navigation guard.
    }
    if (selectionPreventDefault) e.preventDefault();
    if (selectionStopPropagation) e.stopPropagation();
    expands++;
    const job = jobs.find((j) => j.id === card.dataset.fixtureId);
    if (onExpand && onExpand(win, { job, expands }) === false) return;
    win.document.querySelectorAll('.job-card-box.active').forEach((node) => node.classList.remove('active'));
    card.classList.add('active');
    win.document.getElementById('detail-host').innerHTML = detail(job, job.jd || (job.id === JOB.id ? JD
      : '负责下一型号 STM32 控制器固件设计，使用 FreeRTOS 开发驱动模块，并维护设备通信协议及量产测试软件。'));
    win.document.querySelector('.op-btn-chat').addEventListener('click', (event) => {
      event.preventDefault(); clicks++; countAtClick = win.BH.loadStats().sent;
      if (onContact) onContact(win, { clicks, countAtClick, job });
      if (officialSuccess) {
        win.document.querySelector('.op-btn-chat').textContent = '继续沟通';
        const dialog = win.document.createElement('section'); dialog.className = 'greet-dialog';
        dialog.innerHTML = '<header><h3 class="title">已向BOSS发送消息</h3></header>'
          + '<footer><button class="default-btn cancel-btn">留在此页</button></footer>';
        dialog.querySelector('button').addEventListener('click', () => dialog.remove());
        win.document.body.append(dialog);
      }
      // Keep the mock operation on the same page and terminate immediately after observation.
      if (clicks >= stopAfter) win.BH.state.stopFlag = true;
      if (officialSuccess) return;
      const stay = win.document.createElement('button');
      stay.className = 'default-btn cancel-btn'; stay.textContent = '留在此页';
      stay.addEventListener('click', () => stay.remove()); win.document.body.append(stay);
    });
    });
  }
  let runtime = code;
  if (snapshotWait != null) {
    const call = 'waitForJobSnapshot(expected, { previous, selection })';
    assert.ok(runtime.includes(call), 'The retry fixture must use the real snapshot wait call');
    runtime = runtime.replace(call, 'waitForJobSnapshot(expected, { previous, selection, timeoutMs: '
      + snapshotWait + ', stableMs: 50, pollMs: 10 })');
  }
  win.eval(runtime);
  await delay(0);
  t.after(() => { win.BH.state.stopFlag = true; win.close(); });
  return { win, values, requests, errors, selectionDefaultStates, expandCount: () => expands, clickCount: () => clicks, countAtClick: () => countAtClick,
    logs: () => win.document.querySelector('.bh-log')?.textContent || '',
    // Start persists settings before marking the loop running; that pending save is not a stopped task.
    stopped: () => !win.BH.state.running && !win.BH.state._starting && !win.BH.state._loopActive,
    start: () => win.document.querySelector('[data-act="toggle"]').click() };
}

async function waitUntil(condition, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (condition()) return; await delay(25); }
}

test('三岗位仅内层card-area监听：默认A详情，A/B/C分别调用AI并正确推进', { timeout: 30000 }, async (t) => {
  const jobs = [
    { id: 'innerSelectionA', data: 'inner-a', title: 'MCU电机控制工程师A', company: '电机研发公司A',
      jd: '岗位A负责STM32电机FOC固件开发和PWM控制，这是岗位A独有的职责。' },
    { id: 'innerSelectionB', data: 'inner-b', title: 'RTOS通信软件工程师B', company: '通信研发公司B',
      jd: '岗位B负责FreeRTOS通信协议栈和CAN总线模块，这是岗位B独有的职责。' },
    { id: 'innerSelectionC', data: 'inner-c', title: '机器人嵌入式工程师C', company: '机器人研发公司C',
      jd: '岗位C负责机器人IMU与传感器驱动及MCU调试，这是岗位C独有的职责。' },
  ];
  const observed = [], contacted = [];
  const f = await fixture(t, { aiEnabled: true, innerSelection: true, initialJob: jobs[0], jobs, stopAfter: 3, officialSuccess: true,
    settings: { aiCacheEnabled: true },
    onRequest(win, request) {
      const card = win.document.querySelector('.job-card-box.active');
      const expected = win.BH.readJobCard(card);
      const input = win.BH.jobFromSnapshot(win.BH.extractJobSnapshot(expected), expected);
      observed.push({ selected: card.dataset.fixtureId, input, prompt: JSON.parse(request.data).messages[1].content });
    },
    onContact(win, { job }) {
      contacted.push({ id: job.id, selected: win.document.querySelector('.job-card-box.active')?.dataset.fixtureId });
    },
  });
  for (const card of f.win.document.querySelectorAll('.job-card-box')) {
    assert.equal(f.win.BH.getJobCardClickTarget(card), card.querySelector('.card-area'));
  }
  f.start();
  await waitUntil(() => f.stopped() || /主循环异常/.test(f.logs()), 26000);
  assert.equal(f.clickCount(), 3, f.logs());
  assert.equal(f.expandCount(), 3, f.logs());
  assert.equal(f.requests.length, 3, '每个目标岗位均应执行一次AI');
  assert.equal(f.win.BH.state.config.aiEnabled, true, '推进卡片不能关闭AI');
  assert.deepEqual(observed.map((entry) => entry.selected), jobs.map((job) => job.id));
  assert.deepEqual(contacted, jobs.map((job) => ({ id: job.id, selected: job.id })));
  const cache = f.values.get('boss_helper_ai_cache_v1');
  assert.deepEqual(Object.keys(cache).sort(), jobs.map((job) => job.id).sort(), 'AI缓存ID必须来自相应目标卡片');
  for (const [i, job] of jobs.entries()) {
    assert.equal(observed[i].input.jobId, job.id);
    assert.equal(observed[i].input.title, job.title);
    assert.equal(observed[i].input.jd, job.jd, '不能将上一岗位JD作为当前AI输入');
    assert.ok(observed[i].prompt.includes('职位标题：' + job.title));
    assert.ok(observed[i].prompt.includes(job.jd));
    assert.equal(cache[job.id].jf, f.win.BH.aiJobFingerprint(observed[i].input));
    const card = f.win.document.querySelector('[data-fixture-id="' + job.id + '"]');
    assert.ok(card.querySelector('.bh-tag-pass'), f.logs());
  }
  assert.equal(f.win.document.querySelector('.job-card-box.active').dataset.fixtureId, jobs[2].id);
  assert.equal(f.win.BH.loadStats().aiCalls, 3);
  assert.equal(f.win.BH.loadStats().skipped, 0);
});

test('详情暂未就绪保持可重试，下一轮成功后才标记已处理', { timeout: 16000 }, async (t) => {
  let retried = false;
  const f = await fixture(t, { aiEnabled: true, innerSelection: true, snapshotWait: 250, officialSuccess: true,
    onExpand(win, { expands }) {
      if (expands === 1) return false;
      const card = win.document.querySelector('.job-card-box');
      retried = card.dataset.bhProcessed !== '1' && win.BH.getUnprocessedJobCards().includes(card)
        && card.querySelector('.bh-tag')?.dataset.bhRetryable === '1';
    },
  });
  f.start();
  await waitUntil(() => f.stopped() || /主循环异常/.test(f.logs()), 13000);
  assert.equal(f.expandCount(), 2, f.logs());
  assert.equal(retried, true, '暂未就绪不能因为存在状态标签就被永久标为已处理');
  assert.equal(f.requests.length, 1);
  assert.equal(f.clickCount(), 1, f.logs());
  assert.equal(f.win.BH.loadStats().skipped, 0, '读取未就绪不是筛选拒绝');
  assert.ok(f.win.document.querySelector('.bh-tag-pass'));
});

for (const innerSelection of [true, false]) {
  test(`卡片${innerSelection ? 'role=button主体' : '新标签职位链接'}：祖先委托先收到未取消事件再正确选择`, { timeout: 16000 }, async (t) => {
    const f = await fixture(t, { aiEnabled: true, innerSelection, selectionDelegated: true,
      cardBodyRole: innerSelection, titleNewTab: !innerSelection, officialSuccess: true });
    const card = f.win.document.querySelector('.job-card-box');
    assert.equal(f.win.BH.getJobCardClickTarget(card), card.querySelector(innerSelection ? '.card-area' : '.job-name'));
    f.start();
    await waitUntil(() => f.stopped() || /主循环异常/.test(f.logs()), 13000);
    assert.equal(f.expandCount(), 1, f.logs());
    assert.deepEqual(f.selectionDefaultStates, [false], '不能在BOSS祖先选择监听前preventDefault');
    assert.equal(f.requests.length, 1);
    assert.equal(f.clickCount(), 1, f.logs());
    assert.equal(f.win.document.querySelector('.job-card-box.active')?.dataset.fixtureId, JOB.id);
    assert.ok(f.win.document.querySelector('.bh-tag-pass'));
    assert.deepEqual(f.errors, [], '职位选择不能触发原生新标签或页面导航');
  });
}

test('站点选择监听stopPropagation后仍取消职位链接原生新标签导航', { timeout: 16000 }, async (t) => {
  const f = await fixture(t, { aiEnabled: true, titleNewTab: true, officialSuccess: true,
    selectionPreventDefault: false, selectionStopPropagation: true });
  f.start();
  await waitUntil(() => f.stopped() || /主循环异常/.test(f.logs()), 13000);
  assert.equal(f.expandCount(), 1, f.logs());
  assert.equal(f.requests.length, 1);
  assert.equal(f.clickCount(), 1, f.logs());
  assert.ok(f.win.document.querySelector('.bh-tag-pass'));
  assert.deepEqual(f.errors, [], '冒泡被站点停止时仍不能执行原生页面导航');
});

test('详情连续未就绪只进行三次有界重试，不请求AI或占用投递额度', { timeout: 18000 }, async (t) => {
  const f = await fixture(t, { aiEnabled: true, innerSelection: true, snapshotWait: 100, onExpand: () => false });
  f.start();
  await waitUntil(() => f.win.document.querySelector('.job-card-box')?.dataset.bhProcessed === '1'
    || /主循环异常/.test(f.logs()), 15000);
  f.win.BH.stop('fixture completed');
  assert.equal(f.expandCount(), 3, f.logs());
  assert.equal(f.requests.length, 0);
  assert.equal(f.clickCount(), 0);
  assert.equal(f.win.BH.loadStats().sent, 30);
  assert.equal(f.win.BH.loadStats().skipped, 0);
  assert.match(f.win.document.querySelector('.bh-tag-not-sent')?.textContent || '', /连续未就绪/);
});

for (const phase of ['request', 'retry-wait']) {
  test(`AI${phase === 'request' ? '请求在途' : '一分钟等待'}切换岗位后重新读取，不再把旧JD交给下一API`, { timeout: 20000 }, async (t) => {
    const jobs = [
      { ...JOB, id: 'guardInputA', data: 'guard-a', title: '电机固件岗位A', jd: 'A独有职责：STM32电机控制固件与FOC算法调试。' },
      { ...JOB, id: 'guardInputB', data: 'guard-b', title: '通信固件岗位B', jd: 'B独有职责：FreeRTOS通信协议与CAN控制模块开发。' },
    ];
    let changed = false;
    const switchToB = (win) => {
      changed = true;
      win.document.querySelectorAll('.job-card-box.active').forEach((node) => node.classList.remove('active'));
      win.document.querySelector('[data-fixture-id="guardInputB"]').classList.add('active');
      win.document.getElementById('detail-host').innerHTML = detail(jobs[1], jobs[1].jd);
    };
    const f = await fixture(t, { aiEnabled: true, primaryFails: true, innerSelection: true, officialSuccess: true,
      jobs, settings: { maxRounds: 1, aiCacheEnabled: false },
      onRequest(win, request) {
        const prompt = JSON.parse(request.data).messages[1].content;
        if (prompt.includes(jobs[0].jd)) {
          if (phase === 'request' && !changed) setTimeout(() => {
            switchToB(win); request.onload({ status: 503, responseText: '{}' });
          }, 0);
          else queueMicrotask(() => request.onload({ status: 503, responseText: '{}' }));
        } else queueMicrotask(() => request.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: {
          content: '{"match":true,"score":92,"reason":"当前B岗位方向匹配"}',
        } }] }) }));
        return false;
      },
    });
    f.start();
    if (phase === 'retry-wait') {
      await waitUntil(() => /一分钟后重试全部接口/.test(f.logs()), 10000);
      assert.equal(f.requests.length, 2, f.logs());
      switchToB(f.win);
    }
    await waitUntil(() => f.stopped() || /主循环异常/.test(f.logs()), 16000);
    assert.equal(changed, true);
    assert.equal(f.clickCount(), 1, f.logs());
    const prompts = f.requests.map((request) => request.messages[1].content);
    assert.equal(prompts.filter((prompt) => prompt.includes(jobs[0].jd)).length, phase === 'request' ? 1 : 2,
      '输入切换之后不能再发送旧岗位JD');
    assert.equal(prompts.filter((prompt) => prompt.includes(jobs[1].jd)).length, 1);
    assert.ok(f.requests.at(-1).url.includes('primary.example'), '重读B后从主API开始');
    const a = f.win.document.querySelector('[data-fixture-id="guardInputA"]');
    const b = f.win.document.querySelector('[data-fixture-id="guardInputB"]');
    assert.notEqual(a.dataset.bhProcessed, '1', '旧输入变化仍保留A等待重新读取');
    assert.equal(a.querySelector('.bh-tag')?.dataset.bhRetryable, '1');
    assert.ok(b.querySelector('.bh-tag-pass'), f.logs());
    assert.equal(f.win.BH.loadStats().skipped, 0);
    assert.equal(f.win.BH.loadStats().sent, 31);
  });
}

test('截图MCU与Linux混合校招先调用AI，通过后离线关键词不能再次拦截', { timeout: 16000 }, async (t) => {
  const f = await fixture(t, { aiEnabled: true, jobs: [MIXED_JOB], settings: {
    mustHave: ['AUTOSAR'], mustNot: ['Linux'], yearsMin: 5, eduMin: 4, salaryMin: 50,
    aiUserPortrait: '寻找 MCU、RTOS、单片机嵌入式研发校招岗位，愿意学习同领域技术。',
  } });
  f.start();
  await waitUntil(() => f.clickCount() > 0 || /主循环异常/.test(f.logs()), 12000);
  assert.equal(f.requests.length, 1, f.logs());
  assert.equal(f.clickCount(), 1, f.logs());
  assert.equal(f.win.BH.loadStats().skipped, 0);
  const prompt = f.requests[0].messages.map((message) => message.content).join('\n');
  assert.match(prompt, /MCU\/RTOS/);
  assert.match(prompt, /Linux\/RTOS/);
  assert.match(prompt, /MCU.*不互斥|不互斥.*MCU/);
  assert.match(f.logs(), /AI 通过/);
});

test('混合技术岗位仍使用AI实际结论，不能因命中MCU和Linux就强行投递', { timeout: 16000 }, async (t) => {
  const f = await fixture(t, { aiEnabled: true, jobs: [MIXED_JOB], settings: { mustHave: ['MCU|Linux'], maxRounds: 1 },
    onRequest(win, request) {
      request.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: {
        content: '{"match":false,"score":10,"reason":"画像明确排除该岗位业务"}',
      } }] }) });
      return false;
    } });
  f.start();
  await waitUntil(() => f.stopped() || f.win.document.querySelector('.job-card-box')?.dataset.bhProcessed === '1', 12000);
  assert.equal(f.requests.length, 1, f.logs());
  assert.equal(f.clickCount(), 0);
  assert.match(f.logs(), /AI 不匹配.*画像明确排除该岗位业务/);
});

for (const aiEnabled of [false, true]) {
  test(`离线完整投递：AI${aiEnabled ? '未配置' : '关闭'}，MCU别名命中STM32后只发起一次沟通`, { timeout: 20000 }, async (t) => {
    const f = await fixture(t, { aiEnabled, settings: { aiApiKey: '', mustHave: ['MCU'], mustHaveMin: 1 } });
    f.start();
    await waitUntil(() => f.clickCount() > 0 || /主循环异常/.test(f.logs()));
    assert.equal(f.clickCount(), 1, f.logs());
    assert.equal(f.requests.length, 0);
    assert.equal(f.countAtClick(), 31);
    assert.equal(f.win.BH.loadStats().skipped, 0);
    if (aiEnabled) assert.match(f.logs(), /本地规则复核通过/);
  });
}

test('AI已开启但未配置时完整复核必含词，不能只检查排除词后放行', { timeout: 16000 }, async (t) => {
  const f = await fixture(t, { aiEnabled: true, settings: { aiApiKey: '', mustHave: ['射频天线设计'], mustHaveMin: 1, maxRounds: 1 } });
  f.start();
  await waitUntil(() => f.stopped() || f.win.document.querySelector('.job-card-box')?.dataset.bhProcessed === '1', 12000);
  assert.equal(f.clickCount(), 0, f.logs());
  assert.equal(f.requests.length, 0);
  assert.match(f.logs(), /必含词仅命中/);
});

test('全部AI接口故障时保留当前卡片等待，停止立即结束且不记跳过或占投递额度', { timeout: 16000 }, async (t) => {
  const f = await fixture(t, { aiEnabled: true, primaryFails: true,
    onRequest(win, o) {
      queueMicrotask(() => o.onload({ status: 503, responseText: '{"error":{"message":"offline"}}' }));
      return false;
    } });
  f.start();
  await waitUntil(() => /一分钟后重试全部接口/.test(f.logs()), 12000);
  assert.equal(f.requests.length, 2, f.logs());
  assert.equal(f.clickCount(), 0);
  assert.equal(f.win.document.querySelector('.job-card-box').dataset.bhProcessed, undefined);
  assert.equal(f.win.BH.loadStats().skipped, 0);
  assert.equal(f.win.BH.loadStats().sent, 30);
  assert.equal(f.win.BH.loadStats().pending, 0);
  f.win.BH.stop('测试停止');
  await waitUntil(() => f.stopped(), 1500);
  assert.equal(f.stopped(), true, f.logs());
  assert.equal(f.requests.length, 2);
});

test('请求途中暂停后AI成功响应仍保留岗位，恢复后只沟通一次', { timeout: 16000 }, async (t) => {
  const f = await fixture(t, { aiEnabled: true, onRequest(win) { win.BH.state.paused = true; } });
  f.start();
  await waitUntil(() => f.requests.length === 1, 10000);
  await delay(200);
  assert.equal(f.win.BH.state.paused, true);
  assert.equal(f.clickCount(), 0);
  assert.equal(f.win.document.querySelector('.job-card-box').dataset.bhProcessed, undefined);
  f.win.BH.state.paused = false;
  await waitUntil(() => f.clickCount() === 1, 10000);
  assert.equal(f.clickCount(), 1, f.logs());
  assert.equal(f.requests.length, 1);
  assert.equal(f.win.BH.loadStats().skipped, 0);
});

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

test('两岗位连续投递：先异步关闭成功弹窗再展开下一家，两张卡片均为绿色完成', { timeout: 25000 }, async (t) => {
  const events = [], violations = [], stayClicks = [], continueClicks = [];
  const timers = [];
  const f = await fixture(t, { jobs: [JOB, SECOND], stopAfter: 2,
    onContact(win, { job }) {
      events.push('contact:' + job.id);
      if (win.document.querySelector('.greet-dialog')) violations.push('contact-before-close:' + job.id);
      win.document.querySelector('.job-detail .op-btn-chat').textContent = '继续沟通';
      const dialog = win.document.createElement('section'); dialog.className = 'greet-dialog';
      dialog.innerHTML = '<header><h3 class="title">已向BOSS发送消息</h3></header><p>本次默认招呼语</p>'
        + '<footer><button class="default-btn cancel-btn">留在此页</button><button class="continue-btn">继续沟通</button></footer>';
      dialog.querySelector('.continue-btn').addEventListener('click', () => continueClicks.push(job.id));
      dialog.querySelector('.cancel-btn').addEventListener('click', () => {
        stayClicks.push(job.id); events.push('stay:' + job.id);
        timers.push(setTimeout(() => { dialog.remove(); events.push('closed:' + job.id); }, 120));
      });
      win.document.body.append(dialog);
    },
  });
  t.after(() => timers.forEach(clearTimeout));
  for (const card of f.win.document.querySelectorAll('.job-card-box')) card.addEventListener('click', () => {
    events.push('expand:' + card.dataset.fixtureId);
    if (f.win.document.querySelector('.greet-dialog')) violations.push('expand-before-close:' + card.dataset.fixtureId);
  }, true);
  f.start();
  await waitUntil(() => f.stopped() || /主循环异常/.test(f.logs()), 22000);
  assert.equal(f.clickCount(), 2, f.logs());
  assert.deepEqual(violations, [], events.join('\n'));
  assert.deepEqual(stayClicks, [JOB.id, SECOND.id], '每次成功后只能点同框留在此页');
  assert.deepEqual(continueClicks, [], '不能进入聊天页打断下一家处理');
  assert.equal(f.win.document.querySelector('.greet-dialog'), null, '最终成功弹窗也应清理');
  assert.ok(events.indexOf('closed:' + JOB.id) < events.indexOf('expand:' + SECOND.id), events.join('\n'));
  for (const card of f.win.document.querySelectorAll('.job-card-box')) {
    const completed = card.querySelector('.bh-tag-pass');
    assert.ok(completed, '已确认成功的岗位使用绿色完成状态');
    assert.match(completed.textContent, /完成/);
    assert.equal(card.querySelector('.bh-tag-pending'), null);
  }
  assert.equal(f.win.BH.loadStats().sent, 32);
  assert.deepEqual(f.errors, []);
});

test('停止后成功回执迟到，原卡由待确认转为绿色完成并关闭弹窗，不重复点击', { timeout: 10000 }, async (t) => {
  let timer, dialog, stayClicks = 0, sawPending = false, pendingAtReceipt = '';
  const f = await fixture(t, {
    onContact(win) {
      timer = setTimeout(() => {
        pendingAtReceipt = win.document.querySelector('.job-card-box .bh-tag-pending')?.textContent || '';
        dialog = win.document.createElement('section'); dialog.className = 'greet-dialog';
        dialog.innerHTML = '<header><h3 class="title">已向BOSS发送消息</h3></header><p>迟到的官方成功回执</p>'
          + '<footer><button class="default-btn cancel-btn">留在此页</button><button>继续沟通</button></footer>';
        dialog.querySelector('.cancel-btn').addEventListener('click', () => { stayClicks++; dialog.remove(); });
        win.document.body.append(dialog);
      }, 600);
    },
  });
  const card = f.win.document.querySelector('.job-card-box');
  const observer = new f.win.MutationObserver(() => { if (card.querySelector('.bh-tag-pending')) sawPending = true; });
  observer.observe(card, { childList: true, subtree: true });
  t.after(() => { clearTimeout(timer); observer.disconnect(); });
  f.start();
  await waitUntil(() => card.querySelector('.bh-tag-pass') && dialog && !dialog.isConnected && f.stopped(), 9000);
  assert.equal(sawPending, true, '回执必须在原投递已返回待确认后才到达');
  assert.match(pendingAtReceipt, /待确认/);
  assert.match(card.querySelector('.bh-tag-pass')?.textContent || '', /完成/);
  assert.equal(card.querySelector('.bh-tag-pending'), null);
  assert.equal(stayClicks, 1);
  assert.ok(dialog && !dialog.isConnected);
  assert.equal(f.win.BH.state.stopFlag, true, '只补记完成与关闭弹窗，不能恢复投递循环');
  assert.equal(f.expandCount(), 1);
  assert.equal(f.clickCount(), 1);
  assert.equal(f.win.BH.loadStats().sent, 31);
  assert.deepEqual(f.errors, []);
});

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
