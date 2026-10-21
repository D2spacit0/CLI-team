import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, success, until } from './helpers.mjs';

const transientFailure = () => ({ success: false, report: null, response: '', riskFlags: ['process_error'],
  error: 'TEMPORARY_WORKER_UNAVAILABLE', exitCode: 1 });
const defaultSteps = [{ key: 'a', dependsOn: [] }, { key: 'b', dependsOn: ['a'] }];

function recoveryFixture({ steps = defaultSteps, failStep = 'b', failAttempts = 1, repairLimit = 0,
  legacy = false, failure = transientFailure } = {}) {
  let f, worker;
  const calls = [], attempts = new Map();
  f = fixture({ verifier: async () => ({ passed: true, exitCode: 0, testCount: 1, skipped: 0 }),
    agentExecutor: async (member, prompt, options) => {
      const run = f.service.store.list('runs').find((item) => item.nativeLog === options.logFile);
      assert.ok(run, 'Every CLI invocation must have a persisted run');
      calls.push({ run, member, prompt, ...options });
      if (run.stage === 'plan') {
        const task = f.service.require('tasks', run.taskId);
        return success('负责人已拆分有依赖的产物', { delegation: { steps: steps.map((step) => ({
          ...step, title: `生成 ${step.key}`, objective: `交付有效的 ${step.key}.json`, memberId: task.participantIds[0],
          ...(legacy ? {} : { output: { type: 'files', files: [{ path: `${step.key}.json`, format: 'json' }] } }),
        })) } });
      }
      if (run.stage === 'delegate') {
        const attempt = (attempts.get(run.stepKey) || 0) + 1;
        attempts.set(run.stepKey, attempt);
        if (run.stepKey === failStep && attempt <= failAttempts) return failure({ run, member, prompt, ...options });
        const step = steps.find((item) => item.key === run.stepKey);
        const dependencies = Object.fromEntries(step.dependsOn.map((key) => [key,
          JSON.parse(fs.readFileSync(path.join(options.workspace, `${key}.json`), 'utf8')).generation]));
        fs.writeFileSync(path.join(options.workspace, `${run.stepKey}.json`), JSON.stringify({ generation: attempt, dependencies }));
        return success(`OUTPUT_${run.stepKey}_GENERATION_${attempt}`);
      }
      if (run.stage === 'implement') return success('负责人已确认实际文件并完成汇总');
      if (run.stage === 'review') return success('独立评审通过', { verdict: 'approve' });
      throw new Error(`Unexpected stage: ${run.stage}`);
    } });
  worker = f.service.saveMember({ name: '可恢复协作者', handle: 'resume-worker', provider: 'custom',
    executable: process.execPath, role: 'builder', permission: 'edit', enabled: true });
  f.service.updateSettings({ repairLimit });
  return { f, worker, calls, attempts,
    create: () => f.service.createTask({ title: '协作断点恢复', objective: '根据已验收步骤继续执行',
      executionMode: 'delegated', assigneeId: f.builder.id, participantIds: [worker.id],
      reviewerId: f.reviewer.id, verification: { executable: process.execPath, args: ['--test'] }, start: true }) };
}

const callsAt = (group, stage) => group.calls.filter((item) => item.run.stage === stage);
const stepOf = (group, task, key) => group.f.service.require('tasks', task.id).coordination.steps.find((step) => step.key === key);
const stopped = (group, task) => until(() => group.f.service.require('tasks', task.id).status === 'blocked' && group.f.service.active.size === 0);
const reviewed = (group, task) => until(() => group.f.service.require('tasks', task.id).status === 'review' && group.f.service.active.size === 0);

test('A passed and B failed resumes B without replanning or repeating verified A', async () => {
  const group = recoveryFixture();
  const { f } = group;
  try {
    const task = group.create();
    await stopped(group, task);
    const firstA = structuredClone(stepOf(group, task, 'a'));
    const firstBytes = fs.readFileSync(path.join(task.workspace, 'a.json'));
    assert.equal(firstA.outputCheck.status, 'passed');
    assert.equal(firstA.outputCheck.files[0].sha256, createHash('sha256').update(firstBytes).digest('hex'));
    const progress = f.service.taskProgress(task.id);
    assert.equal(progress.resume.available, true);
    assert.equal(progress.resume.reusableSteps, 1);
    assert.equal(progress.resume.totalSteps, 2);
    assert.equal(typeof progress.resume.reason, 'string');
    f.service.startTask(task.id);
    await reviewed(group, task);
    assert.equal(callsAt(group, 'plan').length, 1);
    assert.equal(group.attempts.get('a'), 1);
    assert.equal(group.attempts.get('b'), 2);
    assert.equal(stepOf(group, task, 'a').runId, firstA.runId);
    assert.deepEqual(fs.readFileSync(path.join(task.workspace, 'a.json')), firstBytes);
    assert.equal(f.service.require('tasks', task.id).repairCount, 0);
    assert.equal(f.service.require('tasks', task.id).gate.status, 'passed');
    assert.equal(f.service.require('tasks', task.id).reviewVerdict, 'approve');
  } finally { await f.close(); }
});

