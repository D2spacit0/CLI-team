import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TeamService } from '../server/service.mjs';
import { manifest } from '../server/safety.mjs';
import { cleanup, fixture, success, until, writeDeliverable } from './helpers.mjs';

const passingGate = async () => ({ passed: true, exitCode: 0, testCount: 1, skipped: 0 });
const helpQuestion = 'WHICH_RECORD_FIELD';
const ownerAnswer = 'CONFIRMED_STABLE_RECORD_ID';
const ask = () => success('需要负责人确认字段', { status: 'needs_help', helpRequest: { question: helpQuestion } });
const transientFailure = () => ({ success: false, report: null, response: '', riskFlags: ['process_error'],
  exitCode: 1, error: 'TEMPORARY_SUCCESSOR_FAILURE' });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const addMember = (f, handle, permission = 'edit') => f.service.saveMember({ name: handle, handle, provider: 'custom',
  executable: process.execPath, role: 'builder', permission, enabled: true });
const fileStep = (memberId, key = 'module', dependsOn = [], file = 'result.mjs') => ({
  key, title: `完成 ${key}`, objective: `交付 ${file}`, memberId, dependsOn,
  output: { type: 'files', files: [{ path: file, format: 'text' }] },
});

function lifecycleFixture({ plan, delegate, coordinate, consult, implement, verifier = passingGate } = {}) {
  let f, activeService, worker, helper;
  const calls = [];
  const executor = async (member, prompt, options) => {
    const run = activeService.store.list('runs').find((item) => item.nativeLog === options.logFile);
    assert.ok(run);
    const call = { run, member, prompt, ...options };
    calls.push(call);
    const attempt = calls.filter((item) => item.run.stage === run.stage && item.run.stepKey === run.stepKey).length;
    const context = { ...call, attempt, service: activeService, worker, helper };
    if (run.stage === 'plan') return plan ? plan(context) : success('负责人已派工', { delegation: { steps: [fileStep(worker.id)] } });
    if (run.stage === 'delegate') {
      if (delegate) return delegate(context);
      if (attempt === 1) return ask();
      assert.ok(prompt.includes(ownerAnswer), '恢复后的原步骤没有收到负责人答复');
      writeDeliverable(options.workspace);
      return success('已按答复完成原步骤');
    }
    if (run.stage === 'coordinate') return coordinate ? coordinate(context) : success(ownerAnswer);
    if (run.stage === 'consult') return consult ? consult(context) : success('CURRENT_PEER_EVIDENCE');
    if (run.stage === 'implement') return implement ? implement(context) : success('负责人已汇总实际产物');
    if (run.stage === 'review') return success('独立评审通过', { verdict: 'approve' });
    throw new Error(`Unexpected stage: ${run.stage}`);
  };
  f = fixture({ verifier, agentExecutor: executor });
  activeService = f.service;
  worker = addMember(f, 'lifecycle-worker');
  helper = addMember(f, 'lifecycle-peer');
  f.service.updateSettings({ repairLimit: 0 });
  return { f, worker, helper, calls, executor, useService: (service) => { activeService = service; },
    create: () => activeService.createTask({ title: '协作生命周期', objective: '在暂停和重启后继续当前协作',
      executionMode: 'delegated', assigneeId: f.builder.id, participantIds: [worker.id, helper.id],
      reviewerId: f.reviewer.id, verification: { executable: process.execPath, args: ['--test'] }, start: true }) };
}
const callsAt = (group, stage) => group.calls.filter((item) => item.run.stage === stage);
const helpFor = (service, task) => service.store.list('assistance').filter((item) => item.taskId === task.id);
const settledAt = async (service, task, status) => {
  try { return await until(() => service.require('tasks', task.id).status === status && service.active.size === 0); }
  catch (error) {
    const current = service.require('tasks', task.id);
    error.message += `\n${JSON.stringify({ expected: status, status: current.status, summary: current.summary,
      phase: current.coordination?.phase, runs: service.store.list('runs').filter((run) => run.taskId === task.id)
        .map(({ stage, status, error, summary }) => ({ stage, status, error, summary })) })}`;
    throw error;
  }
};

