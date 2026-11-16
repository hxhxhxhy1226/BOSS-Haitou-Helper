import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const source = fs.readFileSync(SCRIPT, 'utf8');
const PRIMARY = 'https://mcu-primary.example/v1/chat/completions';
const BACKUP = 'https://mcu-backup.example/v1/chat/completions';
const portrait = '熟悉 STM32 单片机开发，做过 FreeRTOS 任务通信、外设驱动和 FOC 电机控制项目，希望从事 MCU 嵌入式固件研发。';
const accepted = { match: true, score: 86, reason: '设备端固件与画像 MCU、外设驱动和 FreeRTOS 项目方向相关，具体协议待面试确认' };
const rejected = { match: false, score: 20, reason: '核心职责为 BLE/WiFi 通信及 ESP32 开发，与画像单片机电机控制方向不相关' };
const robot = {
  jobId: 'screenshot-robot-technical-excerpt', title: '嵌入式软件工程师',
  jd: '岗位职责：负责机器人固件、底层驱动、外设接口及通信模块开发，参与板级调试和整机联调，配合排查软硬件问题。\n任职要求：C/C++基础扎实，有MCU或嵌入式Linux开发经验，熟悉常用外设及通信接口，具备基本硬件知识和实际调试能力。',
};
const iot = {
  jobId: 'screenshot-iot-technical-excerpt', title: '嵌入式软件工程师（物联网方向）',
  jd: '岗位职责：负责微信小程序与 ESP32 之间的应用层协议维护，BLE 连接稳定性、吞吐量、功耗优化，多连接管理、广播策略、MTU 协商优化。\n负责 WiFi 通信开发与维护，STA 模式下扫描、连接、自动重连，NVS 凭证存储与掉电恢复，WiFi/BLE 共存场景下的时频资源调度与异常场景处理。\n负责 WebSocket 云端长连接，ESP WebSocket Client 稳定性维护，二进制协议报文可靠上传、断线重连、认证握手和 keep-alive 机制。\n负责空中升级 OTA，基于 esp_delta_ota 的差分升级流程，BLE 通道大文件分片传输、合包、校验、容错与回滚。\n任职要求：精通 C，熟悉 C++；深入理解 FreeRTOS 任务、队列、信号量、事件组和中断管理。',
};

function respond(request, result) {
  request.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }) });
}

async function fixture(context, { cfg = {}, gm } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://www.zhipin.com/web/geek/job?query=synthetic-mcu-regression',
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  const requests = [];
  const store = new Map();
  const NativeDate = win.Date;
  win.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [Date.parse('2026-11-16T04:00:00Z')])); }
    static now() { return Date.parse('2026-11-16T04:00:00Z'); }
  };
  win.GM_getValue = (key, fallback) => store.has(key) ? structuredClone(store.get(key)) : fallback;
  win.GM_setValue = (key, value) => store.set(key, structuredClone(value));
  win.GM_listValues = () => [...store.keys()];
  win.GM_deleteValue = (key) => store.delete(key);
  win.GM_addStyle = () => {};
  win.unsafeWindow = win;
  win.fetch = () => assert.fail('MCU regressions must not contact any real API');
  win.GM_xmlhttpRequest = (request) => {
    requests.push({ url: request.url, body: JSON.parse(request.data) });
    queueMicrotask(() => (gm || ((pending) => respond(pending, accepted)))(request, requests.length));
    return { abort() {} };
  };
  win.eval(source);
  await delay(0);
  const helper = win.BH;
  context.after(() => { helper.state.stopFlag = true; helper.state.paused = false; win.close(); });
  await helper.applyConfig({ ...helper.loadConfig(), aiEnabled: true, aiBaseUrl: PRIMARY,
    aiApiKey: 'synthetic-mcu-key', aiModel: 'synthetic-mcu-model', aiPrimaryEnabled: true,
    aiCacheEnabled: true, aiTimeoutMs: 3000, aiMaxRetries: 0, aiUserPortrait: portrait,
    mustNot: [], activeDays: 0, salaryMin: 0, aiEndpoints: [], ...cfg });
  helper.state.stopFlag = false;
  return { helper, requests, store };
}

