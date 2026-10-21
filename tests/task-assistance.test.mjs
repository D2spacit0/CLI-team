import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { manifest } from '../server/safety.mjs';
import { fixture, success, until } from './helpers.mjs';

const question = 'MISSING_INTERFACE_FIELD';
const answer = 'USE_STABLE_RECORD_ID';
const needsHelp = (text = question) => success('需要补充具体信息', { status: 'needs_help', helpRequest: { question: text } });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const addMember = (f, handle) => f.service.saveMember({ name: handle, handle, provider: 'custom',
  executable: process.execPath, role: 'builder', permission: 'edit', enabled: true });

function assistanceFixture({ delegate, coordinate, consult, stepCount = 1 } = {}) {
  let f, worker, helper, outsider;
  let gates = 0;
  const calls = [];
  f = fixture({ verifier: async () => { gates++; return { passed: true, exitCode: 0, testCount: 1, skipped: 0 }; },
    agentExecutor: async (member, prompt, options) => {
      const run = f.service.store.list('runs').find((item) => item.nativeLog === options.logFile);
      assert.ok(run, 'Every CLI invocation must have a persisted run');
      const call = { run, member, prompt, ...options };
      calls.push(call);
      const attempt = calls.filter((item) => item.run.stage === run.stage && item.run.stepKey === run.stepKey).length;
      const context = { ...call, attempt, f, worker, helper, outsider };
      if (run.stage === 'plan') return success('负责人已派工', { delegation: { steps: Array.from({ length: stepCount }, (_, index) => ({
        key: `module-${index}`, title: `完成模块 ${index}`, objective: `交付 module-${index}.mjs`, memberId: worker.id,
        dependsOn: index ? [`module-${index - 1}`] : [],
        output: { type: 'files', files: [{ path: `module-${index}.mjs`, format: 'text' }] },
      })) } });
      if (run.stage === 'delegate') {
        if (delegate) return delegate(context);
        fs.writeFileSync(path.join(options.workspace, `${run.stepKey}.mjs`), 'export const value = 42;\n');
        return success('指定模块已交付');
      }
      if (run.stage === 'coordinate') return coordinate ? coordinate(context) : success(answer);
      if (run.stage === 'consult') return consult ? consult(context) : success('PEER_INTERFACE_EVIDENCE');
      if (run.stage === 'implement') return success('负责人已检查并汇总协作产物');
      if (run.stage === 'review') return success('独立评审通过', { verdict: 'approve' });
      throw new Error(`Unexpected stage: ${run.stage}`);
    } });
  worker = addMember(f, 'help-worker');
  helper = addMember(f, 'help-peer');
  outsider = addMember(f, 'not-in-pool');
  f.service.updateSettings({ repairLimit: 3 });
  return { f, worker, helper, outsider, calls, gates: () => gates,
    create: (extra = {}) => f.service.createTask({ title: '协作求助闭环', objective: '补齐接口信息后继续原步骤',
      executionMode: 'delegated', assigneeId: f.builder.id, participantIds: [worker.id, helper.id],
      reviewerId: f.reviewer.id, verification: { executable: process.execPath, args: ['--test'] }, start: true, ...extra }) };
}

const assistanceFor = (group, task) => group.f.service.store.list('assistance').filter((item) => item.taskId === task.id);
const callsAt = (group, stage) => group.calls.filter((item) => item.run.stage === stage);
const finishStep = ({ workspace, run }) => {
  fs.writeFileSync(path.join(workspace, `${run.stepKey}.mjs`), 'export const value = 42;\n');
  return success('根据已确认接口交付模块');
};

test('owner answers worker help read-only, resumes the same step, and ignores a duplicate answer callback', async () => {
  const ownerReply = deferred(), resumedWork = deferred();
  const group = assistanceFixture({
    delegate: (context) => context.attempt === 1 ? needsHelp() : resumedWork.promise.then(() => {
      assert.match(context.prompt, new RegExp(answer));
      return finishStep(context);
    }),
    coordinate: (context) => {
      assert.equal(context.member.id, context.f.builder.id);
      assert.equal(context.member.permission, 'plan');
      assert.match(context.prompt, new RegExp(question));
      return ownerReply.promise;
    },
  });
  const { f } = group;
  try {
    const task = group.create();
    const ownerCall = await until(() => callsAt(group, 'coordinate')[0]);
    const help = assistanceFor(group, task)[0];
    assert.equal(assistanceFor(group, task).length, 1);
    assert.equal(ownerCall.run.helpId, help.id);
    assert.equal(f.service.taskProgress(task.id).assistance[0].question, question);
    assert.notEqual(f.service.require('tasks', task.id).coordination.steps[0].status, 'succeeded');
    assert.notEqual(f.service.require('tasks', task.id).coordination.steps[0].outputCheck?.status, 'passed');
    assert.equal(group.gates(), 0);
    assert.throws(() => f.service.acceptTask(task.id, { note: '求助不能当作验收成功' }));
    ownerReply.resolve(success(answer));
    await until(() => callsAt(group, 'delegate').length === 2);
    const runCount = f.service.store.list('runs').length;
    await f.service.advanceTask(f.service.require('runs', ownerCall.run.id), manifest(task.workspace));
    assert.equal(f.service.require('tasks', task.id).status, 'running');
    assert.equal(f.service.store.list('runs').length, runCount);
    assert.equal(assistanceFor(group, task).length, 1);
    resumedWork.resolve();
    await until(() => f.service.require('tasks', task.id).status === 'review' && f.service.active.size === 0);
    assert.deepEqual(group.calls.map((item) => item.run.stage), ['plan', 'delegate', 'coordinate', 'delegate', 'implement', 'review']);
    assert.deepEqual(callsAt(group, 'delegate').map((item) => item.run.stepKey), ['module-0', 'module-0']);
    assert.equal(assistanceFor(group, task)[0].status, 'answered');
    assert.equal(group.gates(), 1);
    assert.equal(f.service.require('tasks', task.id).repairCount, 0);
    assert.equal(f.service.require('tasks', task.id).gate.status, 'passed');
  } finally { ownerReply.resolve(success(answer)); resumedWork.resolve(); await f.close(); }
});

