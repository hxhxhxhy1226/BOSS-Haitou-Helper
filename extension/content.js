(function installBossContentControl() {
  'use strict';
  if (window.__bossContentControl) return;
  window.__bossContentControl = true;
  const supportedPage = () => /^\/job_detail\//.test(location.pathname)
    || /^\/web\/geek\/(?:job|jobs|recommend)/.test(location.pathname);
  async function helper() {
    await window.BHNative.ready;
    // helper.js registers its ready continuation before this entry point.
    if (!window.BH) await new Promise((resolve) => setTimeout(resolve, 0));
    if (!window.BH) throw new Error('助手初始化失败，请刷新 BOSS 页面');
    return window.BH;
  }
  function snapshot(core) {
    const panel = document.getElementById('boss-helper-panel');
    return { ok: true, running: core.state.running, paused: core.state.paused,
      visible: !!panel && !panel.hidden, version: chrome.runtime.getManifest().version };
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'BH_UI') return undefined;
    (async () => {
      const core = await helper();
      if (message.action === 'stop') core.stop('通过扩展工具栏停止');
      else if (message.action === 'toggle-panel') {
        if (!supportedPage()) throw new Error('请打开 BOSS 职位列表或详情页');
        core.setPanelVisible(document.getElementById('boss-helper-panel')?.hidden !== false);
      } else if (message.action !== 'status') throw new Error('未知助手操作');
      return snapshot(core);
    })().then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
  helper().catch((error) => {
    const notice = document.createElement('div');
    notice.id = 'boss-helper-load-error';
    notice.textContent = error.message || '助手加载失败，请刷新 BOSS 页面';
    Object.assign(notice.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
      background: '#fff4f4', color: '#a12626', padding: '16px', borderRadius: '12px', maxWidth: '340px' });
    document.documentElement.append(notice);
  });
})();
