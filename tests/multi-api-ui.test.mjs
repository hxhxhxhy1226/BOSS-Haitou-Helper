import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const CONFIG_KEY = 'boss_helper_config_v1';
const primary = { aiBaseUrl: 'https://primary.example/v1/chat/completions', aiApiKey: 'primary-secret', aiModel: 'primary-model' };
const backup = (id = 'backup-1', extra = {}) => ({ id, name: '备用接口', enabled: true,
  baseUrl: 'https://backup.example/v1/chat/completions', apiKey: 'backup-secret', model: 'backup-model', ...extra });
async function until(condition, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'UI 异步操作应在时限内完成');
    await delay(10);
  }
}

async function fixture(t, values = new Map(), config) {
  if (config) values.set(CONFIG_KEY, structuredClone(config));
  const requests = [];
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://www.zhipin.com/web/geek/job?query=fixture',
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  win.GM_getValue = (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback;
  win.GM_setValue = (key, value) => values.set(key, structuredClone(value));
  win.GM_addStyle = (css) => { const style = win.document.createElement('style'); style.textContent = css; win.document.head.append(style); };
  win.unsafeWindow = win;
  win.GM_xmlhttpRequest = (options) => {
    requests.push(options);
    setTimeout(() => options.onload({ status: 200, responseText: JSON.stringify(options.method === 'GET'
      ? { data: [{ id: 'backup-discovered' }] }
      : { choices: [{ message: { content: '{"match":true,"score":90,"reason":"方向匹配"}' } }] }) }), 0);
    return { abort() {} };
  };
  win.fetch = () => { throw new Error('UI 测试不得请求外网'); };
  win.eval(fs.readFileSync(SCRIPT, 'utf8'));
  await delay(0);
  t.after(() => { win.BH.state.stopFlag = true; win.close(); });
  const doc = win.document;
  const open = () => doc.querySelector('[data-act="aiopen"]').click();
  const modal = () => doc.getElementById('bh-ai-modal');
  const cards = () => Array.from(doc.querySelectorAll('#bh-ai-endpoint-list [data-endpoint-id]'));
  const action = async (act, root = modal()) => {
    const previousLogs = new Set(doc.querySelectorAll('.bh-log-line'));
    root.querySelector('[data-act="' + act + '"]').click();
    if (act === 'aisave') {
      await until(() => [...doc.querySelectorAll('.bh-log-line')].some((line) => !previousLogs.has(line)
        && /AI 设置已保存|AI 设置保存失败/.test(line.textContent)));
    }
  };
  const field = (card, name) => card.querySelector('[data-endpoint-field="' + name + '"]');
  const fill = (card, endpoint) => {
    for (const name of ['name', 'baseUrl', 'apiKey', 'model']) field(card, name).value = endpoint[name] || '';
    field(card, 'enabled').checked = endpoint.enabled !== false;
  };
  return { win, doc, values, requests, open, modal, cards, action, field, fill };
}

test('旧主 API 配置直接打开，新增开关默认为启用且不产生备用接口', async (t) => {
  const f = await fixture(t, new Map(), primary);
  f.open();
  assert.equal(f.doc.querySelector('[data-cfg="aiPrimaryEnabled"]').checked, true);
  assert.equal(f.doc.querySelector('[data-cfg="aiApiKey"]').value, primary.aiApiKey);
  assert.equal(f.cards().length, 0);
  assert.equal(f.requests.length, 0);
});

test('添加多个备用 API 并保存，页面重建后完整恢复', async (t) => {
  const values = new Map();
  const f = await fixture(t, values, primary);
  f.open();
  f.action('aiendpointadd');
  f.fill(f.cards()[0], backup('ignored', { baseUrl: 'https://backup.example/v1' }));
  f.action('aiendpointadd');
  f.fill(f.cards()[1], backup('ignored', { name: '第二接口', apiKey: 'second-secret', enabled: false }));
  f.doc.querySelector('[data-cfg="aiPrimaryEnabled"]').checked = false;
  await f.action('aisave');
  const saved = values.get(CONFIG_KEY);
  assert.equal(saved.aiPrimaryEnabled, false);
  assert.equal(saved.aiEndpoints.length, 2);
  assert.notEqual(saved.aiEndpoints[0].id, saved.aiEndpoints[1].id);
  assert.equal(saved.aiEndpoints[0].baseUrl, 'https://backup.example/v1/chat/completions');
  assert.equal(saved.aiEndpoints[1].enabled, false);
  const reload = await fixture(t, values);
  reload.open();
  assert.equal(reload.cards().length, 2);
  assert.equal(reload.field(reload.cards()[0], 'apiKey').value, 'backup-secret');
  assert.equal(reload.field(reload.cards()[0], 'apiKey').type, 'password');
  assert.equal(reload.field(reload.cards()[1], 'enabled').checked, false);
  assert.equal(reload.doc.querySelector('[data-cfg="aiPrimaryEnabled"]').checked, false);
});

test('仅修改备用 API 也检测未保存，丢弃后保留原配置', async (t) => {
  const f = await fixture(t, new Map(), { ...primary, aiPrimaryEnabled: true, aiEndpoints: [backup()] });
  f.open();
  f.field(f.cards()[0], 'apiKey').value = 'unsaved-backup-secret';
  f.action('aiclose');
  assert.ok(f.doc.getElementById('bh-ai-confirm'));
  f.doc.querySelector('#bh-ai-confirm [data-act="neutral"]').click();
  assert.equal(f.modal(), null);
  f.open();
  assert.equal(f.field(f.cards()[0], 'apiKey').value, 'backup-secret');
  assert.equal(f.values.get(CONFIG_KEY).aiEndpoints[0].apiKey, 'backup-secret');
});

test('启用的备用 API 校验地址和凭据，停用的草稿可以保存', async (t) => {
  const f = await fixture(t, new Map(), primary);
  f.open();
  f.action('aiendpointadd');
  await f.action('aisave');
  assert.match(f.doc.getElementById('bh-ai-save-error').textContent, /API Key.*模型名/);
  assert.equal(f.values.get(CONFIG_KEY).aiEndpoints?.length || 0, 0);
  f.fill(f.cards()[0], backup('ignored', { baseUrl: 'javascript:alert(1)' }));
  await f.action('aisave');
  assert.match(f.doc.getElementById('bh-ai-save-error').textContent, /HTTP.*HTTPS/);
  f.fill(f.cards()[0], backup('ignored', { baseUrl: '', apiKey: '', model: '', enabled: false }));
  await f.action('aisave');
  assert.equal(f.values.get(CONFIG_KEY).aiEndpoints[0].enabled, false);
  assert.equal(f.doc.getElementById('bh-ai-save-error').style.display, 'none');
});

test('备用 API 的优先级调整和删除均保存到配置', async (t) => {
  const f = await fixture(t, new Map(), { ...primary, aiEndpoints: [backup('a'), backup('b'), backup('c')] });
  f.open();
  f.action('aiendpointup', f.cards()[2]);
  assert.deepEqual(f.cards().map((card) => card.dataset.endpointId), ['a', 'c', 'b']);
  f.action('aiendpointdown', f.cards()[0]);
  f.action('aiendpointremove', f.cards()[2]);
  await f.action('aisave');
  assert.deepEqual(f.values.get(CONFIG_KEY).aiEndpoints.map((endpoint) => endpoint.id), ['c', 'a']);
});

test('备用 API 测试读取当前未保存输入并只调用选中的接口', async (t) => {
  const f = await fixture(t, new Map(), { ...primary, aiEndpoints: [backup()] });
  f.open();
  f.field(f.cards()[0], 'apiKey').value = 'draft-key';
  f.field(f.cards()[0], 'baseUrl').value = 'https://draft.example/v1';
  f.field(f.cards()[0], 'model').value = 'draft-model';
  f.action('aiendpointtest', f.cards()[0]);
  await until(() => f.requests.length > 0);
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every((request) => request.url.startsWith('https://draft.example/')));
  assert.ok(f.requests.every((request) => request.headers.Authorization === 'Bearer draft-key'));
  assert.equal(JSON.parse(f.requests[0].data).model, 'draft-model');
  assert.equal(f.values.get(CONFIG_KEY).aiEndpoints[0].apiKey, 'backup-secret');
});

