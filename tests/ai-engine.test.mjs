/**
 * BOSS 海投助手 1.0.24 —— AI 模块自动化测试
 * 用 jsdom 加载真实脚本，桩掉 GM_* API 与网络层，验证第七节测试用例中与逻辑相关的部分。
 * 运行： node --experimental-vm-modules 本文件   （需 jsdom）
 */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const code = fs.readFileSync(SCRIPT, 'utf8');

// ---------- 环境搭建 ----------
const store = new Map();
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://www.zhipin.com/web/geek/job?query=嵌入式&city=101280600',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const win = dom.window;

win.GM_getValue = (k, d) => structuredClone(store.has(k) ? store.get(k) : d);
win.GM_setValue = (k, v) => store.set(k, structuredClone(v));
win.GM_addStyle = (css) => {
  const s = win.document.createElement('style');
  s.textContent = css;
  win.document.head.appendChild(s);
};
win.unsafeWindow = win;

// 网络桩：由测试逐条注入行为
let netHandler = null;
let netCalls = 0;
win.GM_xmlhttpRequest = function (opts) {
  netCalls++;
  setTimeout(() => {
    try {
      netHandler && netHandler(opts);
    } catch (e) {
      opts.onerror && opts.onerror(e);
    }
  }, 0);
};
const reply = (opts, obj, status = 200) =>
  opts.onload({ status, responseText: typeof obj === 'string' ? obj : JSON.stringify(obj) });
const chatReply = (content) => reply({}, { choices: [{ message: { content } }] });

win.eval(code);
const BH = win.BH;
await new Promise((r) => setTimeout(r, 50));

// ---------- 断言框架 ----------
let pass = 0, fail = 0, skipped = 0;
const results = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
}
// 依赖外部环境（外网 / 平台特性）的断言走这里 —— 不可用时跳过，不计失败。
// 否则一换网络环境就报"N 条失败"，把真正的问题淹掉。
function skip(name, why = '') {
  skipped++;
  results.push(`  ⏭️ ${name}${why ? '（跳过：' + why + '）' : ''}`);
}
function section(t) { results.push(''); results.push('### ' + t); }

async function waitForUI(condition, description, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('UI 操作未完成：' + description);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Advance the window clock only in retry tests; the production wait remains one minute.
async function withAIClock(run) {
  const NativeDate = win.Date;
  const clock = { now: NativeDate.now() };
  win.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  };
  try { return await run(clock); } finally { win.Date = NativeDate; }
}

const CFG = (over = {}) => ({
  ...BH.loadConfig(),
  aiEnabled: true,
  aiApiKey: 'sk-testkey-1234567890',
  aiBaseUrl: 'https://api.example.com/v1/chat/completions',
  aiModel: 'gpt-4o-mini',
  aiMaxRetries: 1,
  aiTimeoutMs: 20000,
  aiDailyLimit: 100,
  aiMaxJDChars: 2500,
  aiFallback: 'local',
  aiCacheEnabled: true,
  aiCacheDays: 7,
  aiUserPortrait: '5年嵌入式软件工程师，精通 STM32/FreeRTOS，深圳 16K 以上，不做外包',
  ...over,
});
const setCfg = (c) => { BH.state.config = c; };
const resetAll = () => {
  store.clear();
  win.localStorage.clear();
  BH.resetStats();
  BH.clearAICache();
  netCalls = 0;
  netHandler = null;
  // 主循环 start() 会重置这些运行时状态，测试里手动对齐
  BH.state._aiFailStreak = 0;
  BH.state._aiWarned = false;
  BH.state._aiHits = 0;
  BH.state.paused = false;
  BH.state.stopFlag = false;
  BH.state.skipKeywordCheck = false;
  BH.state.config = null; // 回到"未启动"的空闲态
  // v1.0.8：清完 store 后立刻按"空配置"刷一次主面板 AI 按钮，
  // 否则上一个测试用例改过的 dataset.on / 内联 style 会残留在按钮上，
  // 让"测试默认值"的断言失败。
  BH.syncAISettingsButton?.(BH.loadConfig());
};

// ============================================================
section('1. 脚本加载与向后兼容');
ok('脚本能在 DOM 环境成功初始化', !!BH && typeof BH.aiScreen === 'function');
ok('默认 aiEnabled=false（0.9.2 老用户无感）', BH.loadConfig().aiEnabled === false);
ok('默认配置含全部 AI 字段', ['aiEnabled','aiBaseUrl','aiApiKey','aiModel','aiTemperature','aiTimeoutMs',
   'aiMaxRetries','aiFallback','aiDailyLimit','aiMaxJDChars','aiUserPortrait','aiPromptTemplate',
   'aiCacheEnabled','aiCacheDays'].every((k) => k in BH.loadConfig()));
ok('maskKey 脱敏（不泄露完整 Key）', BH.maskKey('sk-testkey-1234567890') === 'sk-***7890',
   BH.maskKey('sk-testkey-1234567890'));
ok('API Key 不出现在 prompt 里', (() => {
  setCfg(CFG());
  const p = BH.buildAIPrompt({ title: 't', company: 'c', salary: 's', jd: 'x', jobId: 'j' });
  return !p.includes('sk-testkey');
})());

// ============================================================
section('2. parseAIResult 解析容错（4.5）');
{
  const P = BH.parseAIResult;
  ok('标准 JSON', P('{"match":true,"score":88,"reason":"方向匹配"}').match === true);
  ok('```json 包裹能剥离', P('```json\n{"match":false,"score":10,"reason":"方向不符"}\n```').match === false);
  ok('前后多余文字能截取', P('好的，结果如下：{"match":true,"score":70,"reason":"ok"} 以上').match === true);
  ok('score 缺失时返回 null', P('{"match":true,"reason":"x"}').score === null);
  ok('reason 截断到 80 字符', P('{"match":true,"reason":"' + '长'.repeat(200) + '"}').reason.length === 80);
  ok('match 为字符串 "true" 可识别', P('{"match":"true","score":1}').match === true);
  ok('match 非法时返回明确错误', P('{"match":"maybe"}').ok === false && /match 字段非法/.test(P('{"match":"maybe"}').err));
  ok('无 JSON 时返回明确错误（不静默吞掉）', P('我无法判断').ok === false && /AI 输出无 JSON/.test(P('我无法判断').err));
  ok('坏 JSON 返回解析错误', P('{"match":true,}').ok === false && /JSON 解析失败/.test(P('{"match":true,}').err));
  ok('空输入返回错误', P('').ok === false);
}

// ============================================================
section('3. buildAIPrompt 组装（4.2）');
{
  resetAll(); setCfg(CFG({ aiMaxJDChars: 100 }));
  const long = '岗位职责：' + '串口通信与驱动开发 '.repeat(200);
  const p = BH.buildAIPrompt({ title: '嵌入式工程师', company: 'A公司', salary: '20-30K', jd: long, jobId: 'j1' });
  ok('JD 超过 aiMaxJDChars 会被截断', p.includes('已截断') && p.length < long.length + 800, 'prompt长度=' + p.length);
  ok('包含求职者画像', p.includes('5年嵌入式软件工程师'));
  ok('包含职位标题/公司/薪资', p.includes('嵌入式工程师') && p.includes('A公司') && p.includes('20-30K'));

  setCfg(CFG({ aiUserPortrait: '', mustHave: ['stm32', 'freertos'], mustNot: ['外包', '驻场'] }));
  const p2 = BH.buildAIPrompt({ title: 't', company: 'c', salary: 's', jd: 'x', jobId: 'j' });
  ok('画像为空时给出兜底提示', p2.includes('未填写画像'));
  ok('必含词作为软提示进 prompt', p2.includes('stm32') && p2.includes('期望关键词'));
  ok('排除词进 prompt', p2.includes('外包'));
}

// ============================================================
section('4. matchJob 与本地规则的协调（4.3）');
{
  resetAll();
  const jd = '岗位职责：React 前端开发，3年经验，本科。';
  const cfgOff = CFG({ aiEnabled: false, mustHave: ['stm32'], mustNot: ['外包'] });
  setCfg(cfgOff);
  const rOff = BH.matchJob(jd, '', '20-30K', cfgOff, {});
  ok('AI 关闭时必含词硬卡（命中 0/1 → 不匹配）', rOff.matched === false && /必含词/.test(rOff.reason), rOff.reason);
  ok('AI 关闭时 details 无 mustHaveDeferredToAI', !rOff.details.mustHaveDeferredToAI);

  const cfgOn = CFG({ aiEnabled: true, mustHave: ['stm32'], mustNot: ['外包'] });
  setCfg(cfgOn);
  const rOn = BH.matchJob(jd, '', '20-30K', cfgOn, {});
  ok('AI 开启时必含词不硬卡（让位给 AI）', rOn.matched === true, rOn.reason);
  ok('AI 开启时 details.mustHaveDeferredToAI=true', rOn.details.mustHaveDeferredToAI === true);

  const rNot = BH.matchJob('外包驻场开发，3年', '', '20-30K', cfgOn, {});
  ok('AI 开启时排除词交给 AI 结合上下文判断', rNot.matched === true, rNot.reason);
  ok('AI 开启时保留排除词待判标记', rNot.details.mustNotDeferredToAI === true);
  ok('AI 开启时保留字面命中的诊断依据',
     rNot.details.mustNotHit?.hitWord === '外包' && rNot.details.mustNotHit?.hitContext.includes('外包驻场'),
     JSON.stringify(rNot.details));
  const rNotOff = BH.matchJob('stm32 外包驻场开发，3年', '', '20-30K', cfgOff, {});
  ok('AI 关闭时排除词仍按字面拦截',
     rNotOff.matched === false && rNotOff.details.stage === 'mustNot' && /外包/.test(rNotOff.reason), rNotOff.reason);

  // ===== v1.0.9：AI 开启后「年限 / 学历 / 薪资 / 活跃度」不再本地硬卡，交给 AI 判断 =====
  const soft = CFG({ aiEnabled: true });
  ok('AI 开启时 details.aiSoftCriteria=true',
     BH.matchJob('5年，stm32', '今日活跃', '20-30K', soft, {}).details.aiSoftCriteria === true);
  const rYearAi = BH.matchJob('1年经验，本科，stm32', '', '20-30K', { ...soft, yearsMin: 3 }, {});
  ok('AI 开启时年限不再硬卡（1年 < 要求3年 仍放行交给 AI）', rYearAi.matched === true, rYearAi.reason);
  const rEduAi = BH.matchJob('大专学历，5年，stm32', '', '20-30K', { ...soft, eduMin: 2 }, {});
  ok('AI 开启时学历不再硬卡（学历不是硬性门槛）', rEduAi.matched === true, rEduAi.reason);
  const rSalAi = BH.matchJob('5年，stm32', '', '8-12K', { ...soft, salaryMin: 16 }, {});
  ok('AI 开启时薪资不再硬卡', rSalAi.matched === true, rSalAi.reason);
  // v1.0.13：活跃度例外——可确定性解析，交回本地硬卡（用户实测 AI 会漏投 2 个月未活跃的岗位）
  const rActAi = BH.matchJob('5年，stm32', '30天前活跃', '20-30K', { ...soft, activeDays: 7 }, {});
  ok('AI 开启时活跃度仍本地硬卡（不交给 AI）', rActAi.matched === false && /活跃/.test(rActAi.reason), rActAi.reason);
  const rActAiOk = BH.matchJob('5年，stm32', '今日活跃', '20-30K', { ...soft, activeDays: 7 }, {});
  ok('活跃度达标时正常放行', rActAiOk.matched === true, rActAiOk.reason);

  // 零回归：AI 关闭时这四项必须仍然硬卡（= 0.9.2 行为，一个字没变）
  const hard = (over) => CFG({ aiEnabled: false, mustHave: [], ...over });
  const rY2 = BH.matchJob('1年经验，本科，stm32', '', '20-30K', hard({ yearsMin: 3 }), {});
  ok('AI 关闭时年限仍硬卡', rY2.matched === false && /年限不足/.test(rY2.reason), rY2.reason);
  const rE2 = BH.matchJob('大专学历，5年，stm32', '', '20-30K', hard({ eduMin: 2 }), {});
  ok('AI 关闭时学历仍硬卡', rE2.matched === false && /学历/.test(rE2.reason), rE2.reason);
  const rS2 = BH.matchJob('5年，stm32', '', '8-12K', hard({ salaryMin: 16 }), {});
  ok('AI 关闭时薪资仍硬卡', rS2.matched === false && /薪资/.test(rS2.reason), rS2.reason);
  const rA2 = BH.matchJob('5年，stm32', '30天前活跃', '20-30K', hard({ activeDays: 7 }), {});
  ok('AI 关闭时活跃度仍硬卡', rA2.matched === false && /活跃/.test(rA2.reason), rA2.reason);
}

// ============================================================
section('5. aiScreen 正常调用 / 缓存 / 计数（4.6、4.7）');
{
  resetAll(); setCfg(CFG());
  netHandler = (o) => reply(o, { choices: [{ message: { content: '{"match":true,"score":90,"reason":"嵌入式方向高度匹配"}' } }] });

  const r1 = await BH.aiScreen({ title: '嵌入式工程师', company: 'A', salary: '20-30K', jd: 'STM32 FreeRTOS', jobId: 'JOB001' });
  ok('首次调用返回 ok 且 match=true', r1.ok === true && r1.match === true && r1.score === 90, JSON.stringify(r1));
  ok('首次调用消耗 1 次 AI 次数', BH.loadStats().aiCalls === 1, 'aiCalls=' + BH.loadStats().aiCalls);
  ok('结论已写入缓存', !!BH.getAICache('JOB001'));

  const r2 = await BH.aiScreen({ title: '嵌入式工程师', company: 'A', salary: '20-30K', jd: 'STM32 FreeRTOS', jobId: 'JOB001' });
  ok('第二次命中缓存（cached=true）', r2.ok === true && r2.cached === true, JSON.stringify(r2));
  ok('缓存命中不消耗 AI 次数（仍为 1）', BH.loadStats().aiCalls === 1, 'aiCalls=' + BH.loadStats().aiCalls);
  ok('缓存命中计数 +1', BH.loadStats().aiHits === 1);
  ok('缓存命中时网络调用未增加', netCalls === 1, 'netCalls=' + netCalls);

  netHandler = (o) => reply(o, { choices: [{ message: { content: '{"match":false,"score":12,"reason":"岗位方向是前端，与画像不符"}' } }] });
  const r3 = await BH.aiScreen({ title: '前端开发', company: 'B', salary: '20-30K', jd: 'React Vue', jobId: 'JOB002' });
  ok('不匹配场景返回 match=false + 理由', r3.ok && r3.match === false && /前端/.test(r3.reason), JSON.stringify(r3));
}

// ============================================================
section('6. 失败与重试（4.4）');
{
  resetAll(); setCfg(CFG({ aiMaxRetries: 0 }));
  netHandler = (o) => o.ontimeout();
  const r = await BH.aiScreen({ title: 't', jd: 'x', jobId: 'T1' });
  ok('超时返回 ok:false 而不抛异常', r.ok === false && /超时/.test(r.err), JSON.stringify(r));

  resetAll(); setCfg(CFG({ aiMaxRetries: 1 }));
  netHandler = (o) => reply(o, { error: { message: 'Incorrect API key provided' } }, 401);
  let n = 0; netCalls = 0;
  netHandler = (o) => { n++; reply(o, { error: { message: 'Incorrect API key provided' } }, 401); };
  const r401 = await BH.aiScreen({ title: 't', jd: 'x', jobId: 'T2' });
  ok('401 业务错误不重试（只打 1 次）', r401.ok === false && n === 1, 'n=' + n);
  ok('401 错误信息透传到 err', /401|Incorrect/.test(r401.err), r401.err);

  resetAll(); setCfg(CFG({ aiMaxRetries: 1 }));
  n = 0;
  netHandler = (o) => { n++; reply(o, { error: { message: 'server error' } }, 500); };
  const r500 = await BH.aiScreen({ title: 't', jd: 'x', jobId: 'T3' });
  ok('5xx 单轮只请求一次，交给闸门一分钟后完整重试', r500.apiUnavailable === true && n === 1 && r500.retryDelayMs === 60000, 'n=' + n);

  resetAll(); setCfg(CFG());
  netHandler = (o) => reply(o, '这不是 JSON');
  const rBad = await BH.aiScreen({ title: 't', jd: 'x', jobId: 'T4' });
  ok('响应非法时返回 ok:false', rBad.ok === false, JSON.stringify(rBad));

  resetAll(); setCfg(CFG({ aiApiKey: '' }));
  const rNoKey = await BH.aiScreen({ title: 't', jd: 'x', jobId: 'T5' });
  ok('未填 Key 返回明确错误（不发起请求）', rNoKey.ok === false && /API Key/.test(rNoKey.err), rNoKey.err);
}

// ============================================================
section('7. 每日上限与缓存维护（4.6、4.7）');
{
  resetAll(); setCfg(CFG({ aiDailyLimit: 2 }));
  netHandler = (o) => reply(o, { choices: [{ message: { content: '{"match":true,"score":60,"reason":"ok"}' } }] });
  await BH.aiScreen({ title: 'a', jd: 'x', jobId: 'D1' });
  await BH.aiScreen({ title: 'b', jd: 'x', jobId: 'D2' });
  const r3 = await BH.aiScreen({ title: 'c', jd: 'x', jobId: 'D3' });
  ok('超过 aiDailyLimit 后返回 AI次数超限', r3.ok === false && /AI次数超限/.test(r3.err), r3.err);
  ok('超限后 AI 次数停在 2', BH.loadStats().aiCalls === 2);

  // 过期缓存
  resetAll(); setCfg(CFG({ aiCacheDays: 7 }));
  BH.setAICache('OLD1', { match: true, reason: 'x' });
  const all = JSON.parse(JSON.stringify(store.get('boss_helper_ai_cache_v1') || '{}'));
  all.OLD1.ts = Date.now() - 8 * 86400000;
  store.set('boss_helper_ai_cache_v1', all);
  ok('超过 aiCacheDays 的缓存视为未命中', BH.getAICache('OLD1') === null);

  // LRU 上限
  resetAll(); setCfg(CFG());
  for (let i = 0; i < 520; i++) BH.setAICache('K' + i, { match: true, reason: 'r' });
  ok('缓存总量上限 500（LRU 淘汰）', BH.aiCacheSize() === 500, 'size=' + BH.aiCacheSize());

  // 重置计数不清缓存
  resetAll(); setCfg(CFG());
  BH.setAICache('KEEP1', { match: false, reason: 'keep' });
  BH.state.config = CFG();
  BH.loadStats();
  store.set('boss_helper_stats_v1', { date: BH.todayKey(), sent: 5, processed: 5, skipped: 5, aiCalls: 7, aiHits: 2 });
  BH.resetStats();
  ok('重置诊断后投递/AI 请求额度保留，不能绕过每日限额', BH.loadStats().aiCalls === 7 && BH.loadStats().sent === 5);
  ok('重置计数后 AI 缓存保留', !!BH.getAICache('KEEP1'));
  BH.clearAICache();
  ok('清 AI 缓存按钮生效', BH.aiCacheSize() === 0);
}

// ============================================================
section('8. 与现有统计/配置字段的兼容');
{
  resetAll(); setCfg(CFG());
  const cfgKeys = Object.keys(BH.loadConfig());
  ok('本地规则与执行配置字段保持兼容', ['mustHave','mustNot','mustHaveMin','yearsMin','eduMin','salaryMin',
    'activeDays','minDelay','maxDelay','pageDelayMin','pageDelayMax','batchSize','batchPauseSec',
    'dailyLimit','maxRounds','autoSend','autoScroll'].every((k) => cfgKeys.includes(k)));
  ok('旧统计字段保留（sent/processed/skipped）', ['sent','processed','skipped'].every((k) => k in BH.loadStats()));
}

// ============================================================
section('9. 面板 UI 与配置读写（3.2）');
{
  const doc = win.document;
  const panel = doc.getElementById('boss-helper-panel');
  ok('面板已渲染', !!panel);

  // v1.0.1：AI 设置从「规则设置」里拆出来，成为主面板独立按钮 + 弹窗
  ok('主面板有「AI 设置」入口按钮（data-act=aiopen）', !!panel.querySelector('[data-act="aiopen"]'));
  ok('「规则设置」summary 已不再包含 AI section',
     !panel.querySelector('.bh-settings .bh-section h3[data-t="ai"]'));

  // 点开 AI 弹窗，让所有 AI 输入框进入 DOM
  panel.querySelector('[data-act="aiopen"]').click();
  const aiModal = doc.getElementById('bh-ai-modal');
  ok('点击后弹出 AI 设置弹窗（#bh-ai-modal）', !!aiModal);

  // v1.0.1：AI 字段已不在主 panel，弹窗打开后用 document.querySelector 才能读到
  const q = (k) => doc.querySelector('[data-cfg="' + k + '"]');
  for (const k of ['aiEnabled','aiBaseUrl','aiModel','aiApiKey','aiUserPortrait','aiDailyLimit',
                   'aiFallback','aiTimeoutMs','aiMaxJDChars','aiCacheEnabled','aiPromptTemplate']) {
    ok(`AI 输入框存在：${k}`, !!q(k));
  }
  ok('API Key 输入框是 password 类型', q('aiApiKey') && q('aiApiKey').type === 'password');
  ok('统计区存在「AI 已调用」数字位', !!panel.querySelector('[data-stat="aiCalls"]'));
  ok('弹窗内有「清 AI 缓存」按钮', !!aiModal.querySelector('[data-act="clearaicache"]'));
  ok('弹窗内有「测试 AI 连接」按钮', !!aiModal.querySelector('[data-act="aitest"]'));

  // 填值 → 保存 → 读回（点击弹窗里的「保存」，会触发读 config + 写 store）
  resetAll();
  q('aiEnabled').checked = true;
  q('aiBaseUrl').value = 'https://api.mygateway.com/v1/chat/completions';
  q('aiModel').value = 'qwen-plus';
  q('aiApiKey').value = 'sk-mykey-abcdef123456';
  q('aiUserPortrait').value = '3年后端 Go，想找杭州 25K 以上';
  q('aiDailyLimit').value = '42';
  q('aiFallback').value = 'skip';
  q('aiTimeoutMs').value = '15000';
  q('aiMaxJDChars').value = '1800';
  q('aiCacheEnabled').checked = false;
  aiModal.querySelector('[data-act="aisave"]').click();

  const saved = store.get('boss_helper_config_v1');
  ok('保存后 aiEnabled=true', saved.aiEnabled === true);
  ok('保存后接口地址正确', saved.aiBaseUrl === 'https://api.mygateway.com/v1/chat/completions');
  ok('保存后模型正确', saved.aiModel === 'qwen-plus');
  ok('保存后 Key 正确', saved.aiApiKey === 'sk-mykey-abcdef123456');
  ok('保存后画像正确', saved.aiUserPortrait === '3年后端 Go，想找杭州 25K 以上');
  ok('保存后每日上限=42', saved.aiDailyLimit === 42);
  ok('保存后降级策略=skip', saved.aiFallback === 'skip');
  ok('保存后超时=15000', saved.aiTimeoutMs === 15000);
  ok('保存后 JD 截断=1800', saved.aiMaxJDChars === 1800);
  ok('保存后缓存开关=false', saved.aiCacheEnabled === false);
  ok('无 UI 的字段未被保存抹掉（aiTemperature/aiMaxRetries/aiCacheDays）',
     saved.aiTemperature === 0.2 && saved.aiMaxRetries === 1 && saved.aiCacheDays === 7,
     JSON.stringify({ t: saved.aiTemperature, r: saved.aiMaxRetries, d: saved.aiCacheDays }));

  // 恢复默认
  panel.querySelector('[data-act="reload"]').click();
  const def = store.get('boss_helper_config_v1');
  ok('「恢复默认」把 aiEnabled 置回 false', def.aiEnabled === false);
  ok('「恢复默认」恢复默认模型', def.aiModel === 'gpt-4o-mini');
  ok('重新开弹窗后，UI 输入框同步回默认值', (() => {
    panel.querySelector('[data-act="aiopen"]').click();
    return doc.querySelector('[data-cfg="aiModel"]').value === 'gpt-4o-mini';
  })());
}

