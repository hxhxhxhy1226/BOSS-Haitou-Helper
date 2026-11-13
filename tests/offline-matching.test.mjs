import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const source = fs.readFileSync(SCRIPT, 'utf8');
const CONFIG = 'boss_helper_config_v1';
async function fixture(t) {
  const store = new Map();
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://www.zhipin.com/web/geek/job', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const win = dom.window;
  win.GM_getValue = (key, fallback) => store.has(key) ? structuredClone(store.get(key)) : fallback;
  win.GM_setValue = (key, value) => store.set(key, structuredClone(value));
  win.GM_listValues = () => [...store.keys()];
  win.GM_deleteValue = (key) => store.delete(key);
  win.GM_addStyle = () => {};
  win.unsafeWindow = win;
  win.GM_xmlhttpRequest = () => assert.fail('Offline matching must not request AI');
  win.fetch = () => assert.fail('Offline matching must not request a server');
  win.eval(source);
  await delay(0);
  t.after(() => { win.BH.state.stopFlag = true; win.close(); });
  const config = (overrides = {}) => ({ ...win.BH.loadConfig(), aiEnabled: false, mustHave: [], mustNot: [],
    yearsMin: 0, eduMin: 0, salaryMin: 0, activeDays: 0, ...overrides });
  return { win, store, config, match: (jd, cfg, facts = {}) => win.BH.matchJob(jd, '在线', '15-25K', cfg, {}, facts) };
}

test('offline technical keywords use exact aliases and chip/architecture families', async (t) => {
  const f = await fixture(t);
  const r = f.match('单片机产品固件研发，使用 CPP 编程并调试 Cortex-M4 接口。',
    f.config({ mustHave: ['MCU', 'C++', 'ARM'], mustHaveMin: 3 }));
  assert.equal(r.matched, true, r.reason);
  assert.equal(r.details.mustHaveHit, 3);
  for (const model of ['STM32F103C8T6', 'STM32H7', 'STM32WB55', 'ESP32S3']) {
    const key = model.startsWith('STM32') ? 'STM32' : 'ESP32';
    const result = f.match(`负责 ${model} 固件开发`, f.config({ mustHave: [key] }));
    assert.equal(result.matched, true, model + ': ' + result.reason);
  }
  assert.equal(f.match('负责 Free RTOS 设备固件开发', f.config({ mustHave: ['FreeRTOS'] })).matched, true);
  for (const model of ['STM32F103C8T6', 'ESP32S3', 'GD32VF103', 'nRF52840', 'ATmega328P']) {
    assert.equal(f.match(`负责 ${model} 固件开发`, f.config({ mustHave: ['MCU'] })).matched, true, model);
  }
  assert.equal(f.match('负责 STM32 固件开发', f.config({ mustHave: ['单片机'] })).matched, true);
  assert.equal(f.match('负责 MCU 固件开发', f.config({ mustHave: ['STM32'] })).matched, false,
    'general microcontroller evidence cannot establish a specific chip family');
});

test('offline C, C++, C# and unrelated English substrings remain distinct', async (t) => {
  const f = await fixture(t);
  for (const [keyword, jd] of [['C', 'C++ 开发'], ['C', 'C# 开发'], ['C++', 'C# 开发'],
    ['C', 'PLC语言开发'], ['ARM', 'alarm 设备'], ['AI', 'maintain devices'],
    ['FreeRTOS', 'RTOS 开发'], ['LVGL', 'GUI 开发'], ['STM32', '通用 HAL 库'],
    ['传感器', '数据库的数据采集'], ['ADC', '采样分析'], ['OTA', '串口固件升级']]) {
    assert.equal(f.match(jd, f.config({ mustHave: [keyword] })).matched, false, keyword + ': ' + jd);
  }
  assert.equal(f.match('负责 C语言程序开发', f.config({ mustHave: ['C'] })).matched, true);
  assert.equal(f.match('负责 C++ 软件开发', f.config({ mustHave: ['C/C++'] })).matched, true);
  assert.equal(f.match('负责 Ｃ＋＋ 软件开发', f.config({ mustHave: ['C++'] })).matched, true);
  assert.equal(f.match('负责 C++17 软件开发', f.config({ mustHave: ['Ｃ＋＋'] })).matched, true);
  assert.equal(f.match('负责 C99 软件开发', f.config({ mustHave: ['C'] })).matched, true);
  assert.equal(f.match('负责 C#12 软件开发', f.config({ mustHave: ['C#'] })).matched, true);
  assert.equal(f.match('负责 Cortex M4 软件开发', f.config({ mustHave: ['ARM'] })).matched, true);
});