for (const sample of [
  robot,
  iot,
  { jobId: 'gd32-car', title: '车载控制器软件开发', jd: '负责基于 GD32F450 的控制器固件开发、CAN 通信和外设驱动调试。' },
  { jobId: 'nrf52-ble', title: '蓝牙嵌入式工程师', jd: '负责 nRF52840 设备端固件、BLE GATT 协议及低功耗通信开发。' },
  { jobId: 'rp2040-sensor', title: '传感器固件工程师', jd: '负责 RP2040 固件开发，使用 SPI 进行传感器采集与控制。' },
  { jobId: 'cortex-m-controller', title: '工业控制软件开发', jd: '负责 Cortex-M4 实时控制固件和外设驱动开发。' },
  { jobId: 'esp32-variant', title: '智能终端研发工程师', jd: '负责 ESP32-C6 固件开发，实现设备低功耗通信和 OTA 升级。' },
  { jobId: 'mixed-stack-partial-mcu', title: '嵌入式软件开发工程师', jd: '负责嵌入式 Linux 应用，同时参与 MCU 下位机固件开发和 UART 通信联调。' },
  { jobId: 'rtos-without-mcu-word', title: '设备端固件工程师', jd: '负责设备端 FreeRTOS 固件开发，实现实时任务调度、队列通信与传感器驱动。' },
]) {
  test(sample.jobId + '实际设备固件或可选MCU分支建立跨平台方向证据', async (context) => {
    const { helper } = await fixture(context);
    const evidence = helper.mcuDirectionEvidence(sample, helper.state.config);
    assert.ok(evidence.portrait, 'candidate MCU skills or target must be evidenced');
    assert.ok(evidence.job, 'current duties or an applicable requirement branch must be evidenced');
  });
}

for (const sample of [
  { jobId: 'company-only', title: '网站后端工程师', jd: '公司介绍：本公司研发 MCU 和 ESP32 物联网固件。\n岗位职责：负责 Java 网站后端服务开发。' },
  { jobId: 'tag-only', title: '前端工程师', jd: '岗位标签：MCU、ESP32、FreeRTOS\n岗位职责：负责 React 网页前端开发和页面交互。' },
  { jobId: 'bonus-only', title: '后端工程师', jd: '岗位职责：负责 Java 业务后端开发。\n加分项：熟悉 MCU 固件开发优先。' },
  { jobId: 'course-sales', title: '课程销售顾问', jd: '岗位职责：负责 MCU、STM32 固件开发课程销售，联系学员完成招生业绩。' },
  { jobId: 'course-sales-cross-comma', title: '课程销售顾问', jd: '岗位职责：围绕 MCU 固件开发，完成课程销售和招生业绩。' },
  { jobId: 'company-without-heading', title: '网站后端工程师', jd: '本公司专注 MCU 固件开发。岗位职责：负责 Java 网站后端服务开发。' },
  { jobId: 'technical-development-tag', title: '网站后端工程师', jd: '技术标签：MCU 开发、ESP32 固件开发。岗位职责：负责 Java 网站后端服务开发。' },
  { jobId: 'mcu-priority-after-comma', title: '嵌入式软件工程师', jd: '岗位职责：负责 Linux 内核和 BSP 开发。任职要求：熟悉 MCU 开发，优先考虑。' },
  { jobId: 'negated-mcu', title: '业务后端开发', jd: '岗位职责：负责 Java 后端开发，不负责 MCU 固件开发和外设驱动。' },
  { jobId: 'negated-mcu-suffix', title: '业务后端开发', jd: '岗位职责：负责 Java 后端开发。MCU 固件开发无需承担。' },
  { jobId: 'linux-arm-only', title: 'Linux BSP工程师', jd: '负责 ARM Cortex-A Linux BSP、U-Boot、设备树和 PCIe 驱动开发。' },
  { jobId: 'generic-language-only', title: '通用软件开发', jd: '负责 C/C++ 业务后端服务开发，熟悉数据结构和算法。' },
]) {
  test(sample.jobId + '无关主体标签加分或否定不生成MCU工作证据', async (context) => {
    const { helper, requests } = await fixture(context, { gm: (request) => respond(request,
      { match: false, score: 10, reason: '实际岗位职责与画像 MCU 固件目标缺少明确正向关联' }) });
    assert.equal(helper.mcuDirectionEvidence(sample, helper.state.config).job, '');
    const result = await helper.aiScreen(sample);
    assert.equal(result.ok, true, result.err);
    assert.equal(result.match, false);
    assert.equal(requests.length, 1, 'a legitimate unrelated-role rejection must not be corrected merely for an MCU word');
  });
}

