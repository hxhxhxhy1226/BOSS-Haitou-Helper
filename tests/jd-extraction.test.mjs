/**
 * BOSS 海投助手 1.0.24：详情采集、字段边界和 SPA 切换稳定性回归。
 * 运行：node --test tests/jd-extraction.test.mjs
 * 所有页面为 jsdom fixture；禁用外部请求与实际沟通操作。
 */
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const code = fs.readFileSync(SCRIPT, 'utf8');
const LIST_URL = 'https://www.zhipin.com/web/geek/job?query=test';
const A = { title: '嵌入式软件工程师', company: '甲研发有限公司', jobId: 'a12XYZ_-old', dataJobId: '10001' };
const B = { title: 'DSP 软件工程师', company: '乙研发有限公司', jobId: 'b34XYZ_-new', dataJobId: '10002' };
const OLD_JD = '负责旧型号控制器维护，使用旧平台通信协议完成设备升级。';
const NEW_JD = '负责新型号 DSP 固件研发，开发高速数据采集和信号处理算法。';
const WAIT = { timeoutMs: 1000, pollMs: 10, stableMs: 60, requireChange: true };
const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function header(job, salary = '8-13K') {
  return `<header class="job-banner">
    <h1 class="job-name">${esc(job.title)}</h1>
    <a class="company-name" href="/gongsi/test.html">${esc(job.company)}</a>
    <span class="salary">${esc(salary)}</span>
    <div class="job-require"><span>湘潭</span><span>3-5年</span><span>本科</span></div>
    <a class="job-detail-link" href="/job_detail/${esc(job.jobId)}.html?lid=fixture">查看职位</a>
    <a class="op-btn-chat" href="javascript:void(0)">立即沟通</a>
  </header>`;
}

function detail(job = A, jd = OLD_JD, extra = '', attrs = '') {
  return `<section class="job-detail" data-jobid="${esc(job.dataJobId)}" ${attrs}>
    ${header(job)}
    <div class="job-tags"><span>STM32开发</span><span>DSP开发</span></div>
    <section class="job-detail-section"><h2>职位描述</h2><div class="job-sec-text">${jd}</div></section>
    <div class="boss-info"><span class="name">陈经理</span><span class="active-time">3天前活跃</span></div>
    ${extra}
  </section>`;
}

function card(job = B, salaryMarkup = '<span class="job-salary">8-13K</span>', companyMarkup) {
  return `<li class="job-card-box" data-jobid="${esc(job.dataJobId)}">
    <a class="job-name" href="/job_detail/${esc(job.jobId)}.html?securityId=fixture">${esc(job.title)}</a>
    ${salaryMarkup}
    <ul class="tag-list"><li>3-5年</li><li>本科</li><li>STM32开发</li></ul>
    <div class="job-info">负责产品固件开发。</div>
    ${companyMarkup ?? `<a class="company-name" href="/gongsi/test.html">${esc(job.company)}</a>`}
    <div class="job-card-footer"><span class="name">王先生</span><span class="time">刚刚活跃</span></div>
  </li>`;
}

function mountWithCard(detailMarkup = detail(), target = B) {
  return `<ul class="job-list-wrapper">${card(target)}</ul><main id="detail-host">${detailMarkup}</main>`;
}

async function fixture(t, html, url = LIST_URL) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  const values = new Map();
  let networkCalls = 0;
  win.GM_getValue = (key, fallback) => values.has(key) ? values.get(key) : fallback;
  win.GM_setValue = (key, value) => values.set(key, value);
  win.GM_addStyle = () => {};
  win.GM_xmlhttpRequest = () => { networkCalls++; throw new Error('采集测试禁止联网'); };
  win.fetch = () => { networkCalls++; throw new Error('采集测试禁止联网'); };
  win.unsafeWindow = win;

  const hidden = (el) => {
    for (let node = el; node?.nodeType === 1; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true'
        || node.style.display === 'none' || node.style.visibility === 'hidden') return true;
    }
    return false;
  };
  // jsdom 不做布局；只补尺寸与可见性，不改 DOM 文本/选择器/采集函数。
  Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { get() { return hidden(this) ? 0 : 600; } });
  Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { get() { return hidden(this) ? 0 : 300; } });
  win.Element.prototype.getBoundingClientRect = function () {
    const left = this.closest('.job-list-wrapper') ? 60 : 600;
    const width = hidden(this) ? 0 : 600;
    const height = hidden(this) ? 0 : 300;
    return { x: left, y: 180, left, top: 180, right: left + width, bottom: 180 + height, width, height, toJSON() {} };
  };
  win.Element.prototype.getClientRects = function () { return hidden(this) ? [] : [this.getBoundingClientRect()]; };
  win.eval(code);
  await delay(0);
  const BH = win.BH;
  BH.state.config = { ...BH.loadConfig(), aiEnabled: false, mustHave: [], mustNot: [], activeDays: 0, autoSend: false };
  t.after(() => {
    BH.state.stopFlag = true;
    BH.state.paused = false;
    dom.window.close();
    assert.equal(networkCalls, 0, '采集测试不得产生外部请求');
  });
  return {
    win, doc: win.document, BH,
    expected: () => BH.readJobCard(win.document.querySelector('.job-card-box')),
    host: () => win.document.getElementById('detail-host'),
  };
}

test('隐藏旧详情与其他职位卡片不会混入当前 JD', async (t) => {
  const f = await fixture(t, mountWithCard(
    detail(A, '隐藏的旧岗位要求先缴培训费。', '', 'style="display:none"') + detail(B, NEW_JD), B));
  const snapshot = f.BH.extractJobSnapshot(f.expected());
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.equal(snapshot.title, B.title);
  assert.equal(snapshot.company, B.company);
  assert.match(snapshot.description, /新型号 DSP/);
  assert.doesNotMatch(snapshot.description, /培训费|旧岗位/);
  assert.equal(snapshot.root.classList.contains('job-detail'), true);
});

