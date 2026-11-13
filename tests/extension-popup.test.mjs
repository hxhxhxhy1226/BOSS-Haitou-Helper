import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const extension = new URL('../extension/', import.meta.url);
const html = fs.readFileSync(new URL('popup.html', extension), 'utf8');
const code = fs.readFileSync(new URL('popup.js', extension), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', extension), 'utf8'));
const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const CONFIG = 'boss_helper_config_v1';

async function until(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Popup should finish the requested asynchronous action');
    await delay(5);
  }
}

async function fixture(t, options = {}) {
  const errors = [], messages = [], permissionRequests = [], created = [];
  const listeners = { storage: [], added: [], removed: [] };
  const values = { [CONFIG]: options.config || {} };
  const granted = new Set(options.granted || []);
  const status = { ok: true, running: true, paused: false, visible: true, version: manifest.version, ...options.status };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(html, {
    url: 'https://extension.invalid/popup.html', runScripts: 'outside-only', virtualConsole,
  });
  const win = dom.window;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  win.chrome = {
    runtime: { getManifest: () => manifest },
    tabs: {
      query: async () => options.noTab ? [] : [{ id: 17, url: options.url || 'https://www.zhipin.com/web/geek/job?query=fixture' }],
      sendMessage: async (tabId, payload) => {
        messages.push({ tabId, ...clone(payload) });
        if (options.disconnected) throw new Error('Receiving end does not exist');
        if (payload.action === 'toggle-panel') status.visible = !status.visible;
        if (payload.action === 'stop') { status.running = false; status.paused = false; }
        return clone(status);
      },
      create: async (value) => { created.push(clone(value)); return { id: 29 }; },
    },
    storage: {
      local: { get: async (key) => ({ [key]: clone(values[key]) }) },
      onChanged: { addListener: (listener) => listeners.storage.push(listener) },
    },
    permissions: {
      contains: async ({ origins }) => origins.every((origin) => granted.has(origin)
        || granted.has(origin.startsWith('https://') ? 'https://*/*' : 'http://*/*')),
      request: (request) => {
        permissionRequests.push(clone(request));
        if (options.permissionThrows) throw new Error('Request not available');
        if (options.permissionDenied) return Promise.resolve(false);
        request.origins.forEach((origin) => granted.add(origin));
        listeners.added.forEach((listener) => listener(clone(request)));
        return Promise.resolve(true);
      },
      onAdded: { addListener: (listener) => listeners.added.push(listener) },
      onRemoved: { addListener: (listener) => listeners.removed.push(listener) },
    },
  };
  win.fetch = () => assert.fail('Popup must not make external requests');
  win.eval(code);
  t.after(() => dom.window.close());
  const doc = win.document;
  await until(() => !doc.getElementById('api-summary').textContent.startsWith('正在')
    && doc.getElementById('page-state').textContent !== '正在连接…');
  return { win, doc, errors, messages, permissionRequests, created, granted,
    id: (id) => doc.getElementById(id),
    async config(next) {
      values[CONFIG] = next;
      listeners.storage.forEach((listener) => listener({ [CONFIG]: { newValue: next } }, 'local'));
      await delay(0);
    },
    async removePermission(origin) {
      granted.delete(origin);
      listeners.removed.forEach((listener) => listener({ origins: [origin] }));
      await delay(0);
    },
  };
}

test('Edge 扩展清单仅常驻 BOSS 权限，MV3 入口与本地图标完整', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, packageVersion);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['https://www.zhipin.com/*', 'https://www.zhipin.cn/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.deepEqual(manifest.content_scripts[0].js, ['platform.js', 'helper.js', 'content.js']);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /unsafe-eval|https?:/);
  assert.equal(manifest.externally_connectable, undefined);
  for (const [size, file] of Object.entries(manifest.icons)) {
    const png = fs.readFileSync(new URL(file, extension));
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
  }
});

for (const url of ['https://www.zhipin.com/web/geek/job?x=1', 'https://www.zhipin.cn/web/geek/recommend', 'https://www.zhipin.com/job_detail/fixture.html']) {
  test(`Popup 在支持的职位页连接助手：${new URL(url).pathname}`, async (t) => {
    const f = await fixture(t, { url });
    assert.equal(f.id('page-state').textContent, '投递中');
    assert.equal(f.id('toggle-panel').disabled, false);
    assert.equal(f.id('stop').disabled, false);
    assert.deepEqual(f.messages, [{ tabId: 17, type: 'BH_UI', action: 'status' }]);
    assert.equal(f.permissionRequests.length, 0, 'Opening a popup must never ask for AI access automatically');
    assert.deepEqual(f.errors, []);
  });
}