test('备用 API 获取模型和选择模型只更新对应卡片', async (t) => {
  const f = await fixture(t, new Map(), { ...primary, aiEndpoints: [backup()] });
  f.open();
  f.field(f.cards()[0], 'baseUrl').value = 'https://draft.example/v1';
  f.field(f.cards()[0], 'apiKey').value = 'draft-key';
  f.action('aiendpointmodels', f.cards()[0]);
  await until(() => f.doc.querySelector('#bh-model-picker [data-model="backup-discovered"]'));
  assert.equal(f.requests[0].url, 'https://draft.example/v1/models');
  assert.equal(f.requests[0].headers.Authorization, 'Bearer draft-key');
  const pick = f.doc.querySelector('#bh-model-picker [data-model="backup-discovered"]');
  assert.ok(pick);
  pick.click();
  assert.equal(f.field(f.cards()[0], 'model').value, 'backup-discovered');
  assert.equal(f.doc.querySelector('[data-cfg="aiModel"]').value, 'primary-model');
});

test('备用 API 名称作为文本显示，不能注入页面元素', async (t) => {
  const f = await fixture(t, new Map(), { ...primary, aiEndpoints: [backup('backup-1', { name: '<img src=x onerror=alert(1)>' })] });
  f.open();
  assert.equal(f.field(f.cards()[0], 'name').value, '<img src=x onerror=alert(1)>');
  assert.equal(f.cards()[0].querySelector('img'), null);
});

test('多个 API 卡片留在可滚动的弹窗内，操作按钮和错误消息允许换行', async (t) => {
  const f = await fixture(t, new Map(), { ...primary, aiEndpoints: Array.from({ length: 8 }, (_, i) => backup('api-' + i)) });
  f.open();
  const css = (selector) => f.win.getComputedStyle(f.doc.querySelector(selector));
  assert.equal(f.cards().length, 8);
  assert.ok(Math.abs(parseFloat(css('.bh-ai-modal-card').maxWidth) - f.win.innerWidth * 0.92) < 0.1);
  assert.ok(Math.abs(parseFloat(css('.bh-ai-modal-card').maxHeight) - f.win.innerHeight * 0.88) < 0.1);
  assert.equal(css('.bh-ai-modal-body').overflowY, 'auto');
  assert.equal(css('.bh-ai-endpoint-actions').flexWrap, 'wrap');
  assert.equal(css('.bh-ai-modal-footer').flexWrap, 'wrap');
  assert.equal(css('#bh-ai-save-error').flexBasis, '100%');
  assert.equal(css('#bh-ai-save-error').overflowWrap, 'anywhere');
  assert.ok(f.cards().every((card) => card.closest('.bh-ai-modal-body')));
  assert.ok(f.cards().every((card) => card.querySelector('[data-endpoint-health]').textContent.includes('未测试')));
});