test('pausing coordination resumes the owner on explicit Start without requiring a fabricated human answer', async () => {
  const interruptedReply = deferred();
  const group = lifecycleFixture({ coordinate: ({ attempt }) => attempt === 1 ? interruptedReply.promise : success(ownerAnswer) });
  const { f } = group;
  try {
    const task = group.create();
    const first = await until(() => callsAt(group, 'coordinate')[0]);
    const help = helpFor(f.service, task)[0];
    f.service.pauseTask(task.id);
    assert.equal(first.signal.aborted, true);
    assert.throws(() => f.service.startTask(task.id), { status: 409 });
    interruptedReply.resolve(success('LATE_OWNER_ANSWER'));
    await settledAt(f.service, task, 'blocked');
    assert.equal(helpFor(f.service, task)[0].status, 'blocked');
    assert.equal(Boolean(helpFor(f.service, task)[0].answer), false);
    f.service.startTask(task.id);
    await settledAt(f.service, task, 'review');
    const coordinators = callsAt(group, 'coordinate');
    assert.equal(coordinators.length, 2);
    assert.notEqual(coordinators[1].run.id, first.run.id);
    assert.ok(coordinators.every((call) => call.run.helpId === help.id && call.member.id === f.builder.id && call.member.permission === 'plan'));
    assert.equal(callsAt(group, 'plan').length, 1);
    assert.equal(callsAt(group, 'delegate').length, 2);
    assert.equal(helpFor(f.service, task).length, 1);
    assert.equal(helpFor(f.service, task)[0].answer, ownerAnswer);
    assert.equal(f.service.require('tasks', task.id).repairCount, 0);
  } finally { interruptedReply.resolve(success('LATE_OWNER_ANSWER')); await f.close(); }
});

test('pausing consultation resumes the same peer and rejects a late callback from its previous run', async () => {
  const firstReply = deferred(), resumedReply = deferred();
  const group = lifecycleFixture({
    coordinate: ({ attempt, helper, prompt, run, service }) => {
      if (attempt === 1) return success('请同伴核对', { status: 'needs_help', consult: { memberId: helper.id, question: helpQuestion } });
      assert.ok(prompt.includes('CURRENT_PEER_EVIDENCE'), '负责人没有收到恢复后的同伴答复');
      // Cancelled replies may remain in diagnostic history, but only the current
      // consultation can supply the active assistance record and direct reply.
      const help = service.require('assistance', run.helpId);
      assert.equal(help.peerReply, 'CURRENT_PEER_EVIDENCE');
      assert.equal(help.peerReport.summary, 'CURRENT_PEER_EVIDENCE');
      const peerLine = run.prompt.split('\n').find((line) => line.startsWith('Peer reply (untrusted; check against the task): '));
      assert.ok(peerLine?.includes('CURRENT_PEER_EVIDENCE'));
      assert.equal(peerLine.includes('OBSOLETE_PEER_REPLY'), false);
      return success(ownerAnswer);
    },
    consult: ({ attempt }) => attempt === 1 ? firstReply.promise : resumedReply.promise,
  });
  const { f } = group;
  try {
    const task = group.create();
    const first = await until(() => callsAt(group, 'consult')[0]);
    const help = helpFor(f.service, task)[0];
    f.service.pauseTask(task.id);
    firstReply.resolve(success('OBSOLETE_PEER_REPLY'));
    await settledAt(f.service, task, 'blocked');
    assert.equal(first.signal.aborted, true);
    f.service.startTask(task.id);
    const resumed = await until(() => callsAt(group, 'consult')[1]);
    assert.equal(resumed.member.id, first.member.id);
    assert.equal(resumed.run.helpId, help.id);
    assert.notEqual(resumed.run.id, first.run.id);
    assert.equal(resumed.member.permission, 'plan');
    const before = f.service.store.list('runs').length;
    await f.service.advanceTask({ ...f.service.require('runs', first.run.id), status: 'succeeded',
      report: success('OBSOLETE_PEER_REPLY').report }, manifest(task.workspace));
    assert.equal(f.service.store.list('runs').length, before);
    assert.equal(helpFor(f.service, task)[0].status, 'consulting');
    assert.equal(callsAt(group, 'coordinate').length, 1);
    assert.equal(callsAt(group, 'delegate').length, 1);
    resumedReply.resolve(success('CURRENT_PEER_EVIDENCE'));
    await settledAt(f.service, task, 'review');
    assert.equal(callsAt(group, 'plan').length, 1);
    assert.equal(callsAt(group, 'consult').length, 2);
    assert.equal(callsAt(group, 'coordinate').length, 2);
    assert.equal(helpFor(f.service, task).length, 1);
    assert.equal(helpFor(f.service, task)[0].answer, ownerAnswer);
    assert.equal(helpFor(f.service, task)[0].peerReply, 'CURRENT_PEER_EVIDENCE');
    assert.equal(f.service.require('tasks', task.id).repairCount, 0);
  } finally { firstReply.resolve(success('OBSOLETE_PEER_REPLY')); resumedReply.resolve(success('CURRENT_PEER_EVIDENCE')); await f.close(); }
});

