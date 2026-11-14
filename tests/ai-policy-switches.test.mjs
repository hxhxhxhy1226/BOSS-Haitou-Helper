/** Settings and adversarial model-response regressions. No real browser or API data. */
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const CONFIG = 'boss_helper_config_v1';
const PRIMARY = 'https://policy-primary.example/v1/chat/completions';
const BACKUP = 'https://policy-backup.example/v1/chat/completions';
const source = fs.readFileSync(SCRIPT, 'utf8').replace('aiScreen, callLLM, buildAIPrompt,',
  'validateAIResultPolicy, aiScreen, callLLM, buildAIPrompt,');
const portrait = '应届本科，做过 STM32、FreeRTOS 与 FOC 电机控制项目，寻找嵌入式研发岗位';
const target = (id = 'policy-job') => ({ jobId: id, title: '嵌入式工程师（电调 FOC）', company: '合成研发公司',
  salary: '15-25K', experience: '3-5年', education: '硕士',
  jd: '岗位职责：使用 STM32、FreeRTOS 和 FOC 进行电机控制固件开发。任职要求：3年以上嵌入式开发经验，硕士及以上学历。' });

function respond(request, result) {
  request.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }) });
}
async function until(predicate, message = 'operation did not finish') {
  const deadline = Date.now() + 4000;
  while (!predicate()) { assert.ok(Date.now() < deadline, message); await delay(5); }
}
async function fixture(t, { cfg = {}, store = new Map(), gm } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://www.zhipin.com/web/geek/job?query=synthetic-policy-fixture',
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window, requests = [];
  const NativeDate = win.Date;
  win.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [Date.parse('2026-11-14T04:00:00Z')])); }
    static now() { return Date.parse('2026-11-14T04:00:00Z'); }
  };
  win.GM_getValue = (key, fallback) => store.has(key) ? structuredClone(store.get(key)) : fallback;
  win.GM_setValue = (key, value) => store.set(key, structuredClone(value));
  win.GM_listValues = () => [...store.keys()];
  win.GM_deleteValue = (key) => store.delete(key);
  win.GM_addStyle = () => {};
  win.unsafeWindow = win;
  win.fetch = () => assert.fail('Policy regressions must never contact a server');
  win.GM_xmlhttpRequest = (request) => {
    requests.push({ request, url: request.url, body: JSON.parse(request.data) });
    queueMicrotask(() => (gm || ((o) => respond(o, { match: true, score: 85, reason: '已有 STM32、FreeRTOS 和 FOC 项目基础，职责相关' })))(request, requests.length));
    return { abort() {} };
  };
  win.eval(source);
  await delay(0);
  const BH = win.BH;
  if (!store.has(CONFIG)) {
    await BH.applyConfig({ ...BH.loadConfig(), aiEnabled: true, aiBaseUrl: PRIMARY, aiApiKey: 'synthetic-key',
      aiModel: 'synthetic-model', aiPrimaryEnabled: true, aiCacheEnabled: true, aiTimeoutMs: 3000,
      aiUserPortrait: portrait, mustNot: [], activeDays: 0, salaryMin: 0, aiEndpoints: [], ...cfg });
  } else if (Object.keys(cfg).length) await BH.applyConfig({ ...BH.loadConfig(), ...cfg });
  BH.state.stopFlag = false;
  t.after(() => { BH.state.stopFlag = true; BH.state.paused = false; win.close(); });
  const input = (key) => win.document.querySelector('#boss-helper-panel [data-cfg="' + key + '"]');
  const ai = (key) => win.document.querySelector('#bh-ai-modal [data-cfg="' + key + '"]');
  const action = async (name) => {
    const logs = new Set(win.document.querySelectorAll('.bh-log-line'));
    win.document.querySelector('[data-act="' + name + '"]').click();
    if (['save', 'aisave'].includes(name)) await until(() => [...win.document.querySelectorAll('.bh-log-line')]
      .some((line) => !logs.has(line) && /配置已保存|AI 设置已保存|保存失败/.test(line.textContent)));
  };
  return { BH, win, store, requests, input, ai, action };
}

test('忽略年限学历开关默认开启并置于限制与策略，具有完整可点击轨道', async (t) => {
  const f = await fixture(t);
  assert.equal(f.BH.loadConfig().aiIgnoreEduExp, true);
  await f.action('aiopen');
  const sw = f.ai('aiIgnoreEduExp');
  assert.ok(sw, 'new policy needs an actual form control');
  assert.equal(sw.checked, true);
  assert.match(sw.closest('.bh-ai-group').querySelector('.bh-ai-group-title').textContent, /限制与策略/);
  assert.ok(sw.closest('.bh-ai-toggle').querySelector('.bh-ai-track .bh-ai-knob'));
  assert.match(sw.closest('.bh-ai-row').textContent, /忽略.*(?:学历|年限)|(?:学历|年限).*忽略/);
});