test('offline associates flight firmware with MCU only when realtime and hardware duties are evidenced', async (t) => {
  const f = await fixture(t);
  const firmware = [
    '飞控软件工程师',
    '负责飞行控制器底层固件开发与实时任务调度，实现线程同步、信号量及消息队列。',
    '负责IMU传感器SPI驱动与数据采集，调试PWM电机输出和舵机执行器。',
  ].join('\n');
  const matched = f.match(firmware, f.config({ mustHave: ['MCU', '嵌入式', 'RTOS'], mustHaveMin: 3 }));
  assert.equal(matched.matched, true, matched.reason);
  assert.equal(matched.details.mustHaveHit, 3);
  assert.ok(matched.details.mustHaveHits.includes('飞控实时控制固件'), 'diagnostics retain the actual association');
  for (const keyword of ['STM32', 'FreeRTOS']) {
    assert.equal(f.match(firmware, f.config({ mustHave: [keyword] })).matched, false,
      'flight duties do not establish the specific platform ' + keyword);
  }
  const bareMetal = firmware.replace('实时任务调度，实现线程同步、信号量及消息队列', '实时控制程序');
  assert.equal(f.match(bareMetal, f.config({ mustHave: ['MCU'] })).matched, true);
  assert.equal(f.match(bareMetal, f.config({ mustHave: ['RTOS'] })).matched, false,
    'realtime bare-metal control does not establish an RTOS');
  for (const jd of [
    '飞控软件工程师，研发飞行控制器。',
    '飞控软件工程师，负责Linux内核和PCIe驱动开发，必须独立承担Linux内核移植。',
    firmware + '\n本岗位必须独立完成高级导航算法、控制律设计和状态估计。',
    '公司主营飞控底层固件开发、实时系统、传感器驱动和PWM电机控制。本岗位负责React网页开发。',
    '飞控工程师，负责固件开发与实时系统测试，负责传感器驱动，没有电机或舵机研发职责。',
    firmware.replace('飞控软件工程师', '服务器软件工程师').replace('飞行控制器', '计算服务'),
  ]) assert.equal(f.match(jd, f.config({ mustHave: ['MCU'] })).matched, false, jd);
  assert.equal(f.match('负责 Cortex-M7 控制器固件开发', f.config({ mustHave: ['MCU'] })).matched, true);
  assert.equal(f.match('负责 Cortex-A72 Linux软件开发', f.config({ mustHave: ['MCU'] })).matched, false);
});

const FLIGHT_FIRMWARE_REGRESSION_JD = [
  '飞控软件工程师',
  '负责飞行控制器底层固件开发与实时任务调度，实现线程同步、信号量及消息队列。',
  '负责IMU传感器SPI驱动与数据采集，调试PWM电机输出和舵机执行器。',
].join('\n');

