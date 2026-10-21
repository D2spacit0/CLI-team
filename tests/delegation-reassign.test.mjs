import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, success, until, writeDeliverable } from './helpers.mjs';

const passingGate = async () => ({ passed: true, exitCode: 0, testCount: 1, skipped: 0 });
const assignment = (prompt) => prompt.split(/Current assignment:\r?\n/)[1] || '';
const plan = (worker) => success('安排协作者执行', { delegation: { steps: [{ key: 'module', title: '完成模块',
  objective: '保留输入并完成 result.mjs', memberId: worker.id, dependsOn: [] }] } });
const addMember = (f, handle, permission = 'edit') => f.service.saveMember({ name: handle, handle, provider: 'custom',
  executable: process.execPath, role: permission === 'edit' ? 'builder' : 'reviewer', permission, enabled: true });
function members(f) {
  return { worker: addMember(f, 'old-worker'), owner: addMember(f, 'new-owner'),
    replacement: addMember(f, 'new-worker'), reviewer: addMember(f, 'new-reviewer', 'plan') };
}
const create = (f, group, extra = {}) => f.service.createTask({ title: '协作改派恢复', objective: '保留上一轮产物并继续协作',
  executionMode: 'delegated', assigneeId: f.builder.id, participantIds: [group.worker.id], reviewerId: f.reviewer.id,
  verification: { executable: process.execPath, args: ['--test'] }, start: true, ...extra });
const update = (group, extra = {}) => ({ assigneeId: group.owner.id, participantIds: [group.replacement.id],
  reviewerId: group.reviewer.id, note: 'REASSIGN_KEEP_PRIOR_OUTPUT', ...extra });