// ============================================================
section('10. 降级策略 runAIGate 行为（第五节）');
{
  // 通过 aiScreen 的降级语义间接验证：三档策略由 aiFallback 决定
  resetAll(); setCfg(CFG({ aiFallback: 'local', aiApiKey: '' }));
  const r = await BH.aiScreen({ title: 'x', jd: 'y', jobId: 'F1' });
  ok('local 策略：aiScreen 仅返回失败，由上层复核本地排除词', r.ok === false);

  resetAll(); setCfg(CFG({ aiFallback: 'skip' }));
  netHandler = (o) => o.ontimeout();
  const r2 = await BH.aiScreen({ title: 'x', jd: 'y', jobId: 'F2' });
  ok('skip 策略：aiScreen 返回 ok:false，交由上层标记跳过', r2.ok === false && /超时/.test(r2.err));

  resetAll(); setCfg(CFG({ aiDailyLimit: 0 }));
  const r3 = await BH.aiScreen({ title: 'x', jd: 'y', jobId: 'F3' });
  ok('aiDailyLimit=0 时直接超限（不发起请求）', r3.ok === false && /AI次数超限/.test(r3.err));

  resetAll(); setCfg(CFG({ aiCacheEnabled: false }));
  netHandler = (o) => reply(o, { choices: [{ message: { content: '{"match":true,"score":50,"reason":"ok"}' } }] });
  await BH.aiScreen({ title: 'x', jd: 'y', jobId: 'F4' });
  ok('关闭缓存时不写缓存', BH.aiCacheSize() === 0);
}

// ============================================================
section('11. 配置持久化回归（AI 开关必须能留住）');
{
  const doc2 = win.document;
  const p2 = doc2.getElementById('boss-helper-panel');

  // 11a. 用户开启 AI 并保存 → 重新载入后必须还是 true
  resetAll();
  // v1.0.1：必须先点开 AI 弹窗才能读到/写入 AI 输入框
  p2.querySelector('[data-act="aiopen"]').click();
  const aiModal2 = doc2.getElementById('bh-ai-modal');
  const q2 = (k) => doc2.querySelector('[data-cfg="' + k + '"]');
  q2('aiEnabled').checked = true;
  q2('aiApiKey').value = 'sk-realkey-9999';
  q2('aiModel').value = 'qwen-plus';
  q2('aiFallback').value = 'pause';
  aiModal2.querySelector('[data-act="aisave"]').click();

  const reloaded = BH.loadConfig();
  ok('保存后重新载入，aiEnabled 仍为 true（不被迁移逻辑重置）', reloaded.aiEnabled === true);
  ok('保存后重新载入，自定义模型保留', reloaded.aiModel === 'qwen-plus');
  ok('保存后重新载入，降级策略保留', reloaded.aiFallback === 'pause');
  ok('保存后重新载入，Key 保留', reloaded.aiApiKey === 'sk-realkey-9999');

  // 11b. 老 0.9.2 配置（无任何 ai* 字段）迁移后 aiEnabled 必须是 false
  store.clear();
  store.set('boss_helper_config_v1', {
    mustHave: ['stm32'], mustNot: ['外包'], mustHaveMin: 0,
    yearsMin: 3, eduMin: 2, salaryMin: 0, activeDays: 7,
    minDelay: 3, maxDelay: 6, pageDelayMin: 4, pageDelayMax: 8,
    batchSize: 20, batchPauseSec: 60, dailyLimit: 50, maxRounds: 0,
    autoSend: true, autoScroll: true, greetings: ['你好'], greetingMode: 'fixed',
  });
  const oldCfg = BH.loadConfig();
  ok('0.9.2 老配置迁移后 aiEnabled=false（升级无感）', oldCfg.aiEnabled === false);
  ok('0.9.2 老配置迁移后 AI 字段补齐', oldCfg.aiModel === 'gpt-4o-mini' && oldCfg.aiDailyLimit === 100);
  ok('0.9.2 老配置的原有字段未被破坏', oldCfg.mustHave[0] === 'stm32' && oldCfg.yearsMin === 3 && oldCfg.dailyLimit === 50);

  // 11c. 老配置升级后，用户手动开启仍能留住
  store.set('boss_helper_config_v1', { ...oldCfg, aiEnabled: true, aiApiKey: 'sk-x' });
  ok('老配置升级后手动开启 AI 也能留住', BH.loadConfig().aiEnabled === true);
}

// ============================================================
section('12. runAIGate AI 优先、无配置离线与连续失败重试');
{
  const job = { title: '测试职位', company: 'C', salary: '20-30K', jd: 'x', jobId: 'G1' };

  // accept（正常通过）
  resetAll(); setCfg(CFG());
  netHandler = (o) => reply(o, { choices: [{ message: { content: '{"match":true,"score":80,"reason":"匹配"}' } }] });
  let g = await BH.runAIGate(null, job);
  ok('AI 通过 → action=accept', g.action === 'accept' && g.score === 80);

  // reject
  resetAll(); setCfg(CFG());
  netHandler = (o) => reply(o, { choices: [{ message: { content: '{"match":false,"score":8,"reason":"方向不符"}' } }] });
  g = await BH.runAIGate(null, job);
  ok('AI 拒绝 → action=reject 且带理由', g.action === 'reject' && g.reason === '方向不符');

  for (const fallback of ['local', 'skip', 'pause']) {
    resetAll(); setCfg(CFG({ aiFallback: fallback, aiApiKey: '', yearsMin: 0, eduMin: 0 }));
    g = await BH.runAIGate(null, job);
    ok('无配置 + ' + fallback + ' 旧策略：完整本地规则通过即放行',
       g.action === 'accept' && g.local === true && !g.degraded && netCalls === 0 && !BH.state.paused, JSON.stringify(g));
  }

  resetAll(); setCfg(CFG({ aiFallback: 'skip', aiCacheEnabled: false }));
  await withAIClock(async (clock) => {
    netHandler = (o) => reply(o, { error: { message: 'server offline' } }, 503);
    let settled = false;
    const pending = BH.runAIGate(null, job).then((result) => { settled = true; return result; });
    for (let round = 1; round <= 3; round++) {
      await waitForUI(() => BH.state._aiFailStreak >= round, '第 ' + round + ' 轮失败');
      ok('第 ' + round + ' 轮失败保留当前岗位，不静默跳过', !settled && !BH.state.paused);
      if (round < 3) clock.now += 60001;
    }
    ok('连续失败计数达到 3', BH.state._aiFailStreak === 3);
    netHandler = (o) => reply(o, { choices: [{ message: { content: '{"match":true,"score":66,"reason":"恢复后通过"}' } }] });
    clock.now += 60001;
    g = await pending;
    ok('一分钟重试后服务恢复，使用真实 AI 结论通过', g.action === 'accept' && g.reason === '恢复后通过' && netCalls === 4, JSON.stringify(g));
    ok('AI 成功一次后连续失败计数归零', BH.state._aiFailStreak === 0);
  });
}

// ============================================================
section('13. 缓存旁路（测试连接不污染缓存）');
{
  resetAll(); setCfg(CFG());
  netHandler = (o) => reply(o, { choices: [{ message: { content: '{"match":true,"score":55,"reason":"ok"}' } }] });
  await BH.aiScreen({ title: 't', jd: 'x', jobId: 'BC1' }, { bypassCache: true });
  ok('bypassCache 时不写缓存', BH.aiCacheSize() === 0);
  ok('bypassCache 时仍计入 AI 次数', BH.loadStats().aiCalls === 1);

  resetAll(); setCfg(CFG());
  BH.setAICache('BC2', { match: true, reason: 'cached' });
  netHandler = (o) => reply(o, { choices: [{ message: { content: '{"match":false,"score":1,"reason":"fresh"}' } }] });
  const r = await BH.aiScreen({ title: 't', jd: 'x', jobId: 'BC2' }, { bypassCache: true });
  ok('bypassCache 时不读缓存（拿到新结论）', r.match === false && r.reason === 'fresh', JSON.stringify(r));
}

// ============================================================
section('14. 面板实时值读取 + 获取模型列表');
{
  const doc3 = win.document;
  const p3 = doc3.getElementById('boss-helper-panel');

  // v1.0.1：AI 输入框不再在主面板里，需先打开 AI 弹窗（document 范围查找）
  p3.querySelector('[data-act="aiopen"]').click();
  const aiModal3 = doc3.getElementById('bh-ai-modal');
  const q3 = (k) => doc3.querySelector('[data-cfg="' + k + '"]');

  // 14a. 未点保存也能读到输入框里的 Key（用户实际遇到的坑）
  resetAll();
  q3('aiApiKey').value = 'sk-typed-not-saved-7777';
  ok('落盘配置里 Key 仍为空（确实没保存）', BH.loadConfig().aiApiKey === '');
  ok('getAIConfig 读到的是输入框当前值', BH.getAIConfig().aiApiKey === 'sk-typed-not-saved-7777',
     BH.getAIConfig().aiApiKey);

  // 14b. 运行中优先用 state.config
  resetAll(); setCfg(CFG({ aiApiKey: 'sk-running-state' }));
  q3('aiApiKey').value = 'sk-panel-value';
  ok('运行中（state.config 存在）优先用 state.config', BH.getAIConfig().aiApiKey === 'sk-running-state');
  BH.state.config = null;
  ok('空闲时回退到面板值', BH.getAIConfig().aiApiKey === 'sk-panel-value');

  // 14c. /models 地址推导
  const D = BH.deriveModelsUrl;
  ok('OpenAI 官方地址推导正确',
     D('https://api.openai.com/v1/chat/completions') === 'https://api.openai.com/v1/models');
  ok('只填 /v1 的网关推导正确', D('https://oneapi.com/v1') === 'https://oneapi.com/v1/models');
  ok('Gemini OpenAI 兼容网关推导正确',
     D('https://x.com/v1beta/openai/chat/completions') === 'https://x.com/v1beta/openai/models');
  ok('带路径前缀的网关推导正确', D('https://x.com/api/v1') === 'https://x.com/api/v1/models');
  ok('末尾斜杠不影响推导', D('https://x.com/v1/') === 'https://x.com/v1/models');

  // 14d. 拉取模型列表（成功）
  resetAll();
  BH.state.config = null;
  q3('aiApiKey').value = 'sk-list-ok';
  q3('aiModel').value = '';
  // v1.0.1：通过弹窗内的「保存」触发落盘
  aiModal3.querySelector('[data-act="aisave"]').click();
  BH.state.config = null;
  netHandler = (o) => {
    if (o.method === 'GET') reply(o, { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }, { id: 'deepseek-chat' }, { id: 'qwen-plus' }] });
    else reply(o, { choices: [{ message: { content: '{"match":true,"score":1,"reason":"x"}' } }] });
  };
  await BH.fetchAIModelList();
  const dl = doc3.getElementById('bh-ai-model-list');
  ok('拉到模型后填充 datalist 候选', dl && dl.children.length === 4, '候选=' + (dl ? dl.children.length : 0));
  ok('模型名为空时自动填入一个（优先 mini 级）', q3('aiModel').value === 'gpt-4o-mini', q3('aiModel').value);
  const picker = doc3.getElementById('bh-model-picker');
  ok('弹出模型选择窗', !!picker);
  ok('选择窗列出全部模型', picker && picker.querySelectorAll('button[data-model]').length === 4);

  // 14e. 点选模型 → 填值 + 保存 + 关闭
  const pickBtn = [...picker.querySelectorAll('button[data-model]')].find((b) => b.dataset.model === 'deepseek-chat');
  pickBtn.click();
  await waitForUI(() => !doc3.getElementById('bh-model-picker'), '选择模型后持久化并关闭选择窗');
  ok('点选后填入模型名', q3('aiModel').value === 'deepseek-chat');
  // pickBtn.click 内部会自己保存（在 1.0.0 是这样），再次保险
  ok('点选后自动保存配置', BH.loadConfig().aiModel === 'deepseek-chat');
  ok('点选后弹窗关闭', !doc3.getElementById('bh-model-picker'));

  // 14f. 无 Key 时不发起请求
  resetAll();
  BH.state.config = null;
  q3('aiApiKey').value = '';
  aiModal3.querySelector('[data-act="aisave"]').click();
  BH.state.config = null;
  netCalls = 0;
  await BH.fetchAIModelList();
  ok('未填 Key 时不发起 /models 请求', netCalls === 0, 'netCalls=' + netCalls);

  // 14g. 401 → 明确报错，不崩溃
  resetAll();
  BH.state.config = null;
  q3('aiApiKey').value = 'sk-bad';
  aiModal3.querySelector('[data-act="aisave"]').click();
  BH.state.config = null;
  netHandler = (o) => reply(o, { error: { message: 'Invalid Authorization' } }, 401);
  await BH.fetchAIModelList();
  ok('401 时给出可读错误（不抛异常、不静默）', true);

  // 14h. 返回 200 但格式异常
  resetAll();
  BH.state.config = null;
  q3('aiApiKey').value = 'sk-fmt';
  aiModal3.querySelector('[data-act="aisave"]').click();
  BH.state.config = null;
  netHandler = (o) => reply(o, { foo: 'bar' });
  await BH.fetchAIModelList();
  ok('接口格式异常时给出提示（不崩溃）', true);
}

// ============================================================
section('15. 接口地址自动补全（/v1 → /v1/chat/completions）');
{
  const N = BH.normalizeChatUrl;
  ok('只填到 /v1 会自动补全', N('https://apihub.agnes-ai.com/v1') === 'https://apihub.agnes-ai.com/v1/chat/completions');
  ok('末尾带斜杠也能补全', N('https://apihub.agnes-ai.com/v1/') === 'https://apihub.agnes-ai.com/v1/chat/completions');
  ok('已带 /chat/completions 时原样保留',
     N('https://api.openai.com/v1/chat/completions') === 'https://api.openai.com/v1/chat/completions');
  ok('/v1beta/openai 这类前缀会补全',
     N('https://x.com/v1beta/openai') === 'https://x.com/v1beta/openai/chat/completions');
  ok('自定义路径不被破坏（/openapi/chat 保持原样）', N('https://x.com/openapi/chat') === 'https://x.com/openapi/chat');
  ok('无路径时也会补全', N('https://x.com') === 'https://x.com/chat/completions');
  ok('空地址返回空', N('') === '');

  // 端到端：只填 /v1，实际 POST 必须打到 /v1/chat/completions
  const p4 = win.document.getElementById('boss-helper-panel');
  // v1.0.1：AI 输入框需要先打开弹窗（document 范围查找）
  p4.querySelector('[data-act="aiopen"]').click();
  const aiModal4 = win.document.getElementById('bh-ai-modal');
  const q4 = (k) => win.document.querySelector('[data-cfg="' + k + '"]');
  resetAll();
  q4('aiBaseUrl').value = 'https://apihub.agnes-ai.com/v1';
  q4('aiApiKey').value = 'sk-xxx38Mm';
  q4('aiModel').value = 'agnes-2.5-flash';
  const urls = [];
  netHandler = (o) => { urls.push(o.url); reply(o, { choices: [{ message: { content: '{"match":true,"score":85,"reason":"匹配"}' } }] }); };
  const rr = await BH.aiScreen({ title: '嵌入式', jd: 'STM32', jobId: 'U1' }, { bypassCache: true });
  ok('实际请求打到 /v1/chat/completions（不再 POST /v1 → 404）',
     urls[0] === 'https://apihub.agnes-ai.com/v1/chat/completions', urls[0]);
  ok('补全后调用成功', rr.ok === true && rr.match === true);

  // 保存后落盘与回显都是补全后的地址
  aiModal4.querySelector('[data-act="aisave"]').click();
  ok('保存后落盘为补全后的地址', BH.loadConfig().aiBaseUrl === 'https://apihub.agnes-ai.com/v1/chat/completions');
  ok('保存后输入框回显补全后的地址', q4('aiBaseUrl').value === 'https://apihub.agnes-ai.com/v1/chat/completions');

  // 模型列表地址也要跟着补全后的 base 走
  ok('补全后 /models 地址仍正确',
     BH.deriveModelsUrl('https://apihub.agnes-ai.com/v1/chat/completions') === 'https://apihub.agnes-ai.com/v1/models');
}

// ============================================================
section('16. 实测 agnes-ai 网关行为');
if (process.env.BOSS_TEST_NETWORK !== '1') {
  skip('agnes-ai 网关实测（3 条）', '默认离线；仅 BOSS_TEST_NETWORK=1 时执行真实请求');
} else {
  // 直接打真实网关（无 Key，看路径是否对）
  // 注意：这几条是**真实网络探测**，不是逻辑断言。外网不通时应该 skip 而不是 fail，
  // 否则一换网络环境就报"3 条失败"，把真正的问题淹掉。
  const probes = [
    ['POST', 'https://apihub.agnes-ai.com/v1'],
    ['POST', 'https://apihub.agnes-ai.com/v1/chat/completions'],
  ];
  const probeResults = [];
  for (const [m, url] of probes) {
    let last = { url, status: 'ERR', msg: 'no attempt' };
    // 真实网络，允许重试几次（沙箱偶发 fetch failed）
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url, {
          method: m,
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer bh-test-invalid' },
          body: m === 'POST' ? JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }) : undefined,
        });
        last = { url, status: r.status, msg: (await r.text()).slice(0, 150) };
        break;
      } catch (e) {
        last = { url, status: 'ERR', msg: e.message };
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    probeResults.push(last);
  }
  if (probeResults.every((r) => r.status === 'ERR')) {
    skip('agnes-ai 网关实测（3 条）', '外网不可达：' + probeResults[0].msg);
  } else {
    const bare = probeResults.find((r) => r.url.endsWith('/v1') && r.url.indexOf('/chat') < 0);
    const full = probeResults.find((r) => r.url.endsWith('/v1/chat/completions'));
    ok('POST /v1 返回 404（确认裸 /v1 路径网关不接受）', bare && bare.status === 404, JSON.stringify(bare));
    ok('POST /v1/chat/completions 返回 401（路径正确，是 Key 问题）',
       full && full.status === 401, JSON.stringify(full));
    ok('结论：用户填入的 /v1 + 脚本自动补全 → 实际命中正确端点', full && full.status === 401);
  }
}

// ============================================================
section('17. 传输通道：GM 挂起 / 失败 → 自动降级 fetch');
{
  const origGM = win.GM_xmlhttpRequest;
  const origFetch = win.fetch;
  const okReply = { choices: [{ message: { content: '{"match":true,"score":91,"reason":"ok"}' } }] };

  // 17a. GM 完全不回调（油猴域名未授权的典型表现）→ 看门狗兜底 + fetch 降级
  resetAll();
  win.GM_xmlhttpRequest = () => { /* 永不回调 */ };
  win.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(okReply) });
  setCfg(CFG({ aiTimeoutMs: 500 }));
  let r = await BH.aiScreen({ title: 't', jd: 'x', jobId: 'TR1', salary: '1', company: 'c' }, { bypassCache: true, transport: undefined });
  ok('GM 不回调时看门狗兜底，不会永久挂起', r.ok === true, JSON.stringify(r));
  ok('GM 挂起后自动降级到 fetch 并成功',
     r.ok === true && String(r.transport || '').startsWith('fetch'), r.transport);

  // 17b. 强制 gm 通道 → 失败（证明确实是 GM 那侧的问题）
  r = await BH.aiScreen({ title: 't', jd: 'x', jobId: 'TR2' }, { bypassCache: true, transport: 'gm' });
  ok('强制 gm 通道时失败（定位到 GM 侧）', r.ok === false && /超时/.test(r.err), JSON.stringify(r));

  // 17c. 强制 fetch 通道 → 成功
  r = await BH.aiScreen({ title: 't', jd: 'x', jobId: 'TR3' }, { bypassCache: true, transport: 'fetch' });
  ok('强制 fetch 通道时成功', r.ok === true && r.transport === 'fetch', JSON.stringify(r));

  // 17d. GM 返回业务错误（401，非网络类）→ 不应再降级重试，避免浪费一次调用
  resetAll();
  let fetchCalls = 0;
  win.GM_xmlhttpRequest = (o) => setTimeout(() => reply(o, { error: { message: 'Invalid token' } }, 401), 0);
  win.fetch = async () => { fetchCalls++; return { ok: true, status: 200, text: async () => JSON.stringify(okReply) }; };
  setCfg(CFG({ aiTimeoutMs: 3000, aiMaxRetries: 0 }));
  r = await BH.aiScreen({ title: 't', jd: 'x', jobId: 'TR4' }, { bypassCache: true });
  ok('401 业务错误不重试也不降级（fetch 未被调用）', r.ok === false && fetchCalls === 0, 'fetchCalls=' + fetchCalls);
  ok('401 错误信息带通道标记便于定位', /gm/.test(r.err), r.err);

  // 17e. GM 超时（retryable）→ 会降级到 fetch
  resetAll();
  win.GM_xmlhttpRequest = (o) => setTimeout(() => o.ontimeout(), 0);
  win.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(okReply) });
  setCfg(CFG({ aiTimeoutMs: 500 }));
  r = await BH.aiScreen({ title: 't', jd: 'x', jobId: 'TR5' }, { bypassCache: true });
  ok('GM 超时（网络类）→ 降级 fetch 成功', r.ok === true && String(r.transport || '').startsWith('fetch'), JSON.stringify(r));

  win.GM_xmlhttpRequest = origGM;
  win.fetch = origFetch;
}