test('画像只有通用编程或明确不做MCU时不能用JD反向编造候选人关联', async (context) => {
  const { helper } = await fixture(context);
  for (const candidate of ['熟悉 Java 和 React，目标是网页前端研发。', '不做 MCU 固件开发，只投 Java 后端。']) {
    const cfg = { ...helper.state.config, aiUserPortrait: candidate };
    assert.equal(helper.mcuDirectionEvidence(iot, cfg).portrait, '', candidate);
  }
});

for (const template of ['', '只有核心平台和项目与岗位完全一致才能通过，未列相关协议经历则拒绝。']) {
  test((template ? '旧自定义' : '默认') + '请求保留完整输入并发送MCU跨平台匹配规则', async (context) => {
    const { helper, requests } = await fixture(context, { cfg: { aiPromptTemplate: template } });
    const result = await helper.aiScreen(iot);
    assert.equal(result.ok, true, result.err);
    const messages = requests[0].body.messages;
    assert.ok(messages[1].content.includes(iot.jd));
    assert.ok(messages[1].content.includes(portrait));
    assert.match(messages[0].content, /ESP32/i);
    assert.match(messages[0].content, /MCU/);
    assert.match(messages[0].content, /BLE|Wi-?Fi/i);
    const userRules = messages[1].content.replace(iot.jd, '').replace(portrait, '');
    assert.match(userRules, /MCU[\s\S]{0,180}(?:固件|可选|相关|关联)/);
    if (template) assert.ok(messages[0].content.includes(template));
  });
}

for (const sample of [
  { job: robot, reason: '核心职责为机器人嵌入式软件，与画像 MCU 电机控制方向不匹配' },
  { job: iot, reason: rejected.reason },
  { job: { ...iot, jobId: 'iot-missing-platform' }, reason: '候选人画像未写 ESP32 和 BLE 协议开发经历，岗位方向缺少明确正向关联' },
]) {
  test(sample.job.jobId + '错误方向拒绝先复核再采用模型新结论', async (context) => {
    const { helper, requests } = await fixture(context, { gm: (request, attempt) => respond(request,
      attempt === 1 ? { match: false, score: 15, reason: sample.reason } : accepted) });
    const result = await helper.runAIGate(null, sample.job);
    assert.equal(result.action, 'accept');
    assert.deepEqual(requests.map((request) => request.url), [PRIMARY, PRIMARY]);
    assert.match(requests[1].body.messages[0].content, /程序策略复核/);
    assert.ok(requests[1].body.messages[1].content.includes(sample.job.jd));
    assert.ok(requests[1].body.messages[1].content.includes(portrait));
    assert.equal(helper.getAICache(sample.job.jobId, sample.job).match, true);
    assert.equal(helper.loadStats().aiCalls, 2);
    assert.equal(helper.loadStats().sent, 0, 'screening is not a verified delivery');
  });
}

test('持续MCU方向误拒不直接反转通过且不缓存，返回可重试状态', async (context) => {
  const { helper, requests } = await fixture(context, { gm: (request) => respond(request, rejected) });
  const result = await helper.aiScreen(iot);
  assert.equal(result.ok, false);
  assert.equal(result.match, undefined);
  assert.equal(result.apiUnavailable, true);
  assert.equal(result.policyViolation, true);
  assert.equal(result.retryDelayMs, 60000);
  assert.deepEqual(requests.map((request) => request.url), [PRIMARY, PRIMARY]);
  assert.equal(helper.getAICache(iot.jobId, iot), null);
  assert.equal(helper.loadStats().sent, 0);
});

test('主接口持续方向误拒时备用接口收到完整规则并提供有效结论', async (context) => {
  const { helper, requests } = await fixture(context, {
    cfg: { aiEndpoints: [{ id: 'mcu-backup', name: '合成MCU备用', enabled: true,
      baseUrl: BACKUP, apiKey: 'synthetic-backup-key', model: 'synthetic-backup-model' }] },
    gm: (request) => respond(request, request.url === PRIMARY ? rejected : accepted),
  });
  const result = await helper.aiScreen(iot);
  assert.equal(result.ok, true, result.err);
  assert.equal(result.match, true);
  assert.equal(result.endpointId, 'mcu-backup');
  assert.deepEqual(requests.map((request) => request.url), [PRIMARY, PRIMARY, BACKUP]);
  assert.match(requests[2].body.messages[0].content, /ESP32/);
  assert.ok(requests[2].body.messages[1].content.includes(iot.jd));
});

