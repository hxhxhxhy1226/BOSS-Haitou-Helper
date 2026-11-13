(() => {
  'use strict';
  const CONFIG_KEY = 'boss_helper_config_v1';
  const byId = (id) => document.getElementById(id);
  const toggleButton = byId('toggle-panel');
  const stopButton = byId('stop');
  const authorizeButton = byId('authorize-api');
  const authorizeAllButton = byId('authorize-all-api');
  const ALL_API_ORIGINS = ['https://*/*', 'http://*/*'];
  let activeTabId = null;
  let helperStatus = null;
  let permissionPatterns = [];
  let permissionBusy = false;
  let permissionRevision = 0;
  let allApiGranted = false;

  byId('version').textContent = chrome.runtime.getManifest().version;

  function message(text, error = false) {
    byId('message').textContent = text;
    byId('message').classList.toggle('error', error);
  }

  function supportedPage(raw) {
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && ['www.zhipin.com', 'www.zhipin.cn'].includes(url.hostname)
        && (/^\/web\/geek\/(?:job|recommend)/.test(url.pathname) || /^\/job_detail\//.test(url.pathname));
    } catch (_) { return false; }
  }

  function disconnected(title, hint) {
    helperStatus = null;
    byId('connection').dataset.connected = 'false';
    byId('page-state').textContent = title;
    byId('page-hint').textContent = hint;
    toggleButton.disabled = true;
    stopButton.disabled = true;
  }

  function connected(status) {
    helperStatus = status;
    byId('connection').dataset.connected = 'true';
    byId('page-state').textContent = status.paused ? '投递已暂停' : status.running ? '投递中' : '助手已连接';
    byId('page-hint').textContent = status.running
      ? '正在按已保存的配置处理岗位，可随时停止。'
      : '打开页面助手，检查配置后点击「开始」。';
    toggleButton.textContent = status.visible === false ? '显示助手' : '隐藏助手';
    toggleButton.disabled = false;
    stopButton.disabled = !status.running && !status.paused;
  }

  async function refreshPage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !Number.isInteger(tab.id) || !supportedPage(tab.url)) {
        activeTabId = null;
        disconnected('请打开 BOSS 职位页', '进入职位列表或职位详情页后即可使用助手。');
        return;
      }
      activeTabId = tab.id;
      const result = await chrome.tabs.sendMessage(activeTabId, { type: 'BH_UI', action: 'status' });
      if (!result?.ok) throw new Error('Helper unavailable');
      connected(result);
    } catch (_) {
      disconnected('页面助手尚未连接', '安装或更新扩展后，请刷新当前 BOSS 页面再试。');
    }
  }

  async function pageAction(action) {
    if (activeTabId === null || !helperStatus) return;
    toggleButton.disabled = true;
    stopButton.disabled = true;
    try {
      const result = await chrome.tabs.sendMessage(activeTabId, { type: 'BH_UI', action });
      if (!result?.ok) throw new Error('Helper unavailable');
      connected(result);
      message(action === 'stop' ? '已停止投递。' : result.visible === false ? '已隐藏页面助手。' : '已显示页面助手。');
    } catch (_) {
      disconnected('页面助手尚未连接', '页面可能已跳转或刷新，请重新打开扩展。');
      message('操作未完成，请刷新 BOSS 页面后重试。', true);
    }
  }

  function apiOrigins(config) {
    const endpoints = [];
    if (config && config.aiPrimaryEnabled !== false) endpoints.push(config.aiBaseUrl);
    for (const endpoint of Array.isArray(config?.aiEndpoints) ? config.aiEndpoints : []) {
      if (endpoint?.enabled !== false) endpoints.push(endpoint?.baseUrl);
    }
    const origins = new Map();
    for (const raw of endpoints) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      try {
        const url = new URL(raw);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
        // Host permission match patterns apply to every port on a host.
        const pattern = `${url.protocol}//${url.hostname}/*`;
        origins.set(url.origin, pattern);
      } catch (_) {}
    }
    return [...origins].map(([origin, pattern]) => ({ origin, pattern }));
  }

  async function refreshPermissions() {
    const revision = ++permissionRevision;
    authorizeButton.disabled = true;
    authorizeAllButton.disabled = true;
    try {
      const [stored, allGranted] = await Promise.all([
        chrome.storage.local.get(CONFIG_KEY),
        chrome.permissions.contains({ origins: ALL_API_ORIGINS }),
      ]);
      const origins = apiOrigins(stored[CONFIG_KEY]);
      const states = await Promise.all(origins.map(async (item) => ({
        ...item, granted: allGranted || await chrome.permissions.contains({ origins: [item.pattern] }),
      })));
      if (revision !== permissionRevision) return;
      allApiGranted = allGranted;
      permissionPatterns = [...new Set(states.filter((item) => !item.granted).map((item) => item.pattern))];
      const list = byId('api-origins');
      list.replaceChildren();
      for (const item of states) {
        const row = document.createElement('li');
        const origin = document.createElement('span');
        origin.className = 'origin';
        origin.textContent = item.origin;
        const permission = document.createElement('span');
        permission.className = 'permission' + (item.granted ? ' granted' : '');
        permission.textContent = item.granted ? '已授权' : '待授权';
        row.append(origin, permission);
        list.append(row);
      }
      byId('api-summary').textContent = allGranted
        ? '访问权限已记住：新增接口、测试连接和拉取模型无需再次授权。'
        : !states.length ? '可先一次授权，或保存接口后仅授权对应域名。'
          : permissionPatterns.length ? '以下服务尚未授权。可一次允许所有 API 域名，或仅允许已保存域名。'
            : '已保存的域名均已授权；同域名下更换模型、密钥或地址路径无需再次授权。';
      authorizeAllButton.textContent = allGranted ? '已开启：新增 API 免重复授权' : '一次授权，新增 API 免重复授权';
      authorizeAllButton.disabled = permissionBusy || allGranted;
      authorizeButton.textContent = states.length && !permissionPatterns.length ? 'AI 接口已授权' : '仅授权已保存域名';
      authorizeButton.disabled = permissionBusy || permissionPatterns.length === 0;
    } catch (_) {
      if (revision !== permissionRevision) return;
      permissionPatterns = [];
      allApiGranted = false;
      byId('api-summary').textContent = '无法读取接口权限，请重新打开扩展后重试。';
      authorizeButton.disabled = true;
      authorizeAllButton.disabled = true;
    }
  }

  toggleButton.addEventListener('click', () => pageAction('toggle-panel'));
  stopButton.addEventListener('click', () => pageAction('stop'));
  byId('open-boss').addEventListener('click', async () => {
    try { await chrome.tabs.create({ url: 'https://www.zhipin.com/web/geek/job' }); }
    catch (_) { message('未能打开职位页，请手动打开 BOSS 网站。', true); }
  });
  function requestPermissions(origins, all = false) {
    if (permissionBusy || !origins.length) return;
    permissionBusy = true;
    authorizeButton.disabled = true;
    authorizeAllButton.disabled = true;
    // Call directly in the user click handler, before any await, to preserve the browser gesture.
    let request;
    try { request = chrome.permissions.request({ origins: [...origins] }); }
    catch (_) { request = Promise.reject(new Error('Permission request unavailable')); }
    Promise.resolve(request).then((granted) => {
      message(granted ? all
        ? '一次授权完成。后续新增接口和拉取模型无需再授权，可回到页面继续。'
        : 'AI 接口授权完成。此域名的权限会保留，无需每次拉取模型时授权。'
        : '未授予新的接口权限，已有授权和本地筛选仍可使用。', !granted);
    }, () => {
      message('权限操作未完成，请重新打开扩展后重试。', true);
    }).finally(() => { permissionBusy = false; refreshPermissions(); });
  }
  authorizeButton.addEventListener('click', () => {
    if (!authorizeButton.disabled) requestPermissions(permissionPatterns);
  });
  authorizeAllButton.addEventListener('click', () => {
    if (!authorizeAllButton.disabled && !allApiGranted) requestPermissions(ALL_API_ORIGINS, true);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.hasOwn(changes, CONFIG_KEY)) refreshPermissions();
  });
  chrome.permissions.onAdded.addListener(refreshPermissions);
  chrome.permissions.onRemoved.addListener(refreshPermissions);
  refreshPage();
  refreshPermissions();
})();