test('offline flight inference rejects mandatory Linux and algorithm work in either order or across lines', async (t) => {
  const f = await fixture(t);
  const cfg = f.config({ mustHave: ['MCU'] });
  const requirements = [
    '本岗位必须独立完成Linux内核与PCIe驱动开发。',
    'Linux内核和PCIe驱动开发为必须独立承担的核心职责。',
    '导航算法、控制律设计和状态估计为核心工作，入职必须独立承担。',
    '核心职责：\nLinux内核和PCIe驱动开发。',
    'Linux内核和PCIe驱动开发：\n入职必须独立承担。',
    '任职要求：\n必须独立掌握\nLinux内核、PCIe驱动和导航算法。',
    'Linux内核经验不是必备，但必须独立完成导航算法和状态估计研发。',
    '必须掌握实时固件或Linux内核至少一种，但所有人必须独立承担PCIe开发。',
    '公司福利提供导师培训，但本岗位必须独立承担Linux内核和PCIe驱动开发。',
    'Linux内核必须独立掌握且不要求导航算法经验。',
    '必须独立承担Linux内核开发且导航算法仅为加分项。',
    '必须独立承担Linux内核开发，并且不要求导航算法经验。',
  ];
  assert.deepEqual(requirements.map((requirement) => ({ requirement,
    matched: f.match(FLIGHT_FIRMWARE_REGRESSION_JD + '\n' + requirement, cfg).matched })),
  requirements.map((requirement) => ({ requirement, matched: false })));
  assert.equal(f.match('飞控控制算法工程师，核心职责为导航算法、控制律设计、状态估计与SLAM研发。', cfg).matched, false);
});

test('offline flight inference retains firmware work when Linux or algorithms are explicitly optional or negated', async (t) => {
  const f = await fixture(t);
  const cfg = f.config({ mustHave: ['MCU', 'RTOS'], mustHaveMin: 2 });
  const qualifications = [
    '不要求独立承担Linux内核或导航算法。',
    'Linux内核、PCIe驱动或高级导航算法经验仅为加分项，并非必备。',
    '任职要求：\n不要求独立承担Linux内核和PCIe驱动。',
    '可选加分项：\n精通Linux内核或导航算法者优先，岗位不强制此类经验。',
    '主要负责实时固件开发，导航算法为选学方向。',
    '任职要求：\n必须掌握实时固件或Linux内核至少一种，可选择固件方向。',
    '任职要求：\n必须掌握实时固件或Linux内核，任选其一即可。',
    '不要求独立承担Linux内核且导航算法仅为加分项。',
  ];
  assert.deepEqual(qualifications.map((qualification) => ({ qualification,
    matched: f.match(FLIGHT_FIRMWARE_REGRESSION_JD + '\n' + qualification, cfg).matched })),
  qualifications.map((qualification) => ({ qualification, matched: true })));
});

test('offline flight inference uses the current role instead of duties under company introduction headings', async (t) => {
  const f = await fixture(t);
  const cfg = f.config({ mustHave: ['MCU'] });
  const borrowed = [
    '公司产品\n' + FLIGHT_FIRMWARE_REGRESSION_JD + '\n本岗位负责React网站开发。',
    '公司介绍：\n' + FLIGHT_FIRMWARE_REGRESSION_JD + '\n岗位职责：\n负责React网站开发。',
    '公司业务包括：\n' + FLIGHT_FIRMWARE_REGRESSION_JD + '\n工作内容：\n负责React网站开发。',
    '飞控软件工程师\n岗位职责：\n负责React网站开发。\n任职要求：\n'
      + FLIGHT_FIRMWARE_REGRESSION_JD,
  ];
  assert.deepEqual(borrowed.map((jd) => ({ jd, matched: f.match(jd, cfg).matched })),
    borrowed.map((jd) => ({ jd, matched: false })));
  const currentFirmware = '公司介绍：\n公司还有Linux平台团队，核心业务包含Linux内核和PCIe驱动开发。\n岗位职责：\n'
    + FLIGHT_FIRMWARE_REGRESSION_JD;
  assert.equal(f.match(currentFirmware, cfg).matched, true, 'other teams cannot impose this role\'s mandatory core');
});