// ============================================================
section('18. Escape 关闭弹窗的误触防护（v1.0.3）');
{
  const doc5 = win.document;
  const p5 = doc5.getElementById('boss-helper-panel');
  const modalOpen = () => !!doc5.getElementById('bh-ai-modal');
  const openModal = () => {
    p5.querySelector('[data-act="aiopen"]').click();
    return doc5.getElementById('bh-ai-modal');
  };
  const closeModal = () => {
    const m = doc5.getElementById('bh-ai-modal');
    if (m) m.querySelector('[data-act="aiclose"]').click();
  };
  // 派发一个 Escape keydown；bhSynthetic=true 时打上"脚本合成"标记
  const fireEsc = (extra = {}) => {
    const ev = new win.KeyboardEvent('keydown', Object.assign(
      { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }, extra));
    if (extra.bhSynthetic) { try { ev.bhSynthetic = true; } catch (_) {} }
    doc5.dispatchEvent(ev);
  };

  // 18a. 脚本自己合成的 Escape（投递中关站点弹窗）不应关闭弹窗
  closeModal();
  openModal();
  ok('AI 弹窗已打开（前置条件）', modalOpen());
  fireEsc({ bhSynthetic: true });
  ok('合成 Escape（bhSynthetic）不会关闭 AI 设置弹窗', modalOpen());

  // 18b. 带 Ctrl 的 Escape（输入法 / 浏览器派发）不应关闭弹窗
  fireEsc({ ctrlKey: true });
  ok('Ctrl + Escape 不会关闭 AI 设置弹窗', modalOpen());

  // 18c. 刚按过 Ctrl 后紧跟的 Escape（输入法典型特征）不应关闭弹窗
  doc5.dispatchEvent(new win.KeyboardEvent('keydown',
    { key: 'Control', code: 'ControlLeft', keyCode: 17, bubbles: true }));
  fireEsc();
  ok('刚按过 Ctrl 后紧跟的 Escape 不会关闭弹窗（时间窗防护）', modalOpen());

  // 18d. 真人裸按 Escape 仍然能关闭（可用性保留）—— 等时间窗过期
  await new Promise((r) => setTimeout(r, 1100));
  fireEsc();
  // v1.0.8：close() 现在会检测「未保存改动」（弹窗刚创建就有 aiCacheEnabled 假未保存），
  // 真人按 Esc 后会弹出三按钮确认框；这里选择「丢弃」关闭弹窗。
  if (doc5.getElementById('bh-ai-confirm')) {
    doc5.getElementById('bh-ai-confirm').querySelector('[data-act="neutral"]')?.click();
  }
  ok('真人裸按 Escape 仍能正常关闭弹窗', !modalOpen());

  // 18e. 合成 Escape 不应把正在运行的脚本停掉
  closeModal();
  resetAll();
  BH.state.running = true;
  try {
    fireEsc({ bhSynthetic: true });
    ok('合成 Escape 不会停止正在运行的脚本', BH.state.running === true);
  } catch (e) {
    ok('合成 Escape 不会停止正在运行的脚本', false, e?.message);
  } finally {
    BH.state.running = false;
    BH.state.stopFlag = false;
  }
}

// ============================================================
section('19. AI 弹窗开关组件结构（v1.0.4 防站点样式覆盖）');
{
  const doc6 = win.document;
  const p6 = doc6.getElementById('boss-helper-panel');
  // 确保弹窗打开
  if (!doc6.getElementById('bh-ai-modal')) p6.querySelector('[data-act="aiopen"]').click();
  const m6 = doc6.getElementById('bh-ai-modal');
  ok('AI 弹窗已打开（前置条件）', !!m6);

  // 开关用真实子元素，不再用通用类名 .slider（会被 BOSS 站点同名样式覆盖）
  // v1.0.10：开关数从 2 增到 3（新增「不投短期岗位」），改成"每个开关都必须有轨道+滑块"的断言，
  // 避免以后再加开关又要改这里。
  const tracks = m6.querySelectorAll('.bh-ai-track').length;
  const knobs = m6.querySelectorAll('.bh-ai-knob').length;
  const toggles = m6.querySelectorAll('.bh-ai-toggle').length;
  ok('每个开关都有轨道元素（.bh-ai-track）', tracks === toggles && tracks >= 2, `track=${tracks} toggle=${toggles}`);
  ok('每个开关都有滑块元素（.bh-ai-knob）', knobs === toggles && knobs >= 2, `knob=${knobs} toggle=${toggles}`);
  ok('不再使用通用类名 .slider（避免被站点样式覆盖）', m6.querySelectorAll('.slider').length === 0);

  // 开关的 input 仍然挂在正确的 data-cfg 上
  const enInput = m6.querySelector('[data-cfg="aiEnabled"]');
  const cacheInput = m6.querySelector('[data-cfg="aiCacheEnabled"]');
  ok('aiEnabled 开关结构完整', !!(enInput && enInput.parentElement.querySelector('.bh-ai-track')));
  ok('aiCacheEnabled 开关结构完整', !!(cacheInput && cacheInput.parentElement.querySelector('.bh-ai-track')));

  // 紧凑输入框类名（旧类名 .compact / .compact-select 太通用且 CSS 定义曾遗漏）
  ok('紧凑数字输入框用 bh-ai-num（3 处）', m6.querySelectorAll('.bh-ai-num').length === 3,
     '数量=' + m6.querySelectorAll('.bh-ai-num').length);
  ok('紧凑下拉用 bh-ai-select（1 处）', m6.querySelectorAll('.bh-ai-select').length === 1);
  ok('不再使用通用类名 .compact', m6.querySelectorAll('.compact, .compact-select').length === 0);

  // 样式确实注入到了页面（GM_addStyle 桩会把 CSS 写进 <style>）
  const cssText = [...doc6.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  ok('样式表含 .bh-ai-track 规则', cssText.includes('.bh-ai-track'));
  ok('开关样式带 #bh-ai-modal 前缀提高优先级', cssText.includes('#bh-ai-modal .bh-ai-toggle'));

  // 收尾：关掉弹窗，避免影响后续
  const closeBtn = m6.querySelector('[data-act="aiclose"]');
  if (closeBtn) closeBtn.click();
}

// ============================================================
section('20. 拉取按钮旁的常驻提醒标签（v1.0.6）');
{
  const doc7 = win.document;
  const p7 = doc7.getElementById('boss-helper-panel');
  // 确保弹窗打开
  if (!doc7.getElementById('bh-ai-modal')) p7.querySelector('[data-act="aiopen"]').click();
  const m7 = doc7.getElementById('bh-ai-modal');
  ok('AI 弹窗已打开（前置条件）', !!m7);

  // 标签存在
  const hint = m7.querySelector('.bh-ai-warn-hint');
  ok('拉取按钮上方存在常驻提醒标签 .bh-ai-warn-hint', !!hint);

  // 拉取读取当前草稿，不再要求先保存。
  ok('提醒文案说明使用当前填写的配置', hint && /当前填写/.test(hint.textContent),
     hint && hint.textContent);
  ok('提醒文案明确读取接口', hint && /接口/.test(hint.textContent),
     hint && hint.textContent);

  // 标签和拉取按钮在视觉上相邻（在同一个 flex 容器里）
  const aimodelsBtn = [...m7.querySelectorAll('[data-act="aimodels"]')][0];
  ok('拉取按钮存在', !!aimodelsBtn);
  ok('提醒标签与拉取按钮是兄弟节点（在同一个容器内）',
     !!(hint && aimodelsBtn && hint.parentElement === aimodelsBtn.parentElement));

  // 提醒标签在拉取按钮「上方」（在 DOM 顺序里更靠前）
  if (hint && aimodelsBtn) {
    const pos = hint.compareDocumentPosition(aimodelsBtn);
    ok('提醒标签在拉取按钮之前（DOM 顺序在上方）',
       !!(pos & win.Node.DOCUMENT_POSITION_FOLLOWING));
  }

  // 样式确实注入
  const cssText = [...doc7.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  ok('样式表含 .bh-ai-warn-hint 规则', cssText.includes('.bh-ai-warn-hint'));
  ok('提醒标签样式带 #bh-ai-modal 前缀提高优先级（防站点覆盖）',
     cssText.includes('#bh-ai-modal .bh-ai-warn-hint'));

  // 不使用会撞站点的通用类名
  ok('提醒不使用通用类名（如 .warning / .tip）',
     m7.querySelectorAll('.bh-ai-warn-hint.warning, .bh-ai-warn-hint.tip').length === 0);

  // 关掉弹窗
  const closeBtn = m7.querySelector('[data-act="aiclose"]');
  if (closeBtn) closeBtn.click();
}

// ============================================================
section('21. 年限改为下拉选择（v1.0.7）');
{
  const doc8 = win.document;
  const p8 = doc8.getElementById('boss-helper-panel');
  const sel = p8.querySelector('[data-cfg="yearsMin"]');

  // 21a. 已经是 select，不再是手填数字
  ok('年限控件是 <select>（不再是 number input）',
     sel && sel.tagName === 'SELECT', sel && sel.tagName);

  // 21b. 选项齐全
  const vals = [...sel.options].map((o) => o.value);
  ok('选项含「不限」（值 0）', vals.includes('0'), vals.join(','));
  ok('选项含全部预设年限 1/2/3/5/8/10',
     ['1', '2', '3', '5', '8', '10'].every((v) => vals.includes(v)), vals.join(','));

  // 21c. 与学历下拉结构一致（都是 select + 首个选项为「不限」）
  const eduSel = p8.querySelector('[data-cfg="eduMin"]');
  ok('学历也是下拉（对照组）', eduSel && eduSel.tagName === 'SELECT');
  ok('两者首个选项都是「不限」',
     sel.options[0].value === '0' && eduSel.options[0].value === '0');

  // 21d. 默认值能正确回显
  ok('默认回显 3 年（DEFAULT_CONFIG.yearsMin）',
     sel.value === '3' || sel.value === '', 'sel.value=' + sel.value);

  // 21e. 选不同年限 → readConfig 能正确读出数字（不是字符串）
  const readYears = () => {
    // 通过主面板保存按钮触发 readConfig
    p8.querySelector('[data-act="save"]')?.click();
    return p8.querySelector('[data-cfg="yearsMin"]').value;
  };
  for (const v of ['0', '1', '3', '10']) {
    sel.value = v;
    ok(`选中 ${v} 年后 select.value 保持为 "${v}"`, sel.value === v, sel.value);
  }

  // 21g. 年限过滤逻辑本身没变（回归）
  const rYear = BH.matchJob('1年经验，本科，stm32', '', '20-30K',
    { ...BH.loadConfig(), yearsMin: 3 }, {});
  ok('年限过滤逻辑仍然生效（1年 < 3年 → 跳过）',
     rYear.matched === false && /年限不足/.test(rYear.reason), rYear.reason);
  const rYearPass = BH.matchJob('5年经验，本科，stm32', '', '20-30K',
    { ...BH.loadConfig(), yearsMin: 3 }, {});
  ok('年限达标时放行（5年 ≥ 3年）', rYearPass.matched === true, rYearPass.reason);
}

// ============================================================
section('22. 老配置非预设年限不丢失（v1.0.7 端到端）');
{
  // 真实场景：用户之前用手填输入框设了 4 年，存进 localStorage；
  // 升级到下拉版后重新打开页面，fillConfig 必须能补出 "4 年" 选项，不能静默跳回「不限」。
  const makeEnv = (savedCfg) => {
    const st = new Map();
    if (savedCfg) st.set('boss_helper_config_v1', savedCfg);
    const d = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://www.zhipin.com/web/geek/job?query=x',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const w = d.window;
    w.GM_getValue = (k, dv) => (st.has(k) ? st.get(k) : dv);
    w.GM_setValue = (k, v) => st.set(k, v);
    w.GM_addStyle = () => {};
    w.unsafeWindow = w;
    w.GM_xmlhttpRequest = () => {};
    w.eval(code);
    return { w, st };
  };
  const yearsSelOf = (w) => w.document
    .getElementById('boss-helper-panel')
    .querySelector('[data-cfg="yearsMin"]');
  const awaitInit = () => new Promise((r) => setTimeout(r, 80));

  // 22a. 老配置 yearsMin = 4（非预设值）
  {
    const { w } = makeEnv({ yearsMin: 4 });
    await awaitInit();
    const s = yearsSelOf(w);
    const vals = [...s.options].map((o) => o.value);
    ok('yearsMin=4 → 动态补出「4 年」选项', vals.includes('4'), vals.join(','));
    ok('yearsMin=4 → 选中值正确回显为 4（不跳回不限）', s.value === '4', s.value);
    ok('补入的选项按数字升序插在 3 和 5 之间',
       vals.join(',') === '0,1,2,3,4,5,8,10', vals.join(','));
    w.close();
  }

  // 22b. 老配置 yearsMin = 0（不限）→ 走常规路径，不重复补选项
  {
    const { w } = makeEnv({ yearsMin: 0 });
    await awaitInit();
    const s = yearsSelOf(w);
    const vals = [...s.options].map((o) => o.value);
    ok('yearsMin=0 → 选中「不限」', s.value === '0', s.value);
    ok('yearsMin=0 → 选项不重复（仍是 7 个预设）', vals.length === 7, vals.join(','));
    w.close();
  }

  // 22c. 老配置 yearsMin = 7（另一个非预设值，插在 5 和 8 之间）
  {
    const { w } = makeEnv({ yearsMin: 7 });
    await awaitInit();
    const s = yearsSelOf(w);
    const vals = [...s.options].map((o) => o.value);
    ok('yearsMin=7 → 动态补出「7 年」选项', vals.includes('7'), vals.join(','));
    ok('yearsMin=7 → 插在 5 和 8 之间（保持升序）',
       vals.join(',') === '0,1,2,3,5,7,8,10', vals.join(','));
    w.close();
  }

  // 22d. 补出来的选项保存时能被正确读回（不会变成 NaN / 0）
  {
    const { w } = makeEnv({ yearsMin: 4 });
    await awaitInit();
    const bh = w.BH;
    ok('载入后 loadConfig().yearsMin 仍是数字 4',
       bh.loadConfig().yearsMin === 4, String(bh.loadConfig().yearsMin));
    // 触发一次保存，验证 readConfig 能读回 4（而非被 select 吞掉）
    const panel = w.document.getElementById('boss-helper-panel');
    panel.querySelector('[data-act="save"]')?.click();
    ok('保存后 yearsMin 仍为 4（未被下拉吞掉）',
       bh.loadConfig().yearsMin === 4, String(bh.loadConfig().yearsMin));
    w.close();
  }
}

// ============================================================
section('23. 主面板 AI 按钮状态同步兜底（v1.0.8 修复）');
{
  const doc9 = win.document;
  const p9 = doc9.getElementById('boss-helper-panel');
  const btn = p9.querySelector('[data-act="aiopen"]');
  const lbl = p9.querySelector('[data-ai-btn]');

  // 23a. 默认落盘配置 aiEnabled=false → 紫色
  resetAll();
  // 清理前序 section 可能残留的弹窗（测试间互相干扰的常见 bug）
  doc9.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());
  ok('默认未开启时 dataset.on = "0"', btn.dataset.on === '0',
     'dataset.on=' + btn.dataset.on);
  ok('默认未开启时内联 style.background 含紫色（#7c3aed）',
     /124.*58.*237/i.test(btn.style.background) || /7c3aed/i.test(btn.style.background),
     'background=' + btn.style.background);
  ok('默认未开启时 label = "AI 设置"',
     lbl.textContent === 'AI 设置', lbl.textContent);

  // 23b. 打开弹窗，切开 aiEnabled → 主按钮立即变绿（不依赖落盘）
  p9.querySelector('[data-act="aiopen"]').click();
  const m9 = doc9.getElementById('bh-ai-modal');
  const tog = m9.querySelector('[data-cfg="aiEnabled"]');
  tog.checked = true;
  tog.dispatchEvent(new win.Event('change', { bubbles: true }));
  ok('弹窗里切开 aiEnabled 后 dataset.on 立即 = "1"',
     btn.dataset.on === '1', 'dataset.on=' + btn.dataset.on);
  ok('弹窗里切开 aiEnabled 后内联 background 含绿色（#34c759）',
     /52.*199.*89/i.test(btn.style.background) || /34c759/i.test(btn.style.background),
     'background=' + btn.style.background);
  ok('弹窗里切开 aiEnabled 后 label = "AI 已开启 ✓"',
     /AI 已开启/.test(lbl.textContent), lbl.textContent);

  // 23c. 不保存直接关闭 → 关闭逻辑先弹确认框，不会丢状态但内联 style 会被刷新回紫
  //     （用户视角：主按钮颜色回到紫色，因为落盘还是 false，符合预期）
  m9.querySelector('[data-act="aiclose"]').click();
  await new Promise((r) => setTimeout(r, 30));
  const confirmBox = doc9.getElementById('bh-ai-confirm');
  ok('未保存直接关闭 → 弹三按钮确认框', !!confirmBox);
  if (confirmBox) {
    const acts = [...confirmBox.querySelectorAll('[data-act]')].map((b) => b.dataset.act);
    ok('确认框含 ok / neutral / cancel 三个按钮',
       acts.includes('ok') && acts.includes('neutral') && acts.includes('cancel'),
       acts.join(','));
    // 选「继续编辑」→ 不关闭
    confirmBox.querySelector('[data-act="cancel"]').click();
    await new Promise((r) => setTimeout(r, 30));
    ok('选「继续编辑」后弹窗还在（不关闭）',
       !!doc9.getElementById('bh-ai-modal'));
    ok('选「继续编辑」后 AI 按钮仍维持绿色（dataset.on=1）',
       btn.dataset.on === '1');
  }

  // 23d. 这次选「丢弃修改」→ 主按钮应该回到紫色（落盘还是 false）
  m9.querySelector('[data-act="aiclose"]').click();
  await new Promise((r) => setTimeout(r, 30));
  const confirmBox2 = doc9.getElementById('bh-ai-confirm');
  if (confirmBox2) {
    confirmBox2.querySelector('[data-act="neutral"]').click();
    await new Promise((r) => setTimeout(r, 30));
  }
  ok('选「丢弃修改」后弹窗已关闭', !doc9.getElementById('bh-ai-modal'));
  ok('选「丢弃修改」后主按钮回到紫色（落盘还是 false）',
     btn.dataset.on === '0', 'dataset.on=' + btn.dataset.on);
  ok('主按钮 label 回到 "AI 设置"',
     lbl.textContent === 'AI 设置', lbl.textContent);
}

// ============================================================
section('24. AI 设置弹窗未保存改动关闭拦截（v1.0.8）');
{
  const docA = win.document;
  const pA = docA.getElementById('boss-helper-panel');

  // 24a. 打开弹窗、没改任何字段 → 直接关闭（不弹确认）
  resetAll();
  pA.querySelector('[data-act="aiopen"]').click();
  await new Promise((r) => setTimeout(r, 30));
  const mA = docA.getElementById('bh-ai-modal');
  ok('AI 弹窗已打开（前置条件）', !!mA);
  mA.querySelector('[data-act="aiclose"]').click();
  await new Promise((r) => setTimeout(r, 30));
  ok('无未保存改动时点 × 直接关闭（不弹确认）',
     !docA.getElementById('bh-ai-modal') && !docA.getElementById('bh-ai-confirm'));

  // 24b. 改了 AI Key → 关闭时弹确认
  pA.querySelector('[data-act="aiopen"]').click();
  await new Promise((r) => setTimeout(r, 30));
  const mB = docA.getElementById('bh-ai-modal');
  mB.querySelector('[data-cfg="aiApiKey"]').value = 'sk-new-9999';
  mB.querySelector('[data-act="aiclose"]').click();
  await new Promise((r) => setTimeout(r, 30));
  ok('改了 Key 后点 × 弹出确认框',
     !!docA.getElementById('bh-ai-confirm'));

  // 24c. 选「保存并关闭」→ 落盘 + 关闭 + 主按钮颜色按落盘显示
  {
    const cb = docA.getElementById('bh-ai-confirm');
    cb.querySelector('[data-act="ok"]').click();
    await new Promise((r) => setTimeout(r, 30));
    ok('「保存并关闭」后 AI 弹窗消失', !docA.getElementById('bh-ai-modal'));
    ok('「保存并关闭」后 Key 已落盘',
       win.BH.loadConfig().aiApiKey === 'sk-new-9999',
       win.BH.loadConfig().aiApiKey);
  }

  // 24d. Esc 关闭也会触发未保存检查（不是只有 × 触发）
  resetAll();
  docA.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());
  pA.querySelector('[data-act="aiopen"]').click();
  await new Promise((r) => setTimeout(r, 50));
  const mC = docA.getElementById('bh-ai-modal');
  mC.querySelector('[data-cfg="aiModel"]').value = 'gpt-4o';
  // jsdom 在密集测试后偶发首次 dispatchEvent 不触发监听器，
  // 真实场景（用户按键）由浏览器事件循环自然解决，这里用「第二次派发」绕过。
  // 先派发一次"热身"避免假阴性。
  const fireEscOnce = () => {
    const ev = new win.KeyboardEvent('keydown',
      { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true });
    docA.dispatchEvent(ev);
  };
  fireEscOnce();
  // 如果没触发确认框（说明是首次派发没触发），再派一次
  if (!docA.getElementById('bh-ai-confirm')) {
    await new Promise((r) => setTimeout(r, 10));
    fireEscOnce();
  }
  await new Promise((r) => setTimeout(r, 30));
  ok('改了模型名后按 Esc 也弹确认框',
     !!docA.getElementById('bh-ai-confirm'));
  if (docA.getElementById('bh-ai-confirm')) {
    docA.getElementById('bh-ai-confirm').querySelector('[data-act="neutral"]').click();
    await new Promise((r) => setTimeout(r, 30));
  }
  ok('Esc → 选「丢弃」后弹窗关闭', !docA.getElementById('bh-ai-modal'));

  // 24e. 点遮罩也会触发
  resetAll();
  pA.querySelector('[data-act="aiopen"]').click();
  await new Promise((r) => setTimeout(r, 30));
  const mD = docA.getElementById('bh-ai-modal');
  mD.querySelector('[data-cfg="aiFallback"]').value = 'pause';
  // 点遮罩（直接点 wrap）
  const wrapEl = docA.getElementById('bh-ai-modal');
  wrapEl.click();  // e.target === wrap
  await new Promise((r) => setTimeout(r, 30));
  ok('改了降级策略后点遮罩也弹确认框',
     !!docA.getElementById('bh-ai-confirm'));
}