test('reassigning a drained blocked collaboration preserves files, locked inputs, budget and full prior handover', async () => {
  let group, newPlan;
  const calls = [];
  const oldSummary = `${'上轮研究证据。'.repeat(1000)}OLD_WORKER_FULL_SUMMARY_TAIL`;
  const oldFinding = `${'保留此边界条件。'.repeat(230)}OLD_WORKER_FINDING_TAIL`;
  const f = fixture({ verifier: passingGate, agentExecutor: async (member, prompt, { workspace, conversationId }) => {
    const current = assignment(prompt);
    calls.push({ memberId: member.id, current, workspace, conversationId });
    if (current.startsWith('Delegation planning')) {
      if (member.id === group.owner.id) {
        newPlan = prompt;
        return plan(group.replacement);
      }
      return plan(group.worker);
    }
    if (current.startsWith('Delegated step')) {
      writeDeliverable(workspace, 'export const partial = 21;\n');
      return member.id === group.worker.id
        ? success(oldSummary, { findings: [{ severity: 'minor', text: oldFinding }] }) : success('新协作者确认并继续实现');
    }
    if (current.startsWith('Integrate the delegated results')) {
      if (member.id === f.builder.id) return { success: false, report: null, response: '', error: '原负责人暂时无法完成集成',
        riskFlags: ['process_error'], exitCode: 1 };
      writeDeliverable(workspace, 'export const integrated = 42;\n');
      return success('新负责人完成集成');
    }
    return success('新独立评审通过', { verdict: 'approve' });
  } });
  try {
    group = members(f);
    f.service.updateSettings({ repairLimit: 1 });
    const task = create(f, group, { start: false });
    const input = Buffer.from('必须完整保留的输入');
    const material = f.service.importMaterial(task.id, { name: 'requirements.txt', contentBase64: input.toString('base64'),
      sha256: createHash('sha256').update(input).digest('hex') });
    f.service.startTask(task.id);
    await until(() => f.service.require('tasks', task.id).status === 'blocked' && f.service.active.size === 0);
    const before = f.service.require('tasks', task.id);
    const priorBytes = fs.readFileSync(path.join(task.workspace, 'result.mjs'));
    const priorRuns = f.service.store.list('runs').length;
    const priorCalls = calls.length;
    assert.equal(before.repairCount, 1);
    const changed = f.service.reassignTask(task.id, update(group));
    assert.equal(changed.status, 'blocked');
    assert.equal(changed.assigneeId, group.owner.id);
    assert.equal(changed.reviewerId, group.reviewer.id);
    assert.deepEqual(changed.participantIds, [group.replacement.id]);
    assert.equal(changed.repairCount, before.repairCount);
    assert.equal(changed.startedAt, before.startedAt);
    assert.equal(changed.workspace, before.workspace);
    assert.equal(changed.gate.status, 'pending');
    assert.equal(changed.reviewVerdict, null);
    assert.equal(f.service.store.list('runs').length, priorRuns);
    assert.equal(calls.length, priorCalls);
    assert.deepEqual(fs.readFileSync(path.join(task.workspace, 'result.mjs')), priorBytes);
    assert.deepEqual(fs.readFileSync(path.join(task.workspace, material.relativePath)), input);
    assert.equal(f.service.taskMaterials(task.id).locked, true);
    assert.throws(() => f.service.removeMaterial(task.id, material.id));
    f.service.startTask(task.id, 'EXPLICIT_RECOVERY_REQUIREMENT');
    await until(() => f.service.require('tasks', task.id).status === 'review' && f.service.active.size === 0);
    assert.equal(calls[priorCalls].memberId, group.owner.id);
    assert.match(calls[priorCalls].current, /^Delegation planning/);
    assert.equal(calls[priorCalls].conversationId, null);
    assert.match(newPlan, /REASSIGN_KEEP_PRIOR_OUTPUT/);
    assert.match(newPlan, /EXPLICIT_RECOVERY_REQUIREMENT/);
    assert.match(newPlan, /OLD_WORKER_FULL_SUMMARY_TAIL/);
    assert.match(newPlan, /OLD_WORKER_FINDING_TAIL/);
    assert.ok(calls.slice(priorCalls).every((call) => call.workspace === task.workspace && call.memberId !== group.worker.id));
    const current = f.service.require('tasks', task.id);
    assert.equal(current.repairCount, 1);
    assert.equal(Boolean(current.pendingFeedback), false);
    assert.equal(current.gate.status, 'passed');
    assert.equal(current.reviewVerdict, 'approve');
    assert.deepEqual(fs.readFileSync(path.join(task.workspace, material.relativePath)), input);
    assert.equal(f.service.acceptTask(task.id, { note: '新团队完成后验收' }).status, 'done');
  } finally { await f.close(); }
});

test('historical writers cannot become independent reviewers even after permission changes or on legacy runs', async () => {
  let group;
  const f = fixture({ agentExecutor: async (_member, prompt, { workspace }) => {
    if (assignment(prompt).startsWith('Delegation planning')) return plan(group.worker);
    writeDeliverable(workspace);
    return { ...success('已有贡献，后续需恢复'), success: false, riskFlags: ['permission_denied'] };
  } });
  try {
    group = members(f);
    const task = create(f, group);
    await until(() => f.service.require('tasks', task.id).status === 'blocked' && f.service.active.size === 0);
    const run = f.service.store.list('runs').find((item) => item.taskId === task.id && item.stage === 'delegate');
    assert.equal(run.effectivePermission, 'edit');
    f.service.saveMember({ permission: 'plan' }, group.worker.id);
    const before = structuredClone(f.service.require('tasks', task.id));
    assert.throws(() => f.service.reassignTask(task.id, update(group, { reviewerId: group.worker.id })));
    assert.deepEqual(f.service.require('tasks', task.id), before);
    const { effectivePermission: _permission, ...legacyRun } = run;
    f.service.store.put('runs', legacyRun);
    assert.throws(() => f.service.reassignTask(task.id, update(group, { reviewerId: group.worker.id })));
    assert.deepEqual(f.service.require('tasks', task.id), before);
    f.service.reassignTask(task.id, update(group));
    // Also guard legacy persisted task assignments at start, before any new plan is admitted.
    f.service.store.update('tasks', task.id, { reviewerId: group.worker.id });
    const runCount = f.service.store.list('runs').length;
    assert.throws(() => f.service.startTask(task.id));
    assert.equal(f.service.store.list('runs').length, runCount);
    assert.equal(f.service.require('tasks', task.id).status, 'blocked');
  } finally { await f.close(); }
});

