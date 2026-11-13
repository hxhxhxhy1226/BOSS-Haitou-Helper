// Runs only in edge-smoke's intercepted page and disposable browser profile.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

function installFixture() {
  const list = document.querySelector('.job-list-wrapper');
  const host = document.querySelector('#detail-host');
  list.innerHTML = Array.from({ length: 160 }, (_, i) => `<li class="job-card-box" data-memory-id="${i}" data-jobid="memory-${i}">
    <a class="job-name" href="/job_detail/memory-${i}.html">内存测试岗位${i}</a><span class="job-salary">20-30K</span>
    <a class="company-name" href="/gongsi/memory.html">本地内存测试公司</a></li>`).join('');
  window.fixtureRetiredDetails = [];
  window.fixtureMemoryClicks = 0;
  const button = document.createElement('button');
  button.id = 'fixture-memory-click'; button.textContent = '本地点击响应检查';
  button.style.cssText = 'position:fixed;left:10px;top:10px;z-index:2147483647;width:180px;height:40px;';
  button.addEventListener('click', () => { window.fixtureMemoryClicks++; });
  document.body.append(button);
  window.fixtureRenderMemoryJob = (round) => {
    if (host.firstElementChild) window.fixtureRetiredDetails.push(new WeakRef(host.firstElementChild));
    list.querySelectorAll('.active').forEach(node => node.classList.remove('active'));
    const id = round % 160;
    list.querySelector(`[data-memory-id="${id}"]`).classList.add('active');
    host.innerHTML = `<section class="job-detail" data-jobid="memory-${id}"><header class="job-banner">
      <h1 class="job-name">内存测试岗位${id}</h1><a class="company-name" href="/gongsi/memory.html">本地内存测试公司</a>
      <span class="salary">20-30K</span><a href="/job_detail/memory-${id}.html">查看职位</a></header>
      <section class="job-detail-section"><h2>职位描述</h2><div class="job-sec-text">第${round}轮：${'负责STM32固件研发与FreeRTOS驱动调试，完成设备通信协议和量产测试。'.repeat(80)}</div></section></section>`;
  };
  window.fixtureRenderMemoryJob(0);
}

export async function inspectBrowserMemory({ send, evaluate, page, contexts, check }) {
  let contextId;
  for (const id of contexts.keys()) {
    if (await evaluate(page, 'typeof BH !== "undefined" && typeof BH.extractJobSnapshot === "function"', { contextId: id })) {
      contextId = id; break;
    }
  }
  assert.ok(contextId, 'Find the real extension isolated world in the local fixture');
  await send('Performance.enable', {}, page);
  await evaluate(page, '(' + installFixture.toString() + ')()');
  const capture = async () => {
    const result = await evaluate(page, '(()=>{const s=BH.extractJobSnapshot();return {ok:s.ok,id:s.jobId};})()', { contextId });
    assert.equal(result.ok, true);
    return result;
  };
  await capture();
  const measure = async () => {
    // Let mutation delivery and the coalesced navigation observer release old nodes.
    await delay(800);
    await send('HeapProfiler.collectGarbage', {}, page);
    await delay(50);
    await send('HeapProfiler.collectGarbage', {}, page);
    const metrics = Object.fromEntries((await send('Performance.getMetrics', {}, page)).metrics.map(item => [item.name, item.value]));
    return { heapBytes: metrics.JSHeapUsedSize, ...(await send('Memory.getDOMCounters', {}, page)) };
  };
  const before = await measure();
  for (let round = 1; round <= 200; round++) {
    await evaluate(page, `fixtureRenderMemoryJob(${round})`);
    assert.equal((await capture()).id, 'memory-' + round % 160);
    if (round % 40 === 0) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 80, y: 25, button: 'left', clickCount: 1 }, page);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 80, y: 25, button: 'left', clickCount: 1 }, page);
    }
  }
  const after = await measure();
  const retained = await evaluate(page, 'fixtureRetiredDetails.filter(ref=>ref.deref()).length');
  const clicks = await evaluate(page, 'fixtureMemoryClicks');
  check(retained <= 3 && after.nodes - before.nodes < 600 && after.heapBytes - before.heapBytes < 24 * 1024 * 1024,
    '真实Edge的160张卡片与200次详情重建后旧DOM可回收，堆增长保持有界');
  check(clicks === 5, '大量详情重建期间五次实际鼠标点击均得到响应');
  return { cards: 160, replacements: 200, before, after, retainedOldDetails: retained, clicks,
    note: 'Disposable synthetic page after forced GC; not a heap capture of the user tab or its reported 7.95 GB.' };
}