test('offline flight inference does not treat explicitly excluded sensor or actuator work as positive evidence', async (t) => {
  const f = await fixture(t);
  const cfg = f.config({ mustHave: ['MCU'] });
  const denied = [
    FLIGHT_FIRMWARE_REGRESSION_JD.replace('调试PWM电机输出和舵机执行器', '不做PWM电机输出和舵机执行器开发'),
    FLIGHT_FIRMWARE_REGRESSION_JD.replace('调试PWM电机输出和舵机执行器', '无需调试PWM电机输出和舵机执行器'),
    FLIGHT_FIRMWARE_REGRESSION_JD.replace('调试PWM电机输出和舵机执行器', '不要求开发电机PWM或舵机执行器控制'),
    FLIGHT_FIRMWARE_REGRESSION_JD.replace('负责IMU传感器SPI驱动与数据采集', '不做IMU传感器SPI驱动或数据采集'),
  ];
  assert.deepEqual(denied.map((jd) => ({ jd, matched: f.match(jd, cfg).matched })),
    denied.map((jd) => ({ jd, matched: false })));
  const affirmative = FLIGHT_FIRMWARE_REGRESSION_JD.replace('调试PWM电机输出和舵机执行器',
    '不做舵机执行器开发，但负责PWM电机输出调试');
  assert.equal(f.match(affirmative, cfg).matched, true, 'a separate affirmative duty remains actual work');
  for (const actual of [
    '负责PWM电机输出调试且不要求舵机经验',
    '不做舵机执行器开发而负责PWM电机输出调试',
    '负责PWM电机输出调试并不要求舵机经验',
  ]) {
    const jd = FLIGHT_FIRMWARE_REGRESSION_JD.replace('调试PWM电机输出和舵机执行器', actual);
    assert.equal(f.match(jd, cfg).matched, true, actual);
  }
});

test('offline actual STM32/FreeRTOS flight and ECU work retain explicit aliases and OR platform choices', async (t) => {
  const f = await fixture(t);
  const platforms = f.config({ mustHave: ['MCU', 'STM32', 'RTOS', 'FreeRTOS'], mustHaveMin: 4 });
  for (const jd of [
    '飞控嵌入式工程师，负责STM32传感器驱动和FreeRTOS飞控固件开发。',
    '汽车ECU软件工程师，负责STM32外设驱动、FreeRTOS任务和CAN通信开发。',
  ]) assert.equal(f.match(jd, platforms).matched, true, jd);
  assert.equal(f.match(FLIGHT_FIRMWARE_REGRESSION_JD,
    f.config({ mustHave: ['MCU|ECU', 'RTOS|Linux'], mustHaveMin: 2 })).matched, true);
  assert.equal(f.match('飞控Linux工程师，必须独立承担Linux内核和PCIe驱动开发，没有可选固件分支。',
    f.config({ mustHave: ['MCU'] })).matched, false);
  assert.equal(f.match('Linux内核和PCIe驱动研发', f.config({ mustHave: ['Linux'] })).matched, true,
    'the flight association does not impose new hard limits on manually selected literal platforms');
});

test('offline accepts mixed MCU/RTOS and embedded Linux campus work when technical slots meet the threshold', async (t) => {
  const f = await fixture(t);
  const jd = [
    '机器人嵌入式软件工程师（校招）',
    '参与机器人控制器及传感器嵌入式软件开发，负责MCU/SoC底层驱动、实时任务及通信协议。',
    '参与CAN、UART、SPI、I2C接口联调，熟悉C/C++和嵌入式系统基础。',
    '了解STM32、ARM、RTOS或嵌入式Linux中的至少一种平台。',
  ].join('\n');
  const cfg = f.config({ mustHave: ['MCU', 'RTOS', 'Linux', 'C/C++'], mustHaveMin: 4,
    mustNot: ['外包', '销售', '培训'], yearsMin: 0, eduMin: 2, salaryMin: 14 });
  const result = f.match(jd, cfg, { experience: '在校/应届', education: '本科' });
  assert.equal(result.matched, true, result.reason);
  assert.equal(result.details.mustHaveHit, 4, 'Linux and RTOS coexist without imposing an extra direction veto');
  assert.equal(f.match('Linux服务器日常运维与部署', cfg, { experience: '在校/应届', education: '本科' }).matched, false,
    'an unrelated job that misses the explicit technical threshold still fails');

  const linuxOnly = '嵌入式开发实习生，负责ARM平台的嵌入式Linux底层驱动与C/C++软件开发。';
  const flexible = f.config({ mustHave: ['MCU|Linux', 'RTOS|Linux', 'ARM', 'C/C++'], mustHaveMin: 4 });
  assert.equal(f.match(linuxOnly, flexible, { experience: '在校/应届' }).matched, true,
    'the user can express acceptable alternative platforms through OR slots');
});