test('三个策略开关保存、运行配置及重新载入一致，弹窗关闭后主面板保存保留值', async (t) => {
  const f = await fixture(t);
  await f.action('aiopen');
  for (const key of ['aiIgnoreEduExp', 'aiRejectShortTerm', 'aiStrictFacts']) f.ai(key).checked = false;
  await f.action('aisave');
  for (const key of ['aiIgnoreEduExp', 'aiRejectShortTerm', 'aiStrictFacts']) {
    assert.equal(f.store.get(CONFIG)[key], false, key + ' persisted');
    assert.equal(f.BH.state.config[key], false, key + ' runtime');
  }
  await f.action('aiclose');
  f.input('dailyLimit').value = '125';
  await f.action('save');
  const reload = await fixture(t, { store: f.store });
  await reload.action('aiopen');
  for (const key of ['aiIgnoreEduExp', 'aiRejectShortTerm', 'aiStrictFacts']) assert.equal(reload.ai(key).checked, false, key + ' reload');
  assert.equal(reload.input('dailyLimit').value, '125');
});

test('旧配置升级启用忽略学历年限，不覆盖显式关闭值', async (t) => {
  for (const storedValue of [undefined, false, true]) {
    const config = { aiEnabled: true, aiUserPortrait: portrait };
    if (storedValue !== undefined) config.aiIgnoreEduExp = storedValue;
    const f = await fixture(t, { store: new Map([[CONFIG, config]]) });
    assert.equal(f.BH.loadConfig().aiIgnoreEduExp, storedValue !== false);
  }
});

test('学历年限忽略开启时画像也不能追加学历年限筛选，关闭后恢复画像明确条件', async (t) => {
  const f = await fixture(t, { cfg: { aiUserPortrait: portrait + '；只投硕士以下；工作经历3年' } });
  const ignored = f.BH.profileEduExpPolicy(f.BH.state.config);
  assert.equal(ignored.hasEdu, false);
  assert.equal(ignored.hasExp, false);
  const on = f.BH.buildAIPrompt(target());
  assert.ok(!on.includes('经验要求（当前岗位字段）'));
  assert.ok(!on.includes('学历要求（当前岗位字段）'));
  assert.ok(!on.includes('【画像中的学历/经验条件（唯一可用的学历与经验判断依据）】'));
  await f.BH.applyConfig({ ...f.BH.state.config, aiIgnoreEduExp: false });
  const profile = f.BH.profileEduExpPolicy(f.BH.state.config);
  assert.equal(profile.hasEdu, true);
  assert.equal(profile.hasExp, true);
  const off = f.BH.buildAIPrompt(target());
  assert.ok(off.includes('学历要求（当前岗位字段）：硕士'));
  assert.ok(off.includes('经验要求（当前岗位字段）：3-5年'));
});

test('关闭忽略开关也不能把本科应届身份或主面板阈值自动变成AI拒绝条件', async (t) => {
  const f = await fixture(t, { cfg: { aiIgnoreEduExp: false, yearsMin: 10, eduMin: 4 } });
  const profile = f.BH.profileEduExpPolicy(f.BH.state.config);
  assert.equal(profile.hasEdu, false);
  assert.equal(profile.hasExp, false);
  const result = await f.BH.runAIGate(null, target());
  assert.equal(result.action, 'accept');
});

for (const key of ['aiIgnoreEduExp', 'aiRejectShortTerm', 'aiStrictFacts']) {
  test(key + '变化使缓存立即失效，恢复设置可使用原策略结论', async (t) => {
    const f = await fixture(t);
    const job = target(key);
    f.BH.setAICache(job.jobId, { match: false, score: 20, reason: '合成缓存条目' }, job);
    const before = f.BH.aiCacheFingerprint();
    await f.BH.applyConfig({ ...f.BH.state.config, [key]: false });
    assert.notEqual(f.BH.aiCacheFingerprint(), before);
    assert.equal(f.BH.getAICache(job.jobId, job), null);
    await f.BH.applyConfig({ ...f.BH.state.config, [key]: true });
    assert.ok(f.BH.getAICache(job.jobId, job));
  });
}