test('pausing integration reuses checked work and rejects a late success from its previous run', async () => {
  const firstResult = deferred(), resumedResult = deferred();
  let verifications = 0;
  const group = lifecycleFixture({
    delegate: ({ workspace }) => { writeDeliverable(workspace); return success('已交付可复用的实际产物'); },
    implement: ({ attempt }) => attempt === 1 ? firstResult.promise : resumedResult.promise,
    verifier: async () => { verifications++; return passingGate(); },
  });
  const { f } = group;
  try {
    const task = group.create();
    const first = await until(() => callsAt(group, 'implement')[0]);
    const originalPlanId = f.service.require('tasks', task.id).coordination.planId;
    f.service.pauseTask(task.id);
    assert.equal(first.signal.aborted, true);
    assert.throws(() => f.service.startTask(task.id), { status: 409 });
    firstResult.resolve(success('OBSOLETE_INTEGRATION_RESULT'));
    await settledAt(f.service, task, 'blocked');
    assert.equal(verifications, 0);
    assert.equal(f.service.taskProgress(task.id).resume.reusableSteps, 1);
    f.service.startTask(task.id);
    const resumed = await until(() => callsAt(group, 'implement')[1]);
    assert.notEqual(resumed.run.id, first.run.id);
    assert.equal(resumed.run.planId, originalPlanId);
    const before = f.service.store.list('runs').length;
    // advanceTask reloads the stored run. Persist the late success to model an
    // obsolete completion arriving after the replacement integration started.
    const obsolete = f.service.store.update('runs', first.run.id, { status: 'succeeded', handledAt: null,
      executionSucceeded: true, exitCode: 0, error: null, riskFlags: [],
      summary: 'OBSOLETE_INTEGRATION_RESULT', report: success('OBSOLETE_INTEGRATION_RESULT').report });
    await f.service.advanceTask(obsolete, manifest(task.workspace));
    const current = f.service.require('tasks', task.id);
    assert.equal(current.status, 'running');
    assert.equal(current.coordination.phase, 'synthesizing');
    assert.equal(current.coordination.integrationRunId, resumed.run.id);
    assert.equal(current.coordination.planId, originalPlanId);
    assert.equal(current.gate.status, 'pending');
    assert.equal(f.service.require('runs', resumed.run.id).status, 'running');
    assert.equal(f.service.require('runs', first.run.id).handledAt, null);
    assert.equal(f.service.store.list('runs').length, before);
    assert.equal(callsAt(group, 'review').length, 0);
    assert.equal(verifications, 0);
    resumedResult.resolve(success('CURRENT_INTEGRATION_RESULT'));
    await settledAt(f.service, task, 'review');
    assert.equal(callsAt(group, 'plan').length, 1);
    assert.equal(callsAt(group, 'delegate').length, 1);
    assert.equal(callsAt(group, 'implement').length, 2);
    assert.equal(callsAt(group, 'review').length, 1);
    assert.equal(verifications, 1);
    assert.equal(f.service.require('tasks', task.id).gate.status, 'passed');
    assert.equal(f.service.require('tasks', task.id).repairCount, 0);
  } finally {
    firstResult.resolve(success('OBSOLETE_INTEGRATION_RESULT'));
    resumedResult.resolve(success('CURRENT_INTEGRATION_RESULT'));
    await f.close();
  }
});