test('命中当前指纹的缓存误拒也重新判断，不沿用矛盾的方向拒绝', async (context) => {
  const { helper, requests } = await fixture(context);
  helper.setAICache(iot.jobId, rejected, iot);
  const result = await helper.aiScreen(iot);
  assert.equal(result.ok, true, result.err);
  assert.equal(result.match, true);
  assert.equal(result.cached, false);
  assert.equal(requests.length, 1);
  assert.equal(helper.getAICache(iot.jobId, iot).match, true);
});

for (const sample of [
  { name: 'MCU或Linux任选其一', jobId: 'mcu-or-linux-explicit-choice',
    requirement: '必备要求：具有 MCU 或 Linux 内核开发经验，任选其一即可。' },
  { name: 'MCU经验逗号后或Linux经验', jobId: 'mcu-comma-or-linux-experience',
    requirement: '必备要求：有 MCU 开发经验，或有 Linux 内核开发经验。' },
  { name: 'MCU与Linux列举后至少掌握一种', jobId: 'mcu-linux-at-least-one-after-comma',
    requirement: '必备要求：有 MCU、Linux 内核开发经验，至少掌握一种即可。' },
  { name: 'Linux专家经验仅加分', jobId: 'linux-expert-bonus-only',
    requirement: '任职要求：具备 Linux 内核专家经验为加分项。' },
  { name: 'Linux内核明确非必备', jobId: 'linux-kernel-nonmandatory',
    requirement: '任职要求：Linux 内核开发为加分项，非必备。' },
  { name: '无需Linux专家能力', jobId: 'linux-expert-not-required',
    requirement: '任职要求：无需专家级 Linux 内核开发能力。' },
]) {
  test(sample.name + '不能借画像不会Linux拒绝真实MCU工作', async (context) => {
    const job = { jobId: sample.jobId, title: '嵌入式软件工程师',
      jd: '岗位职责：负责机器人 MCU 固件开发。\n' + sample.requirement };
    const candidate = portrait + '明确不会 Linux 内核开发。';
    const invalid = { match: false, score: 10,
      reason: 'JD 必备 Linux 内核开发能力，画像明确不会 Linux 内核开发，存在硬性技术冲突且岗位方向不匹配。' };
    const { helper, requests } = await fixture(context, { cfg: { aiUserPortrait: candidate },
      gm: (request, attempt) => respond(request, attempt === 1 ? invalid : accepted) });
    assert.ok(helper.mcuDirectionEvidence(job, helper.state.config).job);
    const result = await helper.aiScreen(job);
    assert.equal(result.ok, true, result.err);
    assert.equal(result.match, true);
    assert.equal(result.cached, false);
    assert.deepEqual(requests.map((request) => request.url), [PRIMARY, PRIMARY]);
    assert.match(requests[1].body.messages[0].content, /程序策略复核/);
    assert.ok(requests[1].body.messages[1].content.includes(job.jd));
    assert.ok(requests[1].body.messages[1].content.includes(candidate));
    assert.equal(helper.getAICache(job.jobId, job).match, true);
    assert.equal(helper.loadStats().aiCalls, 2);
    assert.equal(helper.loadStats().sent, 0);
  });
}

