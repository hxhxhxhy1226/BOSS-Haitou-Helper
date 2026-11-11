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

test('保存后连续拉取主 API 模型不弹未保存提示，也不重复保存配置', async (t) => {
  const f = await fixture(t, new Map(), { ...primary, aiEndpoints: [backup()] });
  let configWrites = 0;
  const setValue = f.win.GM_setValue;
  f.win.GM_setValue = (key, value) => {
    if (key === CONFIG_KEY) configWrites++;
    return setValue(key, value);
  };
  f.open();
  await f.action('aisave');
  const saved = structuredClone(f.values.get(CONFIG_KEY));
  assert.equal(configWrites, 1);
  for (let i = 0; i < 2; i++) {
    await f.action('aimodels');
    assert.equal(f.doc.getElementById('bh-ai-confirm'), null);
    await until(() => f.doc.querySelector('#bh-model-picker [data-model="backup-discovered"]'));
    assert.equal(f.requests.length, i + 1);
    assert.equal(f.requests[i].url, 'https://primary.example/v1/models');
    f.doc.querySelector('#bh-model-picker [data-act="close"]').click();
  }
  assert.equal(configWrites, 1);
  assert.deepEqual(f.values.get(CONFIG_KEY), saved);
  await f.action('aiclose');
  assert.equal(f.modal(), null);
  assert.equal(f.doc.getElementById('bh-ai-confirm'), null);
});

test('主 API 直接用未保存输入拉取，仅选择模型后保存且重开无误报', async (t) => {
  const f = await fixture(t, new Map(), { ...primary, aiUserPortrait: '原画像' });
  f.open();
  f.doc.querySelector('[data-cfg="aiBaseUrl"]').value = ' https://draft.example/v1 ';
  f.doc.querySelector('[data-cfg="aiApiKey"]').value = ' draft-key ';
  f.doc.querySelector('[data-cfg="aiUserPortrait"]').value = '新画像：固件研发';
  const saved = structuredClone(f.values.get(CONFIG_KEY));
  await f.action('aimodels');
  assert.equal(f.doc.getElementById('bh-ai-confirm'), null);
  await until(() => f.doc.querySelector('#bh-model-picker [data-model="backup-discovered"]'));
  assert.equal(f.requests[0].url, 'https://draft.example/v1/models');
  assert.equal(f.requests[0].headers.Authorization, 'Bearer draft-key');
  assert.deepEqual(f.values.get(CONFIG_KEY), saved, '拉取列表不能顺带保存草稿');
  f.doc.querySelector('#bh-model-picker [data-act="close"]').click();
  await f.action('aimodels');
  assert.equal(f.doc.getElementById('bh-ai-confirm'), null);
  await until(() => f.doc.querySelector('#bh-model-picker [data-model="backup-discovered"]'));
  f.doc.querySelector('#bh-model-picker [data-model="backup-discovered"]').click();
  await until(() => !f.doc.getElementById('bh-model-picker'));
  assert.equal(f.values.get(CONFIG_KEY).aiBaseUrl, 'https://draft.example/v1/chat/completions');
  assert.equal(f.values.get(CONFIG_KEY).aiApiKey, 'draft-key');
  assert.equal(f.values.get(CONFIG_KEY).aiUserPortrait, '新画像：固件研发');
  assert.equal(f.values.get(CONFIG_KEY).aiModel, 'backup-discovered');
  await f.action('aiclose');
  assert.equal(f.modal(), null);
  assert.equal(f.doc.getElementById('bh-ai-confirm'), null);
  f.open();
  assert.equal(f.doc.querySelector('[data-cfg="aiModel"]').value, 'backup-discovered');
  await f.action('aiclose');
  assert.equal(f.modal(), null);
});