test('offline excludes real disallowed roles while accepting explicit negation and technical support', async (t) => {
  const f = await fixture(t);
  const cfg = f.config({ mustHave: ['MCU'], mustNot: ['外包|驻场', '销售', '培训'] });
  for (const jd of [
    '单片机研发，本岗位非外包，无需驻场。',
    '单片机研发，编制工艺文件并组织技术培训。',
    '单片机研发，提供入职培训与内部培训。',
    '单片机研发，配合销售团队开展技术支持。',
  ]) assert.equal(f.match(jd, cfg).matched, true, jd);
  for (const jd of [
    '单片机开发，外包项目驻场。',
    '单片机销售工程师，负责客户销售。',
    '单片机培训讲师，负责培训课程和招生。',
    '单片机技术培训工程师，负责客户课程。',
    '单片机研发，非外包描述不能改变本次外包项目的性质。',
    '单片机研发，不接受非外包岗位。',
  ]) {
    const r = f.match(jd, cfg);
    assert.equal(r.matched, false, jd);
    assert.equal(r.details.stage, 'mustNot');
  }
  assert.equal(f.match('单片机研发', f.config({ mustNot: ['MCU'] })).matched, true,
    'aliases apply to positive skills; exclusions remain the user\'s literal words');
});

test('offline applies required hit counts and explicit hard limits; missing facts do not invent failures', async (t) => {
  const f = await fixture(t);
  assert.equal(f.match('单片机开发', f.config({ mustHave: ['MCU', 'FreeRTOS'], mustHaveMin: 2 })).matched, false);
  assert.equal(f.match('单片机开发', f.config({ mustHave: ['MCU', 'FreeRTOS'], mustHaveMin: 0 })).matched, true);
  assert.equal(f.match('单片机开发', f.config({ mustHave: ['MCU'], yearsMin: 3, eduMin: 2 })).matched, true);
  assert.equal(f.match('单片机开发', f.config({ yearsMin: 3 }), { experience: '1年' }).matched, false);
  for (const experience of ['在校/应届', '在校／应届', '在校生', '在校/应届生']) {
    const campus = f.match('单片机开发', f.config({ yearsMin: 0 }), { experience });
    assert.equal(campus.matched, true, experience);
    const experiencedOnly = f.match('单片机开发', f.config({ yearsMin: 3 }), { experience });
    assert.equal(experiencedOnly.matched, false, experience);
    assert.deepEqual(Array.from(experiencedOnly.details.foundYears), [0]);
  }
  assert.equal(f.match('单片机开发', f.config({ eduMin: 2 }), { education: '大专' }).matched, false);
  assert.equal(f.match('单片机开发', f.config({ salaryMin: 20 })).matched, false);
});

test('offline rules pasted with newlines, commas, semicolons and OR expressions survive saving', async (t) => {
  const f = await fixture(t);
  const input = (key) => f.win.document.querySelector(`[data-cfg="${key}"]`);
  input('mustHave').value = 'MCU，C/C++;ARM|RISC-V\nFreeRTOS\\RT-Thread';
  input('mustNot').value = '外包,驻场；电话销售';
  input('mustHaveMin').value = '2';
  f.win.document.querySelector('[data-act="save"]').click();
  for (let i = 0; i < 100 && !f.store.has(CONFIG); i++) await delay(10);
  const saved = f.store.get(CONFIG);
  assert.deepEqual(saved.mustHave, ['MCU', 'C/C++', 'ARM|RISC-V', 'FreeRTOS\\RT-Thread']);
  assert.deepEqual(saved.mustNot, ['外包', '驻场', '电话销售']);
  assert.equal(saved.mustHaveMin, 2);
  const result = f.match('单片机 CPP 软件研发', saved);
  assert.equal(result.matched, true, result.reason);
});