for (const template of ['', '请严格按我自定义格式输出 match、score 和 reason。']) {
  test((template ? '自定义' : '默认') + '系统提示仍发送当前忽略学历年限策略和完整技术JD', async (t) => {
    const f = await fixture(t, { cfg: { aiPromptTemplate: template } });
    const result = await f.BH.aiScreen(target());
    assert.equal(result.ok, true);
    const messages = f.requests[0].body.messages;
    assert.ok(messages[1].content.includes(target().jd), 'policy must not remove technology text from the JD');
    assert.match(messages.map((m) => m.content).join('\n'), /(?:忽略|不作为判断依据).*(?:学历|工作年限)|(?:学历|工作年限).*(?:忽略|不作为判断依据)/);
    if (template) assert.ok(messages[0].content.includes(template));
  });
}

const violations = [
  { label: '学历门槛', reason: 'JD强制要求硕士及以上学历，候选人只有本科，所以不匹配', cfg: {} },
  { label: '年限门槛', reason: 'JD强制要求3年以上FOC量产经验，候选人为应届，仅有项目经历', cfg: {} },
  { label: '短期过滤关闭', reason: '该职位为短期实习，所以不匹配', cfg: { aiRejectShortTerm: false } },
  { label: '只按事实禁止推测', reason: '疑似劳务派遣，招聘流程可能不符，风险高', cfg: { aiStrictFacts: true } },
  { label: '英文加号工作年限', reason: 'Requires 3+ years of FOC production experience; candidate has only student projects', cfg: {} },
  { label: '英文未知技能不能当缺口', reason: 'Insufficient evidence of Linux skills; candidate profile does not mention Linux', cfg: {} },
  { label: '求职者未提及技能不能当缺口', reason: '求职者未提及Linux开发经验，因此不匹配', cfg: {} },
  { label: '没有验证技能不能当缺口', reason: '候选人没有验证Linux开发能力，因此不匹配', cfg: {} },
];
for (const sample of violations) {
  test(sample.label + '违规拒绝同接口纠正后采用新结论，不缓存首次错误', { timeout: 8000 }, async (t) => {
    const f = await fixture(t, { cfg: sample.cfg, gm: (o, n) => respond(o, n === 1
      ? { match: false, score: 10, reason: sample.reason }
      : { match: true, score: 85, reason: 'STM32、FreeRTOS 和 FOC 项目与核心职责相关，具体技能待面试确认' }) });
    const job = target(sample.label);
    const result = await f.BH.runAIGate(null, job);
    assert.equal(result.action, 'accept');
    assert.deepEqual(f.requests.map((r) => r.url), [PRIMARY, PRIMARY]);
    assert.equal(f.BH.getAICache(job.jobId, job).match, true);
    assert.equal(f.BH.loadStats().aiCalls, 2, 'corrective model call counts as a real attempt');
    assert.notDeepEqual(f.requests[1].body.messages, f.requests[0].body.messages, 'second call must include policy correction');
  });
}

test('同接口两次持续违反策略时不生成通过或拒绝结论，也不写缓存', async (t) => {
  const f = await fixture(t, { gm: (o) => respond(o, { match: false, score: 5, reason: '候选人本科应届，JD要求硕士及以上学历和3年经验' }) });
  const result = await f.BH.aiScreen(target());
  assert.equal(result.ok, false);
  assert.equal(result.match, undefined);
  assert.equal(result.apiUnavailable, true);
  assert.equal(result.retryDelayMs, 60000);
  assert.deepEqual(f.requests.map((r) => r.url), [PRIMARY, PRIMARY]);
  assert.equal(f.BH.getAICache(target().jobId, target()), null);
});

test('拒绝依据在reason第80字后时仍完整校验，不因显示截断绕过学历开关', async (t) => {
  const reason = '候选人的STM32与FreeRTOS项目说明已有固件基础，电机控制项目与岗位方向存在关联。'.repeat(3)
    + '但JD强制要求硕士及以上学历，候选人为本科，因此拒绝。';
  const f = await fixture(t, { gm: (o, n) => respond(o, n === 1
    ? { match: false, score: 10, reason }
    : { match: true, score: 85, reason: '已有固件与电机控制基础，忽略学历后可投' }) });
  const result = await f.BH.runAIGate(null, target());
  assert.equal(result.action, 'accept');
  assert.equal(f.requests.length, 2);
});