for (const url of ['https://example.com/', 'https://www.zhipin.com/web/geek/chat', 'https://www.zhipin.com.attacker.invalid/web/geek/job', 'http://www.zhipin.com/web/geek/job']) {
  test(`非职位页禁用投递控制且不发送内容消息：${url}`, async (t) => {
    const f = await fixture(t, { url });
    assert.match(f.id('page-state').textContent, /请打开 BOSS 职位页/);
    assert.equal(f.id('toggle-panel').disabled, true);
    assert.equal(f.id('stop').disabled, true);
    assert.equal(f.messages.length, 0);
    f.id('open-boss').click();
    assert.deepEqual(f.created, [{ url: 'https://www.zhipin.com/web/geek/job' }]);
  });
}

test('助手未连接时提示刷新，避免假报运行状态', async (t) => {
  const f = await fixture(t, { disconnected: true });
  assert.match(f.id('page-state').textContent, /尚未连接/);
  assert.match(f.id('page-hint').textContent, /刷新/);
  assert.equal(f.id('stop').disabled, true);
});

test('显示隐藏与停止按钮只控制当前职位标签并按回复回显', async (t) => {
  const f = await fixture(t);
  f.id('toggle-panel').click();
  await until(() => f.id('toggle-panel').textContent === '显示助手');
  assert.equal(f.messages.at(-1).action, 'toggle-panel');
  f.id('toggle-panel').click();
  await until(() => f.id('toggle-panel').textContent === '隐藏助手');
  f.id('stop').click();
  await until(() => f.id('page-state').textContent === '助手已连接');
  assert.equal(f.id('stop').disabled, true);
  assert.equal(f.messages.at(-1).action, 'stop');
  assert.ok(f.messages.every((message) => message.tabId === 17 && message.type === 'BH_UI'));
});

test('停止的助手不能误触停止，暂停的任务仍可停止', async (t) => {
  const stopped = await fixture(t, { status: { running: false, paused: false } });
  assert.equal(stopped.id('stop').disabled, true);
  const paused = await fixture(t, { status: { running: false, paused: true } });
  assert.equal(paused.id('page-state').textContent, '投递已暂停');
  assert.equal(paused.id('stop').disabled, false);
});

test('只在用户点击时授权已保存启用接口的域名，不泄露凭据或URL参数', async (t) => {
  const f = await fixture(t, { config: {
    aiBaseUrl: 'https://primary.example/v1/chat/completions?secret=hidden-query', aiApiKey: 'fixture-key-never-display',
    aiEndpoints: [
      { enabled: true, baseUrl: 'https://backup.example/v1', apiKey: 'backup-secret' },
      { enabled: true, baseUrl: 'https://primary.example/other' },
      { enabled: false, baseUrl: 'https://disabled.example/v1' },
      { enabled: true, baseUrl: 'javascript:alert(1)' },
      { enabled: true, baseUrl: 'https://username:password@credential.example/v1' },
    ],
  }, granted: ['https://primary.example/*'] });
  assert.equal(f.permissionRequests.length, 0);
  assert.equal(f.id('api-origins').children.length, 2);
  assert.doesNotMatch(f.doc.body.textContent, /hidden-query|fixture-key|backup-secret|username|password|disabled\.example|credential\.example/);
  assert.equal(f.id('authorize-api').disabled, false);
  f.id('authorize-api').click();
  assert.deepEqual(f.permissionRequests, [{ origins: ['https://backup.example/*'] }], 'Request must be made synchronously in the click handler');
  await until(() => f.id('authorize-api').textContent === 'AI 接口已授权');
  assert.equal(f.id('authorize-api').disabled, true);
  assert.match(f.id('message').textContent, /授权完成/);
});

test('端口接口使用有效的主机匹配模式，界面保留原端口', async (t) => {
  const f = await fixture(t, { config: { aiBaseUrl: 'http://localhost:12345/v1' } });
  assert.match(f.id('api-origins').textContent, /http:\/\/localhost:12345/);
  f.id('authorize-api').click();
  assert.deepEqual(f.permissionRequests, [{ origins: ['http://localhost/*'] }]);
});

test('停用主API时只请求备用服务，拒绝授权后保留本地筛选并允许重试', async (t) => {
  const f = await fixture(t, { permissionDenied: true, config: {
    aiPrimaryEnabled: false, aiBaseUrl: 'https://disabled-primary.example/v1',
    aiEndpoints: [{ enabled: true, baseUrl: 'https://backup.example/v1' }],
  } });
  f.id('authorize-api').click();
  await until(() => /未授予/.test(f.id('message').textContent));
  await until(() => !f.id('authorize-api').disabled);
  assert.deepEqual(f.permissionRequests, [{ origins: ['https://backup.example/*'] }]);
  assert.match(f.id('message').textContent, /本地筛选/);
});

