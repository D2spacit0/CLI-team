import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, success, until, writeDeliverable } from './helpers.mjs';

const passingGate = async () => ({ passed: true, exitCode: 0, testCount: 1, skipped: 0 });
const transientFailure = () => ({ success: false, report: null, response: '', riskFlags: ['process_error'],
  error: 'TRANSIENT_STAGE_FAILURE', exitCode: 1 });
const planFor = (worker) => success('负责人已拆分工作', { delegation: { steps: [{ key: 'module',
  title: '生成模块', objective: '生成 result.mjs', memberId: worker.id, dependsOn: [] }] } });
function setupTask(f) {
  const worker = f.service.saveMember({ name: '协作者', handle: 'stage-worker', provider: 'custom',
    role: 'builder', executable: process.execPath, permission: 'edit', enabled: true });
  return { worker, create: () => f.service.createTask({ title: '负责人阶段恢复', objective: '拆分并集成模块',
    executionMode: 'delegated', assigneeId: f.builder.id, participantIds: [worker.id], reviewerId: f.reviewer.id,
    verification: { executable: process.execPath, args: ['--test'] }, start: true }) };
}

for (const failedStage of ['plan', 'implement']) {
  test(`transient owner ${failedStage} failure retries only that stage and preserves completed work`, async () => {
    let worker, failed = false, savedCoordination;
    const calls = [];
    const f = fixture({ verifier: passingGate, agentExecutor: async (member, prompt, { workspace }) => {
      const stage = prompt.includes('Delegation planning') ? 'plan' : prompt.includes('Delegated step') ? 'delegate'
        : prompt.includes('Integrate the delegated results') ? 'implement' : 'review';
      calls.push(stage);
      if (stage === failedStage && !failed) {
        failed = true;
        const task = f.service.store.list('tasks')[0];
        savedCoordination = structuredClone(task.coordination);
        return transientFailure();
      }
      if (stage === 'plan') return planFor(worker);
      if (stage === 'delegate') { writeDeliverable(workspace); return success('WORKER_RESULT_PRESERVED'); }
      if (stage === 'implement') {
        assert.match(prompt, /WORKER_RESULT_PRESERVED/);
        writeDeliverable(workspace, 'export const integrated = 42;\n');
        return success('负责人集成完成');
      }
      assert.equal(member.role, 'reviewer');
      return success('独立评审通过', { verdict: 'approve' });
    } });
    try {
      f.service.updateSettings({ repairLimit: 1 });
      const setup = setupTask(f); worker = setup.worker;
      const task = setup.create();
      await until(() => f.service.require('tasks', task.id).status === 'review');
      const current = f.service.require('tasks', task.id);
      assert.deepEqual(calls, failedStage === 'plan'
        ? ['plan', 'plan', 'delegate', 'implement', 'review']
        : ['plan', 'delegate', 'implement', 'implement', 'review']);
      assert.equal(current.repairCount, 1);
      assert.equal(current.coordination.round, savedCoordination.round);
      assert.equal(current.gate.status, 'passed');
      assert.equal(current.reviewVerdict, 'approve');
      const stageRuns = f.service.store.list('runs').filter((run) => run.taskId === task.id && run.stage === failedStage);
      assert.deepEqual(stageRuns.map((run) => run.status), ['failed', 'succeeded']);
      if (failedStage === 'implement') {
        assert.equal(current.coordination.integrationRunId, stageRuns[1].id);
        assert.equal(current.coordination.steps[0].runId, savedCoordination.steps[0].runId);
        assert.equal(current.coordination.steps[0].summary, savedCoordination.steps[0].summary);
      }
      assert.equal(f.service.acceptTask(task.id, { note: '确认恢复后的集成结果' }).status, 'done');
    } finally { await f.close(); }
  });
}

test('persistent planning failure consumes only the shared repair limit and then blocks', async () => {
  let calls = 0;
  const f = fixture({ agentExecutor: async () => { calls++; return transientFailure(); } });
  try {
    f.service.updateSettings({ repairLimit: 2 });
    const task = setupTask(f).create();
    await until(() => f.service.require('tasks', task.id).status === 'blocked' && f.service.active.size === 0);
    assert.equal(calls, 3);
    assert.equal(f.service.require('tasks', task.id).repairCount, 2);
    const runs = f.service.store.list('runs').filter((run) => run.taskId === task.id);
    assert.ok(runs.every((run) => run.stage === 'plan' && run.status === 'failed'));
    assert.notEqual(f.service.require('tasks', task.id).gate.status, 'passed');
  } finally { await f.close(); }
});

for (const riskFlag of ['permission_denied', 'read_only_workspace_changed']) {
  test(`owner stage with ${riskFlag} blocks without consuming a retry`, async () => {
    let calls = 0;
    const f = fixture({ agentExecutor: async () => {
      calls++;
      return { ...transientFailure(), riskFlags: ['process_error', riskFlag] };
    } });
    try {
      f.service.updateSettings({ repairLimit: 2 });
      const task = setupTask(f).create();
      await until(() => f.service.require('tasks', task.id).status === 'blocked' && f.service.active.size === 0);
      assert.equal(calls, 1);
      assert.equal(f.service.require('tasks', task.id).repairCount, 0);
      assert.equal(f.service.store.list('runs').length, 1);
    } finally { await f.close(); }
  });
}

test('cancelling an owner stage cannot turn its returned process error into a retry', async () => {
  let activeSignal;
  const f = fixture({ agentExecutor: async (_member, _prompt, { signal }) => {
    activeSignal = signal;
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(transientFailure()), { once: true }));
  } });
  try {
    f.service.updateSettings({ repairLimit: 2 });
    const task = setupTask(f).create();
    await until(() => activeSignal);
    f.service.cancelTask(task.id);
    await until(() => f.service.active.size === 0);
    assert.equal(activeSignal.aborted, true);
    assert.equal(f.service.require('tasks', task.id).status, 'cancelled');
    assert.equal(f.service.require('tasks', task.id).repairCount, 0);
    assert.equal(f.service.store.list('runs').length, 1);
    assert.equal(f.service.store.list('runs')[0].status, 'cancelled');
  } finally { await f.close(); }
});