test('详情中的推荐卡、隐藏内容、网页按钮与脚本面板不作为正文', async (t) => {
  const polluted = `<p>${NEW_JD}</p>
    <p style="display:none">旧详情要求培训收费。</p>
    <aside class="job-recommend"><ul>${card({ ...A, title: '外包推荐岗位' })}</ul></aside>
    <button>立即沟通</button><div id="bh-detail-modal">诊断排除词：培训 外包 销售</div>`;
  const f = await fixture(t, mountWithCard(detail(B, polluted), B));
  const snapshot = f.BH.extractJobSnapshot(f.expected());
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.match(snapshot.description, /新型号 DSP/);
  assert.doesNotMatch(snapshot.description, /外包推荐岗位|培训收费|诊断排除词|立即沟通/);
  const panel = f.doc.getElementById('boss-helper-panel');
  assert.equal(f.BH.readScopedText(panel), '');
});

test('readScopedText 保留段落、换行和否定关系，默认排除列表卡片', async (t) => {
  const f = await fixture(t, `<div id="scope"><p>本岗位不属于</p><p>外包</p><p>不收培训费。<br>负责研发。</p>${card()}</div>`);
  const scoped = f.BH.readScopedText(f.doc.getElementById('scope'));
  assert.match(scoped, /本岗位不属于\s*\n\s*外包/);
  assert.match(scoped, /不收培训费。\s*\n\s*负责研发。/);
  assert.doesNotMatch(scoped, /DSP 软件工程师|乙研发有限公司/);
  const targetCard = f.doc.querySelector('.job-card-box');
  assert.equal(f.BH.readScopedText(targetCard), '');
  assert.match(f.BH.readScopedText(targetCard, { allowCard: true }), /DSP 软件工程师/);
});

test('同一正文被父子选择器命中时只采集一次', async (t) => {
  const line = '负责芯片底层驱动研发，并对生产人员开展技术培训。';
  const f = await fixture(t, mountWithCard(detail(B, `<div class="job-description"><p>${line}</p></div>`), B));
  const snapshot = f.BH.extractJobSnapshot(f.expected());
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.equal(snapshot.description.split(line).length - 1, 1);
});

test('公司介绍标题带按钮或隐藏装饰时，仍不把公司业务当岗位职责', async (t) => {
  const jd = `<p>${NEW_JD}</p><h3>公司介绍<button>展开</button><span hidden>辅助标题</span></h3>
    <p>公司业务包括培训招生、劳务派遣和外包服务。</p>`;
  const f = await fixture(t, mountWithCard(detail(B, jd), B));
  const result = f.BH.extractJobSnapshot(f.expected());
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.description.includes(NEW_JD));
  assert.doesNotMatch(result.description, /培训招生|劳务派遣|外包服务/);
});

test('公司介绍在前、职位描述在后时只取后者，不丢整份 JD', async (t) => {
  const markup = `<section class="job-detail" data-jobid="${B.dataJobId}">${header(B)}
    <h3>公司介绍</h3><p>公司经营培训招生业务。</p>
    <h2>职位描述</h2><div><p>${NEW_JD}</p></div></section>`;
  const f = await fixture(t, mountWithCard(markup, B));
  const result = f.BH.extractJobSnapshot(f.expected());
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.description.includes(NEW_JD));
  assert.doesNotMatch(result.description, /公司经营培训招生/);
});

test('正文内的热门职位容器不污染当前职位', async (t) => {
  const jd = `<p>${NEW_JD}</p><div class="hot-jobs"><h3>热门职位</h3><p>热门培训兼职销售岗位</p></div>`;
  const f = await fixture(t, mountWithCard(detail(B, jd), B));
  const result = f.BH.extractJobSnapshot(f.expected());
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.description.includes(NEW_JD));
  assert.doesNotMatch(result.description, /热门培训兼职销售岗位/);
});

test('通用采集同样排除公司介绍，同时保留当前职位技术标签', async (t) => {
  const f = await fixture(t, mountWithCard(detail(B, NEW_JD, '<section class="company-intro"><p>公司培训业务与岗位无关。</p></section>'), B));
  const root = f.doc.querySelector('.job-detail');
  const text = f.BH.collectText(['.company-intro', '.job-tags', '.job-sec-text'], root);
  assert.ok(text.includes(NEW_JD));
  assert.match(text, /STM32开发/);
  assert.doesNotMatch(text, /公司培训业务/);
});

test('可信根内只有职位描述标题时，不越界读取根外兄弟正文', async (t) => {
  const f = await fixture(t, '<section class="job-detail"><h2>职位描述</h2></section><p>这是根外的培训招生信息。</p>');
  const root = f.doc.querySelector('.job-detail');
  assert.equal(f.BH.collectJobDescriptionText(root), '');
});

for (const [name, jd] of [
  ['短 JD', '负责收银。'],
  ['非技术岗位', '负责前台来访登记、客户接待和办公用品管理，整理日常行政记录。'],
  ['含旧版噪音关键词的真实职责', '负责消息队列、日志搜索、推荐算法和简历解析模块开发，参与研发招聘技术面试。'],
]) {
  test(name + '仍按结构采集，不依赖技术词或长度阈值', async (t) => {
    const target = { ...B, title: '行政助理' };
    const f = await fixture(t, mountWithCard(detail(target, jd), target));
    const snapshot = f.BH.extractJobSnapshot(f.expected());
    assert.equal(snapshot.ok, true, snapshot.reason);
    assert.ok(snapshot.description.includes(jd), snapshot.description);
  });
}

test('超过 2500 字的可信正文完整采集，截断交给后续 AI 输入预算', async (t) => {
  const lines = Array.from({ length: 120 }, (_, i) =>
    `第${i + 1}条职责：负责消息队列与设备驱动研发，参与产品质量验证并维护技术设计文档。`);
  const f = await fixture(t, mountWithCard(detail(B, lines.map((line) => `<p>${line}</p>`).join('')), B));
  const snapshot = f.BH.extractJobSnapshot(f.expected());
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.ok(snapshot.description.length > 2500);
  assert.ok(snapshot.description.includes(lines[0]));
  assert.ok(snapshot.description.includes(lines.at(-1)));
});

test('没有可信详情容器时返回失败，不从整页或列表卡片拼凑 JD', async (t) => {
  const f = await fixture(t, `<h1>嵌入式软件工程师</h1><div>职位描述：广告中的培训信息</div><ul>${card()}</ul>`);
  assert.equal(f.BH.getDetailRoot(), null);
  assert.equal(f.BH.collectJobDescriptionText(), '');
  const snapshot = f.BH.extractJobSnapshot(f.expected());
  assert.equal(snapshot.ok, false);
  assert.ok(snapshot.reason);
});

