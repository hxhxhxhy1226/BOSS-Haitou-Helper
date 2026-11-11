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
    host.innerHTML = `<div class="boss-dialog__wrapper" ${attrs}><div class="dialog-title">${text}</div><button class="default-btn cancel-btn">留在此页</button></div>`;
    const notice = host.firstElementChild;
    notice.querySelector('.cancel-btn').addEventListener('click', () => notice.remove());
    doc.body.append(notice); return notice;
  };
  return { win, doc, BH, button, addNotice, context: () => BH.captureOfficialContactContext(JOB, button),
    logs: () => doc.querySelector('.bh-log')?.textContent || '' };
}

test('本次新出现的可见官方成功弹窗可以确认，并只定位该弹窗内的留在此页', async (t) => {
  const f = await fixture(t), before = f.context();
  const notice = f.addNotice('已向BOSS发送消息');
  const stay = notice.querySelector('.cancel-btn');
  const result = f.BH.readOfficialContactResult(before);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.stay, stay);
});

function customSuccessDialog(f) {
  const dialog = f.doc.createElement('section');
  dialog.className = 'greet-dialog';
  dialog.innerHTML = `<header><h3 class="title"><span>已</span><span>向</span><b>BOSS</b><span>发</span><span>送消息</span></h3></header>
    <div class="greet-preview">${'这是本次打招呼内容的长预览。'.repeat(120)}</div>
    <footer><button class="default-btn cancel-btn"><span>留在此页</span></button><button class="continue-btn">继续沟通</button></footer>`;
  f.doc.body.append(dialog);
  return dialog;
}

test('自定义成功弹窗的拆分标题和长消息预览仍能确认，并定位同框留在此页', async (t) => {
  const f = await fixture(t), before = f.context();
  const outside = f.doc.createElement('button'); outside.textContent = '留在此页'; f.doc.body.append(outside);
  const dialog = customSuccessDialog(f);
  assert.ok(dialog.textContent.length > 1000, '模拟实际长招呼语，不能按整框文字长度丢掉标题回执');
  const result = f.BH.readOfficialContactResult(before);
  assert.equal(result?.status, 'confirmed');
  assert.equal(result.stay, dialog.querySelector('.cancel-btn'));
  assert.notEqual(result.stay, outside);
});

test('回执出现时正文暂时清空，同岗位页头可核验即可确认成功', async (t) => {
  const f = await fixture(t), before = f.context();
  f.doc.querySelector('.job-sec-text').textContent = '';
  assert.equal(f.BH.extractJobSnapshot(JOB).ok, false, '确认本场景没有可供重读的完整 JD');
  f.addNotice('已向BOSS发送消息');
  assert.equal(f.BH.readOfficialContactResult(before)?.status, 'confirmed');
});

test('成功弹窗暂时隐藏原详情时，不能因原详情不可见漏掉本次官方回执', async (t) => {
  const f = await fixture(t), before = f.context();
  f.doc.querySelector('.job-detail').hidden = true;
  assert.equal(f.BH.extractJobSnapshot(JOB).ok, false);
  f.addNotice('已向BOSS发送消息');
  assert.equal(f.BH.readOfficialContactResult(before)?.status, 'confirmed');
});

test('旧自定义成功弹窗的消息预览或按钮更新，不能冒充本次新回执', async (t) => {
  const f = await fixture(t), dialog = customSuccessDialog(f);
  const before = f.context();
  dialog.querySelector('.greet-preview').textContent = '仅更新原有消息预览';
  dialog.querySelector('.continue-btn').textContent = '继续沟通 (2)';
  assert.equal(f.BH.readOfficialContactResult(before), null);
});

test('同岗位仅更新查询参数时，本次成功回执仍可确认', async (t) => {
  const f = await fixture(t), before = f.context();
  f.win.history.replaceState({}, '', '/web/geek/job?query=firmware&securityId=fixture');
  f.addNotice('已向BOSS发送消息');
  assert.equal(f.BH.readOfficialContactResult(before)?.status, 'confirmed');
});

test('原职位 ID 消失且标题公司已换岗时，不能把新成功框归给原岗位', async (t) => {
  const f = await fixture(t), before = f.context();
  f.doc.querySelector('.job-detail').removeAttribute('data-jobid');
  f.doc.querySelector('.job-detail-link').removeAttribute('href');
  f.doc.querySelector('.job-name').textContent = '销售客户经理';
  f.doc.querySelector('.company-name').textContent = '另一家测试公司';
  f.addNotice('已向BOSS发送消息');
  assert.equal(f.BH.readOfficialContactResult(before), null);
});

