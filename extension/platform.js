(function installBossNativePlatform(global) {
  'use strict';
  if (global.BHNative) return;
  const api = global.chrome;
  if (!api?.runtime?.sendMessage) throw new Error('BOSS 助手需要作为浏览器扩展加载');
  const values = Object.create(null), pending = new Map(), failures = new Map(), observedChanges = new Map();
  const listeners = new Set(), errorListeners = new Set();
  let sequence = 0, changeGeneration = 0, queue = Promise.resolve(), initialized = false, connected = true, lastError = '';
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const error = (message, code) => Object.assign(new Error(message), { code: code || 'NATIVE_ERROR' });
  function report(err) {
    lastError = String(err?.message || err);
    for (const fn of errorListeners) { try { fn(err); } catch (_) {} }
  }
  function emit(changes) {
    if (!Object.keys(changes).length) return;
    for (const fn of listeners) { try { fn(clone(changes)); } catch (_) {} }
  }
  function applySnapshot(snapshot, completedSequence = 0, observedAfter = Infinity) {
    const changes = {};
    for (const key of new Set([...Object.keys(values), ...Object.keys(snapshot || {}), ...observedChanges.keys()])) {
      if (pending.has(key) && pending.get(key).sequence > completedSequence) continue;
      const notice = observedChanges.get(key);
      const newerNotice = notice && notice.generation > observedAfter;
      const exists = newerNotice ? notice.exists : own(snapshot || {}, key);
      const oldValue = values[key], newValue = newerNotice ? notice.value : snapshot?.[key];
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
      if (exists) values[key] = clone(newValue); else delete values[key];
      changes[key] = { oldValue: clone(oldValue), newValue: clone(newValue) };
    }
    emit(changes);
  }
  async function send(action, data = {}) {
    const observedAtStart = changeGeneration;
    let result;
    try { result = await api.runtime.sendMessage({ type: 'BH_NATIVE', action, ...data }); }
    catch (_) { connected = false; throw error('扩展连接已中断，请刷新 BOSS 页面后重试', 'DISCONNECTED'); }
    if (!result?.ok) throw error(result?.error || '扩展未能完成操作，请刷新页面后重试', result?.code);
    connected = true;
    // Storage notifications can arrive before an older request's response. Keep their
    // generation with the response so a stale full snapshot cannot undo newer keys/deletions.
    return { ...result, observedAtStart };
  }
  const ready = send('storage.getAll').then((result) => {
    applySnapshot(result.value || {}, 0, result.observedAtStart); initialized = true; return true;
  }).catch((err) => { report(err); throw err; });
  // Loading failures are also surfaced by content.js; attach a handler to avoid an unhandled rejection before it loads.
  ready.catch(() => {});
  function requireReady() { if (!initialized) throw error('扩展配置尚未载入', 'NOT_READY'); }
  function enqueue(key, value, removed = false) {
    requireReady();
    const revision = ++sequence;
    const payload = clone(value);
    pending.set(key, { sequence: revision, value: payload, removed });
    if (removed) delete values[key]; else values[key] = payload;
    const operation = async () => {
      try {
        const result = await send(removed ? 'storage.remove' : 'storage.set', removed ? { keys: [key] } : { values: { [key]: payload } });
        if (pending.get(key)?.sequence === revision) pending.delete(key);
        failures.delete(key);
        applySnapshot(result.values || {}, revision, result.observedAtStart);
        if (!failures.size) lastError = '';
      } catch (err) {
        failures.set(key, err);
        if (pending.get(key)?.sequence === revision) pending.delete(key);
        // Roll back a failed optimistic write so it can never be treated as durable configuration.
        try { const result = await send('storage.getAll'); applySnapshot(result.value || {}, revision, result.observedAtStart); } catch (_) {}
        report(err);
      }
    };
    queue = queue.then(operation, operation);
  }
  async function flush() {
    await ready;
    let current;
    do { current = queue; await current; } while (current !== queue);
    if (failures.size) throw failures.values().next().value;
    if (!connected) throw error('扩展连接已中断，请刷新 BOSS 页面后重试', 'DISCONNECTED');
    return true;
  }
  async function quota(action, data) {
    try {
      await flush();
      const result = await send(action, data);
      applySnapshot(result.values || {}, 0, result.observedAtStart);
      return result.value;
    } catch (err) { report(err); throw err; }
  }
  function heartbeat() {
    let port, timer;
    try {
      port = api.runtime.connect({ name: 'bh-network' });
      port.onDisconnect?.addListener(() => { if (timer) clearInterval(timer); });
      timer = setInterval(() => { try { port.postMessage({ type: 'keepalive' }); } catch (_) { clearInterval(timer); } }, 15000);
    } catch (_) {}
    return () => { if (timer) clearInterval(timer); try { port?.disconnect(); } catch (_) {} };
  }
  function request(details = {}) {
    const requestId = (global.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
    let aborted = false, finished = false, dispatched = false;
    let stopHeartbeat = () => {};
    function settle(callback, value) {
      if (finished) return;
      finished = true; stopHeartbeat();
      try { callback?.(value); } catch (err) { setTimeout(() => { throw err; }, 0); }
    }
    const complete = (async () => {
      await ready;
      if (aborted) return;
      stopHeartbeat = heartbeat(); dispatched = true;
      const result = await send('network.fetch', {
        requestId, method: details.method || 'GET', url: String(details.url || ''),
        headers: clone(details.headers || {}), body: details.data ?? details.body,
        timeout: details.timeout || 20000, endpoint: details.endpoint ? clone(details.endpoint) : undefined,
      });
      if (!aborted) settle(details.onload, result.value);
    })().catch((err) => {
      if (finished) return;
      if (err.code === 'DISCONNECTED') report(err);
      const callback = err.code === 'TIMEOUT' ? details.ontimeout : err.code === 'ABORTED' ? details.onabort : details.onerror;
      settle(callback, { error: err.message, code: err.code });
    });
    return {
      abort() {
        if (finished) return;
        aborted = true;
        if (dispatched) send('network.abort', { requestId }).catch(() => {});
        settle(details.onabort, { error: 'AI 请求已中止', code: 'ABORTED' });
      },
      // A settled promise helps integration tests observe cleanup without depending on timer timing.
      finished: complete,
    };
  }
  function nativeFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      let handle;
      const abortError = () => new DOMException('AI 请求已中止', 'AbortError');
      const abort = () => handle?.abort();
      const cleanup = () => options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted) { reject(abortError()); return; }
      const headers = options.headers instanceof Headers ? Object.fromEntries(options.headers.entries()) : options.headers || {};
      handle = request({ method: options.method || 'GET', url: String(url), headers, data: options.body,
        timeout: options.timeout || 120000, endpoint: options.endpoint,
        onload(response) {
          cleanup();
          const responseHeaders = new Headers();
          for (const line of String(response.responseHeaders || '').split(/\r?\n/)) {
            const index = line.indexOf(':'); if (index > 0) responseHeaders.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
          }
          const noBody = [204, 205, 304].includes(response.status);
          const result = new Response(noBody ? null : response.responseText, { status: response.status, headers: responseHeaders });
          Object.defineProperty(result, 'url', { value: response.finalUrl || String(url) });
          resolve(result);
        },
        onerror(result) { cleanup(); reject(error(result?.error || 'AI 网络请求失败', result?.code)); },
        ontimeout() { cleanup(); reject(new DOMException('AI 请求超时', 'AbortError')); },
        onabort() { cleanup(); reject(abortError()); },
      });
      options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  api.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    const generation = ++changeGeneration;
    const applied = {};
    for (const [key, change] of Object.entries(changes)) {
      // Pending local edits still win in the form until saved, but retain the latest
      // authoritative notice to reconcile that key once its pending write completes.
      observedChanges.set(key, { generation, exists: change.newValue !== undefined, value: clone(change.newValue) });
      if (pending.has(key)) continue;
      if (change.newValue === undefined) delete values[key]; else values[key] = clone(change.newValue);
      applied[key] = change;
    }
    emit(applied);
  });
  global.BHNative = Object.freeze({
    ready, flush,
    get healthy() { return initialized && connected && !lastError && failures.size === 0; },
    health: () => ({ ready: initialized, connected, pending: pending.size, error: lastError }),
    getValue(key, fallback) { requireReady(); return own(values, key) ? clone(values[key]) : fallback; },
    setValue(key, value) { enqueue(String(key), value); },
    deleteValue(key) { enqueue(String(key), undefined, true); },
    listValues() { requireReady(); return Object.keys(values); },
    addStyle(css) { const style = document.createElement('style'); style.textContent = String(css); (document.head || document.documentElement).append(style); return style; },
    onChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onError(fn) { errorListeners.add(fn); if (lastError) fn(error(lastError)); return () => errorListeners.delete(fn); },
    consumeAIDailyQuota: () => quota('quota.consumeAI', {}),
    reserveDelivery: (jobId, limit) => quota('quota.reserve', { jobId, limit }),
    commitDelivery: (reservation, limit) => quota('quota.commit', { reservation, limit }),
    markDeliveryClicked: (reservation) => quota('quota.markClicked', { reservation }),
    cancelUnclickedDelivery: (reservation) => quota('quota.cancelUnclicked', { reservation }),
    releaseDelivery: (reservation) => reservation ? quota('quota.release', { reservation }) : Promise.resolve(false),
    request, fetch: nativeFetch,
  });
})(globalThis);