test('同标题不同公司与同标题同公司不同公开职位 ID 均拒绝串单', async (t) => {
  const sameTitle = { ...B, title: A.title };
  const f = await fixture(t, mountWithCard(detail(A, OLD_JD), sameTitle));
  assert.equal(f.BH.extractJobSnapshot(f.expected()).ok, false, '公司/公开职位 ID 不同不能复用旧正文');
  const sameCompany = { ...sameTitle, company: A.company };
  f.doc.querySelector('.job-list-wrapper').innerHTML = card(sameCompany);
  assert.equal(f.BH.extractJobSnapshot(f.expected()).ok, false, '只看标题公司会漏掉公开职位 ID 冲突');
});

test('完整公开 URL ID 支持大小写、下划线、连字符和 .html，不与内部数字 ID 混比', async (t) => {
  const target = { ...B, jobId: 'af00XYZ_ab-CD12', dataJobId: '987654' };
  const f = await fixture(t, mountWithCard(detail(target, NEW_JD), target));
  const expected = f.expected();
  assert.equal(expected.jobId, 'af00XYZ_ab-CD12');
  assert.equal(String(expected.dataJobId), '987654');
  const snapshot = f.BH.extractJobSnapshot(expected);
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.equal(snapshot.jobId, expected.jobId);
  assert.equal(String(snapshot.dataJobId), '987654');
});

test('列表 data-jobid 是公开加密 ID、详情是数字内部 ID 时确认同一岗位', async (t) => {
  const target = { ...B, title: '机器人嵌入式软件工程师（校招）', company: 'Dobot' };
  const f = await fixture(t, mountWithCard(detail(target, NEW_JD), { ...target, dataJobId: target.jobId }));
  const expected = f.expected();
  assert.equal(expected.jobId, target.jobId);
  assert.equal(expected.dataJobId, '', '公开链接的别名不能留在内部 ID 字段');
  const snapshot = await f.BH.waitForJobSnapshot(expected, { ...WAIT, requireChange: false });
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.equal(snapshot.jobId, target.jobId);
  assert.equal(snapshot.dataJobId, target.dataJobId);
});

test('详情页头的公开 data ID 与正文的数字内部 ID 不造成歧义', async (t) => {
  const markup = detail(B, NEW_JD).replace('<header class="job-banner">',
    `<header class="job-banner" data-job-id="${B.jobId}">`);
  const f = await fixture(t, mountWithCard(markup, B));
  const snapshot = f.BH.extractJobSnapshot(f.expected());
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.equal(snapshot.dataJobId, B.dataJobId);
});

test('无详情公开链接时，已知目标公开 ID 仍可辨认 data ID 别名', async (t) => {
  const markup = detail({ ...B, dataJobId: B.jobId }, NEW_JD)
    .replace(/<a class="job-detail-link"[^>]*>[\s\S]*?<\/a>/g, '');
  const f = await fixture(t, mountWithCard(markup, B));
  const snapshot = f.BH.extractJobSnapshot(f.expected());
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.equal(snapshot.jobId, B.jobId);
  assert.equal(snapshot.dataJobId, '');
});

test('已知公开 ID 的 data 别名不会掩盖真正的内部 ID 冲突或另一职位', async (t) => {
  const extra = `<span data-job-id="${B.jobId}"></span>`;
  const f = await fixture(t, mountWithCard(detail({ ...B, dataJobId: A.dataJobId }, NEW_JD, extra), B));
  assert.equal(f.BH.extractJobSnapshot(f.expected()).ok, false, '数字内部 ID 冲突仍拒绝');
  f.host().innerHTML = detail({ ...B, jobId: A.jobId, dataJobId: A.jobId }, NEW_JD);
  assert.equal(f.BH.extractJobSnapshot(f.expected()).ok, false, '标题公司相同但公开 ID 不同仍拒绝');
});

test('无公开链接的 data ID 与另一侧公开 ID 相等时可核验，标题冲突仍拒绝', async (t) => {
  const f = await fixture(t, mountWithCard(detail(B, NEW_JD), B));
  const opaqueCard = { dataJobId: B.jobId, title: B.title, company: B.company };
  const snapshot = f.BH.extractJobSnapshot(f.expected());
  assert.equal(f.BH.matchSnapshotIdentity(snapshot, opaqueCard).ok, true);
  assert.equal(f.BH.matchSnapshotIdentity(opaqueCard, snapshot).ok, true);
  assert.equal(f.BH.matchSnapshotIdentity(snapshot, { ...opaqueCard, title: A.title }).ok, false);
});

for (const experience of ['在校/应届', '在校生', '在校/应届生', '在校／应届']) {
  test('校招标签保留真实经验字段：' + experience, async (t) => {
    const f = await fixture(t, mountWithCard(detail(B, NEW_JD).replace('<span>3-5年</span>', `<span>${experience}</span>`), B));
    const snapshot = f.BH.extractJobSnapshot(f.expected());
    assert.equal(snapshot.ok, true, snapshot.reason);
    assert.equal(snapshot.experience, experience);
  });
}

test('职位 ID 相同但标题或公司与目标明显冲突仍不放行', async (t) => {
  const wrongTitle = { ...B, title: '电话销售工程师' };
  const f = await fixture(t, mountWithCard(detail(wrongTitle, NEW_JD), B));
  assert.equal(f.BH.extractJobSnapshot(f.expected()).ok, false);
  f.host().innerHTML = detail({ ...B, company: '另一家企业' }, NEW_JD);
  assert.equal(f.BH.extractJobSnapshot(f.expected()).ok, false);
});

test('标题先更新正文后更新时，必须等待新正文稳定', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, mountWithCard(detail(A, OLD_JD), B));
  const previous = f.BH.extractJobSnapshot();
  assert.equal(previous.ok, true, previous.reason);
  const root = f.doc.querySelector('.job-detail');
  root.dataset.jobid = B.dataJobId;
  root.querySelector('.job-banner').outerHTML = header(B);
  let settled = false;
  const waiting = f.BH.waitForJobSnapshot(f.expected(), { ...WAIT, previous, timeoutMs: 3000 }).then((s) => { settled = true; return s; });
  await delay(100);
  assert.equal(settled, false, '新标题不能配上上一份 JD 立即通过');
  root.querySelector('.job-sec-text').textContent = NEW_JD;
  const snapshot = await waiting;
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.equal(snapshot.title, B.title);
  assert.ok(snapshot.description.includes(NEW_JD));
  assert.ok(!snapshot.description.includes(OLD_JD));
});