test('主接口持续违规时尝试备用接口并使用其有效技术结论', async (t) => {
  const f = await fixture(t, { cfg: { aiEndpoints: [{ id: 'backup', name: '合成备用', enabled: true,
    baseUrl: BACKUP, apiKey: 'synthetic-backup-key', model: 'synthetic-backup-model' }] },
    gm: (o) => respond(o, o.url === PRIMARY
      ? { match: false, score: 10, reason: '硕士及以上学历硬性要求，候选人本科不符合' }
      : { match: true, score: 80, reason: '电机控制与 MCU 固件职责相关，可尝试' }) });
  const result = await f.BH.runAIGate(null, target());
  assert.equal(result.action, 'accept');
  assert.equal(result.endpointId, 'backup');
  assert.deepEqual(f.requests.map((r) => r.url), [PRIMARY, PRIMARY, BACKUP]);
});

test('持续违反策略的闸门等待重试，可停止且不会消耗职位投递额度', async (t) => {
  const f = await fixture(t, { gm: (o) => respond(o, { match: false, reason: '缺乏3年以上工作经验，不符合JD年限要求' }) });
  const waiting = f.BH.runAIGate(null, target());
  await until(() => /一分钟后重试全部接口/.test(f.win.document.body.textContent), 'invalid conclusions must enter retry state');
  assert.equal(f.requests.length, 2);
  assert.equal(f.BH.getAICache(target().jobId, target()), null);
  assert.equal(f.BH.loadStats().sent, 0);
  f.BH.state.stopFlag = true;
  const result = await waiting;
  assert.equal(result.action, 'stop');
});

test('明确无关技术职责的有效拒绝保留，一般技术经验不被误认作工作年限', async (t) => {
  const f = await fixture(t, { gm: (o) => respond(o, { match: false, score: 5,
    reason: 'JD核心职责为金融会计核算，画像目标为嵌入式固件研发，方向明确无关' }) });
  const job = { ...target(), jd: '核心职责：金融会计核算与财务报表，须掌握会计核算技能。' };
  const result = await f.BH.runAIGate(null, job);
  assert.equal(result.action, 'reject');
  assert.equal(f.requests.length, 1);
  assert.equal(f.BH.validateAIResultPolicy({ ok: true, match: false, reason: '缺乏FOC算法技术经验，JD核心技术为FOC算法' }, target(), f.BH.state.config), '');
});

test('关闭短期过滤仍保留用户明确排除的兼职，关闭事实开关允许风控推测', async (t) => {
  const f = await fixture(t, { cfg: { aiRejectShortTerm: false, mustNot: ['兼职'] }, gm: (o) => respond(o,
    { match: false, score: 10, reason: 'JD明确写明兼职招聘，命中用户兼职排除项' }) });
  const job = { ...target(), jd: '兼职招聘：使用 STM32 开发电机控制固件。' };
  assert.equal((await f.BH.runAIGate(null, job)).action, 'reject');
  assert.equal(f.requests.length, 1);
  await f.BH.applyConfig({ ...f.BH.state.config, aiStrictFacts: false });
  assert.equal(f.BH.validateAIResultPolicy({ ok: true, match: false, reason: '招聘流程可能不符，疑似派遣风险高' },
    target(), f.BH.state.config), '');
});

test('关闭短期过滤后独立外包驻场排除仍生效，派遣字样不取消明确排除', { timeout: 8000 }, async (t) => {
  const f = await fixture(t, { cfg: { aiRejectShortTerm: false, mustNot: ['外包', '驻场'] }, gm: (o) => respond(o,
    { match: false, score: 10, reason: 'JD明确劳务派遣外包驻场岗位，命中用户外包和驻场排除项' }) });
  const job = { ...target('explicit-outsourcing'), jd: '本岗位为劳务派遣外包驻场开发，负责 STM32、FreeRTOS 固件研发。' };
  const result = await f.BH.runAIGate(null, job);
  assert.equal(result.action, 'reject');
  assert.equal(f.requests.length, 1, 'explicit independent exclusions should not be corrected away');
});

