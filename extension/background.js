'use strict';

// All durable writes and quota decisions are serialized in this extension worker.
// Content scripts run in the isolated world; no page-message bridge is installed.
function createBossNativeBackground(api, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch.bind(globalThis);
  const now = dependencies.now || Date.now;
  const uuid = dependencies.uuid || (() => crypto.randomUUID());
  const setTimer = dependencies.setTimeout || setTimeout;
  const clearTimer = dependencies.clearTimeout || clearTimeout;
  const CONFIG = 'boss_helper_config_v1';
  const STATS = 'boss_helper_stats_v1';
  const EVENT = 'boss_helper_daily_event_v22_';
  const INDEX = 'boss_helper_daily_index_v22_';
  const RESERVED_KEYS = /^(?:boss_helper_daily_(?:event|index|mutex)_v22_|boss_helper_daily_lock_v22$)/;
  const DIAGNOSTICS = ['processed', 'skipped', 'errors', 'aiHits'];
  const MAX_BODY = 2 * 1024 * 1024;
  const MAX_RESPONSE = 4 * 1024 * 1024;
  const requests = new Map();
  let queue = Promise.resolve();

  function serial(fn) {
    const task = queue.then(fn, fn);
    queue = task.catch(() => {});
    return task;
  }
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const count = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
  const day = () => new Date(now() + 8 * 3600000).toISOString().slice(0, 10);
  const stable = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
  function error(message, code = 'NATIVE_ERROR') { return Object.assign(new Error(message), { code }); }
  function trustedSender(sender) {
    if (!sender || sender.id !== api.runtime.id) return false;
    const url = sender.url || sender.tab?.url || '';
    if (url.startsWith(api.runtime.getURL(''))) return true;
    try {
      const parsed = new URL(url);
      return (sender.frameId == null || sender.frameId === 0) && parsed.protocol === 'https:'
        && ['www.zhipin.com', 'www.zhipin.cn'].includes(parsed.hostname);
    } catch (_) { return false; }
  }
  const owner = (sender) => String(sender.tab?.id ?? 'extension') + ':' + String(sender.frameId ?? 0) + ':' + (sender.documentId || sender.url || '');
  async function allValues() { return (await api.storage.local.get(null)) || {}; }
  async function persist(values) {
    if (!Object.keys(values).length) return;
    await api.storage.local.set(values);
    const persisted = await api.storage.local.get(Object.keys(values));
    if (Object.keys(values).some((key) => stable(persisted[key]) !== stable(values[key]))) {
      throw error('扩展配置未能持久化，请检查浏览器存储空间后重试', 'STORAGE_FAILED');
    }
  }
  function base(values) {
    const current = values[STATS];
    return current?.date === day() ? { ...current, schema: 22, sent: count(current.sent), aiCalls: count(current.aiCalls) }
      : { schema: 22, date: day(), sent: 0, aiCalls: 0, processed: 0, skipped: 0, errors: 0, aiHits: 0 };
  }
  function events(values) {
    const prefix = EVENT + day() + '_';
    return Object.entries(values).filter(([key, item]) => key.startsWith(prefix) && item?.date === day())
      .map(([key, item]) => ({ ...item, key }));
  }
  function stats(values) {
    const result = base(values), journal = events(values);
    result.sent += journal.filter((item) => item.kind === 'sent' && item.status === 'dispatched').length;
    result.aiCalls += journal.filter((item) => item.kind === 'ai' && item.status === 'dispatched').length;
    result.pending = journal.filter((item) => item.kind === 'sent' && item.status === 'reserved' && item.expiresAt > now()).length;
    return result;
  }
  function jobHash(value) {
    const json = JSON.stringify(String(value));
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < json.length; i++) { const c = json.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }
  function maximum(values, requested, field, fallback) {
    const saved = values[CONFIG]?.[field];
    return Math.min(count(requested ?? fallback), count(saved == null ? fallback : saved));
  }
  async function append(values, event) {
    const key = EVENT + event.date + '_' + uuid();
    const indexKey = INDEX + event.date;
    const keys = [...new Set([...(Array.isArray(values[indexKey]?.keys) ? values[indexKey].keys : []), key])];
    const update = { [key]: event, [indexKey]: { keys } };
    await persist(update);
    Object.assign(values, update);
    return { ...event, key };
  }
  async function prune(values) {
    const cutoff = new Date(now() + 8 * 3600000 - 7 * 86400000).toISOString().slice(0, 10);
    const obsolete = Object.keys(values).filter((key) => {
      const match = /^(?:boss_helper_daily_event_v22_|boss_helper_daily_index_v22_)(\d{4}-\d{2}-\d{2})(?:_|$)/.exec(key);
      return match && match[1] < cutoff;
    });
    if (obsolete.length) { await api.storage.local.remove(obsolete); obsolete.forEach((key) => delete values[key]); }
  }
  async function quota(action, message, sender) {
    return serial(async () => {
      const values = await allValues();
      await prune(values);
      const current = stats(values);
      let value = false;
      if (action === 'quota.consumeAI') {
        if (current.aiCalls < maximum(values, message.limit, 'aiDailyLimit', 100)) {
          value = !!await append(values, { date: day(), kind: 'ai', status: 'dispatched', ts: now() });
        }
      } else if (action === 'quota.reserve') {
        const hash = message.jobId ? jobHash(message.jobId) : '';
        const duplicate = hash && events(values).some((item) => item.kind === 'sent' && item.jobHash === hash
          && (item.status === 'dispatched' || item.status === 'reserved' && item.expiresAt > now()));
        if (values[CONFIG]?.autoSend !== false && !duplicate && current.sent + current.pending < maximum(values, message.limit, 'dailyLimit', 50)) {
          value = await append(values, { date: day(), kind: 'sent', status: 'reserved', jobHash: hash,
            owner: owner(sender), ts: now(), expiresAt: now() + 60000 });
        }
      } else if (['quota.commit', 'quota.release', 'quota.markClicked', 'quota.cancelUnclicked'].includes(action)) {
        const reservation = message.reservation;
        const key = typeof reservation?.key === 'string' ? reservation.key : '';
        const stored = key.startsWith(EVENT + day() + '_') ? values[key] : null;
        const valid = stored?.kind === 'sent' && stored.date === day() && stored.owner === owner(sender);
        if (valid && action === 'quota.release') {
          if (stored.status === 'reserved') { const event = { ...stored, status: 'cancelled' }; await persist({ [key]: event }); values[key] = event; }
          value = true;
        } else if (valid && action === 'quota.commit' && stored.status === 'reserved' && stored.expiresAt > now() && values[CONFIG]?.autoSend !== false
          && current.sent < maximum(values, message.limit, 'dailyLimit', 50)) {
          // Hold quota durably before activation, while allowing the owner to cancel a
          // preparation that the content script can prove never attempted a click.
          const event = { ...stored, status: 'dispatched', clickPending: true };
          await persist({ [key]: event }); values[key] = event; value = true;
        } else if (valid && action === 'quota.markClicked' && stored.status === 'dispatched' && stored.clickPending === true) {
          const event = { ...stored, clickPending: false, clickedAt: now() };
          await persist({ [key]: event }); values[key] = event; value = true;
        } else if (valid && action === 'quota.cancelUnclicked' && (stored.status === 'reserved'
          || stored.status === 'dispatched' && stored.clickPending === true)) {
          // Missing clickPending belongs to older, possibly sent records: never release it.
          const event = { ...stored, status: 'cancelled', clickPending: false };
          await persist({ [key]: event }); values[key] = event; value = true;
        }
      }
      return { ok: true, value, values };
    });
  }
  function normalizeChatUrl(baseUrl) {
    let value = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(value)) return value;
    try { const path = new URL(value).pathname.replace(/\/+$/, ''); if (!path || /\/v\d+[a-z]*$/i.test(path) || /\/openai$/i.test(path)) value += '/chat/completions'; } catch (_) {}
    return value;
  }
  function modelsUrl(baseUrl) {
    const value = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    return /\/chat\/completions$/i.test(value) ? value.replace(/\/chat\/completions$/i, '/models') : value + '/models';
  }
  function permissionPattern(url) { return url.protocol + '//' + url.hostname + '/*'; }
  async function validateNetwork(message) {
    const method = String(message.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw error('仅支持 AI 模型列表与对话请求', 'INVALID_REQUEST');
    let url;
    try { url = new URL(message.url); } catch (_) { throw error('AI 地址无效', 'INVALID_REQUEST'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw error('AI 地址须为不含账号或密码的 HTTP/HTTPS 地址', 'INVALID_REQUEST');
    const values = await allValues(), cfg = values[CONFIG] || {};
    const bases = message.endpoint?.baseUrl ? [message.endpoint.baseUrl]
      : [cfg.aiBaseUrl, ...(Array.isArray(cfg.aiEndpoints) ? cfg.aiEndpoints.map((item) => item.baseUrl) : [])].filter(Boolean);
    if (!bases.some((baseUrl) => {
      try { return new URL(method === 'POST' ? normalizeChatUrl(baseUrl) : modelsUrl(baseUrl)).href === url.href; }
      catch (_) { return false; }
    })) {
      throw error('请求地址与指定的 AI 接口不一致', 'INVALID_REQUEST');
    }
    if (!await api.permissions.contains({ origins: [permissionPattern(url)] })) {
      throw error('尚未授权此 AI 服务的浏览器访问权限（不是 API 密钥验证失败）。请点击工具栏中的助手图标，选择「一次授权，新增 API 免重复授权」；或先保存接口，再选择「仅授权已保存域名」。授权后重新拉取模型或测试连接，同一域名无需重复授权。', 'HOST_PERMISSION_REQUIRED');
    }
    const headers = {};
    for (const [name, value] of Object.entries(message.headers || {})) {
      if (!/^(authorization|content-type|accept|api-key|x-api-key|anthropic-version)$/i.test(name) || /[\r\n]/.test(String(value))) {
        throw error('不支持此请求头', 'INVALID_REQUEST');
      }
      headers[name] = String(value);
    }
    const body = message.body == null ? undefined : String(message.body);
    if (body && body.length > MAX_BODY) throw error('AI 请求内容过长', 'INVALID_REQUEST');
    return { url: url.href, method, headers, body: method === 'POST' ? body : undefined,
      timeout: Math.max(1000, Math.min(120000, count(message.timeout) || 20000)) };
  }
  async function responseText(response, controller) {
    if (!response.body?.getReader) {
      const text = await response.text();
      if (text.length > MAX_RESPONSE) throw error('AI 响应内容过长', 'RESPONSE_TOO_LARGE');
      return text;
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let bytes = 0, text = '';
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE) { controller.abort(); throw error('AI 响应内容过长', 'RESPONSE_TOO_LARGE'); }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  }
  async function network(message, sender) {
    const id = String(message.requestId || '');
    if (!/^[\w-]{1,100}$/.test(id)) throw error('请求编号无效', 'INVALID_REQUEST');
    const key = owner(sender) + ':' + id;
    if (requests.has(key)) throw error('请求编号重复', 'INVALID_REQUEST');
    const controller = new AbortController();
    const request = { controller, aborted: false, timedOut: false };
    requests.set(key, request);
    let timer;
    try {
      const options = await validateNetwork(message);
      if (request.aborted) throw error('AI 请求已中止', 'ABORTED');
      timer = setTimer(() => { request.timedOut = true; controller.abort(); }, options.timeout);
      const response = await fetchImpl(options.url, { method: options.method, headers: options.headers, body: options.body,
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
      const text = await responseText(response, controller);
      return { ok: true, value: { status: response.status, responseText: text,
        responseHeaders: [...response.headers.entries()].map(([name, value]) => name + ': ' + value).join('\r\n'), finalUrl: response.url || options.url } };
    } catch (err) {
      if (err.code === 'HOST_PERMISSION_REQUIRED') return { ok: true, value: { status: 403,
        responseText: JSON.stringify({ error: { message: err.message } }), responseHeaders: 'content-type: application/json', finalUrl: message.url } };
      const code = request.timedOut ? 'TIMEOUT' : request.aborted ? 'ABORTED' : err.code || 'NETWORK_ERROR';
      throw error(code === 'TIMEOUT' ? 'AI 请求超时' : code === 'ABORTED' ? 'AI 请求已中止' : err.code ? err.message : 'AI 网络请求失败，请检查服务地址和网络连接', code);
    } finally { clearTimer(timer); requests.delete(key); }
  }
  async function handle(message, sender) {
    if (!trustedSender(sender)) return { ok: false, error: '不允许此页面访问扩展', code: 'UNTRUSTED_SENDER' };
    if (message?.type !== 'BH_NATIVE') return { ok: false, error: '消息格式无效', code: 'INVALID_REQUEST' };
    try {
      const action = message.action;
      if (action === 'storage.getAll') return await serial(async () => ({ ok: true, value: await allValues() }));
      if (action === 'storage.set') return await serial(async () => {
        const values = await allValues(), update = clone(message.values || {});
        if (!update || Array.isArray(update) || typeof update !== 'object') throw error('存储格式无效', 'INVALID_REQUEST');
        for (const [key, value] of Object.entries(update)) {
          if (!key.startsWith('boss_helper_') || RESERVED_KEYS.test(key)) throw error('该存储项只能由额度管理器修改', 'INVALID_REQUEST');
          if (key === STATS) {
            const current = base(values);
            update[key] = { ...current, ...Object.fromEntries(DIAGNOSTICS.map((field) => [field, count(value?.[field])])) };
          }
          if (key === CONFIG) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('配置格式无效', 'INVALID_REQUEST');
            update[key]._configUpdatedAt = Math.max(now(), count(values[key]?._configUpdatedAt) + 1, count(value._configUpdatedAt));
          }
        }
        await persist(update); Object.assign(values, update); return { ok: true, value: true, values };
      });
      if (action === 'storage.remove') return await serial(async () => {
        const keys = Array.isArray(message.keys) ? message.keys : [message.key];
        if (keys.some((key) => typeof key !== 'string' || !key.startsWith('boss_helper_') || key === STATS || RESERVED_KEYS.test(key))) {
          throw error('不允许删除当日额度记录', 'INVALID_REQUEST');
        }
        await api.storage.local.remove(keys);
        const values = await allValues();
        if (keys.some((key) => key in values)) throw error('扩展存储删除失败', 'STORAGE_FAILED');
        return { ok: true, value: true, values };
      });
      if (['quota.consumeAI', 'quota.reserve', 'quota.commit', 'quota.release', 'quota.markClicked', 'quota.cancelUnclicked'].includes(action)) return await quota(action, message, sender);
      if (action === 'network.fetch') return await network(message, sender);
      if (action === 'network.abort') {
        const pending = requests.get(owner(sender) + ':' + String(message.requestId));
        if (pending) { pending.aborted = true; pending.controller.abort(); }
        return { ok: true, value: !!pending };
      }
      return { ok: false, error: '不支持的扩展操作', code: 'INVALID_REQUEST' };
    } catch (err) {
      return { ok: false, error: err?.code ? err.message : '扩展存储或连接不可用，请重试或刷新 BOSS 页面', code: err?.code || 'NATIVE_ERROR' };
    }
  }
  function install() {
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== 'BH_NATIVE') return undefined;
      handle(message, sender).then(sendResponse);
      return true;
    });
    api.runtime.onConnect?.addListener((port) => {
      if (port.name !== 'bh-network' || !trustedSender(port.sender)) { port.disconnect(); return; }
      // An active AI call may outlive the worker's idle interval; pings are isolated extension messages.
      port.onMessage.addListener(() => {});
    });
  }
  return { handle, install, stats, trustedSender };
}

if (typeof module === 'object' && module.exports) module.exports = { createBossNativeBackground };
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) createBossNativeBackground(chrome).install();