test('点击后仍显示上一职位时持续等待，目标出现后才开始稳定计时', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, mountWithCard(detail(A, OLD_JD), B));
  const previous = f.BH.extractJobSnapshot();
  let settled = false;
  const update = delay(80).then(() => { f.host().innerHTML = detail(B, NEW_JD); });
  const waiting = f.BH.waitForJobSnapshot(f.expected(), { ...WAIT, previous, timeoutMs: 3000 }).then((s) => { settled = true; return s; });
  await delay(0);
  assert.equal(settled, false, '初次读到上一职位应重试，不能立即跳过');
  await update;
  const result = await waiting;
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.description.includes(NEW_JD));
});

test('详情尚未出现时允许异步加载，出现后校验身份和正文', { timeout: 2500 }, async (t) => {
  const f = await fixture(t, mountWithCard('', B));
  const previous = f.BH.extractJobSnapshot();
  const waiting = f.BH.waitForJobSnapshot(f.expected(), { ...WAIT, previous });
  await delay(80);
  f.host().innerHTML = detail(B, NEW_JD);
  const result = await waiting;
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.jobId, B.jobId);
  assert.ok(result.description.includes(NEW_JD));
});

test('详情根换成新节点但正文仍旧时不能把 DOM 替换当作 JD 更新', { timeout: 2500 }, async (t) => {
  const f = await fixture(t, mountWithCard(detail(A, OLD_JD), B));
  const previous = f.BH.extractJobSnapshot();
  f.host().innerHTML = detail(B, OLD_JD);
  const result = await f.BH.waitForJobSnapshot(f.expected(), { ...WAIT, previous, timeoutMs: 240 });
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});

test('已选中同一目标时无需强迫正文变化，稳定后可继续', { timeout: 2500 }, async (t) => {
  const f = await fixture(t, mountWithCard(detail(B, NEW_JD), B));
  const previous = f.BH.extractJobSnapshot();
  const result = await f.BH.waitForJobSnapshot(f.expected(), { ...WAIT, previous });
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.description.includes(NEW_JD));
});

test('正文尚在变化时持续等待，返回的是稳定后的完整版本', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, mountWithCard(detail(A, OLD_JD), B));
  const previous = f.BH.extractJobSnapshot();
  f.host().innerHTML = detail(B, '新岗位职责正在加载第一段内容。');
  // 先注册页面更新，避免 jsdom 同步采集的开销改变更新与轮询的定时器顺序。
  const update = delay(60).then(() => { f.doc.querySelector('.job-sec-text').textContent = NEW_JD; });
  const waiting = f.BH.waitForJobSnapshot(f.expected(), { ...WAIT, previous, stableMs: 140, timeoutMs: 3000 });
  await update;
  const result = await waiting;
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.description.includes(NEW_JD));
  assert.doesNotMatch(result.description, /正在加载第一段/);
});

test('无详情超时返回失败，停止信号中断等待', { timeout: 2500 }, async (t) => {
  const f = await fixture(t, mountWithCard('', B));
  const absent = await f.BH.waitForJobSnapshot(f.expected(), { ...WAIT, timeoutMs: 150 });
  assert.equal(absent.ok, false);
  const waiting = f.BH.waitForJobSnapshot(f.expected(), { ...WAIT, timeoutMs: 1000 });
  await delay(30);
  f.BH.state.stopFlag = true;
  const stopped = await waiting;
  assert.equal(stopped.ok, false);
  assert.match(stopped.reason, /停止|stop/i);
});

test('暂停期间不返回可投递快照，恢复后重新等待稳定', { timeout: 2500 }, async (t) => {
  const f = await fixture(t, mountWithCard(detail(B, NEW_JD), B));
  const previous = f.BH.extractJobSnapshot();
  f.BH.state.paused = true;
  let settled = false;
  const waiting = f.BH.waitForJobSnapshot(f.expected(), { ...WAIT, previous }).then((s) => { settled = true; return s; });
  await delay(100);
  assert.equal(settled, false);
  f.BH.state.paused = false;
  const result = await waiting;
  assert.equal(result.ok, true, result.reason);
});

test('独立详情页的页头和正文相邻时可绑定同一职位', async (t) => {
  const standalone = `${header(B)}<main class="job-detail"><section class="job-sec"><h2>职位描述</h2>
    <div class="job-sec-text"><p>${NEW_JD}</p></div></section>
    <div class="boss-info"><span class="name">赵女士</span><span class="active-time">刚刚活跃</span></div></main>`;
  const f = await fixture(t, standalone, `https://www.zhipin.com/job_detail/${B.jobId}.html`);
  const result = f.BH.extractJobSnapshot(B);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.title, B.title);
  assert.equal(result.company, B.company);
  assert.ok(result.description.includes(NEW_JD));
  assert.ok(result.headerRoot && result.root);
});

test('活跃状态仅来自当前详情，旧详情/列表在线徽标和正文词语不污染', async (t) => {
  const current = detail(B, '负责在线消息队列处理，试用期半年内可参与研发。');
  const stale = detail(A, OLD_JD, '<span class="active-time">在线</span>', 'hidden');
  const f = await fixture(t, mountWithCard(stale + current, B));
  const result = f.BH.extractJobSnapshot(f.expected());
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.BH.parseActiveDays(result.activeText), 3, result.activeText);
  assert.doesNotMatch(result.activeText, /半年内|在线消息/);
});

test('卡片字段分开提取，缺公司时不会把 HR 姓名当公司', async (t) => {
  const f = await fixture(t, `<ul>${card(B, undefined, '')}</ul>`);
  const result = f.BH.readJobCard(f.doc.querySelector('.job-card-box'));
  assert.equal(result.title, B.title);
  assert.ok(!result.company || /未识别|未知/.test(result.company), result.company);
  assert.notEqual(result.company, '王先生');
  assert.equal(result.experience, '3-5年');
  assert.equal(result.education, '本科');
  assert.match(result.hrText, /刚刚活跃/);
});