// ============================================================
section('25. AI 判断标准：薪资取自「规则设置」，学历/年限只看求职画像（v1.0.9 → v1.0.20）');
{
  // 25a. v1.0.20：年限/学历不再取自「规则设置」；薪资/活跃度仍取自「规则设置」
  resetAll();
  const cfg = { ...BH.loadConfig(), aiEnabled: true, yearsMin: 5, eduMin: 3, salaryMin: 16, activeDays: 7 };
  const crit = BH.aiSoftCriteria(cfg);
  ok('aiSoftCriteria 仍返回 4 项（年限/学历/薪资/活跃度）', crit.length === 4, 'len=' + crit.length);
  ok('v1.0.20：年限不再取「规则设置」的值 → 不作为判断依据',
     crit[0].key === 'yearsMin' && crit[0].text === '不作为判断依据', crit[0] && crit[0].text);
  ok('v1.0.20：学历不再取「规则设置」的值 → 不作为判断依据',
     crit[1].key === 'eduMin' && crit[1].text === '不作为判断依据', crit[1] && crit[1].text);
  ok('年限 hint 写明不得因 JD 年限要求、也不得因应届/往届身份拒投',
     /不得因 JD 写明的工作经验要求/.test(crit[0].hint) && /应届\/往届身份/.test(crit[0].hint), crit[0].hint);
  ok('学历 hint 写明不得因 JD 学历要求、也不得因求职者自身学历拒投',
     /不得因 JD 写明的学历要求/.test(crit[1].hint) && /求职者自身的学历/.test(crit[1].hint), crit[1].hint);
  ok('薪资仍取「规则设置」的值', crit[2].key === 'salaryMin' && crit[2].text === '16K/月及以上', crit[2] && crit[2].text);
  ok('活跃度仍取「规则设置」的值', crit[3].key === 'activeDays' && crit[3].text === '7 天内活跃', crit[3] && crit[3].text);

  // 25b. v1.0.20：画像写明条件时才按画像（单一来源 = profileEduExpPolicy）
  const peOff = BH.profileEduExpPolicy(cfg);
  ok('画像没写学历/经验条件 → 两项都不作为判断依据',
     peOff.hasEdu === false && peOff.hasExp === false && peOff.text === '不作为判断依据', JSON.stringify(peOff));
  const peOn = BH.profileEduExpPolicy({ ...cfg, aiUserPortrait: '只投硕士以下，工作经历3年，熟悉STM32' });
  ok('画像写明「只投硕士以下，工作经历3年」→ 按求职画像判断',
     peOn.hasEdu === true && peOn.hasExp === true
     && peOn.edu[0] === '只投硕士以下' && peOn.exp[0] === '工作经历3年', JSON.stringify(peOn));
  const critOn = BH.aiSoftCriteria({ ...cfg, aiUserPortrait: '只投硕士以下，工作经历3年' });
  ok('画像有条件时 criteria 显示"按求职画像"',
     critOn[0].text === '按求职画像' && critOn[1].text === '按求职画像'
     && /只投硕士以下/.test(critOn[1].hint) && /工作经历3年/.test(critOn[0].hint),
     JSON.stringify(critOn.map((x) => x.text)));

  // 25c. 一行摘要文案（诊断页 / 启动日志 / 日志详情都用它）
  ok('describeAISoftCriteria 串成一行',
     BH.describeAISoftCriteria(cfg) === '年限 不作为判断依据 · 学历 不作为判断依据 · 薪资 16K/月及以上 · 活跃度 7 天内活跃',
     BH.describeAISoftCriteria(cfg));

  // 25d. prompt 里带上标准：薪资/活跃度 = 规则设置；学历/年限 = 不作为判断依据
  setCfg(cfg);
  const p = BH.buildAIPrompt({ title: 't', company: 'c', salary: '10-12K', jd: 'x', activeText: '30天前活跃', jobId: 'j' });
  ok('prompt 含「筛选标准」段', /筛选标准/.test(p));
  ok('prompt 里薪资 = 规则设置的 16K', p.includes('16K/月及以上'));
  ok('prompt 里活跃度 = 规则设置的 7 天', p.includes('7 天内活跃'));
  ok('prompt 含职位活跃文案（供活跃度判断）', p.includes('30天前活跃'));
  ok('v1.0.20：prompt 不再教模型"JD 明确要求更高可判不匹配"', !/JD 明确要求高于/.test(p));
  ok('v1.0.20：prompt 不再出现"5 年及以上"这类年限标准', !p.includes('5 年及以上'));
  ok('v1.0.20：学历/年限行写明不作为判断依据',
     /- 学历：不作为判断依据/.test(p) && /- 年限：不作为判断依据/.test(p));
  ok('v1.0.20：判断依据明写"学历与工作年限一律不作为判断依据"', /学历与工作年限一律不作为判断依据/.test(p));
  ok('v1.0.20：无画像条件时不送 经验要求/学历要求 字段行（避免模型拿它们碰画像身份）',
     !p.includes('经验要求（当前岗位字段）') && !p.includes('学历要求（当前岗位字段）'));
  ok('改了「规则设置」的薪资 → prompt 同步变化（不存在第二份配置）', (() => {
    const before = BH.buildAIPrompt({ title: 't', jd: 'x' });
    setCfg({ ...cfg, salaryMin: 20 });
    const after = BH.buildAIPrompt({ title: 't', jd: 'x' });
    return before.includes('16K/月及以上') && !before.includes('20K/月及以上')
        && after.includes('20K/月及以上');
  })());

  // 25e. AI 设置弹窗里的常驻提醒卡
  const docx = win.document;
  const px = docx.getElementById('boss-helper-panel');
  docx.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());
  setCfg(cfg);                        // 提醒卡渲染的是当前生效值
  px.querySelector('[data-act="aiopen"]').click();
  const mx = docx.getElementById('bh-ai-modal');
  ok('AI 弹窗已打开（前置条件）', !!mx);
  const card = docx.getElementById('bh-ai-criteria');
  ok('弹窗内存在判断标准提醒卡 #bh-ai-criteria', !!card);
  ok('提醒卡排在顶部提示卡之后（AI 总开关下方）',
     !!(mx.querySelector('.bh-ai-tip') && card &&
        (mx.querySelector('.bh-ai-tip').compareDocumentPosition(card) & win.Node.DOCUMENT_POSITION_FOLLOWING)));
  const items = [...docx.querySelectorAll('#bh-ai-criteria-list .bh-ai-criteria-item')];
  ok('提醒卡列出 4 项标准', items.length === 4, 'items=' + items.length);
  ok('提醒卡四项带 data-crit 便于定位与测试',
     ['yearsMin', 'eduMin', 'salaryMin', 'activeDays'].every((k) => !!docx.querySelector('#bh-ai-criteria-list [data-crit="' + k + '"]')));
  ok('v1.0.20：提醒卡显示 学历/年限 = 不作为判断依据，薪资 = 规则设置的值', (() => {
    const txt = items.map((el) => el.textContent).join('|');
    return txt.includes('不作为判断依据') && txt.includes('16K/月及以上');
  })(), items.map((el) => el.textContent).join('|'));
  ok('提醒卡文案点明薪资标准取自「规则设置」', /规则设置/.test(card.textContent));
  ok('v1.0.20：提醒卡点明学历与工作年限默认不作为筛选条件、只看求职画像',
     /学历与工作年限默认不作为筛选条件/.test(card.textContent) && /求职画像/.test(card.textContent));
  ok('提醒卡说明排除词交给 AI 判断',
     /排除词[\s\S]{0,80}AI|AI[\s\S]{0,80}排除词/.test(card.textContent)
     && !/排除词.{0,8}仍本地硬卡/.test(card.textContent), card.textContent);
  ok('AI 开启时提醒卡带高亮类 bh-ai-criteria-on', card.classList.contains('bh-ai-criteria-on'));
  ok('提醒卡样式带 #bh-ai-modal 前缀（防站点样式覆盖）',
     [...docx.querySelectorAll('style')].map((s) => s.textContent).join('\n').includes('#bh-ai-modal .bh-ai-criteria'));
  ok('切换总开关会同步提醒卡高亮', (() => {
    const cb = mx.querySelector('[data-cfg="aiEnabled"]');
    cb.checked = false;
    cb.dispatchEvent(new win.Event('change', { bubbles: true }));
    const off = !card.classList.contains('bh-ai-criteria-on');
    cb.checked = true;
    cb.dispatchEvent(new win.Event('change', { bubbles: true }));
    return off && card.classList.contains('bh-ai-criteria-on');
  })());
  mx.querySelector('[data-act="aiclose"]')?.click();
  docx.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());

  // 25f. 端到端：学历/年限/薪资不达标不再被本地拦下（交给 AI），但活跃度仍本地硬卡（v1.0.13）
  resetAll();
  setCfg(cfg);
  const rE2E = BH.matchJob('要求大专学历，1年经验', '今日活跃', '8-12K', cfg, {});
  ok('端到端：学历/年限/薪资 本地不再拦截（交给 AI 判断）', rE2E.matched === true, rE2E.reason);
  ok('端到端：details 里仍保留本地探测到的明细（供诊断）',
     Array.isArray(rE2E.details.foundYears) && rE2E.details.foundEdu === 1 && rE2E.details.foundSalaryK === 8,
     JSON.stringify(rE2E.details));
  const rE2EAct = BH.matchJob('要求大专学历，1年经验', '2个月前活跃', '8-12K', cfg, {});
  ok('端到端：活跃度超期仍被本地拦下（用户反馈的漏投场景）',
     rE2EAct.matched === false && /活跃/.test(rE2EAct.reason), rE2EAct.reason);
}

// ============================================================
section('26. 「不投短期岗位」开关（v1.0.10）');
{
  const docB = win.document;
  const pB = docB.getElementById('boss-helper-panel');

  // 26a. 默认 = 开（= 升级前模型自由心证的实际效果，零回归）
  resetAll();
  const d0 = BH.loadConfig();
  ok('默认配置含 aiRejectShortTerm 字段', 'aiRejectShortTerm' in d0);
  ok('默认 aiRejectShortTerm = true（保持原有行为）', d0.aiRejectShortTerm === true);
  ok('shortTermPolicy 默认 on=true', BH.shortTermPolicy(d0).on === true);
  ok('显式 undefined 也视为开（!== false 语义）', BH.shortTermPolicy({}).on === true);
  ok('关掉后 on=false 且文案变化', (() => {
    const o = BH.shortTermPolicy({ aiRejectShortTerm: false });
    return o.on === false && /不过滤/.test(o.text);
  })(), BH.shortTermPolicy({ aiRejectShortTerm: false }).text);
  // v1.0.12：特征词只剩岗位性质类；计薪方式（按天/日结）已移出（按天计薪 ≠ 短期岗位）
  ok('特征词含岗位性质类（项目制 / 劳务派遣 / 兼职 / 短期实习）',
     ['项目制', '劳务派遣', '兼职', '短期实习'].every((k) => BH.shortTermPolicy(d0).keywords.includes(k)));
  ok('计薪方式类词已移出特征词（按天计薪 / 日结 / 小时工 不再算短期）',
     ['按天计薪', '按天结算', '日结', '小时工'].every((k) => !BH.shortTermPolicy(d0).keywords.includes(k)));

  // 26b. 关闭短期自动过滤不应取消用户明确设置的排除项。
  const jd = '短期项目制，按天计薪 300元/天，负责数据标注，可远程';
  setCfg({ ...d0, aiEnabled: true, aiRejectShortTerm: true });
  const pOn = BH.buildAIPrompt({ title: '数据标注', jd, jobId: 'S1' });
  ok('开：prompt 含「投递偏好（硬性，命中即判 false）」', /投递偏好（硬性，命中即判 false）/.test(pOn));
  ok('开：prompt 明写「不投短期岗位」', /不投短期岗位/.test(pOn));
  ok('开：prompt 列出短期特征词', /项目制/.test(pOn) && /按天计薪/.test(pOn) && /日结/.test(pOn));

  setCfg({ ...d0, aiEnabled: true, aiRejectShortTerm: false });
  const pOff = BH.buildAIPrompt({ title: '数据标注', jd, jobId: 'S1' });
  ok('关：prompt 仍是「投递偏好」段但不再要求命中即 false',
     /【投递偏好】/.test(pOff) && !/命中即判 false/.test(pOff));
  ok('关：prompt 区分自动短期过滤与用户明确排除',
     /自动|不额外启用短期岗位过滤/.test(promptSection(pOff, '投递偏好')) && /明确排斥/.test(promptSection(pOff, '投递偏好')));
  ok('关：不再要求一律忽略所有岗位形式', !/岗位形式[^\n]*一律不作为判断依据/.test(pOff));
  ok('开/关不影响筛选标准段（学历等仍照常进 prompt）',
     /筛选标准/.test(pOff) && /学历/.test(pOff) && /筛选标准/.test(pOn) && /学历/.test(pOn));
  ok('短期开关不删除用户的排除词段', /明确排斥/.test(pOn) && /明确排斥/.test(pOff));

  // 26c. 弹窗 UI：开关存在 / 默认勾选 / iOS 样式 / 能保存落盘
  docB.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());
  resetAll();
  setCfg({ ...BH.loadConfig(), aiRejectShortTerm: true });
  pB.querySelector('[data-act="aiopen"]').click();
  const mB = docB.getElementById('bh-ai-modal');
  ok('AI 弹窗已打开（前置条件）', !!mB);
  const sw = docB.querySelector('[data-cfg="aiRejectShortTerm"]');
  ok('弹窗里有开关 data-cfg=aiRejectShortTerm', !!sw);
  ok('开关默认勾选（= 过滤短期岗位）', !!sw && sw.checked === true);
  ok('开关位于「限制与策略」分组内',
     !!sw && !!sw.closest('.bh-ai-group') && /限制与策略/.test(sw.closest('.bh-ai-group').textContent));
  ok('开关是 iOS 样式（bh-ai-toggle + track/knob）',
     !!sw.closest('.bh-ai-toggle') && !!sw.closest('.bh-ai-toggle').querySelector('.bh-ai-track .bh-ai-knob'));
  ok('开关行有说明文案（提到短期/项目制/实习）',
     !!sw.closest('.bh-ai-row') && /短期|项目制|实习/.test(sw.closest('.bh-ai-row').textContent),
     sw.closest('.bh-ai-row') && sw.closest('.bh-ai-row').textContent.trim().slice(0, 60));
  ok('改写开关值 → 读配置立即生效（未保存也能读到）', (() => {
    sw.checked = false;
    BH.state.config = null;              // 回到"空闲态"，强制走面板实时值
    return BH.getAIConfig().aiRejectShortTerm === false;
  })());
  mB.querySelector('[data-act="aisave"]').click();
  ok('保存后 aiRejectShortTerm=false 已落盘',
     store.get('boss_helper_config_v1').aiRejectShortTerm === false,
     String(store.get('boss_helper_config_v1').aiRejectShortTerm));
  ok('保存后自动回填仍是「关」（未被默认值 true 覆盖）',
     docB.querySelector('[data-cfg="aiRejectShortTerm"]').checked === false);
  docB.querySelector('#bh-ai-modal [data-act="aiclose"]')?.click();
  docB.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());

  // 26d. 老配置（无该字段）迁移后默认开，且不破坏其它字段
  resetAll();
  store.set('boss_helper_config_v1', { yearsMin: 4, aiModel: 'gpt-4o-mini', aiApiKey: 'sk-old' });
  const mig = BH.loadConfig();
  ok('老配置迁移后 aiRejectShortTerm 默认为 true', mig.aiRejectShortTerm === true);
  ok('老配置其它字段未被破坏（yearsMin / Key / 模型）',
     mig.yearsMin === 4 && mig.aiApiKey === 'sk-old' && mig.aiModel === 'gpt-4o-mini');
  ok('老配置迁移后 prompt 仍走「不投短期」文案（不必手动开）',
     BH.buildAIPrompt({ title: 't', jd: '短期实习' }).includes('不投短期岗位'));
  resetAll();
}

// ============================================================
section('27. 「只按明确事实判断」开关（v1.0.11）');
{
  const docC = win.document;
  const pC = docC.getElementById('boss-helper-panel');

  // 27a. 默认 = 开（掐掉模型的推测性拒绝）
  resetAll();
  const d1 = BH.loadConfig();
  ok('默认配置含 aiStrictFacts 字段', 'aiStrictFacts' in d1);
  ok('默认 aiStrictFacts = true', d1.aiStrictFacts === true);
  ok('strictFactsPolicy 默认 on=true', BH.strictFactsPolicy(d1).on === true);
  ok('显式 undefined 也视为开（!== false 语义）', BH.strictFactsPolicy({}).on === true);
  ok('关掉后 on=false 且文案变化', (() => {
    const o = BH.strictFactsPolicy({ aiStrictFacts: false });
    return o.on === false && /允许保守风控/.test(o.text);
  })(), BH.strictFactsPolicy({ aiStrictFacts: false }).text);

  // 27b. prompt：开 → 禁止推测；关 → 允许保守风控
  const jd = '华为技术有限公司，招聘嵌入式开发，本科及以上，薪资面议，岗位描述较简略';
  setCfg({ ...d1, aiEnabled: true, aiStrictFacts: true });
  const pOn = BH.buildAIPrompt({ title: '嵌入式开发', company: '华为', jd, jobId: 'F1' });
  ok('开：prompt 含「判断依据（只认事实，禁止推测性拒绝）」', /判断依据（只认事实，禁止推测性拒绝）/.test(pOn));
  ok('开：明确点名禁止「疑似 / 可能 / 风险高 / 流程不符」',
     /疑似/.test(pOn) && /风险高/.test(pOn) && /流程不符/.test(pOn));
  ok('开：禁止对公司招聘流程做外部推测', /不要对公司背景/.test(pOn));
  ok('开：拿不准一律放行（判 true）', /拿不准\s*=\s*判\s*true/.test(pOn));
  ok('开：要求 reason 引用 JD 具体依据', /reason 必须引用/.test(pOn));
  ok('SYSTEM_PROMPT 也写明禁止一切推测性拒绝', /禁止一切推测性拒绝/.test(BH.SYSTEM_PROMPT));

  setCfg({ ...d1, aiEnabled: true, aiStrictFacts: false });
  const pOff = BH.buildAIPrompt({ title: '嵌入式开发', company: '华为', jd, jobId: 'F1' });
  ok('关：prompt 改为「判断依据（允许保守风控）」', /判断依据（允许保守风控）/.test(pOff));
  ok('关：不再出现「禁止推测性拒绝」', !/禁止推测性拒绝/.test(pOff));
  ok('关：要求 reason 写明推测依据', /写明/.test(pOff));

  // 27c. 两个开关互不干扰：关掉短期 + 开严格事实 → 只保留"禁止推测"
  setCfg({ ...d1, aiEnabled: true, aiRejectShortTerm: false, aiStrictFacts: true });
  const pBoth = BH.buildAIPrompt({ title: 't', jd: '短期项目制，按天计薪', jobId: 'F2' });
  ok('短期关 + 事实开：不再出现「不投短期岗位」', !/不投短期岗位/.test(pBoth));
  ok('短期关 + 事实开：仍保留「禁止推测性拒绝」', /禁止推测性拒绝/.test(pBoth));
  ok('短期关 + 事实开：关闭自动过滤并保留明确排除规则',
     /自动|不额外启用短期岗位过滤/.test(promptSection(pBoth, '投递偏好')) && /明确排斥/.test(promptSection(pBoth, '投递偏好')));

  // 27d. 弹窗 UI
  docC.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());
  resetAll();
  setCfg({ ...BH.loadConfig(), aiStrictFacts: true });
  pC.querySelector('[data-act="aiopen"]').click();
  const mC = docC.getElementById('bh-ai-modal');
  ok('AI 弹窗已打开（前置条件）', !!mC);
  const swF = docC.querySelector('[data-cfg="aiStrictFacts"]');
  ok('弹窗里有开关 data-cfg=aiStrictFacts', !!swF);
  ok('开关默认勾选（= 只认事实）', !!swF && swF.checked === true);
  ok('开关位于「限制与策略」分组内',
     !!swF && !!swF.closest('.bh-ai-group') && /限制与策略/.test(swF.closest('.bh-ai-group').textContent));
  ok('开关是 iOS 样式（bh-ai-toggle + track/knob）',
     !!swF.closest('.bh-ai-toggle') && !!swF.closest('.bh-ai-toggle').querySelector('.bh-ai-track .bh-ai-knob'));
  ok('开关行说明文案点明「疑似 / 风险高 / 流程不符」',
     !!swF.closest('.bh-ai-row') && /疑似/.test(swF.closest('.bh-ai-row').textContent) &&
     /风险高/.test(swF.closest('.bh-ai-row').textContent) && /流程不符/.test(swF.closest('.bh-ai-row').textContent));
  ok('改写开关值 → 读配置立即生效', (() => {
    swF.checked = false;
    BH.state.config = null;
    return BH.getAIConfig().aiStrictFacts === false;
  })());
  mC.querySelector('[data-act="aisave"]').click();
  ok('保存后 aiStrictFacts=false 已落盘',
     store.get('boss_helper_config_v1').aiStrictFacts === false,
     String(store.get('boss_helper_config_v1').aiStrictFacts));
  mC.querySelector('[data-act="aiclose"]')?.click();
  docC.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());

  // 27e. 老配置迁移
  resetAll();
  store.set('boss_helper_config_v1', { yearsMin: 4, aiRejectShortTerm: false });
  const mig2 = BH.loadConfig();
  ok('老配置迁移后 aiStrictFacts 默认为 true', mig2.aiStrictFacts === true);
  ok('老配置的 aiRejectShortTerm=false 被保留（不被默认值覆盖）',
     mig2.aiRejectShortTerm === false && mig2.yearsMin === 4);
  resetAll();
}

// ============================================================
section('28. 改了判断开关 → 旧 AI 结论自动作废（v1.0.11）');
{
  resetAll();
  const base = { ...BH.loadConfig(), aiEnabled: true, aiRejectShortTerm: true, aiStrictFacts: true };

  setCfg(base);
  BH.setAICache('J1', { match: false, reason: '疑似劳务派遣短期岗位，风险高' });
  ok('指纹一致时正常命中缓存', !!BH.getAICache('J1'));

  setCfg({ ...base, aiRejectShortTerm: false });
  ok('关掉「不投短期岗位」→ 旧结论作废（不再被旧判断误杀）', BH.getAICache('J1') === null);

  setCfg(base);
  BH.setAICache('J2', { match: false, reason: 'x' });
  setCfg({ ...base, aiStrictFacts: false });
  ok('切换「只按明确事实判断」→ 旧结论作废', BH.getAICache('J2') === null);

  setCfg(base);
  BH.setAICache('J3', { match: false, reason: 'x' });
  setCfg({ ...base, aiUserPortrait: '5年嵌入式软件工程师，想找深圳 16K 以上正式开发岗' });
  ok('改了求职画像 → 旧结论作废', BH.getAICache('J3') === null);

  setCfg(base);
  BH.setAICache('J4', { match: false, reason: '老结论' });
  const allC = JSON.parse(JSON.stringify(store.get('boss_helper_ai_cache_v1') || '{}'));
  delete allC.J4.pf;   // 模拟 ≤1.0.10 写下的老条目
  store.set('boss_helper_ai_cache_v1', allC);
  ok('无指纹的老缓存条目一律作废（升级后一次性失效）', BH.getAICache('J4') === null);

  ok('指纹随开关变化',
     BH.aiCacheFingerprint({ ...base, aiStrictFacts: false }) !== BH.aiCacheFingerprint(base) &&
     BH.aiCacheFingerprint({ ...base, aiRejectShortTerm: false }) !== BH.aiCacheFingerprint(base));
  ok('指纹排除词变化时也变',
     BH.aiCacheFingerprint({ ...base, mustNot: ['外包'] }) !== BH.aiCacheFingerprint({ ...base, mustNot: ['外包', '驻场'] }));
  resetAll();

  // 28b. 画像=应届 + 年限≥N 的矛盾自检（v1.0.11 新增启动告警）
  const contradictions = (portrait, yearsMin) => {
    const p = String(portrait || '');
    return /应届|校招|毕业生|无经验|零基础/.test(p) && yearsMin > 0;
  };
  ok('应届画像 + 年限3年 → 判定为矛盾（应告警）', contradictions('2027届应届生，嵌入式方向', 3) === true);
  ok('应届画像 + 年限0（不限）→ 不矛盾', contradictions('2027届应届生，嵌入式方向', 0) === false);
  ok('社招画像 + 年限3年 → 不矛盾', contradictions('5年嵌入式工程师', 3) === false);
  ok('校招画像 + 年限3年 → 判定为矛盾', contradictions('想找正式校招开发岗', 3) === true);
}