test('changed A invalidates its completed dependent B while an independent verified step remains reusable', async () => {
  const group = recoveryFixture({ failStep: 'final', steps: [
    { key: 'a', dependsOn: [] }, { key: 'b', dependsOn: ['a'] },
    { key: 'independent', dependsOn: [] }, { key: 'final', dependsOn: ['b', 'independent'] },
  ] });
  const { f } = group;
  try {
    const task = group.create();
    await stopped(group, task);
    const originalRuns = Object.fromEntries(['a', 'b', 'independent'].map((key) => [key, stepOf(group, task, key).runId]));
    fs.writeFileSync(path.join(task.workspace, 'a.json'), JSON.stringify({ generation: 999, dependencies: {} }));
    const resume = f.service.taskProgress(task.id).resume;
    assert.equal(resume.available, true);
    assert.equal(resume.reusableSteps, 1);
    assert.equal(resume.totalSteps, 4);
    f.service.startTask(task.id);
    await reviewed(group, task);
    assert.equal(callsAt(group, 'plan').length, 1);
    assert.equal(group.attempts.get('a'), 2);
    assert.equal(group.attempts.get('b'), 2);
    assert.equal(group.attempts.get('independent'), 1);
    assert.equal(group.attempts.get('final'), 2);
    assert.notEqual(stepOf(group, task, 'a').runId, originalRuns.a);
    assert.notEqual(stepOf(group, task, 'b').runId, originalRuns.b);
    assert.equal(stepOf(group, task, 'independent').runId, originalRuns.independent);
    assert.equal(JSON.parse(fs.readFileSync(path.join(task.workspace, 'b.json'), 'utf8')).dependencies.a, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(task.workspace, 'final.json'), 'utf8')).dependencies.b, 2);
  } finally { await f.close(); }
});

for (const persistent of [false, true]) {
  test(`contract worker retries only its failed step within the shared repair budget (${persistent ? 'exhausted' : 'recovered'})`, async () => {
    const group = recoveryFixture({ repairLimit: 2, failAttempts: persistent ? Infinity : 1 });
    const { f } = group;
    try {
      const task = group.create();
      await (persistent ? stopped(group, task) : reviewed(group, task));
      assert.equal(callsAt(group, 'plan').length, 1);
      assert.equal(group.attempts.get('a'), 1);
      assert.equal(group.attempts.get('b'), persistent ? 3 : 2);
      assert.equal(f.service.require('tasks', task.id).repairCount, persistent ? 2 : 1);
      assert.equal(stepOf(group, task, 'a').runId, callsAt(group, 'delegate')[0].run.id);
      if (persistent) {
        assert.equal(f.service.taskProgress(task.id).resume.reusableSteps, 1);
        assert.equal(callsAt(group, 'implement').length, 0);
        assert.notEqual(f.service.require('tasks', task.id).gate.status, 'passed');
      } else {
        assert.equal(f.service.require('tasks', task.id).gate.status, 'passed');
        assert.equal(f.service.require('tasks', task.id).reviewVerdict, 'approve');
      }
    } finally { await f.close(); }
  });
}

test('legacy steps without output contracts remain usable but cannot reuse a previous completion claim', async () => {
  const group = recoveryFixture({ legacy: true });
  const { f } = group;
  try {
    const task = group.create();
    await stopped(group, task);
    const firstA = stepOf(group, task, 'a').runId;
    assert.equal(stepOf(group, task, 'a').outputCheck.status, 'not_configured');
    assert.equal(f.service.taskProgress(task.id).resume.reusableSteps, 0);
    f.service.startTask(task.id);
    await reviewed(group, task);
    assert.equal(group.attempts.get('a'), 2);
    assert.equal(group.attempts.get('b'), 2);
    assert.notEqual(stepOf(group, task, 'a').runId, firstA);
    assert.equal(f.service.require('tasks', task.id).gate.status, 'passed');
  } finally { await f.close(); }
});

test('explicit feedback replans and reruns contracted steps instead of silently applying old checkpoints', async () => {
  const group = recoveryFixture();
  const { f } = group;
  try {
    const task = group.create();
    await stopped(group, task);
    const firstA = stepOf(group, task, 'a').runId;
    f.service.startTask(task.id, 'REPLAN_FOR_CHANGED_INTERFACE');
    await reviewed(group, task);
    assert.equal(callsAt(group, 'plan').length, 2);
    assert.match(callsAt(group, 'plan')[1].prompt, /REPLAN_FOR_CHANGED_INTERFACE/);
    assert.equal(group.attempts.get('a'), 2);
    assert.equal(group.attempts.get('b'), 2);
    assert.notEqual(stepOf(group, task, 'a').runId, firstA);
  } finally { await f.close(); }
});

for (const cause of ['invalid JSON output', 'permission failure']) {
  test(`${cause} cannot advance dependent work or use automatic execution retries`, async () => {
    const group = recoveryFixture({ failStep: 'a', failAttempts: Infinity, repairLimit: 3,
      failure: ({ workspace }) => {
        if (cause === 'permission failure') return { ...transientFailure(), riskFlags: ['process_error', 'permission_denied'] };
        fs.writeFileSync(path.join(workspace, 'a.json'), '{invalid-json');
        return success('声称已经交付完整 JSON');
      } });
    const { f } = group;
    try {
      const task = group.create();
      await stopped(group, task);
      assert.equal(callsAt(group, 'plan').length, 1);
      assert.equal(group.attempts.get('a'), 1);
      assert.equal(group.attempts.has('b'), false);
      if (cause === 'invalid JSON output') assert.equal(stepOf(group, task, 'a').outputCheck.status, 'failed');
      assert.equal(f.service.require('tasks', task.id).repairCount, 0);
      assert.equal(callsAt(group, 'implement').length, 0);
      assert.notEqual(f.service.require('tasks', task.id).gate.status, 'passed');
      assert.throws(() => f.service.acceptTask(task.id, { note: '退出成功不能替代产物检查' }));
    } finally { await f.close(); }
  });
}