for (const [name, attrs, expected] of [
  ['title 备用文本', 'title="8-13K"', '8-13K'],
  ['aria-label 备用文本', 'aria-label="薪资 9-14K"', '9-14K'],
  ['data-salary 备用文本', 'data-salary="10-15K"', '10-15K'],
  ['没有可读备用文本', '', null],
]) {
  test('PUA 薪资：' + name, async (t) => {
    const encoded = '\uE039-\uE032\uE034K';
    const f = await fixture(t, `<ul>${card(B, `<span class="job-salary" ${attrs}>${encoded}</span>`)}</ul>`);
    const result = f.BH.readJobCard(f.doc.querySelector('.job-card-box'));
    assert.equal(result.salaryRaw, encoded);
    if (expected) assert.ok(result.salary.includes(expected), result.salary);
    else {
      assert.equal(f.BH.parseSalaryK(result.salary), null);
      assert.doesNotMatch(result.salary || '', /[\uE000-\uF8FF]/);
    }
  });
}

test('首个薪资节点乱码时继续找 scope 内的其他可读薪资', async (t) => {
  const encoded = '\uE039-\uE032\uE034K';
  const salary = `<span class="job-salary">${encoded}</span><span class="salary">8-13K</span>`;
  const f = await fixture(t, `<ul>${card(B, salary)}</ul>`);
  const result = f.BH.readJobCard(f.doc.querySelector('.job-card-box'));
  assert.ok(result.salary.includes('8-13K'), result.salary);
  assert.equal(f.BH.parseSalaryK(result.salary), 8);
});

for (const [name, alternative] of [
  ['隐藏节点', '<span class="salary" hidden>8-13K</span>'],
  ['推荐区', '<aside class="job-recommend"><span class="salary">8-13K</span></aside>'],
  ['公司辅助信息', '<div class="company-intro"><span class="salary">8-13K</span></div>'],
]) {
  test('首个薪资乱码时，不借用' + name + '中的数字', async (t) => {
    const encoded = '\uE039-\uE032\uE034K';
    const f = await fixture(t, `<ul>${card(B, `<span class="job-salary">${encoded}</span>${alternative}`)}</ul>`);
    const result = f.BH.readJobCard(f.doc.querySelector('.job-card-box'));
    assert.equal(f.BH.parseSalaryK(result.salary), null, result.salary);
    assert.equal(result.salaryRaw, encoded);
  });
}

test('详情薪资也使用可读辅助文本，不能把乱码当作工资数字', async (t) => {
  const encoded = '\uE039-\uE032\uE034K';
  const markup = detail(B, NEW_JD).replace('<span class="salary">8-13K</span>', `<span class="salary" title="8-13K">${encoded}</span>`);
  const f = await fixture(t, mountWithCard(markup, B));
  const result = f.BH.extractJobSnapshot(f.expected());
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.salary.includes('8-13K'), result.salary);
  assert.equal(f.BH.parseSalaryK(result.salary), 8);
});

test('humanClick 只派发一次 click，不把 dispatchEvent 和原生 click 叠加', { timeout: 4000 }, async (t) => {
  const f = await fixture(t, '<button id="target">测试按钮</button>');
  const button = f.doc.getElementById('target');
  let clicks = 0;
  button.addEventListener('click', () => { clicks++; });
  assert.equal(await f.BH.humanClick(button), true);
  assert.equal(clicks, 1);
});

for (const change of ['guard 失效', '停止', '暂停', '节点断连']) {
  test('humanClick 延迟期间' + change + '后不再 click', { timeout: 4000 }, async (t) => {
    const f = await fixture(t, '<button id="target">测试按钮</button>');
    const button = f.doc.getElementById('target');
    let clicks = 0;
    let valid = true;
    button.addEventListener('click', () => { clicks++; });
    const pending = f.BH.humanClick(button, change === 'guard 失效' ? () => valid : undefined);
    await delay(30);
    if (change === 'guard 失效') valid = false;
    if (change === '停止') f.BH.state.stopFlag = true;
    if (change === '暂停') f.BH.state.paused = true;
    if (change === '节点断连') button.remove();
    assert.equal(await pending, false);
    assert.equal(clicks, 0);
  });
}

test('humanClick 在 mousedown 后失去 guard 也不再发 click', { timeout: 4000 }, async (t) => {
  const f = await fixture(t, '<button id="target">测试按钮</button>');
  const button = f.doc.getElementById('target');
  let valid = true;
  let clicks = 0;
  button.addEventListener('mousedown', () => { valid = false; });
  button.addEventListener('click', () => { clicks++; });
  assert.equal(await f.BH.humanClick(button, () => valid), false);
  assert.equal(clicks, 0);
});

test('沟通按钮只从核验过的详情 scope 获取，不回退整页或推荐卡', async (t) => {
  const outside = '<a id="outside-chat" class="op-btn-chat">立即沟通</a>';
  const recommended = '<div class="job-card-wrap"><a id="recommended-chat" class="op-btn-chat">立即沟通</a></div>';
  const f = await fixture(t, outside + mountWithCard(detail(B, NEW_JD, recommended), B));
  const snapshot = f.BH.extractJobSnapshot(f.expected());
  assert.equal(snapshot.ok, true, snapshot.reason);
  const correct = snapshot.headerRoot.querySelector('.op-btn-chat');
  assert.equal(f.BH.snapshotChatButton(snapshot), correct);
  correct.remove();
  assert.equal(f.BH.snapshotChatButton(snapshot), null);
});

test('沟通按钮被禁用或隐藏时，scope 查找不会选择它', async (t) => {
  const f = await fixture(t, mountWithCard(detail(B, NEW_JD), B));
  const snapshot = f.BH.extractJobSnapshot(f.expected());
  const button = snapshot.headerRoot.querySelector('.op-btn-chat');
  button.setAttribute('aria-disabled', 'true');
  assert.equal(f.BH.snapshotChatButton(snapshot), null);
  button.removeAttribute('aria-disabled');
  button.style.display = 'none';
  assert.equal(f.BH.snapshotChatButton(snapshot), null);
});

test('详情缺薪资时，卡片补充薪资改变会使发送前快照检查失败', async (t) => {
  const f = await fixture(t, mountWithCard(detail(B, NEW_JD).replace('<span class="salary">8-13K</span>', ''), B));
  const cardEl = f.doc.querySelector('.job-card-box');
  const expected = f.expected();
  const snapshot = f.BH.extractJobSnapshot(expected);
  assert.equal(snapshot.ok, true, snapshot.reason);
  const job = f.BH.jobFromSnapshot(snapshot, expected);
  assert.equal(job.salary, '8-13K');
  assert.equal(f.BH.snapshotStillCurrent(snapshot, expected, job, cardEl), true);
  cardEl.querySelector('.job-salary').textContent = '10-15K';
  assert.equal(f.BH.snapshotStillCurrent(snapshot, expected, job, cardEl), false);
});