test('画像只做STM32时JD允许STM32或ESP32任选不能借ESP32拒绝', async (context) => {
  const job = { jobId: 'stm32-only-with-stm32-esp32-choice', title: 'MCU固件工程师',
    jd: '岗位职责：负责 MCU 固件开发。\n任职要求：熟悉 STM32 或 ESP32 开发，任选一种即可。' };
  const candidate = '熟悉 STM32 单片机，只做 STM32，不投其他芯片平台。';
  const invalid = { match: false, score: 10,
    reason: '画像明确只做 STM32，不投其他芯片，JD 涉及 ESP32，平台方向不匹配。' };
  const valid = { match: true, score: 86,
    reason: 'JD 可选 STM32 开发分支与画像单片机技能和仅 STM32 目标相关，不强制承担 ESP32 开发。' };
  const { helper, requests } = await fixture(context, { cfg: { aiUserPortrait: candidate },
    gm: (request, attempt) => respond(request, attempt === 1 ? invalid : valid) });
  const evidence = helper.mcuDirectionEvidence(job, helper.state.config);
  assert.ok(evidence.portrait);
  assert.ok(evidence.job);
  const result = await helper.aiScreen(job);
  assert.equal(result.ok, true, result.err);
  assert.equal(result.match, true);
  assert.equal(result.cached, false);
  assert.deepEqual(requests.map((request) => request.url), [PRIMARY, PRIMARY]);
  assert.match(requests[1].body.messages[0].content, /程序策略复核/);
  assert.ok(requests[1].body.messages[1].content.includes(job.jd));
  assert.ok(requests[1].body.messages[1].content.includes(candidate));
  assert.equal(helper.getAICache(job.jobId, job).match, true);
  assert.equal(helper.loadStats().aiCalls, 2);
  assert.equal(helper.loadStats().sent, 0);
});

for (const sample of [
  { name: '用户明示不投Linux', profile: portrait + '不投 Linux 岗位。',
    job: { ...robot, jobId: 'mcu-and-mandatory-linux', jd: '负责 MCU 固件开发，同时必须承担 Linux 内核驱动开发。' },
    reason: '画像明确不投 Linux，JD 明确包含 Linux 开发要求，命中用户排除条件' },
  { name: '用户限定仅STM32', profile: '熟悉 STM32 和 FreeRTOS，只做 STM32，不投其他芯片平台。', job: iot,
    reason: '画像明确只做 STM32 不投其他芯片，JD 为 ESP32 平台，命中用户限定' },
  { name: '强制专家能力真实冲突', profile: portrait + '明确不会 Linux 内核和 PCIe 驱动。',
    job: { ...iot, jobId: 'required-linux-expert', jd: '负责 ESP32 固件与 Linux 驱动集成。必须独立完成 Linux 内核和 PCIe 驱动专家级研发。' },
    reason: 'JD 必须独立完成 Linux 内核和 PCIe 专家研发，画像明确不会 Linux 内核和 PCIe 驱动，存在硬性技术冲突' },
  { name: 'MCU与Linux独立AND必备冲突', profile: portrait + '明确不会 Linux 内核开发。',
    job: { ...robot, jobId: 'mcu-and-linux-skill-conflict', jd: '负责机器人 MCU 固件开发，同时必须独立承担 Linux 内核驱动开发。' },
    reason: 'JD 必须独立承担 Linux 内核驱动，画像明确不会 Linux 内核开发，存在硬性技术冲突且岗位方向不匹配。' },
  { name: '仅STM32与STM32及ESP32独立AND必备冲突', profile: '熟悉 STM32 单片机，只做 STM32，不投其他芯片平台。',
    job: { jobId: 'stm32-only-with-mandatory-stm32-and-esp32', title: 'MCU固件工程师',
      jd: '岗位职责：负责 STM32 与 ESP32 固件开发。\n必备要求：STM32 与 ESP32 开发能力均必须具备。' },
    reason: '画像明确只做 STM32 不投其他芯片，JD 必须同时进行 STM32 与 ESP32 开发，平台方向不匹配。' },
  { name: 'FreeRTOS仅入门与强制专家层次冲突', profile: 'STM32 和 FreeRTOS 均仅入门，只能完成教程基础项目。',
    job: { jobId: 'freertos-entry-vs-expert', title: 'MCU固件专家', jd: '负责 MCU 固件开发，必须作为专家独立完成 FreeRTOS 复杂架构设计。' },
    reason: 'JD 必须作为专家独立完成 FreeRTOS 复杂架构设计；画像 FreeRTOS 仅入门，能力层次与岗位方向不匹配。' },
  { name: 'FreeRTOS教程基础与强制专家层次冲突', profile: '熟悉 STM32 单片机，FreeRTOS 只能完成教程基础项目。',
    job: { jobId: 'freertos-tutorial-vs-expert', title: 'MCU固件专家', jd: '负责 MCU 固件开发，必须作为专家独立完成 FreeRTOS 复杂架构设计。' },
    reason: 'JD 必须作为专家独立完成 FreeRTOS 复杂架构设计；画像 FreeRTOS 只能完成教程基础项目，能力层次与岗位方向不匹配。' },
  { name: '用户限定只做Zephyr不做其他RTOS', profile: '熟悉 MCU，只做 Zephyr，不做其他 RTOS。',
    job: { jobId: 'zephyr-only-vs-freertos', title: 'ESP32固件工程师', jd: '负责 ESP32 固件和 FreeRTOS 开发。' },
    reason: '画像明确只做 Zephyr，岗位为 FreeRTOS 平台，方向不匹配。' },
]) {
  test(sample.name + '不被MCU相关规则覆盖', async (context) => {
    const { helper, requests } = await fixture(context, { cfg: { aiUserPortrait: sample.profile },
      gm: (request) => respond(request, { match: false, score: 10, reason: sample.reason }) });
    const result = await helper.aiScreen(sample.job);
    assert.equal(result.ok, true, result.err);
    assert.equal(result.match, false);
    assert.equal(result.cached, false);
    assert.equal(requests.length, 1);
    assert.equal(helper.getAICache(sample.job.jobId, sample.job).match, false);
    assert.equal(helper.loadStats().aiCalls, 1);
    assert.equal(helper.loadStats().sent, 0);
  });
}

