import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const CONFIG = 'boss_helper_config_v1';
const primary = { aiBaseUrl: 'https://api.example/v1/chat/completions', aiApiKey: 'fixture-secret', aiModel: 'fixture-model' };
const source = fs.readFileSync(SCRIPT, 'utf8');
async function fixture(t, config = {}, options = {}) {
  const store = options.store || new Map([[CONFIG, structuredClone(config)]]);
  const requests = [], timers = [], errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + (options.html || '') + '</body></html>', {
    url: 'https://www.zhipin.com/web/geek/job?query=fixture', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console,
  });
  const win = dom.window, doc = win.document;
  if (options.localConfig) win.localStorage.setItem(CONFIG, JSON.stringify(options.localConfig));
  win.GM_getValue = (key, fallback) => store.has(key) ? structuredClone(store.get(key)) : fallback;
  win.GM_setValue = (key, value) => store.set(key, structuredClone(value));
  win.GM_listValues = () => [...store.keys()];
  win.GM_deleteValue = (key) => store.delete(key);
  win.GM_addStyle = () => {};
  win.unsafeWindow = win;
  win.fetch = () => assert.fail('Settings tests must never contact a server');
  win.GM_xmlhttpRequest = (request) => {
    requests.push(request);
    if (options.request) return options.request(win, request, requests.length);
    setTimeout(() => request.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '{"match":true,"reason":"fixture"}' } }] }) }), 0);
    return { abort() {} };
  };
  if (options.fastTimers) {
    const nativeSetTimeout = win.setTimeout.bind(win);
    win.setTimeout = (callback, ms, ...args) => {
      timers.push(ms);
      return nativeSetTimeout(callback, Math.min(ms, 5), ...args);
    };
  }
  Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { get() { return 600; } });
  Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { get() { return 300; } });
  win.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 300, right: 600, bottom: 300 });
  win.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  Object.defineProperty(doc.documentElement, 'scrollHeight', { get() { return 2000; } });
  let scrollY = 0;
  Object.defineProperty(win, 'scrollY', { get() { return scrollY; } });
  win.scrollBy = (x, y) => { scrollY = Math.max(0, Math.min(2000 - win.innerHeight, scrollY + (typeof x === 'object' ? x.top || 0 : y || 0))); };
  win.scrollTo = (x, y) => { scrollY = Math.max(0, Math.min(2000 - win.innerHeight, typeof x === 'object' ? x.top || 0 : y || 0)); };
  // Only expose the existing browse function for an isolated runtime cancellation test.
  let runtime = source.replace('state, loadConfig, loadStats,', 'state, humanBrowse, loadConfig, loadStats,');
  if (options.scheduleOnly) {
    // Keep the real process wrapper, identity bookkeeping and loop. These tests only
    // replace the site/AI work with an explicit completed screening result.
    runtime = runtime.replace('  async function processOneInner(card) {',
      '  async function processOneInner(card) {\n    tagCard(card, "matched", "fixture scheduling only"); return;');
  }
  win.eval(runtime);
  await delay(0);
  t.after(() => { win.BH.state.stopFlag = true; win.close(); });
  const input = (name) => doc.querySelector('#boss-helper-panel [data-cfg="' + name + '"]');
  const ai = (name) => doc.querySelector('#bh-ai-modal [data-cfg="' + name + '"]');
  const action = async (name) => {
    const previousLogs = new Set(doc.querySelectorAll('.bh-log-line'));
    doc.querySelector('[data-act="' + name + '"]').click();
    if (name === 'save' || name === 'aisave') {
      await until(() => [...doc.querySelectorAll('.bh-log-line')].some((line) => !previousLogs.has(line)
        && /配置已保存|配置保存失败|AI 设置已保存|AI 设置保存失败/.test(line.textContent)));
    }
  };
  return { win, doc, BH: win.BH, store, requests, timers, errors, input, ai, action };
}
async function until(condition, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!condition()) { assert.ok(Date.now() < end, 'Operation did not finish in time'); await delay(10); }
}