test('name 容器内同时有 h1 和薪资时，标题只取 h1', async (t) => {
  const markup = detail(B, NEW_JD).replace(
    `<h1 class="job-name">${B.title}</h1>`,
    `<div class="name"><h1>${B.title}</h1><span class="salary">8-13K</span></div>`);
  const f = await fixture(t, mountWithCard(markup, B));
  const snapshot = f.BH.extractJobSnapshot(f.expected());
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.equal(snapshot.title, B.title);
});

test('独立详情页 URL 与 DOM 的公开 ID 冲突时不以 URL 覆盖冲突', async (t) => {
  const wrong = { ...B, jobId: 'c56XYZ_-different' };
  const f = await fixture(t, detail(wrong, NEW_JD), `https://www.zhipin.com/job_detail/${B.jobId}.html`);
  const result = f.BH.extractJobSnapshot({ jobId: B.jobId });
  assert.equal(result.ok, false);
  assert.ok(result.reason);
  const waited = await f.BH.waitForJobSnapshot({ jobId: B.jobId }, { ...WAIT, requireChange: false, timeoutMs: 150 });
  assert.equal(waited.ok, false);
});

test('根和页头的内部职位 ID 冲突时，内层正文候选也不能绕过校验', async (t) => {
  const markup = detail(B, NEW_JD)
    .replace(`data-jobid="${B.dataJobId}"`, `data-jobid="${A.dataJobId}"`)
    .replace('<header class="job-banner">', `<header class="job-banner" data-jobid="${B.dataJobId}">`);
  const f = await fixture(t, mountWithCard(markup, B));
  assert.equal(f.BH.extractJobSnapshot(f.expected()).ok, false);
});

for (const [name, extra] of [
  ['多个公开 ID', `<a href="/job_detail/${A.jobId}.html">其他职位链接</a>`],
  ['多个内部 ID', `<div data-job-id="${A.dataJobId}">另一条内部职位信息</div>`],
]) {
  test('同一可信根出现' + name + '时明确拒绝，不把歧义当作缺失', async (t) => {
    const f = await fixture(t, mountWithCard(detail(B, NEW_JD, extra), B));
    const result = f.BH.extractJobSnapshot(f.expected());
    assert.equal(result.ok, false);
    assert.ok(result.reason);
  });
}

test('隐藏、推荐区与列表卡片中的其他 ID 不造成当前详情身份歧义', async (t) => {
  const noise = `<div hidden data-jobid="${A.dataJobId}"><a href="/job_detail/${A.jobId}.html">隐藏旧职位</a></div>
    <aside class="job-recommend"><div data-job-id="other"><a href="/job_detail/otherXYZ.html">推荐职位</a></div></aside>`;
  const f = await fixture(t, mountWithCard(detail(B, NEW_JD, noise), B) + `<ul>${card(A)}</ul>`);
  const result = f.BH.extractJobSnapshot(f.expected());
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.jobId, B.jobId);
});

test('同一职位 ID 重复出现在多个链接和属性时仍可识别', async (t) => {
  const extra = `<div data-job-id="${B.dataJobId}"><a href="/job_detail/${B.jobId}.html?duplicate=1">同一职位</a></div>`;
  const f = await fixture(t, mountWithCard(detail(B, NEW_JD, extra), B));
  const result = f.BH.extractJobSnapshot(f.expected());
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.jobId, B.jobId);
});

test('卡片本身存在多个公开 ID 时，身份比较两个方向以及无 expected 都拒绝', async (t) => {
  const f = await fixture(t, mountWithCard(detail(B, NEW_JD), B));
  const expected = f.expected();
  const snapshot = f.BH.extractJobSnapshot(expected);
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.equal(f.BH.matchSnapshotIdentity(snapshot, expected).ok, true);
  const other = f.doc.createElement('a');
  other.href = `/job_detail/${A.jobId}.html`;
  other.textContent = '另一职位链接';
  f.doc.querySelector('.job-card-box').appendChild(other);
  const ambiguous = f.expected();
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(f.BH.matchSnapshotIdentity(snapshot, ambiguous).ok, false);
  assert.equal(f.BH.matchSnapshotIdentity(ambiguous, snapshot).ok, false);
  assert.equal(f.BH.matchSnapshotIdentity(ambiguous).ok, false);
});

function withoutDOMJobId(markup) {
  return markup.replace(/\sdata-jobid="[^"]*"/g, '').replace(/<a class="job-detail-link"[^>]*>[\s\S]*?<\/a>/g, '');
}

test('初次独立页无 DOM ID 可使用 URL，但明确 DOM ID 仍标识其来源', async (t) => {
  const f = await fixture(t, withoutDOMJobId(detail(B, NEW_JD)), `https://www.zhipin.com/job_detail/${B.jobId}.html`);
  const fromURL = f.BH.extractJobSnapshot({ jobId: B.jobId });
  assert.equal(fromURL.ok, true, fromURL.reason);
  assert.equal(fromURL.jobId, B.jobId);
  assert.equal(fromURL.jobIdSource, 'url');
  f.doc.querySelector('.job-banner').innerHTML = header(B).replace(/^<header[^>]*>|<\/header>$/g, '');
  const fromDOM = f.BH.extractJobSnapshot({ jobId: B.jobId });
  assert.equal(fromDOM.ok, true, fromDOM.reason);
  assert.equal(fromDOM.jobIdSource, 'dom');
});

test('宽容器包含两个独立详情时，排除歧义父容器后仍能选中目标子详情', async (t) => {
  const f = await fixture(t, mountWithCard(`<div class="job-detail-container">${detail(A, OLD_JD)}${detail(B, NEW_JD)}</div>`, B));
  const result = f.BH.extractJobSnapshot(f.expected());
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.jobId, B.jobId);
  assert.ok(result.description.includes(NEW_JD));
  assert.doesNotMatch(result.description, /旧型号控制器/);
});

