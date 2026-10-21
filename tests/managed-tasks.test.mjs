import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, success, until, cleanup } from './helpers.mjs';
import { TeamService } from '../server/service.mjs';

const assignment = (prompt) => prompt.split('Current assignment:\n')[1]?.split('\nReturn ONLY')[0] || '';
const passing = async () => ({ passed: true, exitCode: 0, testCount: 2, skipped: 0 });
const configure = (f, extra = {}) => {
  const worker = f.service.saveMember({ name: '协作开发', handle: 'managed-worker', provider: 'custom',
    executable: process.execPath, enabled: true, permission: 'edit' });
  f.service.updateSettings({ managedTeam: { ownerId: f.builder.id, workerIds: [worker.id],
    reviewerId: f.reviewer.id, verification: { executable: process.execPath, args: ['--test'] }, autoDeliver: true, ...extra } });
  return worker;
};
const fileStep = (worker, key, dependsOn = []) => ({ key, memberId: worker.id, title: key, objective: `完成 ${key}`,
  dependsOn, output: { type: 'files', files: [{ path: `${key}.txt`, format: 'text' }] } });
const submit = (f, extra = {}) => f.service.managedTasks.submit({ requestId: randomUUID(), objective: '完成协作模块并提供可核查成果', ...extra });
const terminal = (f, task) => until(() => {
  const current = f.service.require('tasks', task.id);
  return ['blocked', 'review', 'done'].includes(current.status) && f.service.active.size === 0 && current;
}, 12000);