for (const sample of [
  { id: 'spi-master-slave', reason: 'JD requires independent master/slave SPI bus design; candidate explicitly states no SPI skills',
    portrait: 'I target MCU firmware development but explicitly have no SPI skills.',
    jd: 'Core duty: independently design master/slave SPI bus firmware. SPI design skills are required.' },
  { id: 'financial-risk-role', reason: 'JD core duties are financial risk analysis; candidate targets MCU firmware development',
    portrait: 'I target MCU firmware development.', jd: 'Core duties: financial risk analysis, financial accounting and risk reporting.' },
  { id: 'undergraduate-course-sales', reason: '岗位主要职责为本科课程招生销售，画像目标是MCU固件研发，方向明确无关',
    portrait: '寻找 MCU 固件研发岗位。', jd: '主要职责：本科课程招生销售，联系学员完成课程销售目标。' },
  { id: 'accounting-internship-unrelated', reason: '岗位为会计实习，核心职责财务核算，画像目标MCU固件研发，方向明确无关',
    portrait: '寻找 MCU 固件研发岗位。', jd: '会计实习，主要负责财务核算与账务凭证整理。' },
]) {
  test(sample.id + '技术或职责合法拒绝不被学位和风险词或实习身份误挡', { timeout: 8000 }, async (t) => {
    const f = await fixture(t, { cfg: { aiRejectShortTerm: false, aiUserPortrait: sample.portrait },
      gm: (o) => respond(o, { match: false, score: 10, reason: sample.reason }) });
    const job = { ...target(sample.id), title: '合成岗位', jd: sample.jd };
    const result = await f.BH.runAIGate(null, job);
    assert.equal(result.action, 'reject');
    assert.equal(f.requests.length, 1, 'legal skill or direction conflict should be consumed directly');
  });
}

test('开启短期过滤时prompt不能把普通实习或项目时长等同短期', async (t) => {
  const f = await fixture(t);
  const prompt = f.BH.buildAIPrompt({ ...target(), jd: '长期实习，6个月，按天计薪，负责 MCU 固件开发。' });
  assert.ok(!prompt.includes('只有明确写了「短期」「实习」「项目制」「兼职」「劳务派遣」才算'));
  assert.match(prompt, /短期实习/);
});

test('开启短期过滤时模型忽略明确短期岗位也会纠正，普通长期实习可通过', async (t) => {
  const f = await fixture(t, { gm: (o, n) => respond(o, n === 2
    ? { match: false, score: 10, reason: '标题明确短期实习，命中不投短期岗位设置' }
    : { match: true, score: 85, reason: 'STM32 和 FreeRTOS 技术方向相关' }) });
  const short = { ...target('clear-short-internship'), title: '短期实习：嵌入式固件开发',
    jd: '本岗位为短期实习。使用 STM32 和 FreeRTOS 完成电机控制开发。' };
  assert.equal((await f.BH.runAIGate(null, short)).action, 'reject');
  assert.equal(f.requests.length, 2);
  const long = { ...target('normal-long-internship'), title: '嵌入式软件开发实习生',
    jd: '长期实习，6个月，按天计薪。负责 MCU 和 FreeRTOS 电机控制固件开发。' };
  assert.equal((await f.BH.runAIGate(null, long)).action, 'accept');
  assert.equal(f.requests.length, 3, 'normal internships must not trigger a correction or rejection');
});

test('全职兼职均可岗位在短期过滤开启时保留全职匹配机会', { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const job = { ...target('fulltime-parttime-options'), title: '嵌入式研发工程师（全职/兼职均可）',
    jd: '本岗位支持全职或兼职，均可申请。全职方向负责 STM32 和 FreeRTOS 电机控制固件研发。' };
  const result = await f.BH.runAIGate(null, job);
  assert.equal(result.action, 'accept');
  assert.equal(f.requests.length, 1, 'optional part-time branch must not exclude a related full-time opening');
});

test('短期过滤开启也纠正模型把普通实习错误当短期的拒绝', { timeout: 8000 }, async (t) => {
  const f = await fixture(t, { gm: (o, n) => respond(o, n === 1
    ? { match: false, score: 10, reason: '岗位是普通实习，按不投短期岗位设置拒绝' }
    : { match: true, score: 85, reason: '普通实习与电机固件项目基础相关，可以尝试' }) });
  const job = { ...target('normal-internship-wrong-rejection'), title: '嵌入式软件开发实习生',
    jd: '长期实习，6个月，按天计薪。负责 MCU 和 FreeRTOS 电机控制固件开发。' };
  const result = await f.BH.runAIGate(null, job);
  assert.equal(result.action, 'accept');
  assert.equal(f.requests.length, 2);
});

test('纠正请求等待中切换学历年限策略使旧响应作废，不写入新策略缓存', async (t) => {
  let pending;
  const f = await fixture(t, { gm: (o, n) => n === 1
    ? respond(o, { match: false, reason: '硕士学历要求不符合' }) : (pending = o) });
  const run = f.BH.aiScreen(target());
  await until(() => !!pending, 'corrective call must be dispatched');
  await f.BH.applyConfig({ ...f.BH.state.config, aiIgnoreEduExp: false });
  respond(pending, { match: true, reason: '技术职责相关' });
  const result = await run;
  assert.equal(result.ok, false);
  assert.equal(result.policyChanged, true);
  assert.equal(f.BH.getAICache(target().jobId, target()), null);
});