test('旧成功弹窗只重建标题节点，不能制造本次新回执', async (t) => {
  const f = await fixture(t), notice = f.addNotice('已向BOSS发送消息');
  const before = f.context(), title = notice.querySelector('.dialog-title');
  title.replaceWith(title.cloneNode(true));
  assert.equal(f.BH.readOfficialContactResult(before), null);
});

test('按钮先变继续沟通、成功框晚一百毫秒挂载，仍等待并关闭该框', { timeout: 8000 }, async (t) => {
  const f = await fixture(t), slot = await f.BH.reserveDelivery(JOB.jobId, 10);
  let dialog, timer, closed = 0;
  t.after(() => clearTimeout(timer));
  f.button.addEventListener('click', () => {
    f.button.textContent = '继续沟通';
    timer = setTimeout(() => {
      dialog = customSuccessDialog(f);
      dialog.querySelector('.cancel-btn').addEventListener('click', () => { closed++; dialog.remove(); });
    }, 100);
  });
  const result = await f.BH.performOfficialContact(f.button, JOB, () => true, slot);
  assert.equal(result.status, 'confirmed');
  assert.ok(dialog, '按钮状态先到不能跳过下一次渲染的成功弹窗');
  assert.equal(closed, 1);
  assert.equal(dialog.isConnected, false);
  assert.equal(result.dialogClosed, true);
  assert.equal(f.BH.loadStats().sent, 1);
});

test('留在此页触发同框重建时，继续关闭新框并等到它消失', { timeout: 8000 }, async (t) => {
  const f = await fixture(t), slot = await f.BH.reserveDelivery(JOB.jobId, 10);
  let oldDialog, replacement, closeCalls = 0;
  f.button.addEventListener('click', () => {
    oldDialog = customSuccessDialog(f);
    oldDialog.querySelector('.cancel-btn').addEventListener('click', () => {
      closeCalls++;
      replacement = oldDialog.cloneNode(true);
      replacement.querySelector('.cancel-btn').addEventListener('click', () => { closeCalls++; replacement.remove(); });
      oldDialog.replaceWith(replacement);
    });
  });
  const result = await f.BH.performOfficialContact(f.button, JOB, () => true, slot);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.dialogClosed, true);
  assert.equal(closeCalls, 2);
  assert.ok(replacement);
  assert.equal(replacement.isConnected, false);
  assert.equal(f.doc.querySelector('.greet-dialog'), null);
  assert.equal(f.BH.state.stopFlag, false);
});

for (const failure of ['no-op', 'throw']) {
  test(`留在此页 ${failure} 时使用同框关闭按钮，保留成功状态`, { timeout: 8000 }, async (t) => {
    const f = await fixture(t), slot = await f.BH.reserveDelivery(JOB.jobId, 10);
    let dialog, stayCalls = 0, iconCalls = 0, outsideCalls = 0;
    const outside = f.doc.createElement('button'); outside.className = 'icon-close'; outside.textContent = '×';
    outside.addEventListener('click', () => outsideCalls++); f.doc.body.append(outside);
    f.button.addEventListener('click', () => {
      dialog = customSuccessDialog(f);
      dialog.querySelector('.cancel-btn').click = () => {
        stayCalls++;
        if (failure === 'throw') throw new Error('fixture stay action failed');
      };
      const icon = f.doc.createElement('button'); icon.className = 'icon-close'; icon.setAttribute('aria-label', '关闭'); icon.textContent = '×';
      icon.addEventListener('click', () => { iconCalls++; dialog.remove(); }); dialog.prepend(icon);
    });
    const result = await f.BH.performOfficialContact(f.button, JOB, () => true, slot);
    assert.equal(result.status, 'confirmed');
    assert.equal(result.dialogClosed, true);
    assert.equal(stayCalls, 1);
    assert.equal(iconCalls, 1);
    assert.equal(outsideCalls, 0);
    assert.equal(dialog.isConnected, false);
    assert.equal(f.BH.state.stopFlag, false);
  });
}

test('成功框的留在此页与关闭按钮均失效时停止后续处理，仍保留已完成状态', { timeout: 8000 }, async (t) => {
  const f = await fixture(t), slot = await f.BH.reserveDelivery(JOB.jobId, 10);
  let dialog;
  f.button.addEventListener('click', () => {
    dialog = customSuccessDialog(f);
    const icon = f.doc.createElement('button'); icon.className = 'icon-close'; icon.textContent = '×';
    icon.click = () => { throw new Error('fixture close action failed'); };
    dialog.prepend(icon);
  });
  const result = await f.BH.performOfficialContact(f.button, JOB, () => true, slot);
  assert.equal(result.status, 'confirmed', '关闭弹窗失败不能撤销已确认的发送结果');
  assert.equal(result.dialogClosed, false);
  assert.equal(dialog.isConnected, true);
  assert.equal(f.BH.state.stopFlag, true);
  assert.match(f.logs(), /投递已完成.*成功弹窗未关闭/);
  assert.doesNotMatch(f.logs(), /未投递|未发起沟通/);
  assert.equal(f.BH.loadStats().sent, 1);
  assert.equal(await f.BH.reserveDelivery(JOB.jobId, 10), false, '不能因关闭失败重新联系同一岗位');
});

