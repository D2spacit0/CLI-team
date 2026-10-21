import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, success, until, writeDeliverable } from './helpers.mjs';

test('reassignment preserves partial output, history and session isolation without replay', async () => {
  const calls = [];
  const f = fixture({ agentExecutor: async (member, _prompt, options) => {
    calls.push({ memberId: member.id, workspace: options.workspace, conversationId: options.conversationId });
    writeDeliverable(options.workspace, 'partial draft');
    return { ...success(), success: false, error: 'timeout' };
  } });
  try {
    const independentReviewer = f.service.saveMember({ name: '独立评审者', handle: 'independent-reviewer', provider: 'custom',
      role: 'reviewer', executable: process.execPath, permission: 'plan', enabled: true });
    const task = f.service.createTask({ title: 'Research', objective: 'Continue', assigneeId: f.builder.id, start: true });
    await until(() => f.service.require('tasks', task.id).status === 'blocked' && f.service.active.size === 0);
    const before = fs.readFileSync(path.join(task.workspace, 'result.mjs'));
    f.service.store.update('tasks', task.id, { repairCount: 1 });
    const updated = f.service.reassignTask(task.id, { assigneeId: f.reviewer.id, reviewerId: independentReviewer.id, note: 'Continue with another member' }, 'controller');
    assert.equal(updated.status, 'blocked');
    assert.equal(updated.repairCount, 1);
    assert.equal(updated.gate.status, 'not_configured');
    assert.equal(calls.length, 1);
    assert.equal(f.service.store.list('runs').length, 1);
    assert.equal(f.service.bootstrap().artifacts.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(task.workspace, 'result.mjs')), before);
    assert.equal(f.service.taskMaterials(task.id).locked, true);
    f.service.startTask(task.id, 'Fix and finish the draft');
    await until(() => calls.length === 2 && f.service.active.size === 0);
    assert.equal(calls[1].workspace, task.workspace);
    assert.equal(calls[1].conversationId, null);
    assert.equal(calls[1].memberId, f.reviewer.id);
  } finally { await f.close(); }
});

test('reassignment rejects active, archived and self-reviewed tasks', async () => {
  const f = fixture();
  try {
    f.service.updateSettings({ paused: true });
    const task = f.service.createTask({ title: 'Draft', objective: 'write', assigneeId: f.builder.id });
    const input = { assigneeId: f.builder.id, reviewerId: f.reviewer.id, note: 'switch' };
    assert.throws(() => f.service.reassignTask(task.id, { ...input, reviewerId: f.builder.id }), /不同成员/);
    f.service.setTaskArchived(task.id, true);
    assert.throws(() => f.service.reassignTask(task.id, input), /只能改派/);
    f.service.setTaskArchived(task.id, false);
    f.service.startTask(task.id);
    assert.throws(() => f.service.reassignTask(task.id, input), /只能改派/);
  } finally { await f.close(); }
});