test('restart blocks pending assistance and interrupts its queued run until the user explicitly resumes', async () => {
  const group = lifecycleFixture({ delegate: (context) => {
    if (context.attempt === 1) {
      context.service.updateSettings({ paused: true });
      return ask();
    }
    assert.ok(context.prompt.includes(ownerAnswer));
    writeDeliverable(context.workspace);
    return success('重启后继续原步骤');
  } });
  const { f } = group;
  let restarted, originalClosed = false;
  try {
    const task = group.create();
    const pending = await until(() => {
      const help = helpFor(f.service, task)[0];
      return help?.status === 'pending' && f.service.active.size === 0 && help;
    });
    const queued = f.service.require('runs', pending.coordinatorRunId);
    assert.equal(queued.status, 'queued');
    assert.equal(callsAt(group, 'coordinate').length, 0);
    // Closing synchronously prevents this queued callback from running, while
    // keeping scheduling enabled in the persisted settings for the restart.
    f.service.updateSettings({ paused: false });
    await f.service.close();
    originalClosed = true;
    restarted = new TeamService({ root: f.root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }),
      verifier: passingGate, agentExecutor: group.executor });
    group.useService(restarted);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarted.settings().paused, false);
    assert.equal(restarted.require('tasks', task.id).status, 'blocked');
    assert.equal(restarted.require('runs', queued.id).status, 'interrupted');
    assert.equal(helpFor(restarted, task)[0].status, 'blocked');
    assert.equal(restarted.active.size, 0);
    assert.equal(callsAt(group, 'coordinate').length, 0);
    restarted.startTask(task.id);
    await settledAt(restarted, task, 'review');
    assert.equal(callsAt(group, 'plan').length, 1);
    assert.equal(callsAt(group, 'coordinate').length, 1);
    assert.equal(callsAt(group, 'coordinate')[0].run.helpId, pending.id);
    assert.notEqual(callsAt(group, 'coordinate')[0].run.id, queued.id);
    assert.equal(callsAt(group, 'delegate').length, 2);
    assert.equal(helpFor(restarted, task)[0].answer, ownerAnswer);
  } finally {
    if (restarted) await restarted.close();
    if (!originalClosed) await f.service.close();
    cleanup(f.root);
  }
});

test('complete analysis sections reach both the dependent worker and owner integration', async () => {
  const evidence = `${'每一项接口约定都必须保留并用于下游实现。'.repeat(300)}FULL_ANALYSIS_EVIDENCE_TAIL`;
  const risks = 'ANALYSIS_RISK_SECTION：字段缺失必须报错，不能静默生成新值。';
  assert.ok(evidence.length > 4000 && evidence.length < 8000);
  const received = [];
  const group = lifecycleFixture({
    plan: ({ helper, worker }) => success('先分析，再按结论实现', { delegation: { steps: [
      { key: 'analyze', title: '分析接口', objective: '给出完整依据和风险', memberId: helper.id, dependsOn: [],
        output: { type: 'analysis', sections: ['summary', 'evidence', 'risks'] } },
      fileStep(worker.id, 'build', ['analyze']),
    ] } }),
    delegate: ({ run, member, workspace, prompt }) => {
      if (run.stepKey === 'analyze') {
        assert.equal(member.permission, 'plan');
        return success('分析摘要', { analysis: [{ key: 'evidence', content: evidence }, { key: 'risks', content: risks }] });
      }
      assert.ok(prompt.includes(evidence), '下游成员没有取得完整的 evidence 章节');
      assert.ok(prompt.includes(risks), '下游成员没有取得 risks 章节');
      received.push('worker');
      writeDeliverable(workspace);
      return success('已按分析约束实现模块');
    },
    implement: ({ prompt }) => {
      assert.ok(prompt.includes(evidence), '负责人没有取得完整的 evidence 章节');
      assert.ok(prompt.includes(risks), '负责人没有取得 risks 章节');
      received.push('owner');
      return success('负责人核对分析和实际实现后完成汇总');
    },
  });
  const { f } = group;
  try {
    f.service.saveMember({ permission: 'plan', role: 'researcher' }, group.helper.id);
    const task = group.create();
    await settledAt(f.service, task, 'review');
    assert.deepEqual(received, ['worker', 'owner']);
    const analysis = f.service.taskProgress(task.id).coordination.steps.find((step) => step.key === 'analyze');
    assert.equal(analysis.outputCheck.status, 'passed');
    assert.equal(analysis.outputCheck.type, 'analysis');
    assert.equal(f.service.require('tasks', task.id).gate.status, 'passed');
  } finally { await f.close(); }
});

