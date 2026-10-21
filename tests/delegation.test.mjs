import test from 'node:test';
import assert from 'node:assert/strict';
import { TeamService } from '../server/service.mjs';
import { cleanup, fixture, success, until, writeDeliverable } from './helpers.mjs';

const passingGate = async () => ({ passed: true, exitCode: 0, testCount: 3, skipped: 0 });
const step = (memberId, extra = {}) => ({ key: 'build', title: '实现模块', objective: '生成模块并解释结果', memberId, dependsOn: [], ...extra });
const worker = (f, extra = {}) => f.service.saveMember({ name: '协作者', handle: 'worker', provider: 'custom',
  role: 'builder', executable: process.execPath, enabled: true, permission: 'edit', skills: 'SQLITE_BOUNDARY_EXPERT', ...extra });
const create = (f, participants, extra = {}) => f.service.createTask({ title: '负责人调度', objective: '调度协作者并集成结果',
  executionMode: 'delegated', assigneeId: f.builder.id, participantIds: participants.map((member) => member.id),
  reviewerId: f.reviewer.id, verification: { executable: process.execPath, args: ['--test'] }, start: true, ...extra });

test('owner plans from skills, dispatches dependency work, integrates and awaits independent acceptance', async () => {
  const calls = [];
  let first, second;
  const f = fixture({ verifier: passingGate, agentExecutor: async (member, prompt, options) => {
    calls.push({ member, prompt, ...options });
    if (prompt.includes('Delegation planning')) return success('拆分完成', { delegation: { steps: [
      step(first.id), step(second.id, { key: 'inspect', title: '复核边界', dependsOn: ['build'] }),
    ] } });
    if (prompt.includes('Delegated step')) {
      if (member.id === first.id) { writeDeliverable(options.workspace); return success('BUILT_BOUNDARY_RESULT'); }
      assert.match(prompt, /BUILT_BOUNDARY_RESULT/);
      return success('INSPECTED_BOUNDARY_RESULT');
    }
    if (prompt.includes('Integrate the delegated results')) {
      assert.match(prompt, /BUILT_BOUNDARY_RESULT/);
      assert.match(prompt, /INSPECTED_BOUNDARY_RESULT/);
      writeDeliverable(options.workspace, 'export const integrated = 42;\n');
      return success('集成完成');
    }
    assert.equal(member.role, 'reviewer');
    return success('独立评审完成', { verdict: 'approve' });
  } });
  try {
    first = worker(f);
    second = worker(f, { name: '边界分析', handle: 'analyst', permission: 'plan', skills: 'DEPENDENCY_ANALYSIS' });
    const task = create(f, [first, second]);
    await until(() => f.service.require('tasks', task.id).status === 'review');
    assert.equal(calls.length, 5);
    assert.deepEqual(calls.map((call) => call.member.id), [f.builder.id, first.id, second.id, f.builder.id, f.reviewer.id]);
    assert.deepEqual(calls.map((call) => call.member.permission), ['plan', 'edit', 'plan', 'edit', 'plan']);
    assert.ok(calls.every((call) => call.workspace === task.workspace));
    assert.match(calls[0].prompt, /SQLITE_BOUNDARY_EXPERT/);
    assert.match(calls[0].prompt, /DEPENDENCY_ANALYSIS/);
    const current = f.service.require('tasks', task.id);
    assert.equal(current.gate.status, 'passed');
    assert.equal(current.reviewVerdict, 'approve');
    assert.ok(current.coordination.steps.every((item) => item.status === 'succeeded' && item.runId && item.summary));
    assert.equal(f.service.acceptTask(task.id, { note: '人工验收完成' }).status, 'done');
  } finally { await f.close(); }
});