test('invalid replacement pools leave assignment, notices, artifacts and messages unchanged', async () => {
  const f = fixture({ agentExecutor: async () => success('计划无法完成', { status: 'blocked' }) });
  try {
    const group = members(f);
    const disabled = addMember(f, 'disabled-worker');
    f.service.saveMember({ enabled: false }, disabled.id);
    const task = create(f, group);
    await until(() => f.service.require('tasks', task.id).status === 'blocked' && f.service.active.size === 0);
    const taskBefore = structuredClone(f.service.require('tasks', task.id));
    const messagesBefore = f.service.store.list('messages');
    const artifactsBefore = f.service.store.list('artifacts');
    const noticesBefore = f.service.store.list('notices');
    for (const participantIds of [[], [group.replacement.id, group.replacement.id], [group.owner.id],
      [group.reviewer.id], ['missing-worker'], [disabled.id], Array(5).fill(group.replacement.id)]) {
      assert.throws(() => f.service.reassignTask(task.id, update(group, { participantIds })));
      assert.deepEqual(f.service.require('tasks', task.id), taskBefore);
      assert.deepEqual(f.service.store.list('messages'), messagesBefore);
      assert.deepEqual(f.service.store.list('artifacts'), artifactsBefore);
      assert.deepEqual(f.service.store.list('notices'), noticesBefore);
    }
    const omittedPool = update(group);
    delete omittedPool.participantIds;
    const changed = f.service.reassignTask(task.id, omittedPool);
    assert.deepEqual(changed.participantIds, [group.worker.id]);
  } finally { await f.close(); }
});

test('reassignment waits for a cancelled owner process to actually stop and rejects running tasks', async () => {
  let release, signal;
  const f = fixture({ agentExecutor: async (_member, _prompt, options) => {
    signal = options.signal;
    return new Promise((resolve) => { release = () => resolve(success('晚到完成回执')); });
  } });
  try {
    const group = members(f);
    const task = create(f, group);
    await until(() => signal);
    assert.throws(() => f.service.reassignTask(task.id, update(group)), { status: 409 });
    const run = f.service.store.list('runs').find((item) => item.taskId === task.id);
    f.service.cancelRun(run.id);
    assert.equal(signal.aborted, true);
    assert.equal(f.service.require('tasks', task.id).status, 'blocked');
    assert.equal(f.service.active.size, 1);
    assert.throws(() => f.service.reassignTask(task.id, update(group)), { status: 409 });
    release();
    await until(() => f.service.active.size === 0);
    const changed = f.service.reassignTask(task.id, update(group));
    assert.equal(changed.assigneeId, group.owner.id);
    assert.equal(f.service.store.list('runs').length, 1);
  } finally { release?.(); await f.close(); }
});

test('review and cancelled tasks reject reassignment without restarting collaboration', async () => {
  let group;
  const f = fixture({ verifier: passingGate, agentExecutor: async (_member, prompt, { workspace }) => {
    const current = assignment(prompt);
    if (current.startsWith('Delegation planning')) return plan(group.worker);
    if (current.startsWith('Delegated step') || current.startsWith('Integrate the delegated results')) writeDeliverable(workspace);
    return success('完成', { verdict: current.startsWith('Independently review') ? 'approve' : 'none' });
  } });
  try {
    group = members(f);
    const task = create(f, group);
    await until(() => f.service.require('tasks', task.id).status === 'review' && f.service.active.size === 0);
    const runCount = f.service.store.list('runs').length;
    assert.throws(() => f.service.reassignTask(task.id, update(group)), { status: 409 });
    f.service.cancelTask(task.id);
    assert.throws(() => f.service.reassignTask(task.id, update(group)), { status: 409 });
    assert.equal(f.service.store.list('runs').length, runCount);
    assert.equal(f.service.require('tasks', task.id).status, 'cancelled');
  } finally { await f.close(); }
});
