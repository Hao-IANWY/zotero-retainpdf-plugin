// useTaskLiveProgress 的行为测试。
//
// 这里钉住的都是真实复现过的 bug:
//   1. diagnostic lane 的 percent 盖掉主进度(60% 倒退回 2%);
//   2. 任务集合一变就关闭并重建全部连接;
//   3. onerror 手动 close 后,任务集合不变就再也不重连。
// 用假 EventSource 驱动,断言连接生命周期而不是源码文本。

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'HTMLElement', 'Node']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances = [];
  static reset() { FakeEventSource.instances = []; }
  static byJob(jobId) {
    return FakeEventSource.instances.filter((es) => es.url.includes(`/${jobId}/progress-events`));
  }
  constructor(url) {
    this.url = url;
    this.readyState = FakeEventSource.OPEN;
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
  fail(readyState) {
    this.readyState = readyState;
    this.onerror?.();
  }
}
dom.window.EventSource = FakeEventSource;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useTaskLiveProgress } = await import(
  '../../src/features/task-center/ui/use-task-live-progress.js'
);

const tick = () => new Promise((resolve) => setImmediate(resolve));

function mount(ids, onEnded = () => {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const Probe = ({ ids: currentIds }) => {
    const live = useTaskLiveProgress(currentIds, '/api/v1', onEnded);
    return React.createElement('div', { 'data-live': JSON.stringify(live) });
  };
  const render = (currentIds) => React.act(async () => {
    root.render(React.createElement(Probe, { ids: currentIds }));
    await tick();
  });
  return { host, render, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}

const liveState = (host) => JSON.parse(host.querySelector('[data-live]').dataset.live);

test('主进度只消费 main lane,diagnostic 不回退 percent', async () => {
  FakeEventSource.reset();
  const session = mount(['job-a']);
  await session.render(['job-a']);
  const es = FakeEventSource.byJob('job-a')[0];

  es.emit('progress', { lane: 'main', progress: { percent: 60 }, stage_detail: '翻译中' });
  es.emit('progress', { lane: 'diagnostic', progress: { percent: 2 }, stage_detail: '第 3 页排版修复' });
  await session.render(['job-a']);

  const live = liveState(session.host);
  assert.equal(live['job-a'].percent, 60, 'diagnostic 的 2% 不得覆盖主进度 60%');
  assert.equal(live['job-a'].stageDetail, '第 3 页排版修复', 'diagnostic 的阶段文案保留');
  await session.unmount();
});

test('任务集合变化只增删变化的连接,不整体重建', async () => {
  FakeEventSource.reset();
  const session = mount(['job-a']);
  await session.render(['job-a']);
  const first = FakeEventSource.byJob('job-a')[0];

  await session.render(['job-a', 'job-b']);
  assert.equal(first.closed, false, '已有任务的连接不得被重建');
  assert.equal(FakeEventSource.byJob('job-b').length, 1, '新任务开新连接');

  await session.render(['job-b']);
  assert.equal(first.closed, true, '离开活跃集合的任务连接被关闭');
  assert.equal(FakeEventSource.byJob('job-b')[0].closed, false, '保留中的连接不受影响');
  assert.deepEqual(Object.keys(liveState(session.host)), [], '已移除任务的进度缓存被清理');
  await session.unmount();
});

test('瞬时断网不关流,交给 EventSource 自动重连;永久失败才摘除', async () => {
  FakeEventSource.reset();
  const session = mount(['job-a']);
  await session.render(['job-a']);
  const first = FakeEventSource.byJob('job-a')[0];

  first.fail(FakeEventSource.CONNECTING);
  await session.render(['job-a', 'job-b']);
  assert.equal(FakeEventSource.byJob('job-a').length, 1, '瞬时错误后不重开连接(浏览器自行重连)');
  assert.equal(first.closed, false, '瞬时错误不得手动 close');

  first.fail(FakeEventSource.CLOSED);
  await session.render(['job-b']);
  await session.render(['job-a', 'job-b']);
  assert.equal(FakeEventSource.byJob('job-a').length, 2, '永久失败(CLOSED)后任务仍在活跃集合时会重开');
  await session.unmount();
});

test('end 事件关流、清缓存并回调 onEnded', async () => {
  FakeEventSource.reset();
  const ended = [];
  const session = mount(['job-a'], (jobId) => ended.push(jobId));
  await session.render(['job-a']);
  const es = FakeEventSource.byJob('job-a')[0];

  es.emit('progress', { lane: 'main', progress: { percent: 90 }, stage_detail: '合成中' });
  es.emit('end', { status: 'succeeded', job_id: 'job-a' });

  assert.equal(es.closed, true, 'end 后主动 close,防重连风暴');
  assert.deepEqual(ended, ['job-a']);
  assert.deepEqual(liveState(session.host), {}, '终态缓存清理');
  await session.unmount();
});

test('卸载时关闭全部连接', async () => {
  FakeEventSource.reset();
  const session = mount(['job-a', 'job-b']);
  await session.render(['job-a', 'job-b']);
  await session.unmount();
  for (const es of FakeEventSource.instances) {
    assert.equal(es.closed, true, `${es.url} 应在卸载时关闭`);
  }
});
