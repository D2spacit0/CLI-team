import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/app.mjs';
import { fixture, success, until, writeDeliverable } from './helpers.mjs';

async function serve(f) {
  const app = createApp(f.service, { controllerToken: 'wait-test-token' });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    wait: async (id, timeout = 2000) => {
      const response = await fetch(`${base}/api/control/wait/${id}?timeout=${timeout}`, {
        headers: { Authorization: 'Bearer wait-test-token' },
      });
      assert.equal(response.status, 200);
      return response.json();
    },
    async close() {
      app.closeStreams();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('run wait remains pending during machine verification and wakes when execution settles', async () => {
  let release;
  const f = fixture({
    agentExecutor: async (_member, _prompt, { workspace }) => { writeDeliverable(workspace); return success(); },
    verifier: async () => new Promise((resolve) => { release = () => resolve({ passed: true, exitCode: 0, testCount: 1 }); }),
  });
  const api = await serve(f);
  try {
    const task = f.service.createTask({ title: '等待验收', objective: '生成产物', assigneeId: f.builder.id,
      verification: { executable: process.execPath, args: ['--test'] }, start: true });
    await until(() => release);
    const run = f.service.store.list('runs').find((item) => item.taskId === task.id);
    assert.equal(f.service.require('runs', run.id).status, 'succeeded');
    const pending = await api.wait(run.id, 100);
    assert.equal(pending.state, 'running');
    assert.equal(pending.terminal, false);
    assert.equal(pending.waiting, true);
    const listeners = f.service.listenerCount('change');
    const finished = api.wait(run.id);
    await until(() => f.service.listenerCount('change') > listeners);
    release();
    const receipt = await finished;
    assert.equal(receipt.state, 'succeeded');
    assert.equal(receipt.terminal, true);
    assert.equal(receipt.waiting, undefined, 'completion must wake by event, not HTTP timeout');
  } finally { release?.(); await api.close(); await f.close(); }
});

test('cancelled run and task wait for the late process exit before reporting terminal', async () => {
  let release;
  const f = fixture({ agentExecutor: async () => new Promise((resolve) => { release = () => resolve(success('晚到结果')); }) });
  const api = await serve(f);
  try {
    const task = f.service.createTask({ title: '等待取消退出', objective: '等待', assigneeId: f.builder.id, start: true });
    await until(() => release);
    const run = f.service.store.list('runs').find((item) => item.taskId === task.id);
    f.service.cancelTask(task.id);
    const [pendingRun, pendingTask] = await Promise.all([api.wait(run.id, 100), api.wait(task.id, 100)]);
    for (const pending of [pendingRun, pendingTask]) {
      assert.equal(pending.state, 'cancelled');
      assert.equal(pending.terminal, false);
      assert.equal(pending.waiting, true);
    }
    const listeners = f.service.listenerCount('change');
    const finished = Promise.all([api.wait(run.id), api.wait(task.id)]);
    await until(() => f.service.listenerCount('change') >= listeners + 2);
    release();
    for (const receipt of await finished) {
      assert.equal(receipt.state, 'cancelled');
      assert.equal(receipt.terminal, true);
      assert.equal(receipt.waiting, undefined);
    }
  } finally { release?.(); await api.close(); await f.close(); }
});

test('ordinary chat run wait wakes promptly on settled event', async () => {
  let release;
  const f = fixture({ agentExecutor: async () => new Promise((resolve) => { release = () => resolve(success('答复完成')); }) });
  const api = await serve(f);
  try {
    f.service.send('team', { body: '请分析', recipientIds: [f.builder.id] });
    await until(() => release);
    const run = f.service.store.list('runs')[0];
    const listeners = f.service.listenerCount('change');
    const finished = api.wait(run.id);
    await until(() => f.service.listenerCount('change') > listeners);
    release();
    const receipt = await finished;
    assert.equal(receipt.state, 'succeeded');
    assert.equal(receipt.terminal, true);
    assert.equal(receipt.waiting, undefined);
  } finally { release?.(); await api.close(); await f.close(); }
});

test('completed task wait is not held by a later read-only task consultation', async () => {
  let release;
  const f = fixture({ agentExecutor: async (member, _prompt, { workspace }) => {
    if (member.permission === 'plan') return new Promise((resolve) => { release = () => resolve(success('只读答复')); });
    writeDeliverable(workspace);
    return success();
  } });
  const api = await serve(f);
  try {
    const task = f.service.createTask({ title: '完成后咨询', objective: '生成产物', assigneeId: f.builder.id, start: true });
    await until(() => f.service.require('tasks', task.id).status === 'review' && f.service.active.size === 0);
    f.service.acceptTask(task.id, { note: '人工检查完成', acknowledgeMissingGate: true });
    f.service.send(task.roomId, { body: '解释结果', recipientIds: [f.builder.id] });
    await until(() => release);
    const receipt = await api.wait(task.id, 100);
    assert.equal(receipt.state, 'done');
    assert.equal(receipt.terminal, true);
    assert.equal(receipt.waiting, undefined);
    assert.equal(f.service.active.size, 1);
  } finally { release?.(); await api.close(); await f.close(); }
});