test('all main parameters survive saving, runtime application and a page reload', async (t) => {
  const f = await fixture(t);
  const fields = { mustHave: 'STM32|ARM\nC++', mustNot: '外包\n驻场', mustHaveMin: '2', yearsMin: '5', eduMin: '3',
    salaryMin: '18.5', activeDays: '15', minDelay: '1.5', maxDelay: '4.5', pageDelayMin: '9', pageDelayMax: '12',
    dailyLimit: '120', maxRounds: '1', batchSize: '7', batchPauseSec: '0' };
  for (const [name, value] of Object.entries(fields)) f.input(name).value = value;
  f.input('autoSend').checked = false;
  f.input('autoScroll').checked = false;
  await f.action('save');
  const saved = f.store.get(CONFIG);
  assert.deepEqual(saved.mustHave, ['STM32|ARM', 'C++']);
  assert.deepEqual(saved.mustNot, ['外包', '驻场']);
  for (const [name, value] of Object.entries(fields).filter(([key]) => !['mustHave', 'mustNot'].includes(key))) {
    assert.equal(saved[name], Number(value), name);
    assert.equal(f.BH.state.config[name], Number(value), name + ' runtime');
  }
  assert.equal(saved.autoSend, false);
  assert.equal(saved.autoScroll, false);
  const reload = await fixture(t, {}, { store: f.store });
  for (const [name, value] of Object.entries(fields)) assert.equal(reload.input(name).value, value, name + ' reload');
  assert.equal(reload.input('autoSend').checked, false);
  assert.equal(reload.input('autoScroll').checked, false);
});

test('opening and cancelling AI settings preserves unsaved main rules, while AI save applies both sections', async (t) => {
  const f = await fixture(t, primary);
  f.input('dailyLimit').value = '135';
  f.input('mustNot').value = '自定义排除';
  f.input('pageDelayMin').value = '11';
  f.input('pageDelayMax').value = '13';
  f.action('aiopen');
  assert.equal(f.input('dailyLimit').value, '135');
  f.action('aiclose');
  assert.equal(f.input('mustNot').value, '自定义排除');
  f.action('aiopen');
  f.ai('aiEnabled').checked = true;
  f.ai('aiUserPortrait').value = '寻找固件研发';
  await f.action('aisave');
  assert.equal(f.store.get(CONFIG).dailyLimit, 135);
  assert.equal(f.store.get(CONFIG).pageDelayMin, 11);
  assert.equal(f.store.get(CONFIG).pageDelayMax, 13);
  assert.equal(f.BH.state.config.aiUserPortrait, '寻找固件研发');
});

test('numeric bounds, integer fields, reversed delay ranges and legal zero values are normalized and shown', async (t) => {
  const f = await fixture(t, primary);
  const cases = { mustHaveMin: ['2.8', 2], salaryMin: ['-3', 0], minDelay: ['80', 60], maxDelay: ['1', 60],
    pageDelayMin: ['12', 12], pageDelayMax: ['3', 12], dailyLimit: ['900', 500], maxRounds: ['-1', 0],
    batchSize: ['0', 1], batchPauseSec: ['0', 0] };
  for (const [key, [value]] of Object.entries(cases)) f.input(key).value = value;
  await f.action('save');
  for (const [key, [, expected]] of Object.entries(cases)) {
    assert.equal(f.store.get(CONFIG)[key], expected, key);
    assert.equal(f.input(key).value, String(expected), key + ' display');
  }
  f.action('aiopen');
  assert.equal(f.ai('aiDailyLimit'), null);
  f.ai('aiTimeoutMs').value = '1';
  f.ai('aiMaxJDChars').value = '90000';
  await f.action('aisave');
  assert.equal(f.store.get(CONFIG).aiDailyLimit, null);
  assert.equal(f.doc.querySelector('[data-role=ai-unlimited]').textContent, '不限');
  assert.equal(f.ai('aiTimeoutMs').value, '3000');
  assert.equal(f.ai('aiMaxJDChars').value, '20000');
});

