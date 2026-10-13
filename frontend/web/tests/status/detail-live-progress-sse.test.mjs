// useLiveProgressEffect(详情页 SSE 通道)的行为测试。
//
// 钉住 2026-10-13 线上实测复现的 bug:apiPrefix 已是 /api/v1(data-port.ts
// 默认值),hook 里又拼一层 /api/v1,SSE 请求 /api/v1/api/v1/jobs/... 全程
// 404,实时通道从未工作,详情页一直靠 1s 轮询兜底撑着。
// 顺带钉住 progress/end 的基本行为,防止契约漂移。

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'HTMLElement', 'Node']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static CLOSED = 2;
  static instances = [];
  static reset() { FakeEventSource.instances = []; }
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.closed = false;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  close() { this.closed = true; this.readyState = FakeEventSource.CLOSED; }
  emit(type, payload) {
    for (const fn of this.listeners.get(type) || []) fn({ data: JSON.stringify(payload) });
  }
}
dom.window.EventSource = FakeEventSource;
// hook 里 startSse 用裸全局 `new EventSource(...)`(非 window.EventSource),
// typeof 检查走 window,构造走 globalThis——两边都得挂。
globalThis.EventSource = FakeEventSource;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useLiveProgressEffect } = await import(
  '../../src/features/job-detail/ui/use-live-progress.js'
);

const tick = () => new Promise((resolve) => setImmediate(resolve));

function mount({ jobId = 'job-a', apiPrefix = '/api/v1', isActive = true, onStage, onTerminal, pollOnce } = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls = { stages: [], terminals: 0, polls: 0 };
  const Probe = () => {
    useLiveProgressEffect({
      jobId,
      apiPrefix,
      isActive,
      onStage: onStage || ((detail) => calls.stages.push(detail)),
      onTerminal: onTerminal || (() => { calls.terminals += 1; }),
      pollOnce: pollOnce || (async () => { calls.polls += 1; return 'running'; }),
    });
    return null;
  };
  const render = async () => React.act(async () => {
    root.render(React.createElement(Probe));
    await tick();
  });
  return { host, render, calls, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}

test('SSE URL 精确形状:apiPrefix 已含 /api/v1,不得重复拼接', async () => {
  FakeEventSource.reset();
  const session = mount();
  await session.render();
  const urls = FakeEventSource.instances.map((es) => es.url);
  assert.deepEqual(urls, ['/api/v1/jobs/job-a/progress-events'],
    'apiPrefix(/api/v1) 之上再拼 /api/v1 会得到 /api/v1/api/v1/...,线上 404');
  await session.unmount();
});

test('progress 事件上送 stage_detail,end 事件关流并触发 onTerminal', async () => {
  FakeEventSource.reset();
  const session = mount();
  await session.render();
  const es = FakeEventSource.instances[0];

  es.emit('progress', { lane: 'main', stage_detail: '已翻译 10/20 页', progress: { percent: 50 } });
  assert.deepEqual(session.calls.stages, ['已翻译 10/20 页']);

  es.emit('end', { status: 'succeeded', job_id: 'job-a' });
  await tick();
  assert.equal(es.closed, true, 'end 后主动 close');
  assert.equal(session.calls.terminals, 1, 'end 触发一次终态收尾');
  assert.equal(session.calls.polls, 0, 'SSE 健康时不得降级轮询');
  await session.unmount();
});

test('非活跃任务不建流', async () => {
  FakeEventSource.reset();
  const session = mount({ isActive: false });
  await session.render();
  assert.equal(FakeEventSource.instances.length, 0);
  await session.unmount();
});
