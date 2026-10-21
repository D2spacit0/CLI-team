import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, success, until, writeDeliverable } from './helpers.mjs';

const create = (f, extra = {}) => f.service.createTask({ title: '协作任务', objective: '完成指定文件',
  assigneeId: f.builder.id, roomId: 'team', ...extra });

test('task consultation and peer handoff retain workspace, isolate context, and never advance acceptance', async () => {
  const calls = [];
  const f = fixture({ agentExecutor: async (member, prompt, options) => {
    calls.push({ member, prompt, ...options });
    return success('咨询完成', member.handle === 'builder'
      ? { handoff: { to: 'reviewer', message: '请复核这个任务的文件' } } : {});
  } });
  try {
    const first = create(f);
    const second = create(f, { title: '另一任务' });
    f.service.message('team', 'user', '你', 'ONLY_FIRST_TASK_CONTEXT', { taskId: first.id });
    f.service.message('team', 'user', '你', 'NEVER_SHARE_SECOND_CONTEXT', { taskId: second.id });
    f.service.store.put('conversations', { id: `${first.id}:${f.builder.id}`, conversationId: 'implementation-session' });
    const message = f.service.send('team', { body: '检查当前文件', taskId: first.id, recipientIds: [f.builder.id] });
    await until(() => calls.length === 2 && f.service.active.size === 0);
    assert.equal(message.taskId, first.id);
    for (const call of calls) {
      assert.equal(call.workspace, first.workspace);
      assert.equal(call.member.permission, 'plan');
      assert.match(call.prompt, /ONLY_FIRST_TASK_CONTEXT/);
      assert.doesNotMatch(call.prompt, /NEVER_SHARE_SECOND_CONTEXT/);
      assert.equal(call.conversationId, null);
    }
    assert.equal(f.service.require('tasks', first.id).status, 'backlog');
    assert.ok(f.service.store.list('runs').every((run) => run.contextTaskId === first.id && !run.taskId));
    assert.ok(f.service.messages('team').filter((item) => item.kind === 'agent').every((item) => item.taskId === first.id));
  } finally { await f.close(); }
});

test('foreign or archived task contexts are rejected before creating messages or runs', async () => {
  const f = fixture();
  try {
    const task = create(f);
    const room = f.service.createRoom({ name: '另一个频道' });
    const input = { body: '检查', taskId: task.id, recipientIds: [f.builder.id] };
    assert.throws(() => f.service.send(room.id, input), /不属于/);
    f.service.setTaskArchived(task.id, true);
    assert.throws(() => f.service.send('team', input), /已归档/);
    assert.equal(f.service.store.list('runs').length, 0);
  } finally { await f.close(); }
});

test('reassigned implementer receives decision and peer findings without other task history', async () => {
  let received;
  const f = fixture({ agentExecutor: async (_member, prompt, { workspace }) => {
    received = prompt;
    writeDeliverable(workspace);
    return success();
  } });
  try {
    const task = create(f);
    const other = create(f);
    f.service.message('team', 'user', '你', 'UNRELATED_DECISION', { taskId: other.id });
    f.service.store.put('runs', { id: 'prior-review', taskId: task.id, roomId: 'team', memberId: f.reviewer.id,
      stage: 'review', status: 'failed', summary: '之前未完成', report: { findings: [{ severity: 'major', text: 'MISSING_BOUNDARY_CHECK' }] } });
    f.service.store.update('tasks', task.id, { status: 'blocked' });
    f.service.reassignTask(task.id, { assigneeId: f.builder.id, reviewerId: null, note: 'KEEP_EXISTING_DRAFT' });
    f.service.startTask(task.id);
    await until(() => f.service.require('tasks', task.id).status === 'review');
    assert.match(received, /KEEP_EXISTING_DRAFT/);
    assert.match(received, /MISSING_BOUNDARY_CHECK/);
    assert.doesNotMatch(received, /UNRELATED_DECISION/);
  } finally { await f.close(); }
});

test('cancelling during verification aborts the gate and cannot enqueue a reviewer', async () => {
  let release, gateSignal;
  const f = fixture({ agentExecutor: async (_member, _prompt, { workspace }) => {
    writeDeliverable(workspace); return success();
  }, verifier: async (_config, { signal }) => {
    gateSignal = signal;
    return new Promise((resolve) => { release = () => resolve({ passed: true, exitCode: 0, testCount: 1, skipped: 0 }); });
  } });
  try {
    const task = create(f, { start: true, reviewerId: f.reviewer.id, verification: { executable: process.execPath, args: ['--test'] } });
    await until(() => release);
    const run = f.service.store.list('runs')[0];
    const visibleRun = f.service.bootstrap().runs.find((item) => item.id === run.id);
    assert.equal(visibleRun.status, 'running');
    assert.equal(visibleRun.stage, 'verification');
    f.service.cancelRun(run.id);
    assert.equal(gateSignal.aborted, true);
    assert.equal(f.service.require('tasks', task.id).status, 'blocked');
    assert.throws(() => f.service.startTask(task.id), /验收仍在停止/);
    release();
    await until(() => f.service.active.size === 0);
    assert.equal(f.service.store.list('runs').length, 1);
    assert.equal(f.service.require('runs', run.id).status, 'cancelled');
    assert.notEqual(f.service.require('tasks', task.id).gate.status, 'passed');
  } finally { release?.(); await f.close(); }
});
