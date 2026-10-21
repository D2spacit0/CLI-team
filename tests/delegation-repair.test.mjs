import test from 'node:test';
import assert from 'node:assert/strict';
import { TeamService } from '../server/service.mjs';
import { cleanup, fixture, success, until, writeDeliverable } from './helpers.mjs';

const passingGate = { passed: true, exitCode: 0, testCount: 3, skipped: 0 };
const step = (memberId) => ({ key: 'build', title: '实现模块', objective: '完成指定模块', memberId, dependsOn: [] });
const addWorker = (f) => f.service.saveMember({ name: '协作者', handle: 'worker', provider: 'custom',
  role: 'builder', executable: process.execPath, enabled: true, permission: 'edit' });
const create = (f, worker) => f.service.createTask({ title: '调度返工验证', objective: '协作实现并验证模块',
  executionMode: 'delegated', assigneeId: f.builder.id, participantIds: [worker.id],
  reviewerId: f.reviewer.id, verification: { executable: process.execPath, args: ['--test'] }, start: true });

for (const failure of ['verification', 'review']) {
  test(`${failure} failure replans with feedback and repeats worker, integration and independent gates`, async () => {
    let worker;
    let gates = 0;
    let reviews = 0;
    const stages = [];
    const plans = [];
    const feedback = failure === 'verification' ? 'MACHINE_BOUNDARY_FAILED' : 'REVIEW_BOUNDARY_FAILED';
    const f = fixture({
      verifier: async () => {
        stages.push('gate');
        gates++;
        return failure === 'verification' && gates === 1
          ? { passed: false, exitCode: 1, testCount: 3, skipped: 0, output: feedback }
          : passingGate;
      },
      agentExecutor: async (member, prompt, { workspace }) => {
        const assignment = prompt.split(/Current assignment:\r?\n/)[1] || '';
        if (assignment.startsWith('Delegation planning')) {
          stages.push('plan');
          plans.push(prompt);
          assert.equal(member.id, f.builder.id);
          return success('拆分已完成', { delegation: { steps: [step(worker.id)] } });
        }
        if (assignment.startsWith('Delegated step')) {
          stages.push('worker');
          assert.equal(member.id, worker.id);
          writeDeliverable(workspace);
          // A worker cannot promote its output into a new owner plan.
          return success('模块已完成', { delegation: { steps: [step('unauthorized-member')] } });
        }
        if (assignment.startsWith('Integrate the delegated results')) {
          stages.push('integrate');
          assert.equal(member.id, f.builder.id);
          writeDeliverable(workspace, 'export const integrated = 42;\n');
          return success('汇总完成');
        }
        stages.push('review');
        reviews++;
        assert.equal(member.id, f.reviewer.id);
        return failure === 'review' && reviews === 1
          ? success(feedback, { verdict: 'changes_requested', findings: [{ severity: 'major', text: feedback }] })
          : success('独立评审通过', { verdict: 'approve' });
      },
    });
    try {
      worker = addWorker(f);
      f.service.updateSettings({ repairLimit: 1 });
      const task = create(f, worker);
      await until(() => f.service.require('tasks', task.id).status === 'review' && f.service.active.size === 0);
      const firstRound = ['plan', 'worker', 'integrate', 'gate', ...(failure === 'review' ? ['review'] : [])];
      assert.deepEqual(stages, [...firstRound, 'plan', 'worker', 'integrate', 'gate', 'review']);
      assert.equal(plans.length, 2);
      assert.match(plans[1], new RegExp(`Address this feedback[^]*${feedback}`));
      const current = f.service.require('tasks', task.id);
      assert.equal(current.repairCount, 1);
      assert.equal(current.coordination.round, 2);
      assert.equal(current.gate.status, 'passed');
      assert.equal(current.reviewVerdict, 'approve');
      assert.ok(current.coordination.steps.every((item) => item.memberId === worker.id && item.status === 'succeeded'));
      assert.equal(f.service.acceptTask(task.id, { note: '完成两轮协作后的人工验收' }).status, 'done');
    } finally { await f.close(); }
  });
}

function controlledWorkerFixture() {
  let worker;
  let release;
  let workerSignal;
  let calls = 0;
  const f = fixture({ agentExecutor: async (_member, prompt, { signal }) => {
    calls++;
    const assignment = prompt.split(/Current assignment:\r?\n/)[1] || '';
    if (assignment.startsWith('Delegation planning')) return success('拆分完成', { delegation: { steps: [step(worker.id)] } });
    workerSignal = signal;
    return new Promise((resolve) => { release = () => resolve(success('晚到的完成结果')); });
  } });
  worker = addWorker(f);
  return { f, worker, release: () => release?.(), signal: () => workerSignal, calls: () => calls };
}

test('cancelled worker leaves cancelled coordination and failed step despite a late success', async () => {
  const controlled = controlledWorkerFixture();
  const { f, worker } = controlled;
  try {
    const task = create(f, worker);
    await until(() => controlled.signal());
    f.service.cancelTask(task.id);
    assert.equal(controlled.signal().aborted, true);
    controlled.release();
    await until(() => f.service.active.size === 0);
    const current = f.service.require('tasks', task.id);
    assert.equal(current.status, 'cancelled');
    assert.equal(current.coordination.phase, 'cancelled');
    assert.equal(current.coordination.steps[0].status, 'failed');
    assert.equal(controlled.calls(), 2);
  } finally { controlled.release(); await f.close(); }
});

test('restart interrupts active delegated worker and marks coordination blocked without replay', async () => {
  const controlled = controlledWorkerFixture();
  const { f, worker } = controlled;
  let restarted;
  let closed = false;
  try {
    const task = create(f, worker);
    await until(() => controlled.signal());
    const closing = f.service.close();
    assert.equal(controlled.signal().aborted, true);
    controlled.release();
    await closing;
    closed = true;
    restarted = new TeamService({ root: f.root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }),
      agentExecutor: async () => { throw new Error('Interrupted work must not replay'); } });
    const current = restarted.require('tasks', task.id);
    assert.equal(current.status, 'blocked');
    assert.equal(current.coordination.phase, 'blocked');
    assert.equal(current.coordination.steps[0].status, 'failed');
    assert.equal(restarted.require('runs', current.coordination.steps[0].runId).status, 'interrupted');
    assert.equal(restarted.active.size, 0);
    assert.equal(restarted.store.list('runs').length, 2);
    assert.equal(controlled.calls(), 2);
  } finally {
    controlled.release();
    if (!closed) await f.service.close();
    if (restarted) await restarted.close();
    cleanup(f.root);
  }
});