// ============================================================
section('29. 误杀修正：明确排斥封闭集合 + 计薪方式不算短期（v1.0.12）');
{
  resetAll();
  const base = { ...BH.loadConfig(), aiEnabled: true, aiStrictFacts: true };
  const JD = '薪资 251-311元/天，项目周期 6 个月。岗位职责：嵌入式软件设计，熟悉 C 语言与 RTOS，本科及以上。';

  // 29a. 排除项范围仍由用户给定，但必须按语义判断，不能把词语出现直接当作拒绝。
  setCfg({ ...base, aiRejectShortTerm: false });
  const p = BH.buildAIPrompt({ title: '嵌入式开发', company: '某科技公司', salary: '251-311元/天', jd: JD, jobId: 'X1' });
  ok('【明确排斥】保留用户排除项', /【明确排斥/.test(p) && p.includes(base.mustNot[0]));
  ok('排除项按上下文与岗位性质判断', /上下文/.test(p) && /岗位性质/.test(p));
  ok('明确排斥下方点名不得把 按天计薪/日结/6个月 自行扩大',
     /不要把/.test(p) && /按天计薪/.test(p) && /6 个月/.test(p));
  ok('排除范围仍为封闭集合，不再要求逐字命中即拒绝',
     /封闭集合/.test(p) && !/命中即判不匹配|只有逐字列出的词才算命中/.test(p));

  // 29b. 计薪方式 / 项目时长不再是"短期"的判据（用户：薪资按天也可以）
  setCfg({ ...base, aiRejectShortTerm: true });
  const pOn = BH.buildAIPrompt({ title: '嵌入式开发', company: '某科技公司', salary: '251-311元/天', jd: JD, jobId: 'X1' });
  const listLine = pOn.split('\n').find((l) => l.indexOf('不投短期岗位') >= 0) || '';
  const noteLine = pOn.split('\n').find((l) => l.indexOf('计薪方式（') >= 0) || '';
  ok('短期开：判据只认「岗位性质」', /岗位性质/.test(pOn));
  ok('短期开：特征词清单里不含 按天计薪 / 日结（已移出）',
     !/按天计薪|日结/.test(listLine), listLine);
  ok('短期开：按天计薪只出现在"不是判据"的说明里',
     /计薪方式（按天计薪/.test(noteLine) && /本身不是/.test(noteLine) && /短期岗位的判据/.test(noteLine), noteLine);
  ok('短期开：明写只有「短期/实习/项目制/兼职/劳务派遣」才算', /只有明确写了/.test(pOn));

  // 29c. 按天薪资不再折算成月薪去卡薪资下限
  setCfg({ ...base, salaryMin: 16 });
  const pSal = BH.buildAIPrompt({ title: 't', salary: '251-311元/天', jd: JD, jobId: 'X2' });
  ok('薪资标准写明按天计薪不要折算成月薪比较', /不要折算成月薪比较/.test(pSal));
  ok('无法可靠换算时视为未标注、不扣分', /视为未标注/.test(pSal));

  // 29d. 复现用户那条理由：prompt 里已没有任何一条支持"按天计薪 = 命中明确排斥项"
  setCfg({ ...base, aiRejectShortTerm: false, aiStrictFacts: true });
  const pFix = BH.buildAIPrompt({ title: '嵌入式开发', company: '某科技公司', salary: '251-311元/天', jd: JD, jobId: 'X3' });
  const exclLines = (pFix.split('【明确排斥')[1] || '').split('\n');
  const exclList = exclLines.find((l) => l.indexOf('外包') >= 0) || '';
  ok('排除词清单里没有「按天计薪」（模型不能再拿它当命中项）', !/按天计薪/.test(exclList), exclList);
  ok('反而明确警告不得把按天计薪自行扩大进排除词',
     exclLines.some((l) => /不要把/.test(l) && /按天计薪/.test(l)));
  ok('未明确排除计薪方式时，按天计薪本身仍不是拒绝依据',
     /计薪方式/.test(promptSection(pFix, '投递偏好'))
     && /不作为判断依据|不得.{0,16}拒绝|不能.{0,16}拒绝|不是.{0,16}判据/.test(promptSection(pFix, '投递偏好')));
  resetAll();
}

// ============================================================
section('30. 「不限」不得当作要求 + 活跃度恢复本地硬卡（v1.0.13）');
{
  resetAll();
  // 复现用户截图里的配置：年限 不限 · 学历 不限 · 薪资 不限 · 活跃度 7 天内活跃
  const cfg = {
    ...BH.loadConfig(), aiEnabled: true, aiStrictFacts: true,
    yearsMin: 0, eduMin: 0, salaryMin: 0, activeDays: 7,
  };

  // 30a. v1.0.20：年限/学历与「规则设置」脱钩，一律写明不作为判断依据
  const crit = BH.aiSoftCriteria(cfg);
  const byKey = Object.fromEntries(crit.map((x) => [x.key, x]));
  ok('v1.0.20：年限 hint 写明一律不作为判断依据，且点名 JD 年限要求与应届/往届身份',
     /一律不作为判断依据/.test(byKey.yearsMin.hint) && /不得因 JD 写明的工作经验要求/.test(byKey.yearsMin.hint)
     && /应届\/往届身份/.test(byKey.yearsMin.hint), byKey.yearsMin.hint);
  ok('v1.0.20：学历 hint 写明一律不作为判断依据，且点名 JD 学历要求与求职者自身学历',
     /一律不作为判断依据/.test(byKey.eduMin.hint) && /不得因 JD 写明的学历要求/.test(byKey.eduMin.hint)
     && /求职者自身的学历/.test(byKey.eduMin.hint), byKey.eduMin.hint);
  ok('薪资「不限」→ hint 写明不得因此判 false', /不得因为薪资判 false/.test(byKey.salaryMin.hint));
  ok('年限/学历显示"不作为判断依据"，薪资为 0 显示「不限」，活跃度仍显示阈值',
     byKey.yearsMin.text === '不作为判断依据' && byKey.eduMin.text === '不作为判断依据'
     && byKey.salaryMin.text === '不限' && byKey.activeDays.text === '7 天内活跃',
     JSON.stringify(crit.map((x) => x.text)));

  // 30b. v1.0.20：即使「规则设置」把学历设为本科、年限设为 5 年，AI 侧也不拿它们说事
  const crit2 = BH.aiSoftCriteria({ ...cfg, eduMin: 2, yearsMin: 5 });
  const edu2 = crit2.find((x) => x.key === 'eduMin');
  ok('学历=本科时也不再出现"JD 明确要求更高"这类排斥引导',
     edu2.text === '不作为判断依据' && !/JD 明确要求高于/.test(edu2.hint), edu2.hint);

  // 30c. prompt：正文段必须声明"标为不限的一律不得作为拒绝理由"
  setCfg(cfg);
  const p = BH.buildAIPrompt({
    title: '嵌入式软件工程师', company: '(未知)', salary: '',
    jd: '5天/周 3个月 硕士 西安\n1 人形机器人关节模组C语言通信协议编写\n2 文档，测试。',
    jobId: 'Y1',
  });
  ok('【筛选标准】下明写"标为「不限」的项目一律不得作为拒绝理由"',
     /标为「不限」的项目＝用户不做任何要求/.test(p) && /一律不得作为拒绝理由/.test(p));
  ok('v1.0.20：学历行显示"不作为判断依据"（不再是"不限"）', /- 学历：不作为判断依据/.test(p));
  ok('v1.0.20：判断依据明写学历与工作年限一律不作为判断依据', /学历与工作年限一律不作为判断依据/.test(p));
  ok('v1.0.20：判断依据禁止拿画像学历/身份与 JD 要求硬碰',
     /不要拿【求职者画像】里的学历或身份描述与 JD 的要求硬碰/.test(p));
  ok('SYSTEM_PROMPT 维度 1 明确"不看学历与工作年限"', /不看学历与工作年限/.test(BH.SYSTEM_PROMPT));

  // 30d. 情境断言：这条 JD（硕士）在没有任何画像条件时不该有任何支持 false 的学历依据
  ok('prompt 里没有把学历列为不符合项（排除词段不含"硕士"）', !/【明确排斥[^】]*】[\s\S]{0,200}硕士/.test(p));

  // 30e. 活跃度回归本地硬卡（用户：2 个月前活跃的也投了）
  const rAct = BH.matchJob('5年，stm32', '2个月前活跃', '20-30K', cfg, {});
  ok('2 个月前活跃 → 本地直接拦截', rAct.matched === false && /活跃/.test(rAct.reason), rAct.reason);
  const rActOk = BH.matchJob('5年，stm32', '刚刚活跃', '20-30K', cfg, {});
  ok('刚刚活跃 → 放行', rActOk.matched === true, rActOk.reason);
  ok('活跃度设为不限时不拦（activeDays=0）',
     BH.matchJob('5年，stm32', '2个月前活跃', '20-30K', { ...cfg, activeDays: 0 }, {}).matched === true);

  // 30f. 提醒卡文案与行为一致（不能还说"四项都不硬卡"）
  const docD = win.document;
  const pD = docD.getElementById('boss-helper-panel');
  docD.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());
  resetAll(); setCfg(cfg);
  pD.querySelector('[data-act="aiopen"]').click();
  const note = (docD.getElementById('bh-ai-criteria') || {}).textContent || '';
  ok('提醒卡仍说明活跃度本地拦截，但排除词交给 AI',
     /活跃度.{0,12}(?:本地|硬卡)/.test(note)
     && /排除词[\s\S]{0,80}AI|AI[\s\S]{0,80}排除词/.test(note)
     && !/活跃度与「排除词」仍本地硬卡/.test(note), note.slice(0, 240));
  ok('提醒卡不再声称四项都"不再本地硬卡"', !/薪资 \/ 活跃度<\/b> 不再本地硬卡/.test(note));
  docD.querySelector('#bh-ai-modal [data-act="aiclose"]')?.click();
  docD.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());
  resetAll();
}

// ============================================================
section('31. HR 在线却被判"活跃 183 天前"（v1.0.14）');
{
  resetAll();
  // 复现用户日志的配置：活跃度阈值 7 天
  const cfg = { ...BH.loadConfig(), aiEnabled: false, yearsMin: 0, eduMin: 0, salaryMin: 0, activeDays: 7 };
  const P = BH.parseActiveDays;

  // 31a. 183 这个数全脚本只有一个出处（"半年内"折算），所以它一定来自文本里的"半年内"
  ok('parseActiveDays 已暴露给测试', typeof P === 'function');
  ok('单条「半年内活跃」仍解析成 183（真不活跃还是要拦）', P('半年内活跃') === 183, String(P('半年内活跃')));
  ok('「1年内活跃」→ 365', P('1年内活跃') === 365, String(P('1年内活跃')));
  ok('「2个月前活跃」→ 60', P('2个月前活跃') === 60, String(P('2个月前活跃')));

  // 31b. 核心修复：多个标记并存时取**最新**的那个，不再让最旧的赢
  ok('「在线 + 半年内活跃」→ 0（这就是用户那条 活跃="在线 半年内活跃"）',
     P('在线\n半年内活跃') === 0, String(P('在线\n半年内活跃')));
  ok('「刚刚活跃 + 1年前活跃」→ 0', P('刚刚活跃\n1年前活跃') === 0);
  ok('「3天前活跃 + 7天内活跃」→ 3（取最新，不是取最旧）',
     P('3天前活跃\n7天内活跃') === 3, String(P('3天前活跃\n7天内活跃')));
  ok('「在线」→ 0', P('在线') === 0);
  ok('「30分钟前活跃」→ 0', P('30分钟前活跃') === 0);

  // 31c. 裸「半年内」不再是活跃标记（JD 正文里的"实习期半年内"不该折算成 183 天）
  ok('「实习期半年内可转正」→ null（不再当活跃度）',
     P('岗位职责：负责RTOS裁剪。实习期半年内可转正') === null,
     String(P('岗位职责：负责RTOS裁剪。实习期半年内可转正')));
  ok('空文本 / null → null', P('') === null && P(null) === null);

  // 31d. 端到端：用户截图里那一幕（HR 绿色在线 + 面板残留上一条职位的活跃档）
  const rFix = BH.matchJob('嵌入式开发实习生（RTOS方向）\n5天/周\n6个月\n硕士', '在线\n半年内活跃', '150-200元/天', cfg, {});
  ok('HR 在线 + 残留「半年内活跃」→ 放行（旧版在这里判"183天前"跳过）',
     rFix.matched === true, rFix.reason);
  ok('details.foundActiveDays 记录为 0', rFix.details.foundActiveDays === 0,
     String(rFix.details.foundActiveDays));
  const rStill = BH.matchJob('嵌入式开发实习生（RTOS方向）', '半年内活跃', '150-200元/天', cfg, {});
  ok('HR 确实「半年内活跃」→ 仍然拦截', rStill.matched === false && /183/.test(rStill.reason), rStill.reason);

  // 完整 DOM 的活跃来源与正文隔离由 jd-extraction.test.mjs 验证。

  // 31f. prompt 缓存指纹升级（活跃文本口径变了，旧结论不能复用）
  ok('AI 结论缓存指纹不再停在 v13', !/^v13\|/.test(BH.aiCacheFingerprint(BH.getAIConfig())),
     BH.aiCacheFingerprint(BH.getAIConfig()));

  resetAll();
}

// ============================================================
section('32. HR 在线仍被判「活跃 14 天前」：实时徽标采不到（v1.0.15）');
{
  resetAll();
  const cfg = { ...BH.loadConfig(), aiEnabled: false, yearsMin: 0, eduMin: 0, salaryMin: 0, activeDays: 7 };
  const P = BH.parseActiveDays;
  const LIVE = BH.isLiveBadge;

  // 32a. 徽标识别必须逐字精确 —— "在线"两个字太常见，宽松匹配会把文案当状态
  ok('「在线」是实时徽标', LIVE('在线') === true);
  ok('带绿点前缀的「● 在线」也是', LIVE('● 在线') === true);
  ok('「刚刚活跃 / 今日活跃 / 今天活跃」是实时徽标',
     LIVE('刚刚活跃') && LIVE('今日活跃') && LIVE('今天活跃'));
  ok('「在线沟通」不是实时徽标', LIVE('在线沟通') === false);
  ok('「随时在线」「HR在线」不是实时徽标',
     LIVE('随时在线') === false && LIVE('HR在线') === false);
  ok('「2周内活跃」不是实时徽标（它是职位档，要走面板子树采集）', LIVE('2周内活跃') === false);
  ok('空串不是实时徽标', LIVE('') === false && LIVE(null) === false);

  // 32b. 只要「在线」进了文本，职位档再旧也不该定罪（用户这次就是 14 天）
  ok('「2周内活跃 + 在线」→ 0', P('2周内活跃\n在线') === 0, String(P('2周内活跃\n在线')));
  ok('单条「2周内活跃」→ 14（真超阈值仍要拦）', P('2周内活跃') === 14, String(P('2周内活跃')));
  ok('单条「2周前活跃」→ 14', P('2周前活跃') === 14, String(P('2周前活跃')));

  // 32c. 端到端复现用户截图：卡片自带职位档「2周内活跃」，面板里 HR 陈女士在线
  const rFix = BH.matchJob('功能安全系统实习生', ['2周内活跃', '在线'].join('\n'), '170-200元/天', cfg, {});
  ok('卡片写「2周内活跃」但 HR 在线 → 放行（1.0.14 在这里判 14 天）',
     rFix.matched === true, rFix.reason);
  ok('details.foundActiveDays 记录为 0', rFix.details.foundActiveDays === 0,
     String(rFix.details.foundActiveDays));
  const rBad = BH.matchJob('功能安全系统实习生', '2周内活跃', '170-200元/天', cfg, {});
  ok('HR 没有在线徽标、职位确实 2 周内活跃 → 仍然拦截',
     rBad.matched === false && /14天/.test(rBad.reason), rBad.reason);

  // 32d. 新版不再回退整页；隐藏旧详情、列表和推荐区的活跃状态由独立 fixture 覆盖。
  const absent = BH.extractJobSnapshot();
  ok('没有可信详情时不从脚本面板等页面区域拼凑职位状态',
     absent.ok === false && !absent.activeText, JSON.stringify(absent));

  // 32e. 缓存指纹升级
  ok('AI 结论缓存指纹已更新到 v114（旧误拒结论不得沿用）', /^v114\|/.test(BH.aiCacheFingerprint(BH.getAIConfig())),
     BH.aiCacheFingerprint(BH.getAIConfig()));

  resetAll();
}

