import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, success, until } from './helpers.mjs';
import { compact } from '../tools/client.mjs';

function diagnosticFixture({ missing = false } = {}) {
  let f;
  f = fixture({ agentExecutor: async (_member, _prompt, { workspace, logFile }) => {
    const run = f.service.store.list('runs').find((item) => item.nativeLog === logFile);
    if (run.stage === 'plan') return success('拆分文件交付', { delegation: { steps: ['a', 'b'].map((key, index) => ({
      key, title: key, objective: `交付 ${key}.json`, memberId: f.worker.id, dependsOn: index ? ['a'] : [],
      output: { type: 'files', files: [{ path: `${key}.json`, format: 'json' }] },
    })) } });
    if (run.stepKey === 'b') return success('缺少继续所需的数据', { status: 'blocked' });
    if (!missing) fs.writeFileSync(path.join(workspace, 'a.json'), '{"value":42}');
    return success('成员声称文件已完成');
  } });
  f.worker = f.service.saveMember({ name: '诊断协作者', handle: 'diagnostic-worker', provider: 'custom',
    executable: process.execPath, enabled: true, permission: 'edit' });
  f.create = () => f.service.createTask({ title: '交付诊断', objective: '依次交付两个 JSON 文件',
    assigneeId: f.builder.id, participantIds: [f.worker.id], executionMode: 'delegated', start: true });
  return f;
}

test('CLI completion with missing delivery remains a claim and is exposed as a machine check problem', async () => {
  const f = diagnosticFixture({ missing: true });
  try {
    const task = f.create();
    await until(() => f.service.require('tasks', task.id).status === 'blocked' && !f.service.active.size);
    const run = f.service.store.list('runs').find((item) => item.stage === 'delegate');
    assert.equal(run.status, 'succeeded');
    assert.equal(run.report.summary, '成员声称文件已完成');
    assert.equal(run.outputCheck.status, 'failed');
    const progress = f.service.taskProgress(task.id);
    const shown = progress.runs.find((item) => item.id === run.id);
    assert.equal(shown.status, 'blocked');
    assert.equal(shown.executionStatus, 'succeeded');
    assert.equal(shown.exitCode, 0);
    assert.match(shown.summary, /交付结构检查未通过/);
    assert.ok(compact(progress).recentProblems.some((item) => item.id === run.id));
    assert.equal(progress.coordination.steps[1].status, 'pending');
    assert.throws(() => f.service.acceptTask(task.id, { note: '不能用进程结果代替交付检查' }));
  } finally { await f.close(); }
});

test('progress distinguishes a historical passing receipt from a checkpoint invalidated by a removed file', async () => {
  const f = diagnosticFixture();
  try {
    const task = f.create();
    await until(() => f.service.require('tasks', task.id).status === 'blocked' && !f.service.active.size);
    const initial = f.service.taskProgress(task.id);
    assert.equal(initial.coordination.steps[0].checkpointValid, true);
    assert.equal(initial.resume.reusableSteps, 1);
    fs.unlinkSync(path.join(task.workspace, 'a.json'));
    const progress = f.service.taskProgress(task.id);
    const step = progress.coordination.steps[0];
    assert.equal(step.outputCheck.status, 'passed');
    assert.equal(step.outputCheck.checkedAt, initial.coordination.steps[0].outputCheck.checkedAt);
    assert.equal(step.checkpointValid, false);
    assert.match(step.checkpointReason, /不能保留/);
    assert.equal(progress.resume.reusableSteps, 0);
    assert.equal(compact(progress).coordination.steps[0].checkpointValid, false);
  } finally { await f.close(); }
});

test('recovery commits interrupted runs, task and help together and repairs a previously partial interruption', async () => {
  const f = fixture();
  try {
    f.service.updateSettings({ paused: true });
    const task = f.service.createTask({ title: '中断恢复事务', objective: '求助须随任务一致恢复', assigneeId: f.builder.id });
    f.service.store.update('tasks', task.id, { status: 'running', coordination: { phase: 'assisting', planId: 'plan-recover',
      steps: [{ key: 'a', memberId: f.builder.id, status: 'waiting', dependsOn: [], helpId: 'help-recover' }] } });
    const run = f.service.enqueue({ roomId: task.roomId, taskId: task.id, memberId: f.builder.id,
      stage: 'coordinate', stepKey: 'a', helpId: 'help-recover', prompt: '恢复测试' });
    f.service.store.put('assistance', { id: 'help-recover', taskId: task.id, status: 'pending', coordinatorRunId: run.id });
    const update = f.service.store.update.bind(f.service.store);
    f.service.store.update = (kind, id, patch) => {
      if (kind === 'assistance') throw new Error('RECOVERY_WRITE_FAILURE');
      return update(kind, id, patch);
    };
    try { assert.throws(() => f.service.recover(), /RECOVERY_WRITE_FAILURE/); }
    finally { f.service.store.update = update; }
    assert.equal(f.service.require('runs', run.id).status, 'queued');
    assert.equal(f.service.require('tasks', task.id).status, 'running');
    assert.equal(f.service.require('assistance', 'help-recover').status, 'pending');
    // A persisted blocked task from an earlier partial recovery must also recover its help.
    f.service.store.update('tasks', task.id, { status: 'blocked' });
    f.service.recover();
    assert.equal(f.service.require('runs', run.id).status, 'interrupted');
    assert.equal(f.service.require('assistance', 'help-recover').status, 'blocked');
    assert.equal(f.service.require('assistance', 'help-recover').interrupted, true);
    assert.equal(f.service.active.size, 0);
  } finally { await f.close(); }
});
