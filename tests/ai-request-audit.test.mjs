import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';
import * as reported from './reported-jobs.mjs';

const code = fs.readFileSync(SCRIPT, 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const longJD = Array.from({ length: 150 }, (_, i) => `第${i + 1}项职责：负责产品的嵌入式驱动、实时任务、通信协议开发与软硬件联调，完整保留本项要求。`).join('\n') + '\n末尾独有要求：完成现场故障复现与维护文档交付。';
const baseJob = { jobId: 'audit-job', title: '嵌入式软件研发', company: '本次研发公司', salary: '16-24K', jdSource: 'selector', companySource: '已确认的当前卡片', salarySource: '已确认的当前卡片' };

async function fixture(t, cfg = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.zhipin.com/web/geek/job', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const win = dom.window, store = new Map(), requests = [];
  win.GM_getValue = (key, fallback) => store.has(key) ? structuredClone(store.get(key)) : fallback;
  win.GM_setValue = (key, value) => store.set(key, structuredClone(value));
  win.GM_addStyle = () => {};
  win.unsafeWindow = win;
  win.chrome = { runtime: { getManifest: () => manifest } };
  win.fetch = () => assert.fail('审计回归不得请求外部服务');
  win.GM_xmlhttpRequest = (request) => {
    requests.push(JSON.parse(request.data));
    queueMicrotask(() => request.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '{"match":true,"score":85,"reason":"值得尝试投递"}' } }] }) }));
    return { abort() {} };
  };
  win.eval(code); await delay(0);
  const BH = win.BH;
  BH.state.config = { ...BH.loadConfig(), aiEnabled: true, aiBaseUrl: 'https://audit.example/v1', aiApiKey: 'audit-only-secret', aiModel: 'audit-model',
    aiEndpoints: [], aiCacheEnabled: false, aiMaxRetries: 0, aiUserPortrait: '原画像：有 STM32 与 FreeRTOS 项目基础，寻找可培养岗位。', mustNot: [], ...cfg };
  BH.state.stopFlag = false;
  t.after(() => { BH.state.stopFlag = true; win.close(); });
  return { win, BH, store, requests };
}

test('旧2500字参数默认全文发送，长JD及用户两份JD首尾均进入实际messages', async (t) => {
  const f = await fixture(t, { aiMaxJDChars: 2500 });
  assert.equal(f.BH.state.config.aiJDMode, 'full');
  const jobs = [{ ...baseJob, jd: longJD }, ...Object.values(reported).filter((value) => value?.jd).map((value, i) => ({ ...baseJob, ...value, jobId: 'reported-' + i }))];
  assert.equal(jobs.length, 3);
  for (const job of jobs) {
    const result = await f.BH.aiScreen(job);
    assert.equal(result.ok, true, result.err);
    const cleaned = f.BH.cleanJDText(job.jd), audit = result.requestAudit;
    assert.ok(f.requests.at(-1).messages[1].content.includes(cleaned), '实际发送必须包含完整清洗后JD');
    assert.equal(audit.originalJDChars, job.jd.length);
    assert.equal(audit.cleanedJDChars, cleaned.length);
    assert.equal(audit.sentJDChars, cleaned.length);
    assert.equal(audit.truncated, false);
    assert.deepEqual(JSON.parse(audit.messagesJSON), f.requests.at(-1).messages);
  }
});

test('手动裁剪和最终日志使用该次不可变请求，保存新设置不能改写历史正文或画像', async (t) => {
  const f = await fixture(t, { aiJDMode: 'truncate', aiMaxJDChars: 300 });
  const job = { ...baseJob, jd: longJD, descriptionChars: longJD.length };
  const gate = await f.BH.runAIGate(null, job), audit = gate.requestAudit;
  assert.equal(gate.action, 'accept');
  assert.equal(audit.truncated, true);
  assert.equal(audit.sentJDChars, audit.jdText.length);
  assert.ok(audit.sentJDChars < longJD.length);
  assert.ok(Object.isFrozen(audit));
  assert.ok(Object.values(audit).every((value) => value === null || ['string', 'number', 'boolean'].includes(typeof value)));
  const sent = JSON.stringify(f.requests[0].messages);
  f.BH.state.config.aiUserPortrait = '新画像：只投测试开发';
  f.BH.state.config.aiJDMode = 'full'; f.BH.state.config.aiMaxJDChars = 20000;
  job.company = '后来的另一家公司'; job.salary = '3-5K'; job.jd = '后来更新的职位正文';
  f.win.chrome.runtime.getManifest = () => ({ version: '999.0.0' });
  const log = f.BH.buildAISkipDetail({ ...job, gate });
  assert.equal(JSON.stringify(JSON.parse(audit.messagesJSON)), sent);
  assert.ok(log.includes('本次研发公司') && log.includes('16-24K'));
  assert.ok(log.includes('原画像：') && log.includes('实际发送JD'));
  assert.ok(log.includes('页面运行版本：' + manifest.version));
  assert.ok(log.includes('已按用户选择裁剪'));
  assert.doesNotMatch(log, /后来的另一家|新画像：|后来更新的职位|999\.0\.0|audit-only-secret/);
});