test('存储重排备用 API 对象属性后，保存再关闭不误报未保存', async (t) => {
  const f = await fixture(t, new Map(), { ...primary, aiEndpoints: [backup()] });
  const getValue = f.win.GM_getValue;
  f.win.GM_getValue = (key, fallback) => {
    const value = getValue(key, fallback);
    if (key === CONFIG_KEY && Array.isArray(value?.aiEndpoints)) {
      value.aiEndpoints = value.aiEndpoints.map((endpoint) =>
        Object.fromEntries(Object.keys(endpoint).sort().map((name) => [name, endpoint[name]])));
    }
    return value;
  };
  f.open();
  await f.action('aisave');
  await f.action('aiclose');
  assert.equal(f.doc.getElementById('bh-ai-confirm'), null);
  assert.equal(f.modal(), null);
});

test('主备 API 拉取列表时不自动改写空模型名或保存配置', async (t) => {
  const f = await fixture(t, new Map(), { ...primary, aiModel: 'gpt-4o-mini',
    aiEndpoints: [backup('backup-1', { enabled: false, model: '' })],
  });
  f.open();
  f.doc.querySelector('[data-cfg="aiModel"]').value = '';
  const saved = structuredClone(f.values.get(CONFIG_KEY));
  await f.action('aimodels');
  await until(() => f.doc.querySelector('#bh-model-picker [data-model="backup-discovered"]'));
  assert.equal(f.doc.querySelector('[data-cfg="aiModel"]').value, '');
  assert.deepEqual(f.values.get(CONFIG_KEY), saved);
  f.doc.querySelector('#bh-model-picker [data-act="close"]').click();
  await f.action('aiendpointmodels', f.cards()[0]);
  await until(() => f.doc.querySelector('#bh-model-picker [data-model="backup-discovered"]'));
  assert.equal(f.field(f.cards()[0], 'model').value, '');
  assert.equal(f.doc.querySelector('[data-cfg="aiModel"]').value, '');
  assert.deepEqual(f.values.get(CONFIG_KEY), saved);
});

test('已存接口简写和首尾空白与表单标准化值等价，不误报未保存', async (t) => {
  const f = await fixture(t, new Map(), { ...primary,
    aiBaseUrl: ' https://primary.example/v1 ', aiApiKey: ' primary-secret ',
    aiUserPortrait: ' 固件研发 ',
    aiEndpoints: [backup('backup-1', { baseUrl: ' https://backup.example/v1 ', apiKey: ' backup-secret ' })],
  });
  f.open();
  await f.action('aiclose');
  assert.equal(f.doc.getElementById('bh-ai-confirm'), null);
  assert.equal(f.modal(), null);
});

test('清空已保存的默认接口地址后关闭仍提示未保存', async (t) => {
  const defaultUrl = 'https://api.openai.com/v1/chat/completions';
  const f = await fixture(t, new Map(), { ...primary, aiBaseUrl: defaultUrl });
  f.open();
  await f.action('aisave');
  f.doc.querySelector('[data-cfg="aiBaseUrl"]').value = '';
  await f.action('aiclose');
  assert.ok(f.doc.getElementById('bh-ai-confirm'));
  assert.ok(f.modal());
  assert.equal(f.values.get(CONFIG_KEY).aiBaseUrl, defaultUrl);
  f.doc.querySelector('#bh-ai-confirm [data-act="neutral"]').click();
  f.open();
  assert.equal(f.doc.querySelector('[data-cfg="aiBaseUrl"]').value, defaultUrl);
});

test('已保存空接口地址打开关闭不误报，拉取提示缺地址且不发送请求', async (t) => {
  const f = await fixture(t, new Map(), { ...primary, aiBaseUrl: '' });
  f.open();
  assert.equal(f.doc.querySelector('[data-cfg="aiBaseUrl"]').value, '');
  await f.action('aiclose');
  assert.equal(f.doc.getElementById('bh-ai-confirm'), null);
  assert.equal(f.modal(), null);
  f.open();
  await f.action('aimodels');
  assert.equal(f.doc.getElementById('bh-ai-confirm'), null);
  await until(() => f.doc.querySelector('#bh-detail-modal [data-role="body"]'));
  assert.match(f.doc.querySelector('#bh-detail-modal [data-role="body"]').value, /接口地址为空/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.values.get(CONFIG_KEY).aiBaseUrl, '');
  assert.equal(f.doc.getElementById('bh-model-picker'), null);
  f.doc.querySelector('#bh-detail-modal [data-act="close"]').click();
  await f.action('aiclose');
  assert.equal(f.modal(), null);
});