test('官方回执延迟超过四秒才出现，默认等待仍确认招呼已发送', { timeout: 8000 }, async (t) => {
  const f = await fixture(t), before = f.context();
  const started = Date.now();
  const timer = setTimeout(() => f.addNotice('招呼已发送'), 4300);
  t.after(() => clearTimeout(timer));
  const result = await f.BH.waitForOfficialContactResult(before);
  assert.equal(result.status, 'confirmed');
  assert.match(result.reason, /招呼已发送/);
  assert.ok(Date.now() - started >= 4000, '覆盖旧四秒等待窗口以外的真实延迟回执');
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

test('调用官方 click 时抛错仍保留占额，不谎称成功也不重复激活', { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const slot = await f.BH.reserveDelivery(JOB.jobId, 10);
  let attempts = 0;
  f.button.addEventListener('click', () => { f.BH.state.stopFlag = true; });
  f.button.click = () => {
    attempts++;
    f.BH.state.stopFlag = true;
    throw new Error('fixture activation interrupted');
  };
  const result = await f.BH.performOfficialContact(f.button, JOB, () => true, slot);
  assert.equal(attempts, 1);
  assert.equal(result.status, 'unconfirmed');
  assert.match(result.reason, /派发中断/);
  assert.equal(f.BH.loadStats().sent, 1);
  assert.equal(f.BH.loadStats().pending, 0);
  assert.equal(await f.BH.reserveDelivery(JOB.jobId, 10), false);
});

test('准备滚动期间同岗位按钮重建，重新定位后只激活最新按钮一次', { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const slot = await f.BH.reserveDelivery(JOB.jobId, 10);
  let originalClicks = 0, replacementClicks = 0, replaced = false;
  f.button.addEventListener('click', () => { originalClicks++; });
  f.button.scrollIntoView = () => {
    if (replaced) return;
    replaced = true;
    const replacement = f.button.cloneNode(true);
    replacement.addEventListener('click', (event) => {
      event.preventDefault(); replacementClicks++;
      f.addNotice('已向BOSS发送消息');
    });
    f.button.replaceWith(replacement);
  };
  const result = await f.BH.performOfficialContact(f.button, JOB, () => true, slot);
  assert.equal(replaced, true);
  assert.equal(originalClicks, 0);
  assert.equal(replacementClicks, 1);
  assert.equal(result.status, 'confirmed');
  assert.equal(f.BH.loadStats().sent, 1);
  assert.equal(f.BH.loadStats().pending, 0);
  assert.equal(await f.BH.reserveDelivery(JOB.jobId, 10), false);
});

test('网站 mousedown 重建逻辑不再造成零 click 却永久占额', { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const slot = await f.BH.reserveDelivery(JOB.jobId, 10);
  let clicks = 0;
  const activate = (event) => { event.preventDefault(); clicks++; f.addNotice('已向BOSS发送消息'); };
  f.button.addEventListener('click', activate);
  f.button.addEventListener('mousedown', () => {
    const replacement = f.button.cloneNode(true);
    replacement.addEventListener('click', activate);
    f.button.replaceWith(replacement);
  });
  const result = await f.BH.performOfficialContact(f.button, JOB, () => true, slot);
  assert.equal(clicks, 1);
  assert.equal(result.status, 'confirmed');
  assert.equal(f.BH.loadStats().sent, 1);
  assert.equal(f.BH.loadStats().pending, 0);
});

test('准备点击过程中停止，零激活且释放占额，恢复后仍可处理同岗位', { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const slot = await f.BH.reserveDelivery(JOB.jobId, 10);
  let clicks = 0;
  f.button.addEventListener('click', () => { clicks++; });
  f.button.scrollIntoView = () => { f.BH.state.stopFlag = true; };
  const result = await f.BH.performOfficialContact(f.button, JOB, () => true, slot);
  assert.equal(result.status, 'not-started');
  assert.equal(clicks, 0);
  assert.equal(f.BH.loadStats().sent, 0);
  assert.equal(f.BH.loadStats().pending, 0);
  f.BH.state.stopFlag = false;
  const retry = await f.BH.reserveDelivery(JOB.jobId, 10);
  assert.ok(retry, '未实际调用 click 的取消操作不能永久屏蔽该岗位');
  await f.BH.releaseDelivery(retry);
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