for (const invalid of ['unknown member', 'unselected member', 'duplicate key', 'unknown dependency', 'dependency cycle', 'empty plan', 'too many steps']) {
  test(`invalid delegation plan is blocked before worker execution: ${invalid}`, async () => {
    const calls = [];
    let selected, unselected;
    const f = fixture({ agentExecutor: async (_member, prompt) => {
      calls.push(prompt);
      let steps = [step(selected.id)];
      if (invalid === 'unknown member') steps[0].memberId = 'unknown-member';
      if (invalid === 'unselected member') steps[0].memberId = unselected.id;
      if (invalid === 'duplicate key') steps.push(step(selected.id));
      if (invalid === 'unknown dependency') steps[0].dependsOn = ['missing'];
      if (invalid === 'dependency cycle') steps = [step(selected.id, { dependsOn: ['second'] }), step(selected.id, { key: 'second', dependsOn: ['build'] })];
      if (invalid === 'empty plan') steps = [];
      if (invalid === 'too many steps') steps = Array.from({ length: 7 }, (_, index) => step(selected.id, { key: `step-${index}` }));
      return success('声称计划完成', { delegation: { steps } });
    } });
    try {
      selected = worker(f);
      unselected = worker(f, { handle: 'unselected' });
      f.service.updateSettings({ repairLimit: 0 });
      const task = create(f, [selected]);
      await until(() => f.service.require('tasks', task.id).status === 'blocked');
      assert.equal(calls.length, 1);
      assert.match(calls[0], /Delegation planning/);
      assert.notEqual(f.service.require('tasks', task.id).gate?.status, 'passed');
    } finally { await f.close(); }
  });
}

test('failed delegated work reaches a bounded replan and cannot be accepted on a complete claim', async () => {
  let selected;
  const calls = [];
  const f = fixture({ agentExecutor: async (_member, prompt) => {
    calls.push(prompt);
    if (prompt.includes('Delegation planning')) return success('计划', { delegation: { steps: [step(selected.id)] } });
    return { ...success('WORKER_FAILURE_DETAILS'), success: false, exitCode: 1, error: 'worker failed' };
  } });
  try {
    selected = worker(f);
    f.service.updateSettings({ repairLimit: 1 });
    const task = create(f, [selected]);
    await until(() => f.service.require('tasks', task.id).status === 'blocked' && f.service.active.size === 0);
    assert.equal(calls.filter((prompt) => prompt.includes('Delegation planning')).length, 2);
    assert.equal(calls.filter((prompt) => prompt.includes('Delegated step')).length, 2);
    assert.match(calls.filter((prompt) => prompt.includes('Delegation planning'))[1], /WORKER_FAILURE_DETAILS/);
    assert.equal(f.service.require('tasks', task.id).repairCount, 1);
    assert.throws(() => f.service.acceptTask(task.id, { note: '不能越过失败' }));
  } finally { await f.close(); }
});

test('cancelling an active worker aborts it and never schedules integration or review', async () => {
  let selected, workerSignal;
  const f = fixture({ agentExecutor: async (_member, prompt, { signal }) => {
    if (prompt.includes('Delegation planning')) return success('计划', { delegation: { steps: [step(selected.id)] } });
    workerSignal = signal;
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ...success(), cancelled: true }), { once: true }));
  } });
  try {
    selected = worker(f);
    const task = create(f, [selected]);
    await until(() => workerSignal);
    f.service.cancelTask(task.id);
    await until(() => f.service.active.size === 0);
    assert.equal(workerSignal.aborted, true);
    assert.equal(f.service.require('tasks', task.id).status, 'cancelled');
    assert.equal(f.service.store.list('runs').length, 2);
  } finally { await f.close(); }
});

test('restarting with delegated planning queued interrupts the task without replaying it', async () => {
  let calls = 0, restarted;
  const f = fixture({ agentExecutor: async () => { calls++; return success(); } });
  try {
    const selected = worker(f);
    f.service.updateSettings({ paused: true });
    const task = create(f, [selected]);
    await f.service.close();
    restarted = new TeamService({ root: f.root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }),
      agentExecutor: async () => { calls++; return success(); } });
    assert.equal(restarted.require('tasks', task.id).status, 'blocked');
    assert.equal(restarted.store.list('runs')[0].status, 'interrupted');
    assert.equal(restarted.active.size, 0);
    assert.equal(calls, 0);
  } finally { if (restarted) await restarted.close(); cleanup(f.root); }
});

test('planning cannot write files even when the owner has edit permission', async () => {
  let selected;
  const f = fixture({ agentExecutor: async (member, _prompt, { workspace }) => {
    assert.equal(member.permission, 'plan');
    writeDeliverable(workspace);
    return success('声称成功', { delegation: { steps: [step(selected.id)] } });
  } });
  try {
    selected = worker(f);
    f.service.updateSettings({ repairLimit: 0 });
    const task = create(f, [selected]);
    await until(() => f.service.require('tasks', task.id).status === 'blocked');
    const runs = f.service.store.list('runs');
    assert.equal(runs.length, 1);
    assert.ok(runs[0].riskFlags.includes('read_only_workspace_changed'));
  } finally { await f.close(); }
});