test('one selected peer consults read-only under the workspace lock and owner reviews its answer before resuming work', async () => {
  const peerReply = deferred();
  const group = assistanceFixture({
    delegate: (context) => {
      if (context.attempt === 1) return needsHelp();
      assert.match(context.prompt, /OWNER_CONFIRMED_INTERFACE/);
      return finishStep(context);
    },
    coordinate: (context) => {
      assert.equal(context.member.permission, 'plan');
      if (context.attempt === 1) return success('请同伴查证接口', { status: 'needs_help',
        consult: { memberId: context.helper.id, question: 'CONSULT_INTERFACE_QUESTION' } });
      assert.match(context.prompt, /PEER_INTERFACE_EVIDENCE/);
      return success('OWNER_CONFIRMED_INTERFACE');
    },
    consult: (context) => {
      assert.equal(context.member.id, context.helper.id);
      assert.equal(context.member.permission, 'plan');
      assert.match(context.prompt, /CONSULT_INTERFACE_QUESTION/);
      return peerReply.promise;
    },
  });
  const { f } = group;
  try {
    const task = group.create();
    const peerCall = await until(() => callsAt(group, 'consult')[0]);
    const help = assistanceFor(group, task)[0];
    assert.equal(help.status, 'consulting');
    assert.equal(peerCall.run.helpId, help.id);
    const writer = f.service.enqueue({ roomId: task.roomId, contextTaskId: task.id, memberId: f.builder.id,
      stage: 'implement', prompt: 'Writing must wait for the active read-only consultation.' });
    f.service.pump();
    assert.equal(f.service.require('runs', writer.id).status, 'queued');
    assert.match(f.service.taskProgress(task.id).currentRuns.find((run) => run.id === writer.id).waitReason, /同一任务目录/);
    f.service.cancelRun(writer.id);
    assert.equal(group.gates(), 0);
    peerReply.resolve(success('PEER_INTERFACE_EVIDENCE'));
    await until(() => f.service.require('tasks', task.id).status === 'review' && f.service.active.size === 0);
    assert.deepEqual(group.calls.map((item) => item.run.stage), ['plan', 'delegate', 'coordinate', 'consult', 'coordinate', 'delegate', 'implement', 'review']);
    assert.ok([...callsAt(group, 'coordinate'), ...callsAt(group, 'consult')].every((item) => item.run.helpId === help.id));
    assert.equal(assistanceFor(group, task).length, 1);
    assert.equal(assistanceFor(group, task)[0].status, 'answered');
    assert.equal(group.gates(), 1);
    assert.equal(f.service.require('tasks', task.id).repairCount, 0);
  } finally { peerReply.resolve(success('PEER_INTERFACE_EVIDENCE')); await f.close(); }
});

for (const [action, stage] of [['pauseTask', 'coordinate'], ['cancelTask', 'consult']]) {
  test(`${action} stops active ${stage} assistance and a late answer cannot restart the worker`, async () => {
    const lateReply = deferred();
    const group = assistanceFixture({ delegate: () => needsHelp(),
      coordinate: (context) => stage === 'coordinate' ? lateReply.promise : success('请求同伴', {
        status: 'needs_help', consult: { memberId: context.helper.id, question } }),
      consult: () => lateReply.promise });
    const { f } = group;
    try {
      const task = group.create();
      const active = await until(() => callsAt(group, stage)[0]);
      const help = assistanceFor(group, task)[0];
      const count = f.service.store.list('runs').length;
      f.service[action](task.id);
      assert.equal(active.signal.aborted, true);
      assert.throws(() => f.service.startTask(task.id), { status: 409 });
      assert.throws(() => f.service.answerTaskAssistance(task.id, help.id, { answer }), { status: 409 });
      lateReply.resolve(success('LATE_UNTRUSTED_ANSWER'));
      await until(() => f.service.active.size === 0);
      assert.equal(f.service.require('tasks', task.id).status, action === 'cancelTask' ? 'cancelled' : 'blocked');
      assert.equal(f.service.store.list('runs').length, count);
      assert.equal(callsAt(group, 'delegate').length, 1);
      assert.notEqual(assistanceFor(group, task)[0].status, 'answered');
      assert.equal(f.service.require('tasks', task.id).repairCount, 0);
      assert.equal(group.gates(), 0);
    } finally { lateReply.resolve(success('LATE_UNTRUSTED_ANSWER')); await f.close(); }
  });
}

