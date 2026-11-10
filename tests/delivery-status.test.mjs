import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const code = fs.readFileSync(SCRIPT, 'utf8');
const JOB = { jobId: 'contactFixture', dataJobId: '202611', title: '嵌入式软件工程师', company: '测试研发公司' };
const html = `<section class="job-detail" data-jobid="${JOB.dataJobId}">
  <header class="job-banner"><h1 class="job-name">${JOB.title}</h1>
    <a class="company-name" href="/gongsi/fixture.html">${JOB.company}</a><span class="salary">20-30K</span>
    <a class="job-detail-link" href="/job_detail/${JOB.jobId}.html">查看职位</a>
    <a class="op-btn-chat" href="javascript:void(0)">立即沟通</a></header>
  <section class="job-detail-section"><h2>职位描述</h2>
    <div class="job-sec-text">负责 STM32 控制器固件开发、FreeRTOS 驱动调试和设备通信协议开发，参与产品量产维护。</div></section>
  <div class="boss-info"><span class="active-time">今日活跃</span></div></section>`;

async function fixture(t, { detail = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: detail ? `https://www.zhipin.com/job_detail/${JOB.jobId}.html` : 'https://www.zhipin.com/web/geek/job',
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window, values = new Map();
  values.set('boss_helper_config_v1', { autoSend: false, aiEnabled: false, mustHave: [], mustNot: [],
    activeDays: 0, yearsMin: 0, eduMin: 0, dailyLimit: 10 });
  win.GM_getValue = (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback;
  win.GM_setValue = (key, value) => values.set(key, structuredClone(value));
  win.GM_listValues = () => [...values.keys()];
  win.GM_deleteValue = (key) => values.delete(key);
  win.GM_addStyle = () => {};
  win.unsafeWindow = win;
  let network = 0;
  const blocked = () => { network++; throw new Error('发送回归禁止连接真实服务'); };
  win.fetch = blocked;
  win.GM_xmlhttpRequest = blocked;
  const hidden = (el) => !!el.closest('[hidden], [aria-hidden="true"], [style*="display:none"], [style*="display: none"]');
  Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { get() { return hidden(this) ? 0 : 600; } });
  Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { get() { return hidden(this) ? 0 : 300; } });
  win.Element.prototype.getBoundingClientRect = function () {
    const width = hidden(this) ? 0 : 600, height = hidden(this) ? 0 : 300;
    return { x: 600, y: 180, left: 600, top: 180, width, height, right: 600 + width, bottom: 180 + height };
  };
  win.Element.prototype.getClientRects = function () { return hidden(this) ? [] : [this.getBoundingClientRect()]; };
  win.eval(code);
  await delay(0);
  const BH = win.BH, doc = win.document;
  BH.state.config = { ...BH.loadConfig(), autoSend: true };
  t.after(() => { BH.state.stopFlag = true; win.close(); assert.equal(network, 0); });
  const button = doc.querySelector('.op-btn-chat');
  button.addEventListener('click', (event) => event.preventDefault());
  const addNotice = (text, attrs = '') => {
    const host = doc.createElement('div');
    host.innerHTML = `<div class="boss-dialog__wrapper" ${attrs}><div class="dialog-title">${text}</div></div>`;
    const notice = host.firstElementChild; doc.body.append(notice); return notice;
  };
  return { win, doc, BH, button, addNotice, context: () => BH.captureOfficialContactContext(JOB, button),
    logs: () => doc.querySelector('.bh-log')?.textContent || '' };
}

test('本次新出现的可见官方成功弹窗可以确认，并只定位该弹窗内的留在此页', async (t) => {
  const f = await fixture(t), before = f.context();
  const notice = f.addNotice('已向BOSS发送消息');
  const stay = f.doc.createElement('button'); stay.textContent = '留在此页'; notice.append(stay);
  const result = f.BH.readOfficialContactResult(before);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.stay, stay);
});

test('旧弹窗、隐藏成功提示、助手日志和 JD 正文都不能证明发送成功', async (t) => {
  const f = await fixture(t);
  f.addNotice('已向BOSS发送消息');
  const before = f.context();
  f.addNotice('打招呼成功', 'hidden');
  f.doc.querySelector('.job-sec-text').insertAdjacentHTML('beforeend', '<div class="dialog-title">消息已发送</div>');
  f.doc.querySelector('.bh-log').insertAdjacentHTML('beforeend', '<div role="status">已向BOSS发送消息</div>');
  f.doc.body.insertAdjacentHTML('beforeend', '<p>已向BOSS发送消息</p>');
  assert.equal(f.BH.readOfficialContactResult(before), null);
  assert.equal((await f.BH.waitForOfficialContactResult(before, 0)).status, 'unconfirmed');
});

test('隐藏的官方弹窗在本次点击后显示，才计为新成功提示', async (t) => {
  const f = await fixture(t), notice = f.addNotice('打招呼成功', 'hidden');
  const before = f.context(); notice.hidden = false;
  assert.equal(f.BH.readOfficialContactResult(before).status, 'confirmed');
});