for (const change of ['feedback', 'reassignment']) {
  test(`${change} cancels obsolete help so an old question cannot be answered in a new assignment`, async () => {
    const group = lifecycleFixture({ coordinate: () => success('等待人工确认', { status: 'blocked' }) });
    const { f } = group;
    try {
      const task = group.create();
      await settledAt(f.service, task, 'blocked');
      const help = helpFor(f.service, task)[0];
      assert.equal(help.status, 'blocked');
      f.service.updateSettings({ paused: true });
      if (change === 'feedback') {
        f.service.startTask(task.id, 'NEW_REQUIREMENT_WITH_DIFFERENT_FIELD');
        f.service.pauseTask(task.id);
      } else {
        const replacement = addMember(f, 'replacement-worker');
        f.service.reassignTask(task.id, { assigneeId: f.builder.id, participantIds: [replacement.id],
          reviewerId: f.reviewer.id, note: '交给新的协作者重新规划' });
      }
      assert.equal(f.service.require('tasks', task.id).status, 'blocked');
      assert.equal(f.service.taskProgress(task.id).active, false);
      assert.equal(helpFor(f.service, task)[0].status, 'cancelled');
      const count = f.service.store.list('runs').length;
      assert.throws(() => f.service.answerTaskAssistance(task.id, help.id, { answer: 'STALE_FIELD_ANSWER' }), { status: 409 });
      assert.equal(f.service.store.list('runs').length, count);
      assert.equal(Boolean(helpFor(f.service, task)[0].answer), false);
      assert.equal(callsAt(group, 'delegate').length, 1);
    } finally { await f.close(); }
  });
}

test('upstream artifact drift during failed work consumes the same finite retry budget', async () => {
  const group = lifecycleFixture({
    plan: ({ worker }) => success('先后执行两个文件步骤', { delegation: { steps: [
      fileStep(worker.id, 'a', [], 'a.txt'), fileStep(worker.id, 'b', ['a'], 'b.txt'),
    ] } }),
    delegate: ({ run, workspace, attempt }) => {
      if (run.stepKey === 'a') {
        fs.writeFileSync(path.join(workspace, 'a.txt'), `upstream-generation-${attempt}`);
        return success('已生成前置产物');
      }
      fs.writeFileSync(path.join(workspace, 'a.txt'), `changed-by-failed-successor-${attempt}`);
      return transientFailure();
    },
  });
  const { f } = group;
  try {
    f.service.updateSettings({ repairLimit: 1 });
    const task = group.create();
    await settledAt(f.service, task, 'blocked');
    assert.deepEqual(callsAt(group, 'delegate').map((call) => call.run.stepKey), ['a', 'b', 'a', 'b']);
    assert.equal(callsAt(group, 'plan').length, 1);
    assert.equal(f.service.require('tasks', task.id).repairCount, 1);
    assert.equal(f.service.taskProgress(task.id).resume.reusableSteps, 0);
    assert.equal(callsAt(group, 'implement').length, 0);
    assert.notEqual(f.service.require('tasks', task.id).gate.status, 'passed');
  } finally { await f.close(); }
});

test('a plan cannot let two steps claim the same output path before either worker runs', async () => {
  const group = lifecycleFixture({ plan: ({ worker }) => success('两个步骤声称产生同一文件', { delegation: { steps: [
    fileStep(worker.id, 'first', [], 'shared.txt'), fileStep(worker.id, 'second', ['first'], 'shared.txt'),
  ] } }) });
  const { f } = group;
  try {
    const task = group.create();
    await settledAt(f.service, task, 'blocked');
    assert.equal(callsAt(group, 'plan').length, 1);
    assert.equal(callsAt(group, 'delegate').length, 0);
    assert.equal(f.service.store.list('runs').filter((run) => run.taskId === task.id).length, 1);
    assert.notEqual(f.service.require('tasks', task.id).gate.status, 'passed');
  } finally { await f.close(); }
});