for (const [name, placeholder] of [
  ['空', ''], ['只有 UI 按钮', '<button>立即沟通</button>'], ['只有标题', '<h2>职位描述</h2>'],
]) {
  test('语义正文容器' + name + '时，可读取 scope 内的真实 article 正文', async (t) => {
    const markup = detail(B, placeholder).replace('</section>\n    <div class="boss-info">',
      `</section><article><p>${NEW_JD}</p></article>\n    <div class="boss-info">`);
    const f = await fixture(t, mountWithCard(markup, B));
    const result = f.BH.extractJobSnapshot(f.expected());
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.description.split(NEW_JD).length - 1, 1);
  });
}

for (const [name, companyInfo] of [
  ['公司介绍 class', '<section class="company-intro"><div class="job-info"><span>博士</span><span>20年</span></div></section>'],
  ['公司介绍标题', '<section><h2>公司介绍</h2><div class="job-info"><span>博士</span><span>20年</span></div></section>'],
]) {
  test('扁平详情的' + name + '不能被当作经验学历字段', async (t) => {
    const markup = `<section class="job-detail" data-jobid="${B.dataJobId}">
      <h1 class="job-name">${B.title}</h1><a class="company-name">${B.company}</a>
      <a href="/job_detail/${B.jobId}.html">职位链接</a>
      <div class="job-sec-text"><p>任职要求：本科及以上学历，负责固件开发。</p></div>${companyInfo}</section>`;
    const f = await fixture(t, mountWithCard(markup, B));
    const result = f.BH.extractJobSnapshot(f.expected());
    assert.equal(result.ok, true, result.reason);
    assert.ok(!result.experience, result.experience);
    assert.ok(!result.education, result.education);
    const matched = f.BH.matchJob(result.description, '', '', {
      ...f.BH.state.config, yearsMin: 5, eduMin: 3,
    }, {}, result);
    assert.equal(matched.details.foundYears.length, 0);
    assert.equal(matched.details.foundEdu, 2);
    assert.equal(matched.matched, false);
  });
}

test('真实职位经验学历字段保留，公司介绍中同名标签不覆盖它们', async (t) => {
  const f = await fixture(t, mountWithCard(detail(B, NEW_JD,
    '<section class="company-intro"><div class="job-info"><span>博士</span><span>20年</span></div></section>'), B));
  const result = f.BH.extractJobSnapshot(f.expected());
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.experience, '3-5年');
  assert.equal(result.education, '本科');
});

function configureAuto(f, overrides = {}) {
  f.BH.state.config = {
    ...f.BH.loadConfig(), autoSend: true, aiEnabled: true,
    aiApiKey: 'sk-local-fixture', aiBaseUrl: 'https://api.example.com/v1/chat/completions', aiModel: 'test-model',
    aiCacheEnabled: false, aiMaxRetries: 0, aiFallback: 'skip', aiDailyLimit: 100,
    aiRejectShortTerm: false, aiUserPortrait: '嵌入式研发',
    mustHave: [], mustNot: [], yearsMin: 0, eduMin: 0, salaryMin: 0, activeDays: 0,
    ...overrides,
  };
}

function mockAI(f, handler = (o) => respondAI(o, true)) {
  const requests = [];
  f.win.GM_xmlhttpRequest = (o) => {
    requests.push(JSON.parse(o.data));
    queueMicrotask(() => handler(o));
  };
  return requests;
}

function respondAI(o, match, reason = match ? '方向匹配' : '方向不符') {
  o.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: {
    content: JSON.stringify({ match, score: match ? 88 : 10, reason }),
  } }] }) });
}

function countChatClicks(f) {
  let count = 0;
  f.doc.addEventListener('click', (event) => {
    if (event.target.closest?.('.op-btn-chat')) { count++; event.preventDefault(); }
  });
  return () => count;
}

test('独立详情自动流程：autoSend=false 时不请求 AI、不点击', async (t) => {
  const f = await fixture(t, detail(B, NEW_JD), `https://www.zhipin.com/job_detail/${B.jobId}.html`);
  configureAuto(f, { autoSend: false });
  const requests = mockAI(f);
  const clicks = countChatClicks(f);
  await f.BH.autoChatOnDetail();
  assert.equal(requests.length, 0);
  assert.equal(clicks(), 0);
  assert.equal(f.BH.loadStats().sent, 0);
});

test('独立详情自动流程：有按钮但读不到 JD 时不调用 AI、不点击', { timeout: 13000 }, async (t) => {
  const f = await fixture(t, header(B), `https://www.zhipin.com/job_detail/${B.jobId}.html`);
  configureAuto(f);
  const requests = mockAI(f);
  const clicks = countChatClicks(f);
  await f.BH.autoChatOnDetail();
  assert.equal(requests.length, 0);
  assert.equal(clicks(), 0);
  assert.equal(f.BH.loadStats().sent, 0);
});

test('独立详情自动流程：本地排除先拦截，不能直接点页面按钮', { timeout: 4000 }, async (t) => {
  const f = await fixture(t, detail(B, '本岗位为外包驻场软件开发。'), `https://www.zhipin.com/job_detail/${B.jobId}.html`);
  configureAuto(f, { aiEnabled: false, mustNot: ['外包'] });
  const requests = mockAI(f);
  const clicks = countChatClicks(f);
  await f.BH.autoChatOnDetail();
  assert.equal(requests.length, 0);
  assert.equal(clicks(), 0);
  assert.equal(f.BH.loadStats().sent, 0);
});

test('独立详情自动流程：AI 拒绝后不点击，AI 获得当前完整 JD', { timeout: 4000 }, async (t) => {
  const f = await fixture(t, detail(B, NEW_JD), `https://www.zhipin.com/job_detail/${B.jobId}.html`);
  configureAuto(f);
  const requests = mockAI(f, (o) => respondAI(o, false));
  const clicks = countChatClicks(f);
  await f.BH.autoChatOnDetail();
  assert.equal(requests.length, 1);
  assert.ok(requests[0].messages.find((m) => m.role === 'user').content.includes(NEW_JD));
  assert.equal(clicks(), 0);
  assert.equal(f.BH.loadStats().sent, 0);
});