// ============================================================
section('33. 后台保活：窗口不用放最前面也能投递（v1.0.16）');
{
  // 33a. sleep 不再是裸 setTimeout —— 必须走 Worker 时钟
  ok('CLOCK 对象已暴露给调试入口', typeof BH.CLOCK === 'object' && typeof BH.CLOCK.sleep === 'function');
  ok('sleep 由 CLOCK 接管（不再是 setTimeout 直连）',
     /const sleep = CLOCK\.sleep/.test(code));
  ok('源码里没有残留的裸 setTimeout 版 sleep',
     !/const sleep = \(ms\) => new Promise\(\(r\) => setTimeout\(r, ms\)\)/.test(code));
  ok('时钟用 Web Worker 驱动（Worker 定时器不受页面可见性限速）',
     /new host\.Worker\(url\)/.test(code) && /setInterval\(\(\)=>postMessage\(1\)/.test(code));
  ok('Worker 创建包在 try/catch 里，且失败会换 unsafeWindow 再试（油猴沙箱兜底）',
     /function ensureWorker\(\)\s*\{[\s\S]{0,300}?const hosts = \[window\][\s\S]{0,900}?try\s*\{[\s\S]{0,600}?new host\.Worker/.test(code));
  ok('降级链存在：MessageChannel 自旋（postMessage 也不走 timer 队列）',
     /new MessageChannel\(\)/.test(code) && /function spinFor\(/.test(code));
  ok('兜底链存在：原生 setTimeout 保证 sleep 一定会结束（= 1.0.15 行为）',
     /setTimeout\(\(\) => \{ if \(timers\.delete\(id\)\) resolve\(\); \}, ms\)/.test(code));

  // 33b. 实测 sleep 精度：不能因为限速而变长
  {
    const t1 = Date.now();
    await BH.CLOCK.sleep(120);
    const d1 = Date.now() - t1;
    ok('CLOCK.sleep(120) 实测耗时在合理区间（未退化成秒级）',
       d1 >= 100 && d1 < 900, d1 + 'ms');
  }
  // 33b-2. Worker 时钟真的能驱动 sleep（jsdom 默认没 Worker，这里单独起一个窗口验证）
  {
    const dom2 = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://www.zhipin.com/web/geek/job?query=test', runScripts: 'outside-only', pretendToBeVisual: true });
    const w2 = dom2.window;
    w2.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
    w2.GM_setValue = (k, v) => store.set(k, v);
    w2.GM_addStyle = () => {};
    w2.GM_xmlhttpRequest = () => {};
    w2.unsafeWindow = w2;
    // jsdom 未实现 createObjectURL / Worker，补最小桩以验证 Worker 分支
    w2.URL.createObjectURL = () => 'blob:mock';
    w2.URL.revokeObjectURL = () => {};
    let workerMade = 0;
    w2.Worker = class {
      constructor() { workerMade++; }
      postMessage(m) { if (m && m.cmd === 'start') this._h = setInterval(() => this.onmessage && this.onmessage({ data: 1 }), 50); }
      terminate() { clearInterval(this._h); }
    };
    w2.eval(code);
    await new Promise((r) => setTimeout(r, 120));
    const BH2 = w2.BH;
    ok('Worker 确实被创建（不是每次都失败后悄悄降级）', workerMade === 1, 'created=' + workerMade);
    ok('workerAlive=true', BH2.clockDiag().workerAlive === true);
    ok('心跳已收到（lastTickAgoMs < 500）',
       BH2.clockDiag().lastTickAgoMs >= 0 && BH2.clockDiag().lastTickAgoMs < 500,
       BH2.clockDiag().lastTickAgoMs + 'ms');
    const d2 = await BH2.bgSleep(1000);
    ok('Worker 时钟下 sleep(1000) 实测 1000±150ms（后台精度保证）',
       d2 >= 950 && d2 <= 1150, d2 + 'ms');
    const d3 = await BH2.bgSleep(300);
    ok('Worker 时钟下 sleep(300) 实测 300±150ms（短等待不被拉长到 1s）',
       d3 >= 250 && d3 <= 450, d3 + 'ms');
    const bgEl = w2.document.querySelector('[data-bgstate]');
    ok('状态条在前台显示 ok 档', /bh-bgstate show ok/.test(bgEl.className), bgEl.className);
    ok('状态条文案提示"切到别的窗口也能继续投递"',
       /切到别的窗口也能继续投递/.test(bgEl.textContent), bgEl.textContent);
    const dg = BH2.diagnosePage();
    ok('诊断页含「后台时钟」段落且标出 Worker 已就绪',
       /=== 后台时钟（v1\.0\.16）===/.test(dg) && /Worker 时钟: 已就绪/.test(dg));
    dom2.window.close();
  }

  // 33c. 页面可见性判定
  ok('isPageHidden 已暴露', typeof BH.isPageHidden === 'function');
  ok('isPageHidden 读的是 document.visibilityState/hidden',
     /visibilityState === 'hidden' \|\| document\.hidden === true/.test(code));
  ok('clockDiag 暴露后台诊断信息', typeof BH.clockDiag === 'function'
     && typeof BH.clockDiag().workerAlive === 'boolean');
  ok('clockStalled 判定心跳停摆（>1.5s 无 tick）',
     typeof BH.clockStalled === 'function' && /1500/.test(code));

  // 33d. smooth 滚动在不可见页面不执行 —— 必须换瞬时
  ok('新增 scrollIntoViewSafe 统一处理滚动', typeof BH.scrollIntoViewSafe === 'function');
  ok('scrollIntoViewSafe 在不可见页面改用 behavior:auto（后台 rAF 冻结，smooth 走不完）',
     /const behavior = isPageHidden\(\) \? 'auto' : 'smooth'/.test(code));
  ok('humanClick 走 scrollIntoViewSafe，不再自己 scrollIntoView',
     /scrollIntoViewSafe\(el\)/.test(code)
     && !/async function humanClick[\s\S]{0,300}?scrollIntoView\(\{/.test(code));
  ok('源码里不再有裸的 scrollIntoView({ behavior: ' + "'smooth'" + ' })',
     !/scrollIntoView\(\{ behavior: 'smooth'/.test(code));

  // 33e. processOne 的视口校验：后台要重试，否则每张卡都被"不在视口内"跳过
  ok('processOne 视口校验在后台重试 3 次，前台为 1 次',
     /const viewportTries = isPageHidden\(\) \? 3 : 1/.test(code));

  // 33f. 保留滚动通知的接线检查。新岗位身份、固定高度列表和有界重试的
  // 行为由 list-loading.test.mjs 覆盖，不再把旧的高度增长/短等待实现写死。
  ok('列表加载补派 scroll 事件唤醒 scroll 监听型懒加载',
     /dispatchEvent\(new Event\('scroll'/.test(code));

  // 33g. 面板状态条 + 接线
  ok('面板新增后台状态条 [data-bgstate]', /data-bgstate/.test(code));
  ok('状态条有 ok / warn / err 三档样式',
     /bh-bgstate\.ok/.test(code) && /bh-bgstate\.warn/.test(code) && /bh-bgstate\.err/.test(code));
  ok('refreshBgState 已接线到 refreshStats', /refreshBgState\(\);\s*\n\s*\}/.test(code));
  ok('注册了 visibilitychange 监听（最小化/切标签/被遮挡都会触发）',
     /addEventListener\('visibilitychange'/.test(code));
  ok('注册了 blur / focus 兜底（窗口遮挡时 visibilitychange 可能不触发）',
     /addEventListener\('blur'/.test(code) && /addEventListener\('focus'/.test(code));
  ok('启动时立刻拉起 Worker（不等到第一次 sleep）', /CLOCK\.ensureWorker\(\); \}\)/.test(code)
     || /try \{ CLOCK\.ensureWorker\(\); \} catch/.test(code));
  ok('心跳巡检走 CLOCK.sleep（自身不受后台限速）',
     /await CLOCK\.sleep\(2000\)/.test(code));

  // 33h. 用户可见的提示
  ok('启动日志说明后台运行仍受浏览器节能和页面休眠影响',
     /后台运行仍受浏览器节能和页面休眠影响/.test(code));
  ok('Worker 不可用时启动日志给出告警', /后台时钟：Worker 不可用/.test(code));
  ok('诊断页新增「后台时钟」段落', /=== 后台时钟（v1\.0\.16）===/.test(code));
  ok('状态条文案区分前台/后台',
     /后台运行中 · Worker 时钟正常/.test(code) && /前台运行中/.test(code));

  // 33i. 后台时钟仍不要求额外配置。
  ok('默认配置未新增任何字段（后台保活是自动的，不需要用户配置）',
     !/bgKeepAlive|bgMode|antiThrottle/.test(code));
  ok('sleep(0) 仍然立即 resolve（不占用时钟队列）',
     /if \(\!\(ms > 0\)\) return Promise\.resolve\(\);/.test(code));

  resetAll();
}

// ============================================================
section('34. 「JD 里没有外包却判命中排除词：外包」（v1.0.17）');
{
  // 34a. 测试可观察的边界，不锁定整页扫描循环；结构化提取在独立 suite 中覆盖。
  ok('可信详情提取接口可用于独立校验',
     typeof BH.readScopedText === 'function' && typeof BH.extractJobSnapshot === 'function');
  ok('找不到详情时返回 null，不能回退到 document', BH.getDetailRoot() === null);
  ok('脚本自己的设置文案不会作为 JD 被读取',
     BH.readScopedText(win.document.getElementById('boss-helper-panel')) === '');

  // 34b. 命中排除词时要能报出「出处」
  ok('新增 keywordContext（取命中位置前后上下文）',
     typeof BH.keywordContext === 'function');
  ok('keywordContext 能取到命中上下文',
     (() => {
       const t = '这是一段说明。我们是一家外包公司，主要做驻场开发。后面还有别的字。';
       const c = BH.keywordContext(t, '外包', 10);
       return c.includes('外包') && c.includes('…');
     })(), BH.keywordContext('这是一段说明。我们是一家外包公司。', '外包', 10));
  ok('keywordContext 对不存在的词返回空串',
     BH.keywordContext('这里没有那个词', '外包', 10) === '');
  const rHit = (() => {
    setCfg({ ...BH.loadConfig(), aiEnabled: false, mustNot: ['外包'], mustHave: [], yearsMin: 0, eduMin: 0, salaryMin: 0, activeDays: 0, skipKeywordCheck: false });
    return BH.matchJob('岗位职责：外包项目驻场，负责前端开发', '', '', BH.state.config, {});
  })();
  ok('命中排除词返回 matched=false 且 reason 正确',
     rHit.matched === false && rHit.reason === '命中排除词：外包', rHit.reason);
  ok('AI 关闭时仍用 stage:mustNot 标识本地排除词拦截', rHit.details.stage === 'mustNot');
  ok('命中排除词带上 hitWord / hitAlt',
     rHit.details.hitWord === '外包' && rHit.details.hitAlt === '外包');
  ok('命中排除词带上命中的那一句上下文（不再是空手猜）',
     typeof rHit.details.hitContext === 'string' && rHit.details.hitContext.includes('外包'),
     rHit.details.hitContext);
  ok('processOne 的 skip 日志带「出处」字样',
     /← 出处：\$\{hits\.join\('；'\)\}/.test(code));
  ok('出处按分段定位（标题/公司/薪资/卡片摘要/详情面板/正文探测）',
     /name: '详情面板'/.test(code) && /name: '正文探测'/.test(code) && /const jdSegs = \[/.test(code));

  // 34c. ★ 真实场景复现：左侧卡片写着"外包"，当前详情里没有 → 不得判命中
  {
    const dom3 = new JSDOM(`<!doctype html><html><body>
      <div class="job-list-wrapper">
        <div class="job-card-wrap" id="cardA">
          <div class="job-title">射频工程师</div>
          <div class="job-info">射频电路设计，天线调试</div>
        </div>
        <div class="job-card-wrap" id="cardB">
          <div class="job-title">前端开发</div>
          <div class="job-info">岗位职责：外包项目驻场开发，负责管理后台页面</div>
        </div>
      </div>
      <div class="job-detail">
        <div class="job-banner"><span class="name">射频工程师</span></div>
        <h2>职位描述</h2>
        <div>1、负责射频电路与天线设计；2、熟悉 2.4GHz 频段调试。本公司为自研团队，非外派。</div>
      </div>
    </body></html>`, {
      url: 'https://www.zhipin.com/web/geek/job?query=射频', runScripts: 'outside-only', pretendToBeVisual: true });
    const w3 = dom3.window;
    w3.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
    w3.GM_setValue = (k, v) => store.set(k, v);
    w3.GM_addStyle = () => {};
    w3.GM_xmlhttpRequest = () => {};
    w3.unsafeWindow = w3;
    // jsdom 没有布局：把尺寸/位置打桩，否则 isVisible=false 会把所有元素都排掉，
    // 测不出"采集越界"这件事。左栏卡片 left=100（<28%），详情面板 left=800（>28%）。
    w3.Object.defineProperty(w3.HTMLElement.prototype, 'offsetWidth', { get() { return 300; } });
    w3.Object.defineProperty(w3.HTMLElement.prototype, 'offsetHeight', { get() { return 200; } });
    w3.Element.prototype.getBoundingClientRect = function () {
      const inList = !!(this.closest && this.closest('.job-list-wrapper'));
      const left = inList ? 100 : 800;
      return { left, top: 200, width: 300, height: 200, right: left + 300, bottom: 400, x: left, y: 200, toJSON() {} };
    };
    w3.eval(code);
    await new Promise((r) => setTimeout(r, 120));
    const BH3 = w3.BH;
    BH3.state.config = { ...BH3.loadConfig(), aiEnabled: false, mustNot: ['外包'], skipKeywordCheck: false };

    const report = BH3.explainMustNotSources().join('\n');
    const detailPart = report.split('【左侧列表卡片')[0];
    const cardPart = report.split('【左侧列表卡片')[1] || '';

    ok('自检报告含两段：当前职位来源 / 左侧列表卡片',
       /【当前职位的详情来源】/.test(report) && /【左侧列表卡片（不该参与匹配）】/.test(report));
    ok('★ 详情来源里不再出现「外包」（左侧卡片的文本没被混进来）',
       !/命中「外包」/.test(detailPart), detailPart.split('\n').slice(2).join(' | '));
    ok('★ 左侧卡片段能指出「外包」其实在 cardB 上（误采来源可见）',
       /命中「外包」/.test(cardPart), cardPart.trim().slice(0, 120));
    ok('左侧卡片段给出上下文，含关键句',
       /外包项目驻场/.test(cardPart), cardPart.trim().slice(0, 200));
    ok('自检报告里提示了"这些命中不属于当前职位"',
       /不属于当前职位/.test(cardPart));

    // 反向验证：把"外包"写进真正的详情正文 → 必须照样命中（别改过头变成漏判）
    const w3d = w3.document;
    w3d.querySelector('.job-detail div:not(.job-banner)').textContent =
      '1、负责射频电路与天线设计；2、该岗位为外包驻场性质，需长期驻客户现场。';
    const report2 = BH3.explainMustNotSources().join('\n');
    const detailPart2 = report2.split('【左侧列表卡片')[0];
    ok('★ 反向验证：详情正文里真有「外包」时必须照样命中（不因收紧而漏判）',
       /命中「外包」/.test(detailPart2), detailPart2.split('\n').slice(2).join(' | '));
    ok('反向验证的上下文指向详情正文那句',
       /外包驻场性质/.test(detailPart2) || /该岗位为外包/.test(detailPart2));

    dom3.window.close();
  }

  resetAll();
}

// 用户提供的真实职责原文；保留重复采集形态，确认第 7 条的“技术培训”不会在 AI 前被拦。
const trainingDutyText = [
  '1、负责DSP、FPGA、CPLD等为主的嵌入式软件开发和维护；',
  '2、按照研发流程要求，完成软件的功能设计、文档编写，代码实现、单元测试、集成测试；',
  '3、负责研发的软件质量与进度控制；',
  '4、与硬件设计人员协作共同完成公司硬件产品开发及产品化。',
  '5、依据新产品研制任务书的要求，完成研发任务。',
  '6、负责设计文档的整理、撰写及审核。',
  '7、负责工艺文件编制和技术培训，对生产现场进行技术指导及产品调试，确保产品的小批量、批量生产的顺利进行。',
  '8、负责主管产品的生产技术、工艺工作、严格执行国家、行业相关的法律、法规和标准，不断采用新技术、新工艺、新材料。',
].join('\n');
const trainingDutyJob = {
  title: '嵌入式软件工程师', company: '湘潭无线电有限公司', salary: '8-13K',
  activeText: '刚刚活跃', jobId: 'USER_TECHNICAL_TRAINING',
  jd: [
    '嵌入式软件工程师', '8-13K', '3-5年', '本科', '湘潭', '嵌入式软件工程师',
    '收藏', '立即沟通', '举报', '微信扫码分享', '职位描述',
    'STM32开发', 'C++', 'DSP开发', '嵌入式/单片机开发经验', '计算机相关专业',
    trainingDutyText, '刚刚活跃', '工作地址', '湘潭雨湖区湘潭无线电有限公司',
    '点击查看地图', '查看更多信息', '职位描述', trainingDutyText, '职位描述', trainingDutyText,
  ].join('\n'),
};
const semanticCfg = (over = {}) => CFG({
  mustHave: ['STM32'], mustNot: ['培训', '销售', '客服', '外包|驻场'],
  yearsMin: 0, eduMin: 0, salaryMin: 0, activeDays: 7,
  aiUserPortrait: '嵌入式软件工程师，希望从事 DSP、STM32 软件开发',
  aiMaxRetries: 0, aiMaxJDChars: 5000, aiCacheEnabled: false,
  aiRejectShortTerm: false, aiStrictFacts: true,
  ...over,
});
function promptSection(prompt, name) {
  const lines = prompt.split('\n');
  const start = lines.findIndex((line) => line.startsWith('【' + name));
  if (start < 0) return '';
  const next = lines.findIndex((line, i) => i > start && line.startsWith('【'));
  return lines.slice(start, next < 0 ? undefined : next).join('\n');
}

// ============================================================
section('35. 所有排除词交给 AI：技术培训真实 JD 与语义对照（v1.0.18）');
{
  resetAll();
  const cfg = semanticCfg();
  setCfg(cfg);
  const local = BH.matchJob(trainingDutyJob.jd, trainingDutyJob.activeText, trainingDutyJob.salary, cfg, {});
  ok('真实 JD：AI 开启后不会因第 7 条“技术培训”被本地跳过', local.matched === true, local.reason);
  ok('真实 JD：排除词判断被明确委托给 AI', local.details.mustNotDeferredToAI === true);
  ok('真实 JD：诊断仍保留“培训”及其技术职责上下文',
     local.details.mustNotHit?.stage === 'mustNot'
     && local.details.mustNotHit?.hitWord === '培训'
     && local.details.mustNotHit?.hitAlt === '培训'
     && /工艺文件编制和技术培训/.test(local.details.mustNotHit?.hitContext || ''),
     JSON.stringify(local.details));

  const off = BH.matchJob(trainingDutyJob.jd, trainingDutyJob.activeText, trainingDutyJob.salary,
    { ...cfg, aiEnabled: false }, {});
  ok('真实 JD：关闭 AI 后识别技术培训职责，不因孤立词拒绝',
     off.matched === true, off.reason);
  ok('关闭 AI 后不声称排除词已经交给 AI', !off.details.mustNotDeferredToAI);

  const inactive = BH.matchJob(trainingDutyJob.jd, '2个月前活跃', trainingDutyJob.salary, cfg, {});
  ok('包含技术培训且 HR 活跃超期时，活跃度规则仍然拦截',
     inactive.matched === false && /活跃/.test(inactive.reason), inactive.reason);

  // 返回值是预设桩，验证的是本地→真实请求组装→AI 结果处理链路，不替代真实模型准确率评估。
  const cases = [
    { name: '用户第 7 条技术培训', words: ['培训'], job: trainingDutyJob,
      match: true, reason: '技术培训是生产指导职责，主体为嵌入式软件研发' },
    { name: '入职培训福利', words: ['培训'], jd: '负责 STM32 驱动开发；公司提供带薪入职培训和五险一金。',
      match: true, reason: '入职培训属于福利，研发方向匹配' },
    { name: '配合销售', words: ['销售'], jd: '负责 DSP 软件开发，配合销售完成技术方案讲解，不承担销售指标。',
      match: true, reason: '配合销售只是技术协作，主要职责为 DSP 研发' },
    { name: '对接客服', words: ['客服'], jd: '负责 STM32 产品固件开发，对接客服定位并修复用户反馈的固件问题。',
      match: true, reason: '对接客服是研发问题处理，不是客服岗位' },
    { name: '对接外包供应商', words: ['外包'], jd: '自研产品嵌入式开发，对接外包供应商交付的测试报告，劳动合同与本公司签订。',
      match: true, reason: '外包描述的是供应商，当前岗位为本公司研发' },
    { name: '明确非外包', words: ['外包|驻场'], jd: '负责 STM32 软件研发，本岗位为正式直招，非外包，不驻场。',
      match: true, reason: 'JD 明确说明非外包，为正式研发岗位' },
    { name: '其他用户自定义排除词', words: ['测试'], jd: '负责 STM32 驱动开发，完成单元测试、集成测试及代码审查。',
      match: true, reason: '测试属于研发职责中的验证工作' },
    { name: '真实培训招生收费', words: ['培训'], jd: '培训机构招生岗位，招收零基础学员，入职前先缴纳培训费并办理培训贷款。',
      match: false, reason: '明确为培训招生岗位，且要求先缴培训费' },
    { name: '真实销售岗位', words: ['销售'], jd: '主要负责产品销售、客户开发，按销售额和签单业绩考核，不涉及软件研发。',
      match: false, reason: '主要职责为产品销售，按签单业绩考核' },
    { name: '真实外包驻场', words: ['外包|驻场'], jd: '该岗位为外包驻场工程师，由外包公司签劳动合同，长期派驻客户现场开发。',
      match: false, reason: 'JD 明确为外包驻场性质' },
    { name: '没有字面词但语义属于排除项', words: ['销售'], jd: '主要任务是开发客户、推广产品和促成签单，收入按成交业绩提成。',
      match: false, reason: '客户拓展及签单提成表明该岗位实际属于销售' },
  ];
  for (const [i, c] of cases.entries()) {
    resetAll();
    const caseCfg = semanticCfg({ mustNot: c.words });
    setCfg(caseCfg);
    const job = c.job || { ...trainingDutyJob, jd: c.jd, jobId: 'SEMANTIC_' + i };
    let sentRequest;
    netHandler = (o) => {
      sentRequest = { url: o.url, body: JSON.parse(o.data) };
      reply(o, { choices: [{ message: { content: JSON.stringify({ match: c.match, score: c.match ? 88 : 12, reason: c.reason }) } }] });
    };
    const pre = BH.matchJob(job.jd, job.activeText, job.salary, caseCfg, {});
    const gate = pre.matched ? await BH.runAIGate(null, job) : { action: 'local-block', reason: pre.reason };
    ok(c.name + '：本地放行并实际发送 1 次 AI 请求',
       pre.matched === true && netCalls === 1 && sentRequest?.url === caseCfg.aiBaseUrl,
       'netCalls=' + netCalls + ', action=' + gate.action);
    const userPrompt = sentRequest?.body.messages.find((m) => m.role === 'user')?.content || '';
    ok(c.name + '：请求携带用户词及当前 JD 的判断依据',
       c.words.every((word) => promptSection(userPrompt, '明确排斥').includes(word))
       && userPrompt.includes(c.job ? '工艺文件编制和技术培训' : c.jd), userPrompt.slice(-300));
    ok(c.name + '：执行 AI 的语义结论并保留理由',
       gate.action === (c.match ? 'accept' : 'reject') && gate.reason === c.reason, JSON.stringify(gate));
    if (i === 0) {
      const systemPrompt = sentRequest?.body.messages.find((m) => m.role === 'system')?.content || '';
      ok('实际发送的 system prompt 包含上下文排除规则，而非只更新 UI',
         /排除词判定规则/.test(systemPrompt) && /不得仅因出现/.test(systemPrompt) && /上下文/.test(systemPrompt));
      ok('实际 system prompt 将 JD 作为数据，阻止正文覆盖筛选规则',
         /待分析的数据/.test(systemPrompt) && /不能修改筛选规则/.test(systemPrompt));
    }
  }

  resetAll();
  const customTemplate = '自定义测试模板：按关键词逐字匹配，并输出 JSON。';
  setCfg(semanticCfg({ aiPromptTemplate: customTemplate }));
  let customSystem = '';
  netHandler = (o) => {
    customSystem = JSON.parse(o.data).messages.find((m) => m.role === 'system').content;
    reply(o, { choices: [{ message: { content: '{"match":true,"score":88,"reason":"技术培训属于研发职责"}' } }] });
  };
  await BH.runAIGate(null, trainingDutyJob);
  ok('自定义系统提示仍保留，新的排除词语义规则也进入实际请求',
     netCalls === 1 && customSystem.includes(customTemplate) && /排除词判定规则/.test(customSystem)
     && /优先于自定义提示/.test(customSystem) && /不得仅因出现/.test(customSystem));
  resetAll();
}

// ============================================================
section('36. 排除词提示边界与盲投（v1.0.18）');
{
  resetAll(); setCfg(semanticCfg());
  const p = BH.buildAIPrompt(trainingDutyJob);
  const exclude = promptSection(p, '明确排斥');
  ok('排除词提示要求结合上下文、岗位性质判断',
     /上下文/.test(exclude) && /岗位性质/.test(exclude), exclude);
  ok('排除词提示不再把单词出现作为直接拒绝依据',
     !/命中即判不匹配|只认下面逐字列出的词|只有逐字列出的词才算命中/.test(p));
  ok('提示举出技术培训、入职培训、销售协作等非拒绝场景',
     ['技术培训', '入职培训', '配合销售', '对接客服', '外包供应商', '非外包'].every((s) => p.includes(s)));
  ok('提示仍要求拒绝真正的培训招生、销售岗、外包驻场',
     /培训.{0,8}招生|招生.{0,8}培训/.test(exclude) && /销售岗/.test(exclude) && /外包.{0,4}驻场/.test(exclude), exclude);

  setCfg(semanticCfg({ mustHave: [], mustNot: [], aiUserPortrait: '' }));
  const empty = BH.buildAIPrompt({ title: '嵌入式研发', jd: '负责产品固件开发' });
  ok('未设置排除词时不自动补充默认禁词',
     !/培训|销售|客服|外包|驻场/.test(promptSection(empty, '明确排斥')), promptSection(empty, '明确排斥'));
  const noWords = BH.matchJob(trainingDutyJob.jd, trainingDutyJob.activeText, trainingDutyJob.salary, BH.state.config, {});
  ok('未设置排除词时不产生待判断的排除词命中', !noWords.details.mustNotHit);

  const modeCfg = semanticCfg({ mustHave: ['独特期望甲'], mustNot: ['稀有禁词乙', '培训'], aiUserPortrait: '' });
  setCfg(modeCfg);
  const normalPrompt = BH.buildAIPrompt(trainingDutyJob);
  ok('普通模式将用户的期望词和排除词送入 prompt',
     normalPrompt.includes('独特期望甲') && normalPrompt.includes('稀有禁词乙'));
  BH.state.skipKeywordCheck = true;
  const blindPrompt = BH.buildAIPrompt(trainingDutyJob);
  ok('盲投模式不把必含词和排除词悄悄交给 AI 继续筛选',
     !blindPrompt.includes('独特期望甲') && !blindPrompt.includes('稀有禁词乙')
     && !/^【明确排斥/m.test(blindPrompt) && !/^【期望关键词/m.test(blindPrompt));
  const blind = BH.matchJob(trainingDutyJob.jd, trainingDutyJob.activeText, trainingDutyJob.salary, modeCfg, {});
  ok('盲投模式也不在本地产生排除词拦截或 AI 委托标记',
     blind.matched === true && !blind.details.mustNotDeferredToAI && !blind.details.mustHaveDeferredToAI, JSON.stringify(blind));
  resetAll();
}

// ============================================================
section('37. 临时故障保留岗位，无配置按全部本地条件复核');
{
  const failures = [
    { name: '接口超时', handler: (o) => o.ontimeout() },
    { name: 'HTTP 401', handler: (o) => reply(o, { error: { message: 'invalid test key' } }, 401) },
    { name: '非 JSON 输出', handler: (o) => reply(o, { choices: [{ message: { content: '无法输出结果' } }] }) },
    { name: '缺少 API Key', config: { aiApiKey: '' } },
    { name: 'AI 次数已达上限', config: { aiDailyLimit: 0 } },
  ];
  for (const f of failures) {
    resetAll(); setCfg(semanticCfg({ mustNot: ['培训'], aiFallback: 'local', ...f.config }));
    netHandler = f.handler || (() => { throw new Error('这个失败场景不应联网'); });
    let settled = false;
    const pending = BH.runAIGate(null, trainingDutyJob).then((result) => { settled = true; return result; });
    if (f.name !== '缺少 API Key') {
      await waitForUI(() => BH.state._aiFailStreak >= 1, f.name + '进入自动等待');
      ok(f.name + '：没有真实 AI 结论时保留岗位等待，不降级跳过', !settled && !BH.state.paused);
      setCfg(semanticCfg({ mustNot: ['培训'], aiApiKey: '' }));
    }
    const g = await pending;
    ok(f.name + '：未配置 AI 后完整本地复核，技术培训职责可以通过',
       g.action === 'accept' && g.local === true && !g.degraded, JSON.stringify(g));
    if (f.config) ok(f.name + '：不发送无效请求', netCalls === 0, 'netCalls=' + netCalls);
  }

  resetAll(); setCfg(semanticCfg({ mustNot: ['培训', '外包|驻场'], aiApiKey: '' }));
  const noHit = await BH.runAIGate(null, { ...trainingDutyJob, jd: 'STM32 产品软件研发，负责 DSP 驱动及单元测试。', jobId: 'FALLBACK_NO_HIT' });
  ok('无 AI 且符合全部本地条件时可以放行',
     noHit.action === 'accept' && noHit.local === true && !noHit.degraded, JSON.stringify(noHit));
  const altHit = await BH.runAIGate(null, { ...trainingDutyJob, jd: '负责 STM32 驻场开发，服务客户的软件项目。', jobId: 'FALLBACK_ALT' });
  ok('无 AI 时保留词组中的 OR 匹配，不只检查首个排除词',
     altHit.action === 'skip' && altHit.local === true && /外包|驻场/.test(altHit.reason || ''), JSON.stringify(altHit));

  BH.state.skipKeywordCheck = true;
  const blind = await BH.runAIGate(null, trainingDutyJob);
  ok('无 AI 的本地规则也尊重跳过关键词开关',
     blind.action === 'accept' && blind.local === true, JSON.stringify(blind));

  resetAll(); setCfg(semanticCfg({ aiFallback: 'skip', aiApiKey: '' }));
  const skipNoKey = await BH.runAIGate(null, trainingDutyJob);
  ok('缺 Key 时忽略旧 skip 策略，符合本地条件便放行', skipNoKey.action === 'accept' && skipNoKey.local === true && netCalls === 0, JSON.stringify(skipNoKey));

  resetAll(); setCfg(semanticCfg({ aiFallback: 'pause', aiDailyLimit: 0 }));
  const waiting = BH.runAIGate(null, trainingDutyJob);
  await waitForUI(() => BH.state._aiFailStreak >= 1, '额度耗尽进入等待');
  ok('额度耗尽保留当前岗位，等待恢复且不发送请求', !BH.state.paused && netCalls === 0);
  BH.state.config.aiDailyLimit = 100;
  netHandler = (o) => reply(o, { choices: [{ message: { content: '{"match":true,"score":88,"reason":"技术培训是研发职责"}' } }] });
  BH.state.paused = false;
  const guard = setTimeout(() => { BH.state.stopFlag = true; BH.state.paused = false; }, 2000);
  const recovered = await waiting;
  clearTimeout(guard);
  ok('提高额度后重新请求 AI，沿用正常结论',
     recovered.action === 'accept' && recovered.reason === '技术培训是研发职责' && netCalls === 1, JSON.stringify(recovered));
  resetAll();
}

// ============================================================
section('38. 语义策略升级与盲投模式不得复用旧缓存（v1.0.18）');
{
  resetAll(); setCfg(semanticCfg({ aiCacheEnabled: true }));
  BH.setAICache(trainingDutyJob.jobId, { match: false, score: 0, reason: '命中排除词：培训' });
  const oldCache = JSON.parse(JSON.stringify(store.get('boss_helper_ai_cache_v1')));
  // 冻结的旧版缓存标记，模拟 v1.0.17 留下的拒绝结论。
  oldCache[trainingDutyJob.jobId].pf = 'v15|st0|sf1|培训,销售,客服,外包|驻场|32|年限 不限 · 学历 不限 · 薪资 不限 · 活跃度 7 天内活跃';
  store.set('boss_helper_ai_cache_v1', oldCache);
  ok('v15 缓存即使未过期也失效，避免升级后继续用旧误判', BH.getAICache(trainingDutyJob.jobId) === null);
  netHandler = (o) => reply(o, { choices: [{ message: { content: '{"match":true,"score":88,"reason":"技术培训属于研发职责"}' } }] });
  const upgraded = await BH.runAIGate(null, trainingDutyJob);
  ok('升级后的同一岗位实际重新请求 AI，并替换旧拒绝结论',
     upgraded.action === 'accept' && !upgraded.cached && netCalls === 1
     && BH.getAICache(trainingDutyJob.jobId)?.match === true, JSON.stringify(upgraded));

  resetAll(); setCfg(semanticCfg({ aiCacheEnabled: true }));
  let match = false;
  const prompts = [];
  netHandler = (o) => {
    prompts.push(JSON.parse(o.data).messages.find((m) => m.role === 'user').content);
    reply(o, { choices: [{ message: { content: JSON.stringify({ match, score: match ? 80 : 10, reason: match ? '通过' : '拒绝' }) } }] });
  };
  const normal = await BH.runAIGate(null, trainingDutyJob);
  ok('普通模式缓存 AI 的结论', normal.action === 'reject' && BH.getAICache(trainingDutyJob.jobId)?.match === false);
  BH.state.skipKeywordCheck = true;
  ok('开启盲投后普通模式的缓存不能复用', BH.getAICache(trainingDutyJob.jobId) === null);
  match = true;
  const blind = await BH.runAIGate(null, trainingDutyJob);
  ok('开启盲投会重新发送不含关键词规则的请求',
     blind.action === 'accept' && !blind.cached && netCalls === 2 && !/^【明确排斥/m.test(prompts[1] || ''), JSON.stringify(blind));
  BH.state.skipKeywordCheck = false;
  ok('关闭盲投后盲投模式的缓存也不能复用', BH.getAICache(trainingDutyJob.jobId) === null);
  match = false;
  const normalAgain = await BH.runAIGate(null, trainingDutyJob);
  ok('关闭盲投会重新按用户排除词请求 AI',
     normalAgain.action === 'reject' && !normalAgain.cached && netCalls === 3 && /^【明确排斥/m.test(prompts[2] || ''), JSON.stringify(normalAgain));
  resetAll();
}

// ============================================================
section('39. JD 清洗保留语义并在截断前去重（v1.0.18）');
{
  resetAll(); setCfg(semanticCfg());
  const clean = BH.cleanJDText(trainingDutyJob.jd);
  ok('重复采集的完整第 7 条技术培训职责只保留一份',
     (clean.match(/负责工艺文件编制和技术培训/g) || []).length === 1);
  ok('清洗去掉独立的网页按钮文本',
     !clean.split('\n').some((line) => ['举报', '收藏', '立即沟通', '微信扫码分享', '点击查看地图', '查看更多信息'].includes(line)));

  const importantLines = [
    '负责消息队列设计、日志搜索、推荐算法以及简历解析模块开发。',
    '岗位为公司直招，非外包，不需要销售，不收取培训费。',
    '入职条件：要求求职者先缴纳培训费用，完成付费培训后才可以上岗。',
  ];
  const core = BH.cleanJDText(['举报', ...importantLines, '去App', '前往App'].join('\n'));
  ok('消息队列、日志搜索、推荐算法、简历解析不会因网页噪音词被删坏', core.includes(importantLines[0]), core);
  ok('否定销售/外包/收费的完整语句原样保留', core.includes(importantLines[1]), core);
  ok('真正要求付费培训的招聘条件也原样保留', core.includes(importantLines[2]), core);
  ok('短行的否定上下文不因去重被拆散',
     BH.cleanJDText('不要求\n销售\n不要求\n培训') === '不要求\n销售\n不要求\n培训');

  const repeatedLine = '负责 STM32、DSP 底层驱动开发与生产调试，完成软件质量验证。';
  const tail = '额外招聘条件：入职前必须缴纳培训费并签署培训贷款协议。';
  const raw = Array(35).fill(repeatedLine).concat(tail).join('\n');
  setCfg(semanticCfg({ aiMaxJDChars: 240 }));
  const p = BH.buildAIPrompt({ ...trainingDutyJob, jd: raw });
  const jobInfo = promptSection(p, '职位信息');
  ok('长 JD 先去重再截断，尾部的真实排除依据不会被前段重复挤出',
     raw.length > 240 && jobInfo.includes(tail) && (jobInfo.match(/负责 STM32、DSP 底层驱动开发/g) || []).length === 1,
     jobInfo);
  resetAll();
}

// ============================================================
section('40. AI 请求进行中切换盲投：旧结果不污染当前模式（v1.0.18）');
{
  for (const startedBlind of [true, false]) {
    resetAll(); setCfg(semanticCfg({ aiCacheEnabled: true }));
    BH.state.skipKeywordCheck = startedBlind;
    let heldRequest;
    let arrived;
    const requestArrived = new Promise((resolve) => { arrived = resolve; });
    netHandler = (o) => { heldRequest = o; arrived(); };
    const pending = BH.aiScreen({ ...trainingDutyJob, jobId: 'SCREEN_RACE_' + startedBlind });
    await requestArrived;
    const sent = JSON.parse(heldRequest.data).messages.find((m) => m.role === 'user').content;
    ok((startedBlind ? '盲投→正常' : '正常→盲投') + '：请求包含发起时模式的关键词规则',
       /^【明确排斥/m.test(sent) === !startedBlind);
    BH.state.skipKeywordCheck = !startedBlind;
    reply(heldRequest, { choices: [{ message: { content: JSON.stringify({ match: startedBlind, score: 80, reason: '旧模式结论' }) } }] });
    const changed = await pending;
    ok((startedBlind ? '盲投→正常' : '正常→盲投') + '：aiScreen 明确标记过期结论',
       changed.ok === false && changed.policyChanged === true, JSON.stringify(changed));
    ok((startedBlind ? '盲投→正常' : '正常→盲投') + '：旧结论不写入任何模式缓存', BH.aiCacheSize() === 0);
    ok((startedBlind ? '盲投→正常' : '正常→盲投') + '：已完成的 API 请求仍正确计数',
       netCalls === 1 && BH.loadStats().aiCalls === 1, 'calls=' + BH.loadStats().aiCalls);
  }

  resetAll(); setCfg(semanticCfg({ aiCacheEnabled: true, aiFallback: 'local' }));
  BH.state.skipKeywordCheck = true;
  const job = { ...trainingDutyJob, jd: '本岗位负责培训招生，要求求职者先缴纳培训费用。', jobId: 'GATE_MODE_RACE' };
  let firstRequest;
  let firstArrived;
  const firstArrivedPromise = new Promise((resolve) => { firstArrived = resolve; });
  const sentPrompts = [];
  netHandler = (o) => {
    sentPrompts.push(JSON.parse(o.data).messages.find((m) => m.role === 'user').content);
    if (sentPrompts.length === 1) {
      firstRequest = o;
      firstArrived();
      return;
    }
    reply(o, { choices: [{ message: { content: '{"match":false,"score":10,"reason":"明确为培训招生并要求先缴费"}' } }] });
  };
  const gatePending = BH.runAIGate(null, job);
  await firstArrivedPromise;
  BH.state.skipKeywordCheck = false;
  reply(firstRequest, { choices: [{ message: { content: '{"match":true,"score":88,"reason":"旧盲投模式通过"}' } }] });
  const gate = await gatePending;
  ok('请求等待中关闭盲投，旧的 true 不会直接放行',
     gate.action === 'reject' && gate.reason === '明确为培训招生并要求先缴费', JSON.stringify(gate));
  ok('runAIGate 重新发送包含当前排除词的请求',
     netCalls === 2 && sentPrompts.length === 2
     && !/^【明确排斥/m.test(sentPrompts[0]) && /^【明确排斥/m.test(sentPrompts[1] || ''));
  ok('模式变化不会计为 AI 失败或触发 local 降级',
     !gate.degraded && BH.state._aiFailStreak === 0 && !BH.state.paused);
  ok('两次已完成的 AI 请求均计数，仅新模式结论进入缓存',
     BH.loadStats().aiCalls === 2 && BH.getAICache(job.jobId)?.match === false,
     'calls=' + BH.loadStats().aiCalls);
  BH.state.skipKeywordCheck = true;
  ok('竞态完成后，新正常模式缓存也不能被盲投复用', BH.getAICache(job.jobId) === null);
  resetAll();
}

// ============================================================
section('41. 长 JD 优先保留全部排除上下文，证据超预算时不得放行（v1.0.18）');
{
  const longResearch = Array.from({ length: 30 }, (_, i) =>
    `研发条目${i + 1}：编写芯片驱动程序、完成接口调试并整理硬件设计文档。`).join('\n');
  const fee = '额外招聘条件：入职前必须缴纳培训费8000元，完成培训后才能上岗。';
  const ordinaryTraining = '负责技术培训，对生产人员讲解设备调试步骤。';
  const contract = '合同性质：外包驻场，与第三方公司签订合同。';
  const sales = '岗位职责补充：主要承担销售签单指标，按成交业绩提成。';
  const cases = [
    { name: '长研发前段后的收费条款', words: ['培训'],
      jd: [longResearch, '招聘补充说明', fee].join('\n'), required: [fee] },
    { name: '首段正常技术培训和尾段真实收费', words: ['培训'],
      jd: ['正常研发职责', ordinaryTraining, '指导生产人员。', longResearch, '招聘补充说明', fee].join('\n'),
      required: [ordinaryTraining, fee] },
    { name: '末尾多个排除词的证据', words: ['培训', '销售', '外包|驻场'],
      jd: [longResearch, '招聘补充说明', contract, sales, fee].join('\n'), required: [contract, sales, fee] },
    { name: '否定语句与其后的岗位事实一起保留', words: ['外包'],
      jd: [longResearch, '本岗位', '并非外包，劳动合同由本公司直接签订。', '属于正式研发团队。'].join('\n'),
      required: ['本岗位', '并非外包，劳动合同由本公司直接签订。', '属于正式研发团队。'] },
  ];
  for (const [i, c] of cases.entries()) {
    resetAll();
    const cfg = semanticCfg({ aiMaxJDChars: 200, mustNot: c.words });
    setCfg(cfg);
    const prepared = BH.prepareAIJDText(c.jd, cfg);
    ok(c.name + '：压缩后仍保留完整相关句子',
       !prepared.error && c.required.every((line) => prepared.text.includes(line)), JSON.stringify(prepared));
    let sentJobInfo = '';
    netHandler = (o) => {
      const p = JSON.parse(o.data).messages.find((m) => m.role === 'user').content;
      sentJobInfo = promptSection(p, '职位信息');
      reply(o, { choices: [{ message: { content: '{"match":false,"score":10,"reason":"依据完整职位信息判断"}' } }] });
    };
    const g = await BH.runAIGate(null, { ...trainingDutyJob, jd: c.jd, jobId: 'LONG_EVIDENCE_' + i });
    ok(c.name + '：实际 API 请求获得完整排除上下文',
       netCalls === 1 && c.required.every((line) => sentJobInfo.includes(line)), sentJobInfo);
    ok(c.name + '：仍由 AI 判断，未用提前字面拦截代替', g.action === 'reject' && !g.degraded, JSON.stringify(g));
  }

  resetAll();
  const cfg = semanticCfg({ aiMaxJDChars: 200, mustNot: ['培训'] });
  setCfg(cfg);
  const short = '负责STM32驱动开发和技术培训，对生产人员进行产品调试指导。';
  const shortPrepared = BH.prepareAIJDText(short, cfg);
  ok('预算内的短 JD 不被改写或丢失职责', !shortPrepared.error && shortPrepared.text === short, JSON.stringify(shortPrepared));

  const overBudget = '完整招聘条件：' + '所有招聘和培训条件须结合整个条款理解，不能只看句尾。'.repeat(18) + fee;
  const incomplete = BH.prepareAIJDText(overBudget, cfg);
  ok('单条排除上下文本身超出预算时明确报告无法完整输入',
     !!incomplete.error && /上下文|预算|超过/.test(incomplete.error), JSON.stringify(incomplete));
  netHandler = () => { throw new Error('证据无法完整送入时不得调用 API'); };
  const screened = await BH.aiScreen({ ...trainingDutyJob, jd: overBudget, jobId: 'TOO_LONG_EVIDENCE' });
  ok('aiScreen 把证据超预算标记为 inputIncomplete 且不请求 API',
     screened.ok === false && screened.inputIncomplete === true && netCalls === 0, JSON.stringify(screened));

  for (const fallback of ['local', 'skip', 'pause']) {
    resetAll(); setCfg(semanticCfg({ aiMaxJDChars: 200, mustNot: ['培训'], aiFallback: fallback }));
    netHandler = () => { throw new Error('证据超预算不应联网'); };
    const guard = setTimeout(() => { BH.state.stopFlag = true; BH.state.paused = false; }, 2000);
    const g = await BH.runAIGate(null, { ...trainingDutyJob, jd: overBudget, jobId: 'TOO_LONG_' + fallback });
    clearTimeout(guard);
    ok('证据超预算 + ' + fallback + ' 策略：直接跳过且说明原因',
       g.action === 'skip' && /上下文/.test(g.reason || '') && /预算|超过|过长|上限/.test(g.reason || '')
       && !g.degraded && !BH.state.paused && netCalls === 0, JSON.stringify(g));
  }
  resetAll();
}

// ============================================================
section('42. 响应等待或暂停期间切换离线，使用最新规则');
{
  for (const addExclusion of [true, false]) {
    resetAll();
    setCfg(semanticCfg({ mustNot: addExclusion ? [] : ['培训'], aiFallback: 'local' }));
    let heldRequest;
    let arrived;
    const arrival = new Promise((resolve) => { arrived = resolve; });
    netHandler = (o) => { heldRequest = o; arrived(); };
    const chargeJob = { ...trainingDutyJob, jd: '负责 STM32 控制固件开发，入职前需缴纳培训费。' };
    const pending = BH.runAIGate(null, chargeJob);
    await waitForUI(() => heldRequest, '等待响应修改规则用例发出 AI 请求');
    // 保存设置会替换 state.config 对象，不只修改旧对象的属性。
    setCfg(semanticCfg({ mustNot: addExclusion ? ['培训'] : [], aiFallback: 'local', aiApiKey: '' }));
    heldRequest.ontimeout();
    const g = await pending;
    ok('等待失败响应时' + (addExclusion ? '新增' : '删除') + '排除词并切离线，复核采用新值',
       g.action === (addExclusion ? 'skip' : 'accept') && g.local === true
       && (!addExclusion || /培训/.test(g.reason || '')), JSON.stringify(g));
  }

  resetAll(); setCfg(semanticCfg({ mustNot: [], aiFallback: 'pause', aiApiKey: '' }));
  BH.state.paused = true;
  const waiting = BH.runAIGate(null, { ...trainingDutyJob, jd: '负责 STM32 驱动开发，需先缴培训费。' });
  await new Promise((r) => setTimeout(r, 120));
  ok('暂停期间修改规则用例进入等待状态', BH.state.paused === true);
  setCfg(semanticCfg({ mustNot: ['培训'], aiFallback: 'local', aiApiKey: '' }));
  BH.state.paused = false;
  const guard = setTimeout(() => { BH.state.stopFlag = true; BH.state.paused = false; }, 2000);
  const g = await waiting;
  clearTimeout(guard);
  ok('暂停后新增排除词，恢复时采用新本地规则',
     g.action === 'skip' && g.local === true && /培训/.test(g.reason || '') && !BH.state.paused, JSON.stringify(g));
  resetAll();
}

// ============================================================
section('43. 关闭自动短期过滤仍保留用户明确排除项（v1.0.18）');
{
  for (const word of ['兼职', '项目制', '劳务派遣']) {
    resetAll(); setCfg(semanticCfg({ mustNot: [word], aiRejectShortTerm: false }));
    const job = { ...trainingDutyJob, jd: '本岗位性质明确为' + word + '，负责嵌入式固件开发。', jobId: 'EXPLICIT_TERM_' + word };
    let sentPrompt = '';
    netHandler = (o) => {
      sentPrompt = JSON.parse(o.data).messages.find((m) => m.role === 'user').content;
      reply(o, { choices: [{ message: { content: JSON.stringify({ match: false, score: 10, reason: '用户已明确排除' + word }) } }] });
    };
    const g = await BH.runAIGate(null, job);
    const preference = promptSection(sentPrompt, '投递偏好');
    ok('自动短期关 + 明确排除' + word + '：请求仍传达该排除项有效',
       netCalls === 1 && promptSection(sentPrompt, '明确排斥').includes(word)
       && /明确排斥/.test(preference) && /仍|优先|不取消|不覆盖/.test(preference), preference);
    ok('自动短期关 + 明确排除' + word + '：没有相反的一律忽略指令',
       !/岗位形式[^\n]*一律不作为判断依据|只按岗位方向是否匹配/.test(preference)
       && preference.split('\n').filter((line) => /岗位形式|计薪方式/.test(line) && /忽略|不作为/.test(line))
         .every((line) => /未列入|未明确排除|没有明确排除/.test(line)), preference);
    ok('自动短期关 + 明确排除' + word + '：正确执行 AI 拒绝结论', g.action === 'reject' && !g.degraded, JSON.stringify(g));
  }
  resetAll(); setCfg(semanticCfg({ mustNot: [], aiRejectShortTerm: false }));
  const p = BH.buildAIPrompt({ ...trainingDutyJob, jd: '兼职研发岗位，按天计薪。' });
  ok('未设明确排除词时，短期开关关闭不会自动新增兼职排除',
     !/^【明确排斥/m.test(p) && !/投递偏好（硬性，命中即判 false）/.test(p));
  resetAll();
}

// ============================================================
section('44. 薪资单位与小数按月薪准确换算（v1.0.19）');
{
  const cases = [
    ['8-13K', 8], ['8.5-13.5K', 8.5], ['8.5K·13薪', 8.5],
    ['0.8-1.3万/月', 8], ['1.5万/月', 15],
    ['8000-13000元/月', 8], ['8500元/月', 8.5],
    ['20-30万/年', null], ['251-311元/天', null], ['100元/小时', null],
    ['8K/周', null], ['面议', null], ['\uE039-\uE032\uE034K', null], ['', null], [null, null],
  ];
  for (const [value, expected] of cases) {
    ok('parseSalaryK(' + JSON.stringify(value) + ') → ' + expected,
       BH.parseSalaryK(value) === expected, String(BH.parseSalaryK(value)));
  }
}

// ============================================================
section('45. 缓存绑定完整职位输入和实际 AI 判断策略（v1.0.19）');
{
  const baseJob = {
    ...trainingDutyJob, jobId: 'FULL_INPUT_CACHE', jd: '负责 STM32 固件开发与单元测试。',
    salary: '20-30K', experience: '3-5年', education: '本科',
  };
  const positiveReply = (o) => reply(o, { choices: [{ message: { content: '{"match":true,"score":88,"reason":"输入匹配"}' } }] });
  resetAll(); setCfg(semanticCfg({ aiCacheEnabled: true }));
  netHandler = positiveReply;
  await BH.aiScreen(baseJob);
  const same = await BH.aiScreen({ ...baseJob });
  ok('同一职位全部输入相同时使用缓存，不增加 API 次数',
     same.cached === true && netCalls === 1 && BH.loadStats().aiCalls === 1, JSON.stringify(same));

  for (const [field, value] of [
    ['jd', '当前岗位改为培训招生，入职前要求缴费。'],
    ['salary', '8-13K'], ['experience', '5-10年'], ['education', '硕士'],
    ['title', 'DSP 软件工程师'], ['company', '另一家研发公司'], ['activeText', '3天前活跃'],
  ]) {
    resetAll(); setCfg(semanticCfg({ aiCacheEnabled: true })); netHandler = positiveReply;
    await BH.aiScreen(baseJob);
    const changed = await BH.aiScreen({ ...baseJob, [field]: value });
    ok('同一 jobId 的 ' + field + ' 改变后重新判断，不复用旧结论',
       changed.ok === true && changed.cached === false && netCalls === 2, JSON.stringify(changed));
  }

  const baseConfig = semanticCfg({ aiCacheEnabled: true, aiUserPortrait: '方向甲', aiPromptTemplate: '按方向甲判断' });
  for (const [field, value] of [
    ['aiUserPortrait', '方向乙'], ['mustHave', ['FPGA']],
    ['aiModel', 'another-test-model'], ['aiBaseUrl', 'https://different-api.example.com/v1/chat/completions'],
    ['aiPromptTemplate', '按方向乙判断'], ['aiTemperature', 0.8],
  ]) {
    resetAll(); setCfg(baseConfig); netHandler = positiveReply;
    await BH.aiScreen(baseJob);
    setCfg({ ...baseConfig, [field]: value });
    const changed = await BH.aiScreen(baseJob);
    ok('改变 ' + field + ' 后重新调用 AI（含等长文字变更）',
       changed.ok === true && changed.cached === false && netCalls === 2, JSON.stringify(changed));
  }

  resetAll(); setCfg(baseConfig); netHandler = positiveReply;
  BH.setAICache(baseJob.jobId, { match: false, score: 0, reason: '缺少职位指纹的旧缓存' });
  const old = await BH.aiScreen(baseJob);
  ok('旧缓存只有 jobId/策略、没有完整职位指纹时不得供 aiScreen 使用',
     old.ok === true && old.cached === false && netCalls === 1, JSON.stringify(old));
  resetAll();
}

// ============================================================
section('46. 等长画像与外部职位对象修改不污染在途请求缓存（v1.0.19）');
{
  resetAll(); setCfg(semanticCfg({ aiCacheEnabled: true, aiUserPortrait: '方向甲' }));
  let held;
  let arrived;
  const arrival = new Promise((resolve) => { arrived = resolve; });
  netHandler = (o) => { held = o; arrived(); };
  const pending = BH.aiScreen(trainingDutyJob);
  await arrival;
  setCfg(semanticCfg({ aiCacheEnabled: true, aiUserPortrait: '方向乙' }));
  reply(held, { choices: [{ message: { content: '{"match":true,"score":88,"reason":"旧画像通过"}' } }] });
  const changed = await pending;
  ok('在途请求期间画像改成等长文字，旧结果仍会作废',
     changed.ok === false && changed.policyChanged === true && BH.aiCacheSize() === 0, JSON.stringify(changed));

  resetAll(); setCfg(semanticCfg({ aiCacheEnabled: true }));
  const mutableJob = { ...trainingDutyJob, jobId: 'MUTABLE_JOB_INPUT', jd: '原岗位负责嵌入式研发。', salary: '20-30K' };
  let first;
  let firstArrived;
  const firstArrival = new Promise((resolve) => { firstArrived = resolve; });
  const sentPrompts = [];
  netHandler = (o) => {
    sentPrompts.push(JSON.parse(o.data).messages.find((m) => m.role === 'user').content);
    if (sentPrompts.length === 1) { first = o; firstArrived(); return; }
    reply(o, { choices: [{ message: { content: '{"match":false,"score":10,"reason":"新岗位为培训招生"}' } }] });
  };
  const firstResult = BH.aiScreen(mutableJob);
  await firstArrival;
  mutableJob.jd = '新岗位负责培训招生，要求求职者付费。';
  mutableJob.salary = '3-5K';
  reply(first, { choices: [{ message: { content: '{"match":true,"score":88,"reason":"原岗位研发匹配"}' } }] });
  await firstResult;
  const current = await BH.aiScreen(mutableJob);
  ok('外部在请求中修改 job 对象，原岗位结果不会错写成新岗位的缓存',
     current.ok === true && current.match === false && current.cached === false && netCalls === 2,
     JSON.stringify(current));
  ok('两次请求分别使用各自发起时的职位文本和工资',
     sentPrompts[0].includes('原岗位负责嵌入式研发。') && sentPrompts[0].includes('20-30K')
     && sentPrompts[1].includes(mutableJob.jd) && sentPrompts[1].includes('3-5K'));
  resetAll();
}

// ============================================================
section('47. 年限和学历优先采用结构字段，正文兜底排除公司与团队噪音（v1.0.19）');
{
  resetAll();
  const hard = (over = {}) => CFG({
    aiEnabled: false, mustHave: [], mustNot: [], activeDays: 0, salaryMin: 0,
    yearsMin: 3, eduMin: 0, ...over,
  });
  for (const jd of [
    '劳动合同期限1年，负责嵌入式开发。',
    '试用期1年，项目周期2年，负责设备维护。',
    '团队平均3年经验，负责固件研发。',
    '团队成员工作经验为10年，公司拥有20年行业经验。',
  ]) {
    const r = BH.matchJob(jd, '', '', hard({ yearsMin: 5 }), {});
    ok('合同/周期/团队描述不当作求职者经验：' + jd,
       r.matched === true && r.details.foundYears?.length === 0, JSON.stringify(r));
  }
  const founded = BH.matchJob('要求1-3年开发经验，公司成立于1998年。', '', '', hard({ yearsMin: 4 }), {});
  ok('成立年份不扩大经验范围，1-3年仍按最大3年判断',
     founded.matched === false && Math.max(...founded.details.foundYears) === 3
     && !founded.details.foundYears.includes(1998), JSON.stringify(founded));
  const companyRequires = BH.matchJob('公司要求3年相关工作经验，负责设备驱动研发。', '', '', hard(), {});
  ok('公司提出的求职经验要求仍可识别',
     companyRequires.matched === true && Math.max(...companyRequires.details.foundYears) === 3, JSON.stringify(companyRequires));

  const diploma = BH.matchJob('要求大专学历，加入博士团队参与研发。', '', '', hard({ yearsMin: 0, eduMin: 2 }), {});
  ok('要求大专加博士团队仍识别为大专，不抬高招聘学历',
     diploma.matched === false && diploma.details.foundEdu === 1, JSON.stringify(diploma));
  const teamOnly = BH.matchJob('团队有博士带队，负责固件开发。', '', '', hard({ yearsMin: 0, eduMin: 2 }), {});
  ok('只有博士团队介绍时学历要求为未知，不误作硬性门槛',
     teamOnly.matched === true && !teamOnly.details.foundEdu, JSON.stringify(teamOnly));
  const degreeRequired = BH.matchJob('任职要求本科。公司团队学历为博士。', '', '', hard({ yearsMin: 0, eduMin: 3 }), {});
  ok('学历要求与公司团队学历分开，明确本科不被博士介绍覆盖',
     degreeRequired.matched === false && degreeRequired.details.foundEdu === 2, JSON.stringify(degreeRequired));

  const noisy = '公司成立于1998年，团队平均20年经验，博士团队带队。';
  const facts = { experience: '3-5年', education: '本科' };
  const factsYears = BH.matchJob(noisy, '', '', hard({ yearsMin: 6 }), {}, facts);
  ok('结构化3-5年优先于正文噪音，仍低于6年门槛',
     factsYears.matched === false && Math.max(...factsYears.details.foundYears) === 5, JSON.stringify(factsYears));
  const factsEducation = BH.matchJob(noisy, '', '', hard({ yearsMin: 0, eduMin: 3 }), {}, facts);
  ok('结构化本科优先于正文的博士团队介绍',
     factsEducation.matched === false && factsEducation.details.foundEdu === 2, JSON.stringify(factsEducation));

  const bare = BH.matchJob('3-5年\n本科', '', '', hard({ eduMin: 2 }), {});
  ok('独立年限/学历标签仍能识别',
     bare.matched === true && Math.max(...bare.details.foundYears) === 5 && bare.details.foundEdu === 2, JSON.stringify(bare));
  const legacy = BH.matchJob('1年，stm32', '', '', hard(), {});
  ok('旧格式“1年，stm32”保留原有筛选行为',
     legacy.matched === false && Math.max(...legacy.details.foundYears) === 1, JSON.stringify(legacy));
  resetAll();
}

// ============================================================
section('48. 开启 AI 不再因学历/工作经验拒投：只认求职画像写明的条件（v1.0.20）');
{
  resetAll();
  // 复现用户截图（2026-10-13）：
  //   卡片1「嵌入式软件工程师（北京算力大陆科技）」JD 任职要求明确标注"硕士及以上" → AI 不匹配
  //   卡片2「嵌入式软件开发（智联安 3-5年 本科）」JD 要求3年以上嵌入式经验，求职者为应届 → AI 不匹配
  // 用户当前画像就是应届生，且没有写任何学历/经验筛选条件；「规则设置」里仍留着 年限3/学历本科。
  const portrait = '嵌入式软件应届生，熟悉 STM32、FreeRTOS，有 FOC 电机控制项目经验，寻找与 MCU 嵌入式软件开发岗位及单片机开发相关开发工作，嵌入式软件相关工作。';
  const cfg = {
    ...BH.loadConfig(), aiEnabled: true, aiStrictFacts: true,
    yearsMin: 3, eduMin: 2, salaryMin: 0, activeDays: 7,
    aiUserPortrait: portrait,
  };

  // 48a. profileEduExpPolicy：身份描述不算条件，筛选条件才算
  const pe = BH.profileEduExpPolicy(cfg);
  ok('画像只有身份描述（应届生/有FOC项目经验）→ 学历经验都不是判断依据',
     pe.hasEdu === false && pe.hasExp === false && pe.text === '不作为判断依据', JSON.stringify(pe));
  const pe2 = BH.profileEduExpPolicy({ ...cfg, aiUserPortrait: '只投硕士以下，工作经历3年' });
  ok('画像写明「只投硕士以下，工作经历3年」→ 两条都成为唯一依据',
     pe2.hasEdu === true && pe2.hasExp === true
     && pe2.edu[0] === '只投硕士以下' && pe2.exp[0] === '工作经历3年', JSON.stringify(pe2));
  const pe3 = BH.profileEduExpPolicy({ ...cfg, aiUserPortrait: '本科及以上学历，3年以上经验' });
  ok('「本科及以上学历，3年以上经验」→ 同样识别为条件', pe3.hasEdu === true && pe3.hasExp === true, JSON.stringify(pe3));
  const pe4 = BH.profileEduExpPolicy({ ...cfg, aiUserPortrait: '5年嵌入式软件工程师，精通 STM32' });
  ok('「5年嵌入式软件工程师」是身份不是条件 → 不触发', pe4.hasExp === false, JSON.stringify(pe4));
  const pe5 = BH.profileEduExpPolicy({ ...cfg, aiUserPortrait: '学历不限，经验不限' });
  ok('「学历不限，经验不限」→ 明确无要求，不触发', pe5.hasEdu === false && pe5.hasExp === false, JSON.stringify(pe5));

  // 48b. 用户截图场景：即使「规则设置」设了 年限3/学历本科，prompt 也不拿它们说事
  setCfg(cfg);
  const job = {
    title: '嵌入式软件开发', company: '智联安', salary: '15-25K',
    experience: '3-5年', education: '本科', activeText: '今日活跃',
    jd: '岗位职责：嵌入式软件开发，电机控制算法实现。\n任职要求：3年以上嵌入式开发经验，硕士及以上学历，熟悉 STM32。',
    jobId: 'J48',
  };
  const p = BH.buildAIPrompt(job);
  ok('prompt 不再教模型"JD 明确要求更高可判不匹配"', !/JD 明确要求高于/.test(p));
  ok('prompt 不再出现"3 年及以上"这类年限标准', !p.includes('3 年及以上'));
  ok('学历/年限行写明不作为判断依据', /- 学历：不作为判断依据/.test(p) && /- 年限：不作为判断依据/.test(p));
  ok('判断依据明写"学历与工作年限一律不作为判断依据"且点名两条拒投路径',
     /学历与工作年限一律不作为判断依据/.test(p)
     && /不得因 JD 写明的学历或经验要求判 false/.test(p)
     && /也不要拿【求职者画像】里的学历或身份描述与 JD 的要求硬碰/.test(p));
  ok('无画像条件时不送 经验要求/学历要求 字段行',
     !p.includes('经验要求（当前岗位字段）') && !p.includes('学历要求（当前岗位字段）'));
  ok('没有"画像中的学历/经验条件"块（画像没写）', !/画像中的学历\/经验条件/.test(p));
  ok('JD 正文原样送入（方向判断不受影响）', p.includes('任职要求：3年以上嵌入式开发经验'));

  // 48c. 画像写明条件时：封闭条件块 + 字段行才出现
  setCfg({ ...cfg, aiUserPortrait: '只投硕士以下，工作经历3年' });
  const p2 = BH.buildAIPrompt(job);
  const blk = p2.indexOf('【画像中的学历/经验条件（唯一可用的学历与经验判断依据）】');
  ok('出现「画像中的学历/经验条件」封闭块，且只列画像写明的两条',
     blk > 0 && p2.indexOf('- 学历：只投硕士以下') > blk && p2.indexOf('- 经验：工作经历3年') > blk);
  ok('条件块注明"除以上列出的外一律不作为判断依据"', /除以上逐条列出的外，学历与工作经验的其他信息一律不作为判断依据/.test(p2));
  ok('有条件时才送 学历要求/经验要求 字段行',
     p2.includes('学历要求（当前岗位字段）：本科') && p2.includes('经验要求（当前岗位字段）：3-5年'));
  ok('SYSTEM_PROMPT 维度 2 改为 薪资/活跃度 + 画像写明的学历/经验条件',
     /薪资 \/ 活跃度，以及【求职者画像】中明确写出的学历 \/ 经验条件/.test(BH.SYSTEM_PROMPT));
  ok('SYSTEM_PROMPT 特别注意"学历与工作年限默认不作为判断依据"',
     /学历与工作年限默认不作为判断依据/.test(BH.SYSTEM_PROMPT));

  // 48d. 端到端：桩模型放行 → accept；真正发出去的 prompt 里没有任何学历/年限排斥依据
  resetAll();
  setCfg({ ...cfg, aiApiKey: 'sk-testkey-1234567890', aiBaseUrl: 'https://api.example.com/v1/chat/completions',
    aiModel: 'gpt-4o-mini', aiDailyLimit: 100, aiMaxJDChars: 2500, aiCacheEnabled: true, aiCacheDays: 7, aiFallback: 'local' });
  let sentPrompt = '';
  netHandler = (o) => {
    try { sentPrompt = JSON.parse(o.data).messages.map((m) => m.content).join('\n'); } catch (_) {}
    reply(o, { choices: [{ message: { content: '{"match":true,"score":90,"reason":"嵌入式方向匹配"}' } }] });
  };
  const r = await BH.aiScreen(job);
  ok('端到端：本地不拦（学历/年限不硬卡）+ AI 放行 → accept',
     r.ok === true && r.match === true, JSON.stringify(r));
  ok('真正发给模型的 prompt 里学历/年限只以"不作为判断依据"出现',
     /- 学历：不作为判断依据/.test(sentPrompt) && !/JD 明确要求高于/.test(sentPrompt)
     && !/经验要求（当前岗位字段）/.test(sentPrompt), sentPrompt.slice(0, 200));

  // 48e. 缓存指纹：v1.0.20 的 prompt 结构变化必须让旧结论失效
  ok('缓存指纹升级到 v114（v21 及更早结论自动失效）',
     /^v114\|/.test(BH.aiCacheFingerprint(cfg)), BH.aiCacheFingerprint(cfg).slice(0, 10));
  ok('指纹随画像变化（写不写学历/经验条件直接影响结论）',
     BH.aiCacheFingerprint({ ...cfg, aiUserPortrait: '只投硕士以下' }) !== BH.aiCacheFingerprint(cfg));

  // 48f. UI 文案与行为一致（不能再宣称"年限/学历/薪资 按规则设置交给 AI"）
  const docG = win.document;
  const pG = docG.getElementById('boss-helper-panel');
  docG.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());
  setCfg(cfg);
  pG.querySelector('[data-act="aiopen"]').click();
  const modal = docG.getElementById('bh-ai-modal');
  ok('AI 总开关说明写明"学历与工作年限默认不作为筛选条件"',
     /学历与工作年限默认不作为筛选条件/.test(modal.textContent));
  ok('AI 总开关说明仍写明活跃度本地硬卡', /活跃度仍本地硬卡/.test(modal.textContent));
  const note = (docG.getElementById('bh-ai-criteria') || {}).textContent || '';
  ok('提醒卡说明薪资取自规则设置、学历/年限只看求职画像',
     /求职画像/.test(note) && /规则设置/.test(note), note.slice(0, 160));
  ok('提醒卡列出 4 项且学历/年限显示"不作为判断依据"', (() => {
    const items = [...docG.querySelectorAll('#bh-ai-criteria-list .bh-ai-criteria-item')];
    const txt = items.map((el) => el.textContent).join('|');
    return items.length === 4 && (txt.match(/不作为判断依据/g) || []).length === 2 && txt.includes('7 天内活跃');
  })(), note.slice(0, 160));
  modal.querySelector('[data-act="aiclose"]')?.click();
  docG.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());
  resetAll();
}

// ============================================================
section('49. 岗位方向匹配以求职画像为核心依据：修大类岗位被误投（v1.0.21）');
{
  // 复现用户截图（2026-10-13）：
  //   画像：嵌入式软件应届生…寻找 MCU 嵌入式/单片机开发工作
  //   岗位：【华为2026秋招】软件开发/算法/AI 大类（八个并列方向），JD 第 (1) 条顺带写了"嵌入式"
  //   → AI 判匹配并已发送沟通。用户原话："求职画像和现在这个职位一点关系没有"。
  const portrait = '嵌入式软件应届生，熟悉 STM32、FreeRTOS，有 FOC 电机控制项目经验，寻找与 MCU 嵌入式软件开发岗位及单片机开发相关开发工作，嵌入式软件相关工作。';
  const hwJob = {
    title: '【华为2026秋招】软件开发/算法/AI工程师',
    company: '华为', salary: '20-40K·16薪', location: '北京',
    experience: '在校/应届', education: '本科', activeText: '2天前活跃', jobId: 'HW49',
    jd: [
      '职位描述：',
      '（1）软件开发-通用软件/数据库/嵌入式/操作系统/编译器',
      '（2）算法工程师-软件算法/通信算法/射频算法/仿真算法/媒体算法/控制算法/感知算法/存储算法',
      '（3）AI模型工程师- AI算法/端侧大模型/AI模型评测/后训练与强化学习/大模型数据技术/Agent技术/语言大模型/空间智能/多模态大模型',
      '（4）AI应用工程师- AI系统软件/AI技术应用',
      '（5）AI安全与隐私工程师- AI应用安全/AI模型与Infra安全',
      '（6）AI Infra工程师-建模仿真/AI算子技术/AI训练系统/AI数据系统',
      '（7）云服务开发工程师',
      '（8）数据科学工程师',
    ].join('\n'),
  };

  // 49a. SYSTEM_PROMPT：维度 1 必须声明"以画像为核心依据 + 顺带提及不算匹配"
  ok('SYSTEM_PROMPT 维度 1 写明以画像技术栈与求职意向为核心依据',
     /核心依据/.test(BH.SYSTEM_PROMPT));
  ok('SYSTEM_PROMPT 写明并列/顺带提及画像关键词不构成方向匹配',
     /并列列出或顺带提及画像中的关键词/.test(BH.SYSTEM_PROMPT));
  ok('SYSTEM_PROMPT 维度 1 要求看标题与主要职责判断主体方向',
     /主体方向（看标题与主要职责）/.test(BH.SYSTEM_PROMPT));

  // 49b. 画像非空：prompt 画像段带方向匹配规则
  resetAll();
  const cfg = {
    ...BH.loadConfig(), aiEnabled: true, aiStrictFacts: true,
    yearsMin: 0, eduMin: 0, salaryMin: 0, activeDays: 7, aiUserPortrait: portrait,
  };
  setCfg(cfg);
  const p = BH.buildAIPrompt(hwJob);
  ok('画像段写明方向匹配以画像技术栈与求职意向为核心依据',
     /判断岗位方向是否匹配，以上方画像的技术栈与求职意向为\*{0,2}核心依据/.test(p));
  ok('画像段写明 JD 并列/顺带提及画像关键词不算匹配',
     /并列列出、顺带提及画像中的关键词（如大类招聘把多个方向并列写在一条里）不构成方向匹配/.test(p));
  ok('画像段要求主体方向与画像方向不同领域时判不匹配',
     /主体方向（看标题与主要职责）与画像方向属于不同领域时，判不匹配/.test(p));
  ok('画像原文完整送入 prompt', p.includes('寻找与 MCU 嵌入式软件开发岗位'));

  // 49c. "只认事实"模式：方向匹配不适用"拿不准放行"
  ok('只认事实模式为方向匹配开例外（不适用拿不准放行）',
     /方向是否匹配不适用/.test(p) && /明确判 false/.test(p));

  // 49d. 画像为空：不强加方向规则，保留原保守文案
  setCfg({ ...cfg, aiUserPortrait: '' });
  const p2 = BH.buildAIPrompt(hwJob);
  ok('画像为空时不强加方向规则', !/判断岗位方向是否匹配，以上方画像/.test(p2));
  ok('画像为空时保留保守判断文案', /用户未填写画像/.test(p2));

  // 49e. 端到端：桩模型，验证真正发出的 prompt 带了画像与方向规则
  resetAll();
  setCfg({ ...cfg, aiApiKey: 'sk-testkey-1234567890', aiBaseUrl: 'https://api.example.com/v1/chat/completions',
    aiModel: 'gpt-4o-mini', aiDailyLimit: 100, aiMaxJDChars: 2500, aiCacheEnabled: true, aiCacheDays: 7, aiFallback: 'local' });
  let sentPrompt = '';
  netHandler = (o) => {
    try { sentPrompt = JSON.parse(o.data).messages.map((m) => m.content).join('\n'); } catch (_) {}
    reply(o, { choices: [{ message: { content: '{"match":true,"score":90,"reason":"ok"}' } }] });
  };
  const r = await BH.aiScreen(hwJob);
  ok('端到端能跑通（桩模型放行 → accept）', r.ok === true && r.match === true, JSON.stringify(r));
  ok('真正发出的 prompt 含画像原文与方向匹配规则',
     sentPrompt.includes('寻找与 MCU 嵌入式软件开发岗位') && /核心依据/.test(sentPrompt));
  ok('真正发出的 prompt 仍不含学历/年限排斥依据',
     !/JD 明确要求高于/.test(sentPrompt) && !/经验要求（当前岗位字段）/.test(sentPrompt));

  // 49f. UI 文案同步
  const docH = win.document;
  const pH = docH.getElementById('boss-helper-panel');
  docH.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());
  setCfg(cfg);
  pH.querySelector('[data-act="aiopen"]').click();
  const modalH = docH.getElementById('bh-ai-modal');
  ok('求职画像字段说明写明"岗位方向匹配以画像为核心依据"',
     /岗位方向匹配以画像里的技术栈与求职意向为核心依据/.test(modalH.textContent));
  modalH.querySelector('[data-act="aiclose"]')?.click();
  docH.querySelectorAll('#bh-ai-modal, #bh-ai-confirm').forEach((el) => el.remove());
  resetAll();
}

// ============================================================
console.log(results.join('\n'));
console.log('\n============================================');
console.log(`结果： ${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''} （共 ${pass + fail + skipped} 条断言）`);
console.log('============================================');
win.close();
process.exit(fail > 0 ? 1 : 0);
