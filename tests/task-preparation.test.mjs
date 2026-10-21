import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { TeamService } from '../server/service.mjs';
import { createApp } from '../server/app.mjs';
import { fixture, temporary, cleanup } from './helpers.mjs';

const taskInput = (assigneeId, extra = {}) => ({ title: '准备一项任务', objective: '导入材料后再启动', assigneeId,
  creationRequestId: randomUUID(), start: false, ...extra });

test('an idempotent preparation retry returns the original task after normalization and creates no new events or runs', async () => {
  const f = fixture();
  try {
    const input = taskInput(f.builder.id, { title: '  同一任务  ', objective: '  需求正文\n  ', requirements: ['  第一项  '] });
    const events = [];
    f.service.on('change', (event) => events.push(event));
    const first = f.service.createTask(input);
    f.service.saveMember({ enabled: false }, f.builder.id);
    const repeated = f.service.createTask({ ...input, title: '同一任务', objective: '需求正文', requirements: ['第一项'],
      reviewerId: null, executionMode: 'direct', participantIds: [], verification: null, category: 'work',
      creationRequestId: input.creationRequestId.toUpperCase() });
    assert.deepEqual(repeated, first, 'A retry is a receipt lookup, even when a member became unavailable afterward');
    assert.equal(f.service.store.list('tasks').length, 1);
    assert.equal(f.service.store.list('runs').length, 0);
    assert.equal(events.filter((event) => event.type === 'task.created').length, 1);
    const receipt = f.service.store.list('taskCreationRequests')[0];
    assert.deepEqual(Object.keys(receipt).sort(), ['createdAt', 'id', 'inputHash', 'taskId']);
    assert.match(receipt.inputHash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(receipt).includes('需求正文'), false);
  } finally { await f.close(); }
});

test('reusing a creation request for changed parameters is a conflict and can never implicitly start a task', async () => {
  const f = fixture();
  try {
    const input = taskInput(f.builder.id);
    const first = f.service.createTask(input);
    for (const patch of [{ title: '不同标题' }, { objective: '不同目标' }, { requirements: ['新增要求'] }, { reviewerId: f.reviewer.id }]) {
      assert.throws(() => f.service.createTask({ ...input, ...patch }), (error) => error.status === 409 && /不同的任务参数/.test(error.message));
    }
    assert.throws(() => f.service.createTask({ ...input, start: true }), (error) => error.status === 400 && /保持未启动/.test(error.message));
    assert.throws(() => f.service.createTask({ ...input, creationRequestId: 'not-a-uuid' }));
    assert.deepEqual(f.service.require('tasks', first.id), first);
    assert.equal(f.service.store.list('tasks').length, 1);
    assert.equal(f.service.store.list('runs').length, 0);
    f.service.store.remove('tasks', first.id);
    assert.throws(() => f.service.createTask(input), (error) => error.status === 409 && /不能自动重新创建/.test(error.message));
    assert.equal(f.service.store.list('tasks').length, 0);
  } finally { await f.close(); }
});

test('creation receipts persist across service restart and participant selection order does not duplicate a task', async () => {
  const root = temporary();
  const options = { root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }) };
  let service = new TeamService(options);
  try {
    const members = ['owner', 'worker-one', 'worker-two'].map((handle) => service.saveMember({ name: handle, handle,
      provider: 'custom', role: 'builder', executable: process.execPath, enabled: true, permission: 'edit' }));
    const input = taskInput(members[0].id, { executionMode: 'delegated', participantIds: [members[1].id, members[2].id] });
    const first = service.createTask(input);
    await service.close();
    service = new TeamService(options);
    const repeated = service.createTask({ ...input, participantIds: [...input.participantIds].reverse() });
    assert.equal(repeated.id, first.id);
    assert.equal(repeated.workspace, first.workspace);
    assert.equal(service.store.list('tasks').length, 1);
    assert.equal(service.store.list('runs').length, 0);
  } finally { await service.close(); cleanup(root); }
});

