import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, success, until, writeDeliverable } from './helpers.mjs';

const create = (f, extra = {}) => f.service.createTask({ title: '任务进度', objective: '执行并验证模块',
  assigneeId: f.builder.id, start: true, ...extra });
const worker = (f) => f.service.saveMember({ name: '协作者', handle: 'progress-worker', provider: 'custom',
  executable: process.execPath, permission: 'edit', enabled: true });

test('a queued task can be paused without executing and a deliberate restart clears its paused marker', async () => {
  let calls = 0;
  const f = fixture({ agentExecutor: async () => { calls++; return success(); } });
  try {
    const collaborator = worker(f);
    f.service.updateSettings({ paused: true });
    const task = create(f, { executionMode: 'delegated', participantIds: [collaborator.id] });
    const queued = f.service.taskProgress(task.id);
    assert.equal(queued.canPause, true);
    assert.equal(queued.canReassign, false);
    assert.equal(queued.currentRuns[0].status, 'queued');
    assert.match(queued.currentRuns[0].waitReason, /全局调度已暂停/);
    f.service.pauseTask(task.id, { note: '先检查分工' });
    const paused = f.service.require('tasks', task.id);
    assert.equal(paused.status, 'blocked');
    assert.ok(paused.pausedAt);
    assert.equal(f.service.taskProgress(task.id).active, false);
    assert.equal(f.service.taskProgress(task.id).canReassign, true);
    assert.equal(f.service.taskProgress(task.id).canPause, false);
    assert.equal(f.service.store.list('runs')[0].status, 'cancelled');
    f.service.startTask(task.id);
    const restarted = f.service.require('tasks', task.id);
    assert.equal(restarted.pausedAt, null);
    assert.equal(restarted.repairCount, 0);
    assert.equal(f.service.taskProgress(task.id).currentRuns[0].stage, 'plan');
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('pausing an active delegated worker exposes stopping progress and prevents recovery before its process settles', async () => {
  let collaborator, release, runningSignal;
  const f = fixture({ agentExecutor: async (_member, prompt, { signal }) => {
    if ((prompt.split(/Current assignment:\r?\n/)[1] || '').startsWith('Delegation planning')) {
      return success('计划完成', { delegation: { steps: [{ key: 'build', title: '构建', objective: '完成模块', memberId: collaborator.id, dependsOn: [] }] } });
    }
    runningSignal = signal;
    return new Promise((resolve) => { release = () => resolve(success('成员晚到的完成报告')); });
  } });
  try {
    collaborator = worker(f);
    const task = create(f, { executionMode: 'delegated', participantIds: [collaborator.id] });
    await until(() => runningSignal);
    assert.equal(f.service.taskProgress(task.id).currentRuns[0].stage, 'delegate');
    f.service.pauseTask(task.id);
    const stopping = f.service.taskProgress(task.id);
    assert.equal(runningSignal.aborted, true);
    assert.equal(stopping.active, true);
    assert.equal(stopping.canReassign, false);
    assert.equal(stopping.currentRuns[0].status, 'cancelled');
    assert.match(stopping.currentRuns[0].waitReason, /正在停止/);
    assert.throws(() => f.service.startTask(task.id), { status: 409 });
    assert.throws(() => f.service.reassignTask(task.id, { assigneeId: f.builder.id, reviewerId: f.reviewer.id, note: '等待停止' }), { status: 409 });
    release();
    await until(() => f.service.active.size === 0);
    const settled = f.service.taskProgress(task.id);
    assert.equal(settled.active, false);
    assert.equal(settled.canReassign, true);
    assert.deepEqual(settled.currentRuns, []);
    assert.equal(f.service.require('tasks', task.id).status, 'blocked');
    assert.equal(f.service.store.list('runs').length, 2);
    assert.equal(settled.coordination.steps[0].status, 'failed');
  } finally { release?.(); await f.close(); }
});

test('pausing verification aborts the gate and cannot create review or passing evidence from a late result', async () => {
  let release, gateSignal;
  const f = fixture({ agentExecutor: async (_member, _prompt, { workspace }) => {
    writeDeliverable(workspace); return success('执行完成');
  }, verifier: async (_config, { signal }) => {
    gateSignal = signal;
    return new Promise((resolve) => { release = () => resolve({ passed: true, exitCode: 0, testCount: 1, skipped: 0 }); });
  } });
  try {
    const task = create(f, { reviewerId: f.reviewer.id, verification: { executable: process.execPath, args: ['--test'] } });
    await until(() => gateSignal);
    const verifying = f.service.taskProgress(task.id);
    assert.equal(verifying.currentRuns[0].stage, 'verification');
    assert.equal(verifying.currentRuns[0].status, 'running');
    f.service.pauseTask(task.id);
    assert.equal(gateSignal.aborted, true);
    assert.equal(f.service.taskProgress(task.id).canReassign, false);
    assert.throws(() => f.service.startTask(task.id), { status: 409 });
    release();
    await until(() => f.service.active.size === 0);
    assert.equal(f.service.taskProgress(task.id).active, false);
    assert.equal(f.service.require('tasks', task.id).gate.status, 'pending');
    assert.equal(f.service.require('tasks', task.id).reviewVerdict, null);
    assert.equal(f.service.store.list('runs').length, 1);
    assert.equal(f.service.store.list('evidence').length, 0);
  } finally { release?.(); await f.close(); }
});

test('queue diagnostics distinguish global pause, occupied members, shared workspace locks and exhausted slots', async () => {
  let release;
  const f = fixture({ agentExecutor: async () => new Promise((resolve) => { release = () => resolve(success()); }) });
  try {
    const activeTask = create(f);
    await until(() => release);
    const memberBlockedTask = create(f, { title: '等待同一成员' });
    assert.match(f.service.taskProgress(memberBlockedTask.id).currentRuns[0].waitReason, /该成员正在处理其他作业/);
    f.service.send(activeTask.roomId, { body: '只读咨询等待写入停止', recipientIds: [f.reviewer.id] });
    const consultation = f.service.taskProgress(activeTask.id).currentRuns.find((run) => run.stage === 'chat');
    assert.equal(consultation.status, 'queued');
    assert.match(consultation.waitReason, /同一任务目录/);
    f.service.updateSettings({ maxParallel: 1 });
    const capacityBlockedTask = create(f, { title: '等待执行容量', assigneeId: f.reviewer.id });
    assert.match(f.service.taskProgress(capacityBlockedTask.id).currentRuns[0].waitReason, /并发名额已满/);
    f.service.updateSettings({ paused: true });
    assert.match(f.service.taskProgress(memberBlockedTask.id).currentRuns[0].waitReason, /全局调度已暂停/);
    assert.match(f.service.taskProgress(capacityBlockedTask.id).currentRuns[0].waitReason, /全局调度已暂停/);
    f.service.pauseTask(activeTask.id);
    f.service.cancelTask(memberBlockedTask.id);
    f.service.cancelTask(capacityBlockedTask.id);
    release();
    await until(() => f.service.active.size === 0);
  } finally { release?.(); await f.close(); }
});

test('task progress retains its own older runs beyond the global bootstrap window without mixing shared-room tasks', async () => {
  const f = fixture();
  try {
    const first = create(f, { roomId: 'team', start: false });
    const other = create(f, { roomId: 'team', start: false });
    const storedRun = (id, taskId, extra = {}) => ({ id, taskId, roomId: 'team', memberId: f.builder.id,
      stage: 'implement', status: 'succeeded', summary: id, riskFlags: [], ...extra });
    f.service.store.put('runs', storedRun('first-task-implementation', first.id));
    f.service.store.put('runs', storedRun('first-task-consultation', null, { contextTaskId: first.id, stage: 'chat' }));
    for (let index = 0; index < 60; index++) f.service.store.put('runs', storedRun(`other-task-${index}`, other.id));
    assert.ok(f.service.bootstrap().runs.every((run) => run.taskId === other.id));
    const progress = f.service.taskProgress(first.id);
    assert.equal(progress.taskId, first.id);
    assert.equal(progress.totalRuns, 2);
    assert.equal(progress.omittedRuns, 0);
    assert.deepEqual(progress.runs.map((run) => run.id).sort(), ['first-task-consultation', 'first-task-implementation']);
    assert.deepEqual(progress.currentRuns, []);
    assert.equal(progress.active, false);
    assert.equal(progress.canPause, false);
  } finally { await f.close(); }
});