test('全文超出20000字明确停止，零API请求，不进入接口故障循环', async (t) => {
  const f = await fixture(t);
  const jd = Array.from({ length: 700 }, (_, i) => `${i + 1}：${'必须保留的独立长条款内容。'.repeat(4)}`).join('\n');
  const gate = await f.BH.runAIGate(null, { ...baseJob, jd });
  assert.equal(gate.action, 'stop');
  assert.equal(gate.inputIncomplete, true);
  assert.equal(f.BH.state.stopFlag, true);
  assert.equal(f.requests.length, 0);
  assert.match(gate.reason, /超过全文发送上限 20000.*未调用 AI、未投递/);
  assert.doesNotMatch(f.win.document.querySelector('.bh-log').textContent, /全部 AI 接口不可用|一分钟后重试/);
});

test('缓存命中不伪装本次实际发送，不将画像或完整请求扩散到持久缓存', async (t) => {
  const f = await fixture(t, { aiCacheEnabled: true });
  const job = { ...baseJob, jd: '负责当前 STM32 产品固件研发与联调。' };
  const first = await f.BH.runAIGate(null, job);
  assert.ok(first.requestAudit);
  const cached = await f.BH.runAIGate(null, job);
  assert.equal(cached.cached, true);
  assert.equal(cached.requestAudit, undefined);
  assert.equal(f.requests.length, 1);
  const log = f.BH.buildAISkipDetail({ ...job, gate: cached });
  assert.match(log, /本次命中缓存，未重新发送 AI 请求/);
  assert.doesNotMatch(log, /本次实际发送记录/);
  const cacheJSON = JSON.stringify(f.store.get('boss_helper_ai_cache_v1'));
  assert.doesNotMatch(cacheJSON, /messagesJSON|requestAudit|原画像：|audit-only-secret/);
});

test('请求审计脱敏短凭据时仍是完整合法JSON，保留原始发送字数', async (t) => {
  const f = await fixture(t, { aiApiKey: 'tiny', aiUserPortrait: '用户误粘贴 tiny 后仍保留完整画像末尾。' });
  const result = await f.BH.aiScreen({ ...baseJob, jd: '负责固件开发与产品联调。' });
  const audit = result.requestAudit;
  assert.equal(audit.redacted, true);
  const messages = JSON.parse(audit.messagesJSON);
  assert.ok(messages[1].content.includes('完整画像末尾。'));
  assert.doesNotMatch(audit.messagesJSON, /tiny/);
  assert.equal(audit.portraitChars, f.BH.state.config.aiUserPortrait.length);
});

test('JD模式从旧配置默认为全文，手动选择后保存重载仍保留', async (t) => {
  const f = await fixture(t);
  f.store.set('boss_helper_config_v1', { ...f.BH.state.config, aiJDMode: undefined, aiMaxJDChars: 900 });
  assert.equal(f.BH.loadConfig().aiJDMode, 'full');
  f.BH.state.config = f.BH.loadConfig();
  f.win.document.querySelector('[data-act="aiopen"]').click();
  const select = f.win.document.querySelector('#bh-ai-modal [data-cfg="aiJDMode"]');
  assert.equal(select.value, 'full');
  const limit = f.win.document.querySelector('#bh-ai-modal [data-cfg="aiMaxJDChars"]');
  assert.equal(limit.disabled, true, '全文模式不能让旧2500字参数看起来仍在限制发送');
  select.value = 'truncate';
  select.dispatchEvent(new f.win.Event('change', { bubbles: true }));
  assert.equal(limit.disabled, false);
  f.win.document.querySelector('#bh-ai-modal [data-act="aisave"]').click();
  await delay(0);
  assert.equal(f.BH.loadConfig().aiJDMode, 'truncate');
  assert.equal(f.BH.loadConfig().aiMaxJDChars, 900);
});