test('task, room, receipt and creation event are committed together or all rolled back', async () => {
  const f = fixture();
  const originalPut = f.service.store.put.bind(f.service.store);
  try {
    const input = taskInput(f.builder.id);
    const roomCount = f.service.store.list('rooms').length;
    const eventCount = () => f.service.store.db.prepare('SELECT COUNT(*) AS count FROM events').get().count;
    const beforeEvents = eventCount();
    const notifications = [];
    f.service.on('change', (event) => notifications.push(event));
    f.service.store.put = (kind, entity) => {
      if (kind === 'taskCreationRequests') throw new Error('SIMULATED_RECEIPT_WRITE_FAILURE');
      return originalPut(kind, entity);
    };
    assert.throws(() => f.service.createTask(input), /SIMULATED_RECEIPT_WRITE_FAILURE/);
    assert.equal(f.service.store.list('tasks').length, 0);
    assert.equal(f.service.store.list('taskCreationRequests').length, 0);
    assert.equal(f.service.store.list('rooms').length, roomCount);
    assert.equal(eventCount(), beforeEvents);
    assert.deepEqual(notifications, []);
    f.service.store.put = originalPut;
    assert.equal(f.service.createTask(input).status, 'backlog');
    assert.equal(f.service.store.list('tasks').length, 1);
    assert.equal(f.service.store.list('taskCreationRequests').length, 1);
  } finally { f.service.store.put = originalPut; await f.close(); }
});

test('prepared start requires an untouched backlog and cannot repeat after blocked or review transitions', async () => {
  const f = fixture();
  try {
    f.service.updateSettings({ paused: true });
    const task = f.service.createTask(taskInput(f.builder.id));
    const started = f.service.startPreparedTask(task.id);
    assert.equal(started.status, 'running');
    assert.ok(started.startedAt);
    assert.equal(f.service.store.list('runs').filter((run) => run.taskId === task.id).length, 1);
    const run = f.service.store.list('runs').find((item) => item.taskId === task.id);
    f.service.store.update('runs', run.id, { status: 'failed' });
    for (const status of ['blocked', 'review', 'backlog']) {
      f.service.store.update('tasks', task.id, { status });
      assert.throws(() => f.service.startPreparedTask(task.id), (error) => error.status === 409 && /不会重复启动/.test(error.message));
      assert.equal(f.service.store.list('runs').filter((item) => item.taskId === task.id).length, 1);
    }
    f.service.store.update('tasks', task.id, { status: 'backlog', startedAt: null });
    assert.throws(() => f.service.startPreparedTask(task.id), /不会重复启动/, 'Historical runs prevent restart even if an old record lacks startedAt');
    f.service.store.update('tasks', task.id, { status: 'blocked' });
    assert.equal(f.service.startTask(task.id).status, 'running', 'Normal task continuation keeps its existing semantics');
    assert.equal(f.service.store.list('runs').filter((item) => item.taskId === task.id).length, 2);
  } finally { await f.close(); }
});

test('prepared start also rejects previous work associated by task context or dedicated room', async () => {
  const f = fixture();
  try {
    f.service.updateSettings({ paused: true });
    for (const association of ['context', 'room']) {
      const task = f.service.createTask(taskInput(f.builder.id));
      f.service.store.put('runs', { id: `run-history-${association}`, taskId: null,
        contextTaskId: association === 'context' ? task.id : null, roomId: task.roomId, status: 'succeeded', memberId: f.builder.id });
      assert.throws(() => f.service.startPreparedTask(task.id), (error) => error.status === 409);
      assert.equal(f.service.require('tasks', task.id).status, 'backlog');
    }
  } finally { await f.close(); }
});

test('HTTP preparation creation retries and explicit unstarted start guard reject stale or unknown requests', async () => {
  const f = fixture();
  f.service.updateSettings({ paused: true });
  const app = createApp(f.service);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const input = taskInput(f.builder.id);
    const firstResponse = await post('/api/tasks', input);
    assert.equal(firstResponse.status, 201);
    await firstResponse.body.cancel(); // The UI did not retain this response.
    const recoveredResponse = await post('/api/tasks', input);
    const task = await recoveredResponse.json();
    assert.equal(recoveredResponse.status, 201);
    assert.equal(f.service.store.list('tasks').length, 1);
    assert.equal((await post('/api/tasks', { ...input, title: '不能覆盖原任务' })).status, 409);
    for (const body of [{ expectedState: 'blocked' }, { expectedState: 'unstarted', unknown: true }, { feedback: '不应在启动接口接受' }]) {
      assert.equal((await post(`/api/tasks/${task.id}/start`, body)).status, 400);
    }
    assert.equal((await post(`/api/tasks/${task.id}/start`, { expectedState: 'unstarted' })).status, 200);
    assert.equal((await post(`/api/tasks/${task.id}/start`, { expectedState: 'unstarted' })).status, 409);
    assert.equal(f.service.store.list('runs').filter((run) => run.taskId === task.id).length, 1);
    const ordinary = f.service.createTask({ title: '普通任务', objective: '沿用原启动流程', assigneeId: f.builder.id });
    assert.equal((await post(`/api/tasks/${ordinary.id}/start`, {})).status, 200);
  } finally { app.closeStreams(); await new Promise((resolve) => server.close(resolve)); await f.close(); }
});