test('配置更新和权限撤回会刷新授权列表，不自动申请新权限', async (t) => {
  const f = await fixture(t, { config: { aiBaseUrl: 'https://old.example/v1' }, granted: ['https://new.example/*'] });
  await f.config({ aiBaseUrl: 'https://new.example/v1' });
  await until(() => f.id('api-origins').textContent.includes('new.example'));
  assert.doesNotMatch(f.id('api-origins').textContent, /old\.example/);
  assert.equal(f.id('authorize-api').disabled, true);
  await f.removePermission('https://new.example/*');
  await until(() => !f.id('authorize-api').disabled);
  assert.equal(f.permissionRequests.length, 0);
});

test('未配置AI时不请求权限，权限接口异常时显示可操作提示', async (t) => {
  const empty = await fixture(t);
  assert.equal(empty.id('authorize-api').disabled, true);
  assert.equal(empty.id('api-origins').children.length, 0);
  assert.equal(empty.permissionRequests.length, 0);
  const failure = await fixture(t, { permissionThrows: true, config: { aiBaseUrl: 'https://api.example/v1' } });
  failure.id('authorize-api').click();
  await until(() => /权限操作未完成/.test(failure.id('message').textContent));
  await until(() => !failure.id('authorize-api').disabled);
  assert.deepEqual(failure.errors, []);
});

test('一次授权仅由明确点击触发，告知浏览器权限范围且无需先保存接口', async (t) => {
  const f = await fixture(t);
  assert.equal(f.id('authorize-all-api').disabled, false);
  assert.equal(f.permissionRequests.length, 0);
  assert.match(f.id('api-all-scope').textContent, /所有 HTTP\/HTTPS 网站/);
  assert.match(f.id('api-all-scope').textContent, /仅发送到你配置的接口/);
  assert.equal(f.id('authorize-all-api').getAttribute('aria-describedby'), 'api-all-scope');
  f.id('authorize-all-api').click();
  assert.deepEqual(f.permissionRequests, [{ origins: ['https://*/*', 'http://*/*'] }],
    'Permission request stays in the button gesture, before any asynchronous operation');
  await until(() => /已开启/.test(f.id('authorize-all-api').textContent));
  assert.equal(f.id('authorize-all-api').disabled, true);
  assert.match(f.id('api-summary').textContent, /新增接口.*拉取模型无需再次授权/);
  assert.match(f.id('message').textContent, /一次授权完成/);
  f.id('authorize-all-api').click();
  assert.equal(f.permissionRequests.length, 1);
});

test('浏览器已记住的一次授权在重新打开和新增不同域名或本地端口后均复用', async (t) => {
  const f = await fixture(t, { granted: ['https://*/*', 'http://*/*'] });
  for (const aiBaseUrl of ['https://new-unsaved.example/v1', 'http://localhost:34567/v1']) {
    await f.config({ aiBaseUrl, aiApiKey: 'never-display-key' });
    await until(() => f.id('api-origins').textContent.includes(new URL(aiBaseUrl).origin));
    assert.equal(f.id('authorize-api').disabled, true);
    assert.equal(f.id('authorize-all-api').disabled, true);
    assert.match(f.id('api-origins').textContent, /已授权/);
  }
  assert.doesNotMatch(f.doc.body.textContent, /never-display-key/);
  assert.equal(f.permissionRequests.length, 0);
});

test('撤回一个协议的全域权限会退出免重复授权，保留单独授权的域名', async (t) => {
  const f = await fixture(t, { config: { aiBaseUrl: 'https://saved.example/v1' },
    granted: ['https://*/*', 'http://*/*', 'https://saved.example/*'] });
  await f.removePermission('https://*/*');
  await until(() => !f.id('authorize-all-api').disabled);
  assert.equal(f.id('authorize-api').disabled, true, 'An individually retained host remains granted');
  assert.doesNotMatch(f.id('api-summary').textContent, /新增接口.*无需再次授权/);
  await f.config({ aiBaseUrl: 'https://another.example/v1' });
  await until(() => !f.id('authorize-api').disabled);
  assert.equal(f.permissionRequests.length, 0, 'Permission removal never causes an automatic permission prompt');
  f.id('authorize-api').click();
  assert.deepEqual(f.permissionRequests, [{ origins: ['https://another.example/*'] }]);
});

test('拒绝一次授权不会清除已有域名权限，并允许继续按域名授权', async (t) => {
  const f = await fixture(t, { permissionDenied: true, config: { aiBaseUrl: 'https://saved.example/v1' },
    granted: ['https://saved.example/*'] });
  f.id('authorize-all-api').click();
  await until(() => /未授予/.test(f.id('message').textContent));
  await until(() => !f.id('authorize-all-api').disabled);
  assert.equal(f.id('authorize-api').disabled, true);
  assert.match(f.id('api-origins').textContent, /已授权/);
  assert.equal(f.granted.has('https://*/*'), false);
  await f.config({ aiBaseUrl: 'https://new.example/v1' });
  await until(() => !f.id('authorize-api').disabled);
  assert.equal(f.permissionRequests.length, 1);
});