test('one objective runs owner planning, per-step rejection and repair, final evidence and automatic delivery', async () => {
  const calls = [];
  let worker, secondAttempts = 0;
  const f = fixture({ verifier: passing, agentExecutor: async (member, prompt, { workspace }) => {
    const current = assignment(prompt);
    calls.push({ current, member: member.id, permission: member.permission });
    if (current.startsWith('Delegation planning')) return success('分为前置与依赖工作', {
      delegation: { steps: [fileStep(worker, 'base'), fileStep(worker, 'dependent', ['base'])] } });
    if (current.startsWith('Delegated step')) {
      const key = current.startsWith('Delegated step base:') ? 'base' : 'dependent';
      if (key === 'dependent') secondAttempts++;
      fs.writeFileSync(path.join(workspace, `${key}.txt`), key === 'dependent' && secondAttempts === 1 ? 'semantically wrong' : 'correct');
      return success(`成员声称 ${key} 已完成`);
    }
    if (current.startsWith('Review delegated step')) {
      assert.equal(member.id, f.builder.id);
      assert.equal(member.permission, 'plan');
      if (current.startsWith('Review delegated step dependent:') && secondAttempts === 1) return success('需要修正', {
        verdict: 'changes_requested', findings: [{ severity: 'major', text: 'SPECIFIC_DEPENDENT_CORRECTION' }] });
      assert.match(prompt, /"outputCheck":\{"status":"passed"/);
      return success('已核对具体文件与需求', { verdict: 'approve' });
    }
    if (current.startsWith('Integrate the delegated results')) {
      assert.equal(fs.readFileSync(path.join(workspace, 'dependent.txt'), 'utf8'), 'correct');
      return success('已汇总');
    }
    assert.equal(member.permission, 'plan');
    return success(current.startsWith('Final delivery review') ? '交付 base.txt 与 dependent.txt，检查与独立评审通过' : '独立评审通过', { verdict: 'approve' });
  } });
  try {
    worker = configure(f);
    const task = submit(f);
    const result = await terminal(f, task);
    assert.equal(result.status, 'done', result.summary);
    assert.equal(result.acceptedBy, 'controller');
    assert.equal(f.service.store.list('messages').find((message) => message.taskId === task.id &&
      message.kind === 'decision' && message.body.startsWith('验收通过：')).senderName, `主控 · ${f.builder.name}`);
    assert.equal(result.delivery.status, 'delivered');
    assert.equal(result.delivery.artifactRevision, result.artifactRevision);
    assert.equal(result.gate.status, 'passed');
    assert.equal(result.reviewVerdict, 'approve');
    assert.equal(result.repairCount, 1);
    assert.deepEqual(result.coordination.steps.map((step) => step.attempts), [1, 2]);
    assert.ok(result.coordination.steps.every((step) => step.ownerReview.verdict === 'approve' && step.ownerReview.sourceRunId === step.runId));
    const workerCalls = calls.filter((call) => call.current.startsWith('Delegated step'));
    assert.match(workerCalls.at(-1).current, /SPECIFIC_DEPENDENT_CORRECTION/);
    assert.equal(calls.filter((call) => call.current.startsWith('Final delivery review')).length, 1);
    assert.equal(f.service.store.list('runs').filter((run) => run.stage === 'step_review').length, 3);
    assert.equal(f.service.store.list('conversations').filter((item) => item.id.includes(':step_review')).length, 1);
  } finally { await f.close(); }
});

for (const outcome of ['missing gate', 'skipped checks', 'manual delivery']) {
  test(`managed delivery preserves explicit acceptance when ${outcome}`, async () => {
    let worker;
    const f = fixture({ verifier: async () => ({ ...(await passing()), skipped: outcome === 'skipped checks' ? 1 : 0 }),
      agentExecutor: async (_member, prompt, { workspace }) => {
        const current = assignment(prompt);
        if (current.startsWith('Delegation planning')) return success('计划', { delegation: { steps: [fileStep(worker, 'result')] } });
        if (current.startsWith('Delegated step')) fs.writeFileSync(path.join(workspace, 'result.txt'), 'delivered');
        return success('审查完毕', { verdict: 'approve' });
      } });
    try {
      worker = configure(f, { ...(outcome === 'missing gate' ? { verification: null } : {}), autoDeliver: outcome !== 'manual delivery' });
      const result = await terminal(f, submit(f));
      assert.equal(result.status, 'review', result.summary);
      assert.equal(result.delivery.status, 'ready');
      assert.equal(result.acceptedAt, undefined);
      if (outcome !== 'manual delivery') assert.match(result.delivery.limitation, /缺少完整/);
      if (outcome === 'missing gate') {
        assert.throws(() => f.service.acceptTask(result.id, { note: '缺少机器证据' }), /明确确认/);
        const accepted = f.service.acceptTask(result.id, { note: '已人工检查并确认缺少自动证据', acknowledgeMissingGate: true });
        assert.equal(accepted.delivery.status, 'delivered');
      }
    } finally { await f.close(); }
  });
}

test('request retry returns the same task without a second run, even after team settings change', async () => {
  const f = fixture();
  try {
    configure(f);
    f.service.updateSettings({ paused: true });
    const input = { requestId: randomUUID(), objective: '重复提交仍然是同一任务' };
    const first = f.service.managedTasks.submit(input);
    f.service.updateSettings({ managedTeam: null });
    const retry = f.service.managedTasks.submit(input);
    assert.equal(retry.id, first.id);
    assert.equal(f.service.store.list('tasks').length, 1);
    assert.equal(f.service.store.list('runs').length, 1);
    assert.throws(() => f.service.managedTasks.submit({ ...input, objective: '另一个目标' }), /不同目标/);
    assert.throws(() => submit(f), /配置主控/);
  } finally { await f.close(); }
});

test('invalid team and unauthorized fields fail before creating a managed task', async () => {
  const f = fixture();
  try {
    assert.throws(() => submit(f), /配置主控/);
    assert.throws(() => f.service.updateSettings({ managedTeam: { ownerId: f.builder.id, workerIds: [f.builder.id] } }), /不能包含负责人/);
    configure(f);
    assert.throws(() => submit(f, { verification: { executable: 'untrusted-shell', args: [] } }));
    assert.equal(f.service.store.list('tasks').length, 0);
  } finally { await f.close(); }
});

test('owner approval cannot override a missing step output and repair is bounded', async () => {
  let worker;
  const f = fixture({ agentExecutor: async (_member, prompt) => assignment(prompt).startsWith('Delegation planning')
    ? success('计划', { delegation: { steps: [fileStep(worker, 'missing')] } }) : success('声称全部通过', { verdict: 'approve' }) });
  try {
    worker = configure(f);
    f.service.updateSettings({ repairLimit: 1 });
    const result = await terminal(f, submit(f));
    assert.equal(result.status, 'blocked');
    assert.match(result.summary, /返工上限/);
    assert.equal(result.coordination.steps[0].ownerReview.verdict, 'changes_requested');
    assert.equal(result.delivery, null);
    assert.equal(f.service.store.list('runs').filter((run) => run.stage === 'delegate').length, 2);
  } finally { await f.close(); }
});

test('owner step review runs read-only and writes cannot be accepted', async () => {
  let worker;
  const f = fixture({ agentExecutor: async (member, prompt, { workspace }) => {
    const current = assignment(prompt);
    if (current.startsWith('Delegation planning')) return success('计划', { delegation: { steps: [fileStep(worker, 'result')] } });
    if (current.startsWith('Delegated step')) fs.writeFileSync(path.join(workspace, 'result.txt'), 'before');
    if (current.startsWith('Review delegated step')) {
      assert.equal(member.permission, 'plan');
      fs.writeFileSync(path.join(workspace, 'result.txt'), 'illegal-review-edit');
    }
    return success('声称通过', { verdict: 'approve' });
  } });
  try {
    worker = configure(f);
    const result = await terminal(f, submit(f));
    assert.equal(result.status, 'blocked');
    const run = f.service.store.list('runs').find((item) => item.stage === 'step_review');
    assert.ok(run.riskFlags.includes('read_only_workspace_changed'));
    assert.equal(result.coordination.steps[0].checkpoint, null);
    assert.equal(f.service.store.list('runs').filter((item) => item.stage === 'implement').length, 0);
  } finally { await f.close(); }
});

function controlledFlow(onStage = () => {}) {
  let worker;
  const calls = [];
  const f = fixture({ verifier: passing, agentExecutor: async (member, prompt, context) => {
    const run = f.service.store.list('runs').find((item) => item.nativeLog === context.logFile);
    calls.push(run);
    const override = await onStage({ run, member, prompt, ...context, f });
    if (override) return override;
    if (run.stage === 'plan') return success('计划', { delegation: { steps: [fileStep(worker, 'result')] } });
    if (run.stage === 'delegate') fs.writeFileSync(path.join(context.workspace, 'result.txt'), 'checked output');
    return success('已核对结果', { verdict: 'approve' });
  } });
  worker = configure(f);
  return { f, calls };
}

for (const stage of ['step_review', 'final_review']) {
  for (const action of ['pause', 'cancel']) {
    test(`${action} during ${stage} ignores a late approval and pause can resume safely`, async () => {
      let held, release;
      const { f, calls } = controlledFlow(({ run }) => {
        if (run.stage === stage && !held) {
          held = run;
          return new Promise((resolve) => { release = () => resolve(success('迟到的通过结论', { verdict: 'approve' })); });
        }
      });
      try {
        const task = submit(f);
        await until(() => held);
        if (action === 'pause') f.service.pauseTask(task.id);
        else f.service.cancelTask(task.id);
        assert.throws(() => f.service.startTask(task.id), /此状态不能启动|仍在停止中/);
        const count = calls.length;
        release();
        await until(() => f.service.active.size === 0);
        const stopped = f.service.require('tasks', task.id);
        assert.equal(stopped.status, action === 'pause' ? 'blocked' : 'cancelled');
        assert.equal(stopped.acceptedAt, undefined);
        assert.ok(!stopped.delivery);
        assert.equal(calls.length, count, '迟到的主控结论不能启动后继阶段');
        assert.equal(f.service.require('runs', held.id).status, 'cancelled');
        if (action === 'pause') {
          f.service.startTask(task.id);
          const resumed = await terminal(f, task);
          assert.equal(resumed.status, 'done', resumed.summary);
          assert.notEqual(resumed.delivery.runId, held.id);
          assert.equal(calls.filter((run) => run.stage === 'plan').length, stage === 'step_review' ? 1 : 2);
        }
      } finally { release?.(); await f.close(); }
    });
  }
}

test('a file change while final review is queued invalidates the evidence before delivery', async () => {
  const { f } = controlledFlow(({ run, f }) => {
    if (run.stage === 'review') f.service.updateSettings({ paused: true });
  });
  try {
    const task = submit(f);
    await until(() => f.service.require('tasks', task.id).coordination?.phase === 'delivering' && f.service.active.size === 0);
    const before = f.service.require('tasks', task.id);
    assert.equal(before.gate.status, 'passed');
    fs.writeFileSync(path.join(task.workspace, 'result.txt'), 'changed after machine verification');
    f.service.updateSettings({ paused: false });
    const stopped = await terminal(f, task);
    assert.equal(stopped.status, 'blocked');
    assert.equal(stopped.gate.status, 'stale');
    assert.match(stopped.summary, /成果已变化/);
    assert.ok(!stopped.delivery);
    assert.throws(() => f.service.acceptTask(task.id, { note: '不能复用旧证据' }), /尚未进入/);
  } finally { await f.close(); }
});

for (const persistent of [false, true]) {
  test(`final owner rejection carries feedback into bounded repair (${persistent ? 'exhausted' : 'recovered'})`, async () => {
    let reviews = 0;
    const { f, calls } = controlledFlow(({ run, prompt }) => {
      if (run.stage === 'plan' && reviews) assert.match(prompt, /FINAL_DELIVERY_REQUIREMENT/);
      if (run.stage === 'final_review' && (++reviews === 1 || persistent)) {
        return success('终审退回', { verdict: 'changes_requested',
          findings: [{ severity: 'major', text: 'FINAL_DELIVERY_REQUIREMENT' }] });
      }
    });
    try {
      f.service.updateSettings({ repairLimit: 1 });
      const result = await terminal(f, submit(f));
      assert.equal(result.status, persistent ? 'blocked' : 'done', result.summary);
      assert.equal(result.repairCount, 1);
      assert.equal(reviews, 2);
      assert.equal(calls.filter((run) => run.stage === 'plan').length, 2);
      assert.equal(calls.filter((run) => run.stage === 'delegate').length, 2);
      if (persistent) { assert.match(result.summary, /返工上限/); assert.ok(!result.delivery); }
      else assert.equal(result.delivery.status, 'delivered');
    } finally { await f.close(); }
  });
}

test('restart retains request deduplication and requires the actual owner review to reuse a checkpoint', async () => {
  const { f } = controlledFlow(({ run, f }) => {
    if (run.stage === 'step_review') f.service.updateSettings({ paused: true });
  });
  let restarted;
  try {
    const input = { requestId: randomUUID(), objective: '重启后继续同一目标并核对主控审查' };
    const task = f.service.managedTasks.submit(input);
    await until(() => f.service.require('tasks', task.id).coordination?.phase === 'synthesizing' && f.service.active.size === 0);
    const checkpoint = f.service.require('tasks', task.id).coordination.steps[0];
    assert.equal(checkpoint.ownerReview.verdict, 'approve');
    await f.service.close();
    restarted = new TeamService({ root: f.root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }),
      agentExecutor: async () => { throw new Error('重启不应自动重放'); } });
    const recovered = restarted.managedTasks.submit(input);
    assert.equal(recovered.id, task.id);
    assert.equal(recovered.status, 'blocked');
    assert.equal(restarted.active.size, 0);
    assert.equal(restarted.taskProgress(task.id).resume.reusableSteps, 1);
    restarted.store.remove('runs', checkpoint.ownerReview.runId);
    assert.equal(restarted.taskProgress(task.id).resume.reusableSteps, 0, '文件检查通过不能替代缺失的主控审查记录');
    assert.equal(restarted.store.list('tasks').length, 1);
  } finally {
    if (restarted) await restarted.close();
    if (!f.service.closing) await f.service.close();
    cleanup(f.root);
  }
});