for (const kind of ['unselected peer', 'second consultation']) {
  test(`${kind} blocks the help request without unauthorized work or automatic repair`, async () => {
    const group = assistanceFixture({ delegate: () => needsHelp(), coordinate: (context) => success('需要咨询', {
      status: 'needs_help', consult: { memberId: kind === 'unselected peer' ? context.outsider.id : context.helper.id, question },
    }) });
    const { f } = group;
    try {
      const task = group.create();
      await until(() => f.service.require('tasks', task.id).status === 'blocked' && f.service.active.size === 0);
      assert.equal(callsAt(group, 'consult').length, kind === 'unselected peer' ? 0 : 1);
      assert.equal(callsAt(group, 'coordinate').length, kind === 'unselected peer' ? 1 : 2);
      assert.ok(group.calls.every((item) => item.member.id !== group.outsider.id));
      assert.equal(callsAt(group, 'delegate').length, 1);
      assert.equal(assistanceFor(group, task)[0].status, 'blocked');
      assert.equal(f.service.require('tasks', task.id).repairCount, 0);
      assert.equal(group.gates(), 0);
    } finally { await f.close(); }
  });
}

test('human help answers require the drained current task and save without automatically starting work', async () => {
  const group = assistanceFixture({ delegate: (context) => {
    if (context.attempt === 1) return needsHelp();
    assert.match(context.prompt, /HUMAN_CONFIRMED_FIELD/);
    return finishStep(context);
  }, coordinate: () => success('缺少用户确认，暂时无法答复', { status: 'blocked' }) });
  const { f } = group;
  try {
    const task = group.create();
    await until(() => f.service.require('tasks', task.id).status === 'blocked' && f.service.active.size === 0);
    const help = assistanceFor(group, task)[0];
    const other = group.create({ title: '另一个任务', start: false });
    assert.equal(help.status, 'blocked');
    assert.throws(() => f.service.answerTaskAssistance(other.id, help.id, { answer }));
    assert.throws(() => f.service.answerTaskAssistance(task.id, help.id, { answer: '   ' }));
    f.service.store.update('assistance', help.id, { planId: 'obsolete-plan' });
    assert.throws(() => f.service.answerTaskAssistance(task.id, help.id, { answer }));
    f.service.store.put('assistance', help);
    const count = f.service.store.list('runs').length;
    f.service.answerTaskAssistance(task.id, help.id, { answer: 'HUMAN_CONFIRMED_FIELD' });
    await new Promise((resolve) => setImmediate(resolve));
    const saved = assistanceFor(group, task)[0];
    assert.equal(saved.status, 'answered');
    assert.equal(saved.answer, 'HUMAN_CONFIRMED_FIELD');
    assert.equal(f.service.require('tasks', task.id).status, 'blocked');
    assert.equal(f.service.store.list('runs').length, count);
    assert.equal(f.service.active.size, 0);
    assert.equal(group.gates(), 0);
    assert.throws(() => f.service.answerTaskAssistance(task.id, help.id, { answer: 'DUPLICATE_REPLACEMENT' }));
    assert.equal(assistanceFor(group, task)[0].answer, 'HUMAN_CONFIRMED_FIELD');
    f.service.startTask(task.id);
    await until(() => f.service.require('tasks', task.id).status === 'review' && f.service.active.size === 0);
    assert.equal(callsAt(group, 'plan').length, 1);
    assert.equal(callsAt(group, 'delegate').length, 2);
    assert.equal(callsAt(group, 'coordinate').length, 1);
    assert.equal(group.gates(), 1);
  } finally { await f.close(); }
});

for (const scope of ['step', 'task']) {
  test(`${scope} help budget bounds repeated questions without claiming acceptance`, async () => {
    const group = assistanceFixture({ stepCount: scope === 'task' ? 4 : 1,
      delegate: (context) => scope === 'step' || context.attempt <= 2 ? needsHelp() : finishStep(context) });
    const { f } = group;
    try {
      const task = group.create();
      await until(() => f.service.require('tasks', task.id).status === 'blocked' && f.service.active.size === 0);
      assert.equal(callsAt(group, 'coordinate').length, scope === 'step' ? 2 : 6);
      assert.equal(assistanceFor(group, task).filter((item) => item.status === 'answered').length, scope === 'step' ? 2 : 6);
      assert.equal(callsAt(group, 'delegate').length, scope === 'step' ? 3 : 10);
      assert.equal(f.service.require('tasks', task.id).repairCount, 0);
      assert.equal(group.gates(), 0);
      assert.notEqual(f.service.require('tasks', task.id).gate.status, 'passed');
    } finally { await f.close(); }
  });
}