for (const change of ['JD 正文变化', '关闭自动发送', '停止任务']) {
  test('独立详情自动流程：等待 AI 时' + change + '，旧通过结论不能触发点击', { timeout: 4000 }, async (t) => {
    const f = await fixture(t, detail(B, NEW_JD), `https://www.zhipin.com/job_detail/${B.jobId}.html`);
    configureAuto(f);
    let held;
    let arrived;
    const arrival = new Promise((resolve) => { arrived = resolve; });
    const requests = mockAI(f, (o) => { held = o; arrived(); });
    const clicks = countChatClicks(f);
    const pending = f.BH.autoChatOnDetail();
    await arrival;
    if (change === 'JD 正文变化') f.doc.querySelector('.job-sec-text').textContent = '岗位内容已更换为培训招生。';
    if (change === '关闭自动发送') f.BH.state.config.autoSend = false;
    if (change === '停止任务') f.BH.state.stopFlag = true;
    respondAI(held, true);
    await pending;
    assert.equal(requests.length, 1);
    assert.equal(clicks(), 0);
    assert.equal(f.BH.loadStats().sent, 0);
  });
}

test('独立详情自动流程：沟通前延迟中正文改变也不能点击', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, detail(B, NEW_JD), `https://www.zhipin.com/job_detail/${B.jobId}.html`);
  configureAuto(f);
  const requests = mockAI(f, (o) => {
    respondAI(o, true);
    f.win.setTimeout(() => { f.doc.querySelector('.job-sec-text').textContent = '延迟中已变成另一份职位内容。'; }, 50);
  });
  const clicks = countChatClicks(f);
  await f.BH.autoChatOnDetail();
  assert.equal(requests.length, 1);
  assert.equal(clicks(), 0);
  assert.equal(f.BH.loadStats().sent, 0);
});

test('独立详情自动流程：点击延迟内 mustNot 改变，旧规则的通过结论不能点击', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, detail(B, NEW_JD), `https://www.zhipin.com/job_detail/${B.jobId}.html`);
  configureAuto(f);
  const requests = mockAI(f, (o) => {
    respondAI(o, true);
    f.win.setTimeout(() => { f.BH.state.config.mustNot = ['DSP']; }, 50);
  });
  const clicks = countChatClicks(f);
  await f.BH.autoChatOnDetail();
  assert.equal(requests.length, 1);
  assert.equal(clicks(), 0);
  assert.equal(f.BH.loadStats().sent, 0);
});

test('独立详情 SPA：无 DOM ID 时 URL 先变化不能让旧正文提前进入 AI', { timeout: 6000 }, async (t) => {
  const f = await fixture(t, withoutDOMJobId(detail(A, OLD_JD)), `https://www.zhipin.com/job_detail/${A.jobId}.html`);
  configureAuto(f);
  const requests = mockAI(f, (o) => respondAI(o, false));
  const clicks = countChatClicks(f);
  f.win.history.pushState({}, '', `/job_detail/${B.jobId}.html`);
  await delay(10);
  const pending = f.BH.autoChatOnDetail();
  await delay(800);
  assert.equal(requests.length, 0, 'URL 变化且旧正文保持稳定时，仍必须等待正文变化');
  const oldRoot = f.doc.querySelector('.job-detail');
  oldRoot.outerHTML = withoutDOMJobId(detail(B, NEW_JD));
  await pending;
  assert.equal(requests.length, 1);
  const prompt = requests[0].messages.find((m) => m.role === 'user').content;
  assert.ok(prompt.includes(NEW_JD));
  assert.ok(!prompt.includes(OLD_JD));
  assert.equal(clicks(), 0);
});

test('独立详情 SPA：没有前态且只靠 URL 推断 ID 时不调用 AI、不点击', { timeout: 4000 }, async (t) => {
  const f = await fixture(t, '<main id="empty-host"></main>');
  configureAuto(f);
  const requests = mockAI(f);
  const clicks = countChatClicks(f);
  f.win.history.pushState({}, '', `/job_detail/${B.jobId}.html`);
  await delay(10);
  f.doc.getElementById('empty-host').innerHTML = withoutDOMJobId(detail(B, NEW_JD));
  await f.BH.autoChatOnDetail();
  assert.equal(requests.length, 0);
  assert.equal(clicks(), 0);
});

test('独立详情 SPA：DOM 标题与 ID 先于 URL 更新时仍须等待正文换成新职位', { timeout: 6000 }, async (t) => {
  const f = await fixture(t, mountWithCard(detail(A, OLD_JD), B));
  configureAuto(f);
  const requests = mockAI(f, (o) => respondAI(o, false));
  const clicks = countChatClicks(f);
  await delay(550); // 让实际 idle watcher 记录完整的 A 快照。
  const root = f.doc.querySelector('.job-detail');
  root.dataset.jobid = B.dataJobId;
  root.querySelector('.job-banner').outerHTML = header(B);
  f.win.history.pushState({}, '', `/job_detail/${B.jobId}.html`);
  await delay(10);
  const pending = f.BH.autoChatOnDetail();
  await delay(800);
  assert.equal(requests.length, 0, 'B 的标题/ID 不能使 A 的旧正文提前进入 AI');
  assert.equal(clicks(), 0);
  root.querySelector('.job-sec-text').textContent = NEW_JD;
  await pending;
  assert.equal(requests.length, 1);
  const prompt = requests[0].messages.find((m) => m.role === 'user').content;
  assert.ok(prompt.includes(NEW_JD));
  assert.ok(!prompt.includes(OLD_JD));
  assert.equal(clicks(), 0);
});

test('独立详情自动流程：判断通过才点核验 scope 按钮，并发调用不会重复', { timeout: 9000 }, async (t) => {
  const outside = '<a class="op-btn-chat" id="outside">立即沟通</a>';
  const f = await fixture(t, outside + detail(B, NEW_JD), `https://www.zhipin.com/job_detail/${B.jobId}.html`);
  configureAuto(f);
  const requests = mockAI(f);
  const clicked = [];
  f.doc.addEventListener('click', (event) => {
    if (event.target.closest?.('.op-btn-chat')) {
      clicked.push(event.target); event.preventDefault();
      f.BH.stop('fixture observed the scoped button');
    }
  });
  const intended = f.doc.querySelector('.job-detail .op-btn-chat');
  const first = f.BH.autoChatOnDetail();
  const concurrent = f.BH.autoChatOnDetail();
  await Promise.all([first, concurrent]);
  assert.equal(requests.length, 1);
  assert.deepEqual(clicked, [intended]);
  assert.equal(f.BH.loadStats().sent, 1);
});
