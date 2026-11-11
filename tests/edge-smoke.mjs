// Real Edge extension smoke test. Every BOSS document is fulfilled locally over CDP;
// all other page requests are blocked. No recruitment account or live message is used.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// fileURLToPath preserves spaces and non-ASCII Windows workspace names.
const { fileURLToPath } = await import('node:url');
const cwd = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(cwd, 'extension', 'manifest.json'), 'utf8'));
const extensionVersion = manifest.version;
const output = path.join(cwd, 'artifacts');
const profile = path.join(output, 'edge-extension-' + Date.now());
const extension = path.join(cwd, 'dist', 'boss-helper-edge-' + extensionVersion);
await fs.mkdir(profile, { recursive: true });
const binary = process.env.EDGE_BINARY || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const child = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile,
  '--load-extension=' + extension, '--disable-extensions-except=' + extension, 'about:blank'],
{ windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let browserLog = '';
child.stderr.on('data', (chunk) => { browserLog += chunk; });
let ws, sequence = 0;
const pending = new Map(), handlers = new Set(), checks = [], pageErrors = [];
function check(condition, message) { assert.ok(condition, message); checks.push(message); console.log('PASS ' + message); }
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) { value = await fn(); if (value) return value; await delay(100); }
  throw Error('Condition timed out after ' + timeout + 'ms');
}
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(session, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
const detail = `<section class="job-detail" data-jobid="fixture01"><header class="job-banner">
  <h1 class="job-name">嵌入式软件工程师</h1><a class="company-name" href="/gongsi/fixture.html">本地测试公司</a>
  <span class="salary">20-30K</span><a class="job-detail-link" href="/job_detail/extensionFixture.html">查看职位</a>
  <a class="op-btn-chat" href="javascript:void(0)">立即沟通</a></header>
  <section class="job-detail-section"><h2>职位描述</h2><div class="job-sec-text">负责 STM32 产品固件研发、FreeRTOS 驱动调试、接口协议实现以及产品功能维护，参与设备通信软件开发。</div></section>
  <div class="boss-info"><span class="active-time">今日活跃</span></div></section>`;
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>独立扩展本地验收</title>
  <style>body{font:16px/1.6 sans-serif;background:#eef3f8;padding:24px;color:#223} .job-list-wrapper{width:330px;padding:20px;background:#fff} main{margin-left:380px;max-width:420px} .op-btn-chat{display:inline-block;padding:12px;background:#00bca4;color:white} .job-sec-text{padding:16px 0} a{cursor:pointer} .contact-completed-overlay{position:fixed;inset:0;z-index:2000;background:#0006;display:flex;align-items:center;justify-content:center}.contact-completed-box{width:500px;background:white;padding:28px;border-radius:16px}.contact-completed-preview{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#f5f5f5;padding:10px}.contact-completed-footer{display:flex;gap:12px;justify-content:flex-end;margin-top:24px}.contact-completed-footer button{padding:10px 16px}</style>
  <h1>Edge 独立扩展验收 · 本地模拟职位</h1><p>无油猴、无真实账号；网站请求全部由本地测试接管。</p>
  <ul class="job-list-wrapper"><li class="job-card-box" data-jobid="fixture01"><a class="job-name" href="/job_detail/extensionFixture.html">嵌入式软件工程师</a><span class="job-salary">20-30K</span><ul class="tag-list"><li>本科</li><li>3-5年</li></ul><a class="company-name" href="/gongsi/fixture.html">本地测试公司</a><div class="job-card-footer"><span class="time">刚刚活跃</span></div></li></ul>
  <main id="detail-host">${detail}</main><script>
  window.fixtureClicks=0; window.fixtureReplacements=0; window.fixtureClickedGeneration=0;
  window.fixtureStayClicks=0; window.fixtureContinueClicks=0; window.fixtureDialogClosed=false;
  let fixtureReplaceTimer=null, fixtureReplaceDeadline=null;
  function stopRebuilding(){clearInterval(fixtureReplaceTimer);clearTimeout(fixtureReplaceDeadline);fixtureReplaceTimer=null;fixtureReplaceDeadline=null;}
  function bindContact(){document.querySelector('.op-btn-chat').addEventListener('click',function(e){
    e.preventDefault();fixtureClicks++;fixtureClickedGeneration=Number(this.dataset.fixtureGeneration||0);stopRebuilding();this.textContent='继续沟通';
    const detailHost=document.querySelector('#detail-host');detailHost.setAttribute('aria-hidden','true');
    const overlay=document.createElement('div');overlay.className='contact-completed-overlay';
    overlay.innerHTML='<section class="contact-completed-box"><h3><span>已向</span> <span>BOSS</span> <span>发送</span> <span>消息</span></h3><div class="contact-completed-preview"></div><p>如需修改打招呼内容，请在消息通知页面修改</p><footer class="contact-completed-footer"><button data-fixture-stay>留在此页</button><button data-fixture-continue>继续沟通</button></footer></section>';
    overlay.querySelector('.contact-completed-preview').textContent='本地模拟的招呼内容与项目经验，仅用于检查长消息预览。'.repeat(100);
    overlay.querySelector('[data-fixture-stay]').addEventListener('click',function(){fixtureStayClicks++;setTimeout(function(){overlay.remove();detailHost.removeAttribute('aria-hidden');fixtureDialogClosed=true;},120);});
    overlay.querySelector('[data-fixture-continue]').addEventListener('click',function(){fixtureContinueClicks++;});
    document.body.append(overlay);
  });}
  function startRebuilding(){stopRebuilding();fixtureReplaceTimer=setInterval(function(){const old=document.querySelector('.op-btn-chat');if(!old||fixtureClicks){stopRebuilding();return;}const current=old.cloneNode(true);current.dataset.fixtureGeneration=String(++fixtureReplacements);old.replaceWith(current);bindContact();},80);fixtureReplaceDeadline=setTimeout(stopRebuilding,6000);}
  bindContact(); document.querySelector('.job-card-box').addEventListener('click',function(e){e.preventDefault();document.querySelector('#detail-host').innerHTML=${JSON.stringify(detail)};bindContact();startRebuilding();});
  </script></html>`;
try {
  const portFile = await until(async () => { try { return await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return null; } });
  const [port, socket] = portFile.trim().split(/\r?\n/);
  ws = new WebSocket('ws://127.0.0.1:' + port + socket);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timeout);
      if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result);
    } else for (const handler of handlers) handler(message);
  });
  const workerSessions = new Map();
  const worker = await until(async () => {
    const targets = (await send('Target.getTargets')).targetInfos.filter((target) => target.type === 'service_worker' && target.url.startsWith('chrome-extension://'));
    for (const target of targets) {
      if (!workerSessions.has(target.targetId)) {
        const session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
        workerSessions.set(target.targetId, session);
        await send('Runtime.enable', {}, session);
      }
      try {
        const name = await evaluate(workerSessions.get(target.targetId), 'typeof chrome!=="undefined"&&chrome.runtime?.getManifest().name');
        if (name === 'BOSS直聘海投助手') return target;
      } catch {}
    }
    return null;
  });
  console.log('Extension worker: ' + worker.url);
  const workerUrl = new URL(worker.url);
  const extensionOrigin = workerUrl.protocol + '//' + workerUrl.host;
  const workerSession = workerSessions.get(worker.targetId);
  check((await evaluate(workerSession, 'chrome.runtime.getManifest().version')) === extensionVersion, 'Edge 实际加载 Manifest V3 扩展与后台');
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const page = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  handlers.add((event) => {
    if (event.sessionId !== page) return;
    if (event.method === 'Runtime.exceptionThrown') pageErrors.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
    if (event.method === 'Fetch.requestPaused') {
      const { requestId, resourceType, request } = event.params;
      const local = resourceType === 'Document' && request.url.startsWith('https://www.zhipin.com/');
      send(local ? 'Fetch.fulfillRequest' : 'Fetch.failRequest', local ? { requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(fixture).toString('base64') }
        : { requestId, errorReason: 'BlockedByClient' }, page).catch((error) => pageErrors.push(error.message));
    }
  });
  await send('Runtime.enable', {}, page);
  await send('Page.enable', {}, page);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, page);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, page);
  await send('Page.navigate', { url: 'https://www.zhipin.com/web/geek/job?extension-local-test' }, page);
  await until(() => evaluate(page, "!!document.querySelector('#boss-helper-panel')"));
  check(await evaluate(page, 'fixtureClicks===0 && typeof window.GM_getValue === "undefined" && typeof window.BH === "undefined"'), '内容脚本独立注入，无油猴全局，默认不投递');
  await evaluate(page, `(()=>{const field=k=>document.querySelector('[data-cfg="'+k+'"]'); for(const [k,v] of Object.entries({mustHave:'',mustNot:'',yearsMin:0,eduMin:0,salaryMin:0,activeDays:0,minDelay:0.5,maxDelay:0.5,dailyLimit:1,maxRounds:1,batchPauseSec:0})){field(k).value=v;} field('autoScroll').checked=false;field('autoSend').checked=true;document.querySelector('[data-act="save"]').click();})()`);
  await until(() => evaluate(workerSession, "chrome.storage.local.get('boss_helper_config_v1').then(v=>v.boss_helper_config_v1?.dailyLimit===1)"));
  check(await evaluate(page, "localStorage.getItem('boss_helper_config_v1')===null"), '配置保存在扩展存储，网站 localStorage 不含配置');
  await evaluate(page, "document.querySelector('[data-act=toggle]').click()");
  await until(() => evaluate(page, 'fixtureClicks===1'), 20000);
  await until(() => evaluate(page, "document.querySelector('.bh-log').textContent.includes('官方已确认')"));
  check(await evaluate(page, 'fixtureClicks===1 && fixtureReplacements>1 && fixtureClickedGeneration===fixtureReplacements && fixtureReplaceTimer===null'), '同岗位按钮持续重建后只激活最新按钮一次，并获得官方确认');
  check(await evaluate(page, "(()=>{const tag=document.querySelector('.job-card-box .bh-tag-pass');return !!tag&&tag.textContent.includes('完成')&&getComputedStyle(tag).backgroundColor.includes('52, 199, 89')&&!document.querySelector('.job-card-box .bh-tag-pending');})()"), '拆分成功标题和长预览在背景详情隐藏时仍被识别，卡片显示绿色完成');
  check(await evaluate(page, "fixtureDialogClosed && fixtureStayClicks===1 && fixtureContinueClicks===0 && !document.querySelector('.contact-completed-overlay') && !document.querySelector('#detail-host').hasAttribute('aria-hidden')"), '只点击留在此页并等待成功框异步关闭，不进入继续沟通');
  await until(() => evaluate(workerSession, "chrome.storage.local.get(null).then(v=>Object.values(v).some(x=>x?.kind==='sent'&&x.status==='dispatched'&&x.clickPending===false&&x.clickedAt>0))"));
  const sent = await evaluate(workerSession, "chrome.storage.local.get(null).then(v=>Object.values(v).filter(x=>x?.kind==='sent'&&x.status==='dispatched').length)");
  check(sent === 1, '模拟岗位经筛选后仅点击一次，后台已持久化额度，官方回执识别成功');
  const bossTabId = await evaluate(workerSession, "chrome.tabs.query({}).then(t=>t.find(x=>x.url?.includes('extension-local-test')).id)");
  let status = await evaluate(workerSession, `chrome.tabs.sendMessage(${bossTabId},{type:'BH_UI',action:'stop'})`);
  check(status.ok && !status.running, '工具栏停止消息能控制真实内容脚本');
  await evaluate(workerSession, `chrome.tabs.sendMessage(${bossTabId},{type:'BH_UI',action:'toggle-panel'})`);
  check(await evaluate(page, "document.querySelector('#boss-helper-panel').hidden"), '工具栏面板显隐消息有效');
  await evaluate(workerSession, `chrome.tabs.sendMessage(${bossTabId},{type:'BH_UI',action:'toggle-panel'})`);
  await send('Page.reload', { ignoreCache: true }, page);
  await until(() => evaluate(page, "document.querySelector('[data-cfg=dailyLimit]')?.value==='1'"));
  check(await evaluate(page, 'fixtureClicks===0'), '刷新恢复已保存配置，页面不会自动重新投递');
  await evaluate(page, `(()=>{document.querySelector('[data-act=aiopen]').click();const f=k=>document.querySelector('#bh-ai-modal [data-cfg="'+k+'"]');f('aiBaseUrl').value='https://api.fixture.example/v1';f('aiApiKey').value='fixture-only-key';f('aiModel').value='fixture-model';document.querySelector('#bh-ai-modal [data-act=aisave]').click();})()`);
  await until(() => evaluate(workerSession, "chrome.storage.local.get('boss_helper_config_v1').then(v=>v.boss_helper_config_v1?.aiApiKey==='fixture-only-key')"));
  await until(() => evaluate(page, "document.querySelector('.bh-log').textContent.includes('AI 设置已保存')"));
  await evaluate(page, `(()=>{document.querySelector('#bh-ai-modal [data-act=aiendpointadd]').click();const card=document.querySelector('#bh-ai-endpoint-list [data-endpoint-id]');for(const [key,value] of Object.entries({name:'备用测试',baseUrl:'https://backup.fixture.example/v1',apiKey:'fixture-backup-key',model:'backup-model'})){card.querySelector('[data-endpoint-field="'+key+'"]').value=value;}document.querySelector('#bh-ai-modal [data-act=aisave]').click();})()`);
  await until(() => evaluate(workerSession, "chrome.storage.local.get('boss_helper_config_v1').then(v=>v.boss_helper_config_v1?.aiEndpoints?.[0]?.apiKey==='fixture-backup-key')"));
  await until(() => evaluate(page, "document.querySelector('#bh-ai-endpoint-list [data-endpoint-field=baseUrl]')?.value.endsWith('/chat/completions')"));
  await evaluate(page, "document.querySelector('#bh-ai-modal [data-act=aiclose]').click()");
  check(await evaluate(page, "!document.querySelector('#bh-ai-confirm') && !document.querySelector('#bh-ai-modal')"), '真实扩展存储保存备用 API 后关闭，不误报未保存');
  await evaluate(page, "document.querySelector('[data-act=aiopen]').click()");
  for (let attempt = 0; attempt < 2; attempt++) {
    await evaluate(page, "document.querySelector('#bh-ai-modal [data-act=aimodels]').click()");
    await until(() => evaluate(page, "document.querySelector('#bh-detail-modal [data-role=body]')?.value.includes('尚未授权')"));
    check(await evaluate(page, "!document.querySelector('#bh-ai-confirm') && !document.querySelector('#bh-ai-modal [data-act=aimodels]').disabled"), `保存后第 ${attempt + 1} 次拉取直接进入请求，按真实权限状态反馈并恢复按钮`);
    await evaluate(page, "document.querySelector('#bh-detail-modal [data-act=ok]').click()");
  }
  await evaluate(page, "document.querySelector('#bh-ai-modal [data-act=aitest]').click()");
  await until(() => evaluate(page, "document.querySelector('#bh-detail-modal [data-role=body]')?.value.includes('尚未授权')"));
  check(await evaluate(page, 'fixtureClicks===0 && localStorage.getItem("boss_helper_config_v1")===null'), '未授权 AI 域名在真实后台被拦截，测试连接不启动投递或泄露到网站存储');
  await evaluate(page, "document.querySelector('#bh-detail-modal [data-act=ok]').click(); document.querySelector('#bh-ai-modal [data-act=aiclose]').click()");
  await evaluate(page, "document.querySelector('[data-role=greeting-help]').scrollIntoView({block:'center'})");
  const screenshot = await send('Page.captureScreenshot', { format: 'png' }, page);
  await fs.writeFile(path.join(output, 'edge-extension-panel.png'), Buffer.from(screenshot.data, 'base64'));
  const popupTarget = await send('Target.createTarget', { url: extensionOrigin + '/popup.html', background: true });
  const popup = (await send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, popup);
  await send('Emulation.setDeviceMetricsOverride', { width: 380, height: 650, deviceScaleFactor: 1, mobile: false }, popup);
  await until(() => evaluate(popup, "document.body?.textContent.includes('BOSS')"));
  check(await evaluate(popup, "!document.querySelector('script:not([src])')"), '工具栏页面在扩展 CSP 下加载');
  const popupShot = await send('Page.captureScreenshot', { format: 'png' }, popup);
  await fs.writeFile(path.join(output, 'edge-extension-popup.png'), Buffer.from(popupShot.data, 'base64'));
  check(pageErrors.length === 0, '真实内容脚本无未捕获页面异常');
  await fs.writeFile(path.join(output, 'edge-extension-report.json'), JSON.stringify({ status: 'passed', checks, pageErrors,
    extensionVersion, browser: await send('Browser.getVersion') }, null, 2));
} catch (error) {
  await fs.writeFile(path.join(output, 'edge-extension-failure.log'), String(error.stack) + '\n' + browserLog);
  throw error;
} finally {
  if (ws?.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch {} ws.close(); }
  child.kill();
}