test('upgrading preserves deliberate keyword rules and custom activity values; obsolete greeting field is absent', async (t) => {
  const words = ['外包', '驻场', '销售', '客服'];
  const f = await fixture(t, { mustNot: words, yearsMin: 4, activeDays: 14, maxRounds: 1,
    greetings: ['旧自定义招呼'], greetingMode: 'fixed' });
  assert.deepEqual(Array.from(f.BH.loadConfig().mustNot), words);
  assert.equal(f.input('yearsMin').value, '4');
  assert.equal(f.input('activeDays').value, '14');
  assert.equal(f.input('greetings'), null);
  assert.match(f.doc.querySelector('[data-role="greeting-help"]').textContent, /手机/);
  await f.action('save');
  assert.deepEqual(f.store.get(CONFIG).mustNot, words);
  assert.equal(f.store.get(CONFIG).activeDays, 14);
  assert.equal(f.store.get(CONFIG).maxRounds, 1);
});

test('nullish legacy AI strings recover defaults while deliberate empty strings remain unchanged', async (t) => {
  const f = await fixture(t, { aiEnabled: true, aiApiKey: 'fixture-secret', aiBaseUrl: null, aiModel: undefined,
    aiProvider: null, aiUserPortrait: null, aiPromptTemplate: null });
  const cfg = f.BH.loadConfig();
  assert.equal(cfg.aiBaseUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal(cfg.aiModel, 'gpt-4o-mini');
  assert.equal(cfg.aiProvider, 'openai');
  assert.equal(cfg.aiUserPortrait, '');
  assert.equal(cfg.aiPromptTemplate, '');
  f.action('aiopen');
  assert.equal(f.ai('aiBaseUrl').value, cfg.aiBaseUrl);
  assert.equal(f.ai('aiModel').value, cfg.aiModel);
  const empty = await fixture(t, { aiBaseUrl: '', aiModel: '', aiApiKey: '' });
  assert.equal(empty.BH.loadConfig().aiBaseUrl, '');
  assert.equal(empty.BH.loadConfig().aiModel, '');
});

test('local fallback saves beat readable stale GM values, survive reload and yield to the next successful GM save', async (t) => {
  const f = await fixture(t, { ...primary, dailyLimit: 50 });
  f.win.GM_setValue = (key, value) => {
    if (key === CONFIG) throw Error('fixture GM config write unavailable');
    f.store.set(key, structuredClone(value));
  };
  f.input('dailyLimit').value = '135';
  await f.action('save');
  const fallback = JSON.parse(f.win.localStorage.getItem(CONFIG));
  assert.equal(f.store.get(CONFIG).dailyLimit, 50);
  assert.equal(fallback.dailyLimit, 135);
  assert.equal(f.BH.loadConfig().dailyLimit, 135);
  const reloaded = await fixture(t, {}, { store: f.store, localConfig: fallback });
  assert.equal(reloaded.input('dailyLimit').value, '135');
  reloaded.input('dailyLimit').value = '140';
  await reloaded.action('save');
  assert.equal(reloaded.BH.loadConfig().dailyLimit, 140);
  assert.ok(reloaded.store.get(CONFIG)._configUpdatedAt > fallback._configUpdatedAt);
  assert.equal(reloaded.win.localStorage.getItem(CONFIG), null, 'Normal GM saves must not retain credential copies in localStorage');
  const next = await fixture(t, {}, { store: reloaded.store, localConfig: fallback });
  assert.equal(next.BH.loadConfig().dailyLimit, 140, 'Even a stale local copy cannot override the newer GM save');
});

test('legacy copies without timestamps still prefer GM; a silently ignored write uses verified local fallback', async (t) => {
  const f = await fixture(t, { dailyLimit: 55 }, { localConfig: { dailyLimit: 75 } });
  assert.equal(f.BH.loadConfig().dailyLimit, 55);
  f.win.GM_setValue = (key, value) => { if (key !== CONFIG) f.store.set(key, structuredClone(value)); };
  f.input('dailyLimit').value = '90';
  await f.action('save');
  assert.equal(f.BH.loadConfig().dailyLimit, 90);
  assert.equal(f.store.get(CONFIG).dailyLimit, 55);
  assert.equal(JSON.parse(f.win.localStorage.getItem(CONFIG)).dailyLimit, 90);
});

test('AI fields save and reload, main saves preserve them, and rule edits invalidate cached conclusions', async (t) => {
  const f = await fixture(t, primary);
  f.action('aiopen');
  const strings = { aiBaseUrl: 'https://updated.example/v1', aiApiKey: 'updated-fixture', aiModel: 'updated-model',
    aiUserPortrait: '固件研发，只投本科以下', aiPromptTemplate: 'Return JSON', aiFallback: 'pause',
    aiTimeoutMs: '15000', aiMaxJDChars: '4000' };
  for (const [key, value] of Object.entries(strings)) f.ai(key).value = value;
  for (const key of ['aiEnabled', 'aiPrimaryEnabled']) f.ai(key).checked = true;
  for (const key of ['aiCacheEnabled', 'aiRejectShortTerm', 'aiStrictFacts']) f.ai(key).checked = false;
  await f.action('aisave');
  const fingerprint = f.BH.aiCacheFingerprint();
  f.action('aiclose');
  f.input('salaryMin').value = '21';
  await f.action('save');
  assert.notEqual(f.BH.aiCacheFingerprint(), fingerprint);
  const reload = await fixture(t, {}, { store: f.store });
  reload.action('aiopen');
  for (const [key, value] of Object.entries(strings)) assert.equal(reload.ai(key).value,
    key === 'aiBaseUrl' ? value + '/chat/completions' : value, key);
  for (const key of ['aiCacheEnabled', 'aiRejectShortTerm', 'aiStrictFacts']) assert.equal(reload.ai(key).checked, false, key);
});

test('an unrelated website data-cfg element cannot overwrite saved AI settings', async (t) => {
  const f = await fixture(t, primary, { html: '<input data-cfg="aiApiKey" value="foreign-key"><input data-cfg="aiEnabled" type="checkbox">' });
  f.action('aiopen');
  assert.equal(f.ai('aiApiKey').value, primary.aiApiKey);
  await f.action('aisave');
  assert.equal(f.store.get(CONFIG).aiApiKey, primary.aiApiKey);
  assert.equal(f.doc.querySelector('body > input').value, 'foreign-key');
});

test('testing an unsaved AI portrait uses the draft in the outgoing prompt without changing the running policy', async (t) => {
  const f = await fixture(t, { ...primary, aiEnabled: true, aiUserPortrait: '旧方向' });
  await f.action('save');
  const cfg = { ...f.BH.state.config, aiUserPortrait: '新方向：电机控制', salaryMin: 27, aiRejectShortTerm: false };
  const result = await f.BH.aiScreen({ title: '测试岗位', jobId: 'draft-fixture', jd: '负责控制软件开发与设备调试。' }, { bypassCache: true, config: cfg });
  assert.equal(result.ok, true);
  const prompt = JSON.parse(f.requests[0].data).messages[1].content;
  assert.match(prompt, /新方向：电机控制/);
  assert.match(prompt, /27/);
  assert.doesNotMatch(prompt, /旧方向/);
  assert.equal(f.BH.state.config.aiUserPortrait, '旧方向');
});

// Synthetic candidate facts only: this portrait contains no real user's text.
const LONG_CANDIDATE_PORTRAIT = [
  '身份背景：普通工科应届候选人，下面的技能、项目和意向用于本地出站回归，所有经历均为合成测试资料。希望根据现有能力寻找可以承担实际开发任务的岗位。',
  '已掌握技能：熟练使用 STM32 MCU、C 语言和 FreeRTOS，能够完成 GPIO、UART、SPI、I2C 外设驱动、任务调度、队列通信和基本中断处理；这些是已经掌握的 MCU/RTOS 技能。',
  '实际项目：独立完成一个合成环境监测控制器，负责传感器接入、串口通信、数据采集、任务划分和日志定位；另有合成电机控制项目，使用 PWM 和状态机完成调速、异常停止与设备联调。',
  '项目边界：以上项目运行于单片机和 FreeRTOS，能说明固件开发及嵌入式调试经验，但没有证明完成过工业 Linux 板级移植、内核裁剪或复杂高速总线驱动，不应从项目名称推导额外能力。',
  '明确技能缺口：Linux 仅入门，能使用基本命令并理解进程概念；尚不熟悉 Linux 内核、设备树和 UBoot，没有 PCIe 驱动项目。岗位必须深入掌握这些技术时，应准确评估当前差距。',
  '目标意向：希望以后从事汽车 ECU 或 AUTOSAR 方向，愿意在有培养安排的岗位中学习；ECU/AUTOSAR 是意向，并不代表已经掌握，也没有实际 ECU 或 AUTOSAR 开发经历。',
  '未验证能力：未提及的专业技术不能自动补写为精通，也不能直接断言不会。请分别考虑已掌握的技能、可转移项目经验、明确缺口与岗位真正的核心必备要求。画像末尾完整性标记：合成候选人画像结束。',
].join('\n');

for (const customSystem of ['', '用户自定义输出要求：依据候选人事实与岗位核心职责，只返回 match、score、reason JSON。']) {
  test(`长多行技能画像保存重载后完整发送主备接口（${customSystem ? '自定义' : '默认'}system）`, async (t) => {
    assert.ok(LONG_CANDIDATE_PORTRAIT.length > 300, '画像超过本用例JD上限，不能误用JD截断逻辑');
    const backup = { id: 'profile-backup', name: '画像回归备用', enabled: true,
      baseUrl: 'https://profile-backup.example/v1/chat/completions', apiKey: 'synthetic-backup-key', model: 'synthetic-backup-model' };
    const f = await fixture(t, { ...primary, aiCacheEnabled: false, aiEndpoints: [backup] });
    await f.action('aiopen');
    f.ai('aiEnabled').checked = true;
    f.ai('aiUserPortrait').value = LONG_CANDIDATE_PORTRAIT;
    f.ai('aiPromptTemplate').value = customSystem;
    f.ai('aiMaxJDChars').value = '300';
    f.ai('aiCacheEnabled').checked = false;
    await f.action('aisave');
    assert.equal(f.store.get(CONFIG).aiUserPortrait, LONG_CANDIDATE_PORTRAIT);
    assert.equal(f.BH.state.config.aiUserPortrait, LONG_CANDIDATE_PORTRAIT);
    await f.action('aiclose');
    f.input('salaryMin').value = '10';
    await f.action('save');
    assert.equal(f.store.get(CONFIG).aiUserPortrait, LONG_CANDIDATE_PORTRAIT, '主面板保存不得覆盖画像');

    const reload = await fixture(t, {}, { store: f.store,
      request(win, request) {
        queueMicrotask(() => request.onload({ status: request.url === primary.aiBaseUrl ? 503 : 200,
          responseText: request.url === primary.aiBaseUrl ? '{"error":{"message":"synthetic primary unavailable"}}'
            : JSON.stringify({ choices: [{ message: { content: '{"match":true,"score":90,"reason":"本地出站回归"}' } }] }),
        }));
        return { abort() {} };
      },
    });
    await reload.action('aiopen');
    assert.equal(reload.ai('aiUserPortrait').value, LONG_CANDIDATE_PORTRAIT);
    assert.equal(reload.ai('aiPromptTemplate').value, customSystem);
    await reload.action('aiclose');
    const result = await reload.BH.aiScreen({ jobId: 'synthetic-long-portrait', title: 'MCU固件开发工程师',
      company: '合成回归研发公司', salary: '15-20K',
      jd: '负责 STM32 与 FreeRTOS 固件开发、传感器接入及设备通信联调。\n'.repeat(16) });
    assert.equal(result.ok, true, result.err);
    assert.equal(result.endpointId, backup.id);
    assert.deepEqual(reload.requests.map((request) => request.url), [primary.aiBaseUrl, backup.baseUrl]);
    const sentUsers = [];
    for (const request of reload.requests) {
      const messages = JSON.parse(request.data).messages;
      const users = messages.filter((message) => message.role === 'user');
      assert.equal(users.length, 1);
      const user = users[0].content, system = messages.find((message) => message.role === 'system').content;
      sentUsers.push(user);
      assert.equal(user.split(LONG_CANDIDATE_PORTRAIT).length - 1, 1, '整段原画像必须恰好一次进入user消息');
      assert.equal(user.slice(user.indexOf('【求职者画像】\n') + '【求职者画像】\n'.length,
        user.indexOf('【求职者画像】\n') + '【求职者画像】\n'.length + LONG_CANDIDATE_PORTRAIT.length), LONG_CANDIDATE_PORTRAIT);
      assert.ok(user.includes('熟练使用 STM32 MCU、C 语言和 FreeRTOS'));
      assert.ok(user.includes('Linux 仅入门'));
      assert.ok(user.includes('ECU/AUTOSAR 是意向，并不代表已经掌握'));
      assert.ok(user.includes('画像末尾完整性标记：合成候选人画像结束。'));
      assert.doesNotMatch(user, /^(?:[-*]\s*)?(?:候选人|求职者|我)?(?:已)?(?:精通Linux|精通ECU|精通AUTOSAR|熟练掌握PCIe)/m,
        '程序不得追加与合成画像相反的熟练技能事实');
      assert.match(system, /候选人画像与核心技能适配规则/);
      assert.match(system, /身份背景.*已掌握技能.*项目.*目标或兴趣.*技能缺口/);
      assert.match(system, /ECU[^\n]*AUTOSAR[^\n]*意向[^\n]*不能[^\n]*开发能力/);
      assert.match(system, /未提及某技能不等于不会，也不等于已经会/);
      if (customSystem) assert.ok(system.includes(customSystem), '自定义system仍须附能力适配规则');
    }
    assert.equal(sentUsers[0], sentUsers[1], '故障切换不能改变或缩短画像输入');
    assert.deepEqual(reload.errors, []);
  });
}

test('legacy AI cap changed to zero during a failed round does not block the next round', async (t) => {
  const f = await fixture(t, { ...primary, aiEnabled: true, aiDailyLimit: 100, aiMaxRetries: 0 }, {
    request(win, request) {
      win.BH.applyConfig({ ...win.BH.state.config, aiDailyLimit: 0 });
      request.onload({ status: 503, responseText: '{}' });
      return { abort() {} };
    },
  });
  await f.action('save');
  const result = await f.BH.aiScreen({ title: '测试岗位', jobId: 'quota-fixture', jd: '负责设备控制软件开发。' });
  assert.equal(result.ok, false);
  assert.equal(f.requests.length, 1);
  assert.equal(result.apiUnavailable, true);
  assert.match(result.err, /HTTP 503/);
  const next = await f.BH.aiScreen({ title: '测试岗位', jobId: 'quota-next-round', jd: '负责设备控制软件开发。' });
  assert.equal(next.ok, false);
  assert.equal(next.apiUnavailable, true);
  assert.equal(next.quotaExceeded, undefined);
  assert.match(next.err, /HTTP 503/);
  assert.equal(f.requests.length, 2, '旧 AI 上限不阻断下一轮真实网络请求');
  assert.equal(f.BH.state.config.aiDailyLimit, null);
});

for (const oldLimit of [0, 100, 73]) {
  test(`旧 AI 上限 ${oldLimit} 自动迁移为不限，投递上限 150 保留`, async (t) => {
    const f = await fixture(t, { ...primary, aiEnabled: true, aiDailyLimit: oldLimit, dailyLimit: 150 });
    assert.equal(f.BH.loadConfig().aiDailyLimit, null);
    assert.equal(f.BH.loadConfig().dailyLimit, 150);
    await f.action('aiopen');
    assert.equal(f.ai('aiDailyLimit'), null);
    assert.equal(f.doc.querySelector('[data-role=ai-unlimited]').textContent, '不限');
    await f.action('aisave');
    assert.equal(f.store.get(CONFIG).aiDailyLimit, null);
    assert.equal(f.store.get(CONFIG).dailyLimit, 150);
  });
}

const cards = '<ul class="job-list-wrapper"><li class="job-card-box" data-jobid="schedule-first"><a class="job-name" href="/job_detail/schedule-first.html">测试岗位</a></li></ul>';
test('one round remains one round after Start; batch size and pause reach the actual loop timer', async (t) => {
  const f = await fixture(t, { autoSend: false, autoScroll: false, maxRounds: 1, batchSize: 1, batchPauseSec: 2,
    minDelay: 0.5, maxDelay: 0.5 }, { html: cards, fastTimers: true, scheduleOnly: true });
  f.action('toggle');
  await until(() => f.BH.state._loopActive === false);
  assert.equal(f.BH.state.config.maxRounds, 1);
  assert.equal(f.BH.state._inBatch, 0);
  assert.match(f.doc.querySelector('.bh-log').textContent, /已处理 1 张，停 2 秒/);
  assert.match(f.doc.querySelector('.bh-reason').textContent, /最大轮次 1/);
  assert.ok(f.timers.filter((ms) => ms === 1000).length >= 2);
  assert.equal(f.requests.length, 0);
});

test('page delay fields reach the actual loop wait after loading more cards', async (t) => {
  const f = await fixture(t, { autoSend: false, autoScroll: false, maxRounds: 2, pageDelayMin: 24, pageDelayMax: 24,
    minDelay: 0.5, maxDelay: 0.5 }, { html: cards, fastTimers: true, scheduleOnly: true });
  let appended = false;
  f.win.addEventListener('scroll', () => {
    if (appended) return;
    appended = true;
    f.doc.querySelector('.job-list-wrapper').insertAdjacentHTML('beforeend',
      '<li class="job-card-box" data-jobid="schedule-next"><a class="job-name" href="/job_detail/schedule-next.html">下一页岗位</a></li>');
  });
  f.action('toggle');
  await until(() => f.BH.state._loopActive === false);
  assert.equal(appended, true, 'A real new job must appear after the list scroll trigger');
  assert.equal(f.doc.documentElement.scrollHeight, 2000, 'Loading can succeed without document-height growth');
  assert.ok(f.doc.querySelector('[data-jobid="schedule-next"]'));
  assert.ok(f.timers.includes(24000), 'Configured page delay must reach CLOCK.sleep as a finite duration');
  assert.ok(f.timers.every(Number.isFinite));
  assert.equal(f.requests.length, 0);
});

test('Stop followed immediately by Start cannot revive a loop that is still unwinding', async (t) => {
  const f = await fixture(t, { autoSend: false, autoScroll: false, maxRounds: 1,
    minDelay: 0.5, maxDelay: 0.5 }, { html: cards, fastTimers: true, scheduleOnly: true });
  const originalSleep = f.BH.CLOCK.sleep;
  let resumeSleep;
  f.BH.CLOCK.sleep = () => new Promise((resolve) => { resumeSleep = resolve; });
  f.action('toggle');
  await until(() => f.BH.state._loopActive === true && typeof resumeSleep === 'function');
  assert.equal(f.BH.state._loopActive, true);
  f.action('toggle');
  f.action('toggle');
  assert.equal(f.BH.state.stopFlag, true);
  assert.match(f.doc.querySelector('.bh-log').textContent, /上一轮正在停止/);
  f.BH.CLOCK.sleep = originalSleep;
  resumeSleep();
  await until(() => f.BH.state._loopActive === false);
  f.action('toggle');
  await until(() => f.BH.state.stopFlag === false);
  assert.equal(f.BH.state.stopFlag, false);
  await until(() => f.BH.state._loopActive === false);
  assert.equal(f.requests.length, 0);
});

test('saving autoScroll=false interrupts an already running simulated browse before its next scroll', async (t) => {
  const f = await fixture(t, { autoScroll: true }, { fastTimers: true });
  await f.action('save');
  let scrolls = 0;
  f.win.scrollTo = () => {
    scrolls++;
    f.BH.applyConfig({ ...f.BH.state.config, autoScroll: false });
  };
  await f.BH.humanBrowse(1000);
  assert.equal(scrolls, 1);
  assert.equal(f.input('autoScroll').checked, false);
});