test('旧成功弹窗里无关的按钮或倒计时更新不能算新回执', async (t) => {
  const f = await fixture(t), notice = f.addNotice('已向BOSS发送消息');
  const before = f.context();
  notice.insertAdjacentHTML('beforeend', '<button>留在此页 3 秒</button>');
  assert.equal(f.BH.readOfficialContactResult(before), null);
});

test('当前职位的按钮从立即沟通变为继续沟通可确认；已存在的继续沟通按钮不能确认', async (t) => {
  const f = await fixture(t);
  const older = f.button.cloneNode(true); older.textContent = '继续沟通'; f.button.parentElement.append(older);
  const before = f.context();
  assert.equal(f.BH.readOfficialContactResult(before), null);
  f.button.textContent = '继续沟通';
  assert.equal(f.BH.readOfficialContactResult(before).status, 'confirmed');
});

test('跳入聊天页或切换其他职位不能自动当作原职位成功', async (t) => {
  const f = await fixture(t), before = f.context();
  f.win.history.replaceState({}, '', '/web/geek/chat');
  f.addNotice('打招呼成功');
  assert.equal(f.BH.readOfficialContactResult(before), null);
  assert.equal((await f.BH.waitForOfficialContactResult(before, 0)).status, 'unconfirmed');
});

test('列表 URL 不变但选中职位已切换时，新弹窗不能归给原职位', async (t) => {
  const f = await fixture(t), before = f.context();
  f.doc.querySelector('.job-detail').dataset.jobid = 'otherJob';
  f.doc.querySelector('.job-detail-link').href = '/job_detail/otherPublicJob.html';
  f.doc.querySelector('.job-name').textContent = '其他职位';
  f.addNotice('已向BOSS发送消息');
  assert.equal(f.BH.readOfficialContactResult(before), null);
});

test('独立详情实际流程：无官方回执时显示待确认、保留占额且不会注入旧话术', { timeout: 8000 }, async (t) => {
  const f = await fixture(t, { detail: true });
  const input = f.doc.createElement('textarea'); input.id = 'chat-input'; input.value = '用户正在编辑的消息'; f.doc.body.append(input);
  let clicks = 0;
  f.button.addEventListener('click', () => { clicks++; f.BH.state.stopFlag = true; });
  assert.equal(await f.BH.autoChatOnDetail(), true);
  assert.equal(clicks, 1);
  assert.equal(f.BH.loadStats().sent, 1);
  assert.equal(f.BH.loadStats().pending, 0);
  assert.match(f.logs(), /已发起沟通，待确认/);
  assert.doesNotMatch(f.logs(), /官方已确认沟通|已发送|已招呼/);
  assert.equal(input.value, '用户正在编辑的消息');
  assert.equal(await f.BH.reserveDelivery(JOB.jobId, 10), false, '未确认也不能重复发起同一职位');
});

test('独立详情实际流程：官方确认后才记成功，保持一次占额', { timeout: 8000 }, async (t) => {
  const f = await fixture(t, { detail: true });
  f.button.addEventListener('click', () => { f.addNotice('已向BOSS发送消息'); f.BH.state.stopFlag = true; });
  assert.equal(await f.BH.autoChatOnDetail(), true);
  assert.match(f.logs(), /官方已确认沟通/);
  assert.doesNotMatch(f.logs(), /已发起沟通，待确认/);
  assert.equal(f.BH.loadStats().sent, 1);
});

test('官方明确拒绝或频繁提示会停止，并保留已发起额度避免重复', { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const slot = await f.BH.reserveDelivery(JOB.jobId, 10);
  f.button.addEventListener('click', () => f.addNotice('发送失败，操作过于频繁，请稍后再试'));
  const result = await f.BH.performOfficialContact(f.button, JOB, () => true, slot);
  assert.equal(result.status, 'rejected');
  assert.equal(f.BH.state.stopFlag, true);
  assert.equal(f.BH.loadStats().sent, 1);
  assert.equal(await f.BH.reserveDelivery(JOB.jobId, 10), false);
});

test('鼠标事件抛错后不会释放已提交额度，也不会谎称未点击或成功', { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const slot = await f.BH.reserveDelivery(JOB.jobId, 10);
  const original = f.button.dispatchEvent.bind(f.button);
  f.button.dispatchEvent = (event) => {
    if (event.type === 'mousedown') { f.BH.state.stopFlag = true; throw new Error('fixture event dispatch failed'); }
    return original(event);
  };
  const result = await f.BH.performOfficialContact(f.button, JOB, () => true, slot);
  assert.equal(result.status, 'unconfirmed');
  assert.match(result.reason, /派发中断/);
  assert.equal(f.BH.loadStats().sent, 1);
  assert.equal(f.BH.loadStats().pending, 0);
  assert.equal(await f.BH.reserveDelivery(JOB.jobId, 10), false);
});

test('点击前停止则释放预留，不占发起次数', async (t) => {
  const f = await fixture(t);
  const slot = await f.BH.reserveDelivery(JOB.jobId, 10);
  f.BH.state.stopFlag = true;
  const result = await f.BH.performOfficialContact(f.button, JOB, () => true, slot);
  assert.equal(result.status, 'not-started');
  assert.equal(f.BH.loadStats().sent, 0);
  assert.equal(f.BH.loadStats().pending, 0);
});
