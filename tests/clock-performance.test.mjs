import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SCRIPT } from './script-target.mjs';

const source = fs.readFileSync(SCRIPT, 'utf8');

async function fixture(t, { native = true } = {}) {
  const data = new Map(), channels = [], metrics = { channels: 0, messages: 0, closedPorts: 0, workers: 0 };
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://www.zhipin.com/web/geek/job', runScripts: 'outside-only',
    pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  const bridge = {
    ready: Promise.resolve(), healthy: true,
    getValue: (key, fallback) => data.has(key) ? structuredClone(data.get(key)) : fallback,
    setValue: (key, value) => data.set(key, structuredClone(value)),
    deleteValue: (key) => data.delete(key), listValues: () => [...data.keys()],
    addStyle() {}, onChanged() {}, onError() {}, flush: async () => {},
    request: () => assert.fail('Clock tests must not perform requests'),
    fetch: () => assert.fail('Clock tests must not perform requests'),
  };
  if (native) win.BHNative = bridge;
  else Object.assign(win, { GM_getValue: bridge.getValue, GM_setValue: bridge.setValue,
    GM_deleteValue: bridge.deleteValue, GM_listValues: bridge.listValues,
    GM_addStyle: bridge.addStyle, GM_xmlhttpRequest: bridge.request });
  win.fetch = bridge.fetch;
  win.unsafeWindow = win;
  win.URL.createObjectURL = () => 'blob:clock-fixture';
  win.URL.revokeObjectURL = () => {};
  win.Worker = class {
    constructor() { metrics.workers++; throw new Error('Fixture CSP does not allow blob workers'); }
  };
  // Real asynchronous ports expose the message storm without replacing it with
  // a synchronous loop or giving the extension a fake clock.
  win.MessageChannel = class {
    constructor() {
      const channel = new NodeMessageChannel();
      channels.push(channel); metrics.channels++;
      this.port1 = channel.port1; this.port2 = channel.port2;
      const post = channel.port2.postMessage.bind(channel.port2);
      channel.port2.postMessage = (...args) => { metrics.messages++; return post(...args); };
      for (const port of [channel.port1, channel.port2]) {
        const close = port.close.bind(port);
        let closed = false;
        port.close = () => { if (!closed) { closed = true; metrics.closedPorts++; } close(); };
      }
    }
  };
  t.after(() => {
    if (win.BH) win.BH.state.stopFlag = true;
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    win.close();
  });
  win.eval(source);
  for (let i = 0; !win.BH && i < 100; i++) await delay(10);
  assert.ok(win.BH, 'The real helper must initialize through its native bridge');
  await delay(0);
  // The helper may keep one low-frequency maintenance sleep alive. Our waits
  // must return to that baseline, rather than cancelling unrelated maintenance.
  return { win, BH: win.BH, metrics, baselinePending: win.BH.clockDiag().pending };
}

test('原生扩展等待只使用定时器，不产生Worker或MessageChannel消息风暴', async (t) => {
  const f = await fixture(t);
  const elapsed = await f.BH.bgSleep(200);
  t.diagnostic(JSON.stringify({ elapsedMs: elapsed, ...f.metrics }));
  assert.ok(elapsed >= 198, 'Waiting must not complete before the requested delay');
  assert.equal(f.metrics.workers, 0);
  assert.equal(f.metrics.channels, 0, 'MV3 content scripts must not start the userscript spin fallback');
  assert.equal(f.metrics.messages, 0);
  assert.equal(f.BH.clockDiag().pending, f.baselinePending);
});

test('原生并发等待可让停止事件执行，完成后释放全部pending计时', async (t) => {
  const f = await fixture(t);
  await Promise.all([f.BH.CLOCK.sleep(0), f.BH.CLOCK.sleep(-1)]);
  assert.equal(f.BH.clockDiag().pending, f.baselinePending);
  let completed = 0, stoppedBeforeCompletion = false;
  const waiting = [220, 260, 300].map((ms) => f.BH.CLOCK.sleep(ms).then(() => { completed++; }));
  assert.equal(f.BH.clockDiag().pending, f.baselinePending + 3);
  f.win.setTimeout(() => {
    f.BH.stop('clock responsiveness fixture');
    stoppedBeforeCompletion = completed === 0;
  }, 10);
  await Promise.all(waiting);
  assert.equal(f.BH.state.stopFlag, true);
  assert.equal(stoppedBeforeCompletion, true, 'A stop event must run while waits remain pending');
  assert.equal(completed, 3);
  assert.equal(f.BH.clockDiag().pending, f.baselinePending);
  assert.equal(f.metrics.channels, 0);
  assert.equal(f.metrics.messages, 0);
});

test('非原生兼容环境仍可使用原有Worker失败兜底并关闭消息端口', async (t) => {
  const f = await fixture(t, { native: false });
  const elapsed = await f.BH.bgSleep(120);
  await delay(20);
  assert.ok(elapsed >= 118);
  assert.ok(f.metrics.workers > 0, 'Legacy harness still attempts its Worker path');
  assert.ok(f.metrics.channels > 0);
  assert.ok(f.metrics.messages > 0);
  assert.equal(f.metrics.closedPorts, f.metrics.channels * 2, 'The legacy fallback must close both ports');
  assert.equal(f.BH.clockDiag().pending, f.baselinePending);
});
