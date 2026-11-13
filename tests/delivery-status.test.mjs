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

function registerWindowCleanup(t, win, network) {
  t.after(() => {
    try {
      if (win.BH) win.BH.state.stopFlag = true;
    } finally {
      try { win.close(); assert.equal(network.count, 0); }
      finally { win = null; }
    }
  });
}

function registerTimerCleanup(t, timers) {
  t.after(() => {
    try { for (const timer of timers) clearTimeout(timer); }
    finally { timers.length = 0; }
  });
}

async function fixture(t, { detail = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: detail ? `https://www.zhipin.com/job_detail/${JOB.jobId}.html` : 'https://www.zhipin.com/web/geek/job',
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window, values = new Map(), network = { count: 0 };
  registerWindowCleanup(t, win, network);
  values.set('boss_helper_config_v1', { autoSend: false, aiEnabled: false, mustHave: [], mustNot: [],
    activeDays: 0, yearsMin: 0, eduMin: 0, dailyLimit: 10 });
  win.GM_getValue = (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback;
  win.GM_setValue = (key, value) => values.set(key, structuredClone(value));
  win.GM_listValues = () => [...values.keys()];
  win.GM_deleteValue = (key) => values.delete(key);
  win.GM_addStyle = () => {};
  win.unsafeWindow = win;
  const blocked = () => { network.count++; throw new Error('发送回归禁止连接真实服务'); };
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

function mountSelectedCard(f, { publicLink = true, dataJobId = JOB.dataJobId } = {}) {
  const list = f.doc.createElement('ul');
  list.className = 'job-list-wrapper';
  list.innerHTML = `<li class="job-card-box active" data-jobid="${dataJobId}">
    ${publicLink ? `<a class="job-name" href="/job_detail/${JOB.jobId}.html">${JOB.title}</a>` : `<span class="job-name">${JOB.title}</span>`}
    <a class="company-name" href="/gongsi/fixture.html">${JOB.company}</a><span class="job-salary">20-30K</span></li>`;
  f.doc.body.prepend(list);
  return list.firstElementChild;
}

test('无公开链接卡片的加密 data ID 与数字详情 ID 可完成一次点击、官方确认及关框', { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const card = mountSelectedCard(f, { publicLink: false, dataJobId: JOB.jobId });
  const expected = f.BH.readJobCard(card), snapshot = f.BH.extractJobSnapshot(expected);
  assert.equal(expected.jobId, '');
  assert.equal(expected.dataJobId, JOB.jobId);
  assert.equal(snapshot.ok, true, snapshot.reason);
  const job = f.BH.jobFromSnapshot(snapshot, expected);
  const slot = await f.BH.reserveDelivery(job.jobId, 10);
  let clicks = 0, notice;
  f.button.addEventListener('click', () => { clicks++; notice = f.addNotice('已向BOSS发送消息'); });
  const result = await f.BH.performOfficialContact(f.button, expected,
    () => f.BH.snapshotStillCurrent(snapshot, expected, job, card), slot);
  assert.equal(clicks, 1);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.dialogClosed, true);
  assert.equal(notice.isConnected, false);
  assert.equal(f.BH.loadStats().sent, 1);
  assert.equal(f.BH.loadStats().pending, 0);
  assert.equal(f.BH.state.stopFlag, false);
});

test('详情无公开链接且页头 data 是公开别名，成功框隐藏原详情后仍确认并关闭', { timeout: 8000 }, async (t) => {
  const f = await fixture(t), card = mountSelectedCard(f);
  f.doc.querySelector('.job-detail-link').remove();
  f.doc.querySelector('.job-banner').setAttribute('data-job-id', JOB.jobId);
  const expected = f.BH.readJobCard(card), snapshot = f.BH.extractJobSnapshot(expected);
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.equal(snapshot.jobId, JOB.jobId);
  assert.equal(snapshot.dataJobId, JOB.dataJobId);
  const job = f.BH.jobFromSnapshot(snapshot, expected);
  const slot = await f.BH.reserveDelivery(job.jobId, 10);
  let clicks = 0, notice;
  f.button.addEventListener('click', () => {
    clicks++;
    f.doc.querySelector('.job-detail').hidden = true;
    notice = f.addNotice('已向BOSS发送消息');
  });
  const result = await f.BH.performOfficialContact(f.button, expected,
    () => f.BH.snapshotStillCurrent(snapshot, expected, job, card), slot);
  assert.equal(clicks, 1);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.dialogClosed, true);
  assert.equal(notice.isConnected, false);
  assert.equal(f.BH.loadStats().sent, 1);
  assert.equal(f.BH.loadStats().pending, 0);
  assert.equal(f.BH.state.stopFlag, false);
});

test('公开别名兼容不能掩盖真实内部 ID 冲突或同标题其他公开 ID', async (t) => {
  const f = await fixture(t), card = mountSelectedCard(f);
  const before = f.context();
  f.addNotice('已向BOSS发送消息');
  card.dataset.jobid = '999999';
  assert.equal(f.BH.readOfficialContactResult(before), null, '公开 ID 相同但数字内部 ID 不同仍拒绝');
  card.dataset.jobid = JOB.dataJobId;
  card.querySelector('.job-name').href = '/job_detail/otherPublicJob.html';
  assert.equal(f.BH.readOfficialContactResult(before), null, '标题公司相同但公开 ID 不同仍拒绝');
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

test('官方回执核验不重读职位正文，正文解析变慢也不阻止确认', async (t) => {
  const f = await fixture(t), before = f.context();
  const bodyText = f.doc.querySelector('.job-sec-text').firstChild;
  const originalText = bodyText.nodeValue;
  let reads = 0;
  Object.defineProperty(bodyText, 'nodeValue', { configurable: true, get() { reads++; return originalText; } });
  f.button.textContent = '继续沟通';
  assert.equal(f.BH.readOfficialContactResult(before)?.status, 'confirmed');
  f.addNotice('已向BOSS发送消息');
  assert.equal(f.BH.readOfficialContactResult(before)?.status, 'confirmed');
  assert.equal(reads, 0, '点击前已经验证过完整JD，回执阶段只需核对身份和官方提示');
});

test('详情全隐藏时深层选中态切B，混合面板更新也须永久作废A的回执', async (t) => {
  const f = await fixture(t), card = mountSelectedCard(f);
  card.classList.remove('active');
  card.querySelector('.job-name').classList.add('selected');
  const before = f.context();
  assert.equal(before.identity.ok, true);
  f.doc.querySelector('.job-detail').hidden = true;
  const link = card.querySelector('.job-name');
  link.href = '/job_detail/anotherHiddenJob.html';
  f.doc.querySelector('.bh-log').insertAdjacentHTML('beforeend', '<p>面板统计更新</p>');
  await delay(0);
  assert.equal(before.invalidated, true, '没有可见详情时仍核对完整外层选中卡片的身份');
  link.href = `/job_detail/${JOB.jobId}.html`;
  f.doc.querySelector('.job-detail').hidden = false;
  f.addNotice('已向BOSS发送消息');
  assert.equal(f.BH.readOfficialContactResult(before), null);
});

test('外部独立页头重建后发生内部ID冲突，正文根仍连接也不能认领回执', async (t) => {
  const f = await fixture(t, { detail: true });
  const header = f.doc.querySelector('.job-banner');
  f.doc.body.prepend(header);
  const before = f.context();
  assert.equal(before.identity.ok, true, before.identity.reason);
  assert.equal(before.identity.headerRoot, header);
  const replacement = header.cloneNode(true);
  replacement.dataset.jobid = 'anotherInternalJob';
  header.replaceWith(replacement);
  f.addNotice('已向BOSS发送消息');
  assert.equal(before.identity.root.isConnected, true);
  assert.equal(f.BH.readOfficialContactResult(before), null);
  assert.equal(before.invalidated, true);
});

test('多个可见详情中继续使用已匹配目标的范围，不把其他岗位回执按钮归给当前岗位', async (t) => {
  const f = await fixture(t), before = f.context();
  const other = f.doc.querySelector('.job-detail').cloneNode(true);
  other.dataset.jobid = 'anotherInternalJob';
  other.querySelector('.job-detail-link').href = '/job_detail/anotherPublicJob.html';
  other.querySelector('.op-btn-chat').textContent = '继续沟通';
  f.doc.body.append(other);
  assert.equal(f.BH.readOfficialContactResult(before), null, '其他详情的按钮变化不能作为当前岗位成功');
  f.button.textContent = '继续沟通';
  assert.equal(f.BH.readOfficialContactResult(before)?.status, 'confirmed');
});

test('同岗位空详情副本缺少公开链接，仍以共同内部ID确认本次回执', async (t) => {
  const f = await fixture(t), before = f.context();
  const mirror = f.doc.querySelector('.job-detail').cloneNode(true);
  mirror.querySelector('.job-detail-link').remove();
  mirror.querySelector('.job-sec-text').textContent = '';
  f.doc.body.append(mirror);
  await delay(0);
  assert.equal(f.BH.extractJobSnapshot(JOB).ok, true, '原完整详情和已核验岗位保持不变');
  f.addNotice('已向BOSS发送消息');
  assert.equal(f.BH.readOfficialContactResult(before)?.status, 'confirmed');
  assert.equal(before.invalidated, false, '缺少字段的同岗位镜像不能永久作废原回执');
});

test('只用公开ID选定目标时，两个详情的真实内部ID冲突仍阻止回执确认', async (t) => {
  const f = await fixture(t);
  const expected = { jobId: JOB.jobId, title: JOB.title, company: JOB.company };
  const before = f.BH.captureOfficialContactContext(expected, f.button);
  assert.equal(before.identity.ok, true);
  const mirror = f.doc.querySelector('.job-detail').cloneNode(true);
  mirror.dataset.jobid = 'anotherInternalJob';
  mirror.querySelector('.job-sec-text').textContent = '';
  f.doc.body.append(mirror);
  f.addNotice('已向BOSS发送消息');
  assert.equal(f.BH.readOfficialContactResult(before), null, '共享公开ID不能掩盖详情内部ID矛盾');
  assert.equal(before.invalidated, true);
});

test('同标题公司但没有强ID依据的多个独立详情，不能唯一认领本次回执', async (t) => {
  const f = await fixture(t);
  const root = f.doc.querySelector('.job-detail');
  root.removeAttribute('data-jobid');
  root.querySelector('.job-detail-link').remove();
  const expected = { title: JOB.title, company: JOB.company };
  const before = f.BH.captureOfficialContactContext(expected, f.button);
  assert.equal(before.identity.ok, true);
  const mirror = root.cloneNode(true);
  mirror.querySelector('.job-sec-text').textContent = '';
  f.doc.body.append(mirror);
  f.addNotice('已向BOSS发送消息');
  assert.equal(f.BH.readOfficialContactResult(before), null);
  assert.equal(before.invalidated, true);
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
  let dialog, closed = 0;
  const timers = [];
  registerTimerCleanup(t, timers);
  f.button.addEventListener('click', () => {
    f.button.textContent = '继续沟通';
    timers.push(setTimeout(() => {
      dialog = customSuccessDialog(f);
      dialog.querySelector('.cancel-btn').addEventListener('click', () => { closed++; dialog.remove(); });
    }, 100));
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

test('慢回执扫描跨过关框截止时间，已消失的成功框仍完成稳定确认', { timeout: 8000 }, async (t) => {
  const f = await fixture(t), slot = await f.BH.reserveDelivery(JOB.jobId, 10);
  let dialog, clicks = 0, scanCost = 0, slowScans = 0;
  const realNow = f.win.Date.now;
  f.win.Date.now = () => realNow() + scanCost;
  const querySelectorAll = f.doc.querySelectorAll;
  f.doc.querySelectorAll = function (selector) {
    if (dialog?.isConnected === false && selector.includes('.boss-dialog__wrapper')) {
      scanCost += 1300;
      slowScans++;
    }
    return querySelectorAll.call(this, selector);
  };
  f.button.addEventListener('click', () => { clicks++; dialog = f.addNotice('已向BOSS发送消息'); });
  const result = await f.BH.performOfficialContact(f.button, JOB, () => true, slot);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.dialogClosed, true, '慢查询消耗截止预算后仍完成已经开始的200ms隐藏稳定核验');
  assert.ok(slowScans >= 2, '模拟关框后的完整通知扫描超过原1200ms期限');
  assert.equal(dialog.isConnected, false);
  assert.equal(clicks, 1);
  assert.equal(f.BH.state.stopFlag, false);
  assert.equal(f.BH.loadStats().sent, 1);
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
  const timers = [];
  registerTimerCleanup(t, timers);
  timers.push(setTimeout(() => f.addNotice('招呼已发送'), 4300));
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

test('独立详情实际流程：无官方回执显示失败原因、保留占额且不会注入旧话术', { timeout: 8000 }, async (t) => {
  const f = await fixture(t, { detail: true });
  const input = f.doc.createElement('textarea'); input.id = 'chat-input'; input.value = '用户正在编辑的消息'; f.doc.body.append(input);
  let clicks = 0;
  f.button.addEventListener('click', () => { clicks++; f.BH.state.stopFlag = true; });
  assert.equal(await f.BH.autoChatOnDetail(), true);
  assert.equal(clicks, 1);
  assert.equal(f.BH.loadStats().sent, 1);
  assert.equal(f.BH.loadStats().pending, 0);
  assert.match(f.logs(), /失败.*未收到.*官方.*回执/);
  assert.doesNotMatch(f.logs(), /待确认/);
  assert.doesNotMatch(f.logs(), /官方已确认沟通|已发送|已招呼/);
  assert.equal(input.value, '用户正在编辑的消息');
  assert.equal(await f.BH.reserveDelivery(JOB.jobId, 10), false, '未确认也不能重复发起同一职位');
});

test('独立详情实际流程：官方确认后才记成功，保持一次占额', { timeout: 8000 }, async (t) => {
  const f = await fixture(t, { detail: true });
  f.button.addEventListener('click', () => { f.addNotice('已向BOSS发送消息'); f.BH.state.stopFlag = true; });
  assert.equal(await f.BH.autoChatOnDetail(), true);
  assert.match(f.logs(), /官方已确认沟通/);
  assert.doesNotMatch(f.logs(), /失败|待确认/);
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