test('真实平台限定在理由80字之后仍有效且完整校验理由用于缓存复核', async (context) => {
  const job = { ...iot, jobId: 'long-rejection-platform-exclusion' };
  const candidate = '熟悉 STM32 单片机，只做 STM32，不投其他芯片平台。';
  const reason = rejected.reason + '。' + '当前判断仅使用实际岗位与求职者画像明确事实。'.repeat(4)
    + '画像明确只做 STM32，不投其他芯片，JD 为 ESP32，命中用户限定。';
  assert.ok(reason.indexOf('只做 STM32') > 80);
  assert.ok(!reason.slice(0, 80).includes('只做 STM32'));
  const { helper, requests } = await fixture(context, { cfg: { aiUserPortrait: candidate },
    gm: (request) => respond(request, { match: false, score: 10, reason }) });
  const first = await helper.aiScreen(job);
  assert.equal(first.ok, true, first.err);
  assert.equal(first.match, false);
  assert.equal(first.cached, false);
  assert.equal(first.reason.length, 80);
  assert.equal(requests.length, 1);
  const cache = helper.getAICache(job.jobId, job);
  assert.equal(cache.match, false);
  assert.equal(cache.reason, first.reason);
  assert.equal(cache.policyReason, reason);
  const second = await helper.aiScreen(job);
  assert.equal(second.ok, true, second.err);
  assert.equal(second.match, false);
  assert.equal(second.cached, true);
  assert.equal(second.reason, first.reason);
  assert.equal(requests.length, 1, 'a validated rejection must not issue another request because its display reason is truncated');
  assert.equal(helper.loadStats().aiCalls, 1);
  assert.equal(helper.loadStats().sent, 0);
});

test('方向纠正后仍可因真实用户排除拒绝，程序不强制模型通过', async (context) => {
  const job = { ...iot, jobId: 'mcu-outsourcing', jd: '本岗位为外包驻场开发。' + iot.jd };
  const { helper, requests } = await fixture(context, { cfg: { mustNot: ['外包', '驻场'] },
    gm: (request, attempt) => respond(request, attempt === 1 ? rejected
      : { match: false, score: 10, reason: 'JD 明确外包驻场，触发用户外包和驻场排除条件' }) });
  const result = await helper.aiScreen(job);
  assert.equal(result.ok, true, result.err);
  assert.equal(result.match, false);
  assert.equal(requests.length, 2);
  assert.equal(helper.getAICache(job.jobId, job).match, false);
});

test('MCU方向匹配不使已忽略的年限学历门槛重新生效', async (context) => {
  const job = { ...iot, jobId: 'mcu-education-tenure', education: '硕士', experience: '3-5年',
    jd: iot.jd + '\n任职条件：硕士及以上，3年以上开发经验。' };
  const { helper, requests } = await fixture(context, { gm: (request, attempt) => respond(request,
    attempt === 1 ? { match: false, score: 10, reason: 'JD 要求硕士和3年以上经验，候选人学历与年限不满足' } : accepted) });
  const result = await helper.aiScreen(job);
  assert.equal(result.ok, true, result.err);
  assert.equal(result.match, true);
  assert.equal(requests.length, 2);
});