test('修改主 API Key 或备用 API 顺序后关闭仍提示真正未保存的改动', async (t) => {
  const f = await fixture(t, new Map(), { ...primary, aiEndpoints: [backup('a'), backup('b')] });
  f.open();
  await f.action('aisave');
  f.doc.querySelector('[data-cfg="aiApiKey"]').value = 'changed-primary-key';
  await f.action('aiclose');
  assert.ok(f.doc.getElementById('bh-ai-confirm'));
  f.doc.querySelector('#bh-ai-confirm [data-act="cancel"]').click();
  assert.ok(f.modal());
  f.doc.querySelector('[data-cfg="aiApiKey"]').value = primary.aiApiKey;
  await f.action('aiendpointup', f.cards()[1]);
  await f.action('aiclose');
  assert.ok(f.doc.getElementById('bh-ai-confirm'));
  f.doc.querySelector('#bh-ai-confirm [data-act="neutral"]').click();
  assert.equal(f.modal(), null);
  f.open();
  assert.deepEqual(f.cards().map((card) => card.dataset.endpointId), ['a', 'b']);
  assert.equal(f.doc.querySelector('[data-cfg="aiApiKey"]').value, primary.aiApiKey);
});

test('选择模型保存失败不显示已保存，保留选择窗口并允许重试', async (t) => {
  const f = await fixture(t, new Map(), primary);
  f.open();
  await f.action('aisave');
  await f.action('aimodels');
  await until(() => f.doc.querySelector('#bh-model-picker [data-model="backup-discovered"]'));
  const saved = structuredClone(f.values.get(CONFIG_KEY));
  const setValue = f.win.GM_setValue;
  const setItem = f.win.Storage.prototype.setItem;
  f.win.GM_setValue = (key, value) => {
    if (key === CONFIG_KEY) throw Error('fixture config write failure');
    return setValue(key, value);
  };
  f.win.Storage.prototype.setItem = function (key, value) {
    if (key === CONFIG_KEY) throw Error('fixture fallback write failure');
    return setItem.call(this, key, value);
  };
  f.doc.querySelector('#bh-model-picker [data-model="backup-discovered"]').click();
  await until(() => /模型已填入，但保存失败/.test(f.doc.querySelector('.bh-log').textContent));
  assert.ok(f.doc.getElementById('bh-model-picker'));
  const saveError = f.doc.querySelector('#bh-model-picker [role="alert"]');
  assert.ok(saveError, '保存失败原因需要在模型选择窗口内可见');
  assert.match(saveError.textContent, /保存失败/);
  assert.deepEqual(f.values.get(CONFIG_KEY), saved);
  assert.equal(f.win.BH.state.config.aiModel, primary.aiModel);
  assert.doesNotMatch(f.doc.querySelector('.bh-log').textContent, /已选择模型：backup-discovered（已保存）/);
  f.win.GM_setValue = setValue;
  f.win.Storage.prototype.setItem = setItem;
  f.doc.querySelector('#bh-model-picker [data-model="backup-discovered"]').click();
  await until(() => !f.doc.getElementById('bh-model-picker'));
  assert.equal(f.values.get(CONFIG_KEY).aiModel, 'backup-discovered');
  assert.match(f.doc.querySelector('.bh-log').textContent, /已选择模型：backup-discovered（已保存）/);
  await f.action('aiclose');
  assert.equal(f.modal(), null);
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
