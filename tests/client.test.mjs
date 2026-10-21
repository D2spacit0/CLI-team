import test from 'node:test';
import assert from 'node:assert/strict';
import { compact } from '../tools/client.mjs';

test('controller task receipts retain routing and evidence without echoing the objective or all inputs', () => {
  const result = compact({
    id: 'task-123', title: 'Example', workspace: 'X:/workspace', roomId: 'room-1',
    objective: 'lengthy instructions', status: 'review', gate: { status: 'passed', evidenceId: 'evidence-1' },
    materials: [{ name: 'a' }], summary: 'Delivered', reviewVerdict: 'approve',
  });
  assert.equal(result.id, 'task-123');
  assert.equal(result.workspace, 'X:/workspace');
  assert.equal(result.gate.evidenceId, 'evidence-1');
  assert.equal(result.materialCount, 1);
  assert.equal(result.objective, undefined);
  assert.equal(result.materials, undefined);
});

test('compact material lists prioritize bad inputs and retain count and truncation metadata', () => {
  const materials = Array.from({ length: 64 }, (_, index) => ({
    id: `material-${index}`, name: 'a'.repeat(180), relativePath: `inputs/${index}`,
    size: 10, sha256: 'a'.repeat(64), integrity: index === 63 ? 'changed' : 'verified',
  }));
  const result = compact({ taskId: 'task-1', locked: true, materials }, 1800);
  assert.equal(result.materials[0].id, 'material-63');
  assert.equal(result.count, 64);
  assert.equal(result.verified, 63);
  assert.equal(result.totalBytes, 640);
  assert.ok(result.omitted > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1800);
});

test('compact progress keeps the current help ID and resume decision without leaking complete reports or answers', () => {
  const question = `确认接口字段：${'边界条件。'.repeat(600)}`;
  const progress = {
    taskId: 'task-123', active: false, canPause: false, canReassign: true,
    remainingRepairs: 2, reviewerExcludedIds: ['worker-1'], totalRuns: 9, omittedRuns: 0,
    currentRuns: [], runs: [{ id: 'run-2', memberId: 'worker-1', stage: 'delegate', status: 'blocked',
      summary: '需要用户确认接口', report: { summary: 'PRIVATE_RUN_REPORT' }, riskFlags: [] }],
    coordination: { phase: 'blocked', planId: 'plan-current', round: 1, steps: [
      { key: 'schema', title: '交付数据结构', memberId: 'worker-1', status: 'succeeded', dependsOn: [], runId: 'run-1',
        objective: 'PRIVATE_STEP_OBJECTIVE', output: { type: 'files', files: [{ path: 'schema.json', format: 'json' }] },
        checkpointValid: false, checkpointReason: '文件内容已变化，此前的通过记录不能用于当前恢复',
        outputCheck: { status: 'passed', type: 'files', summary: '文件结构检查通过，仍需最终验收',
          checkedAt: '2026-10-08T01:02:03.000Z',
          files: [{ path: 'schema.json', sha256: 'a'.repeat(64), size: 60 }], contractHash: 'b'.repeat(64) } },
      { key: 'implementation', title: '实现接口', memberId: 'worker-2', status: 'waiting', dependsOn: ['schema'],
        runId: 'run-2', outputCheck: null },
    ] },
    assistance: [
      { id: 'help-old', planId: 'plan-old', stepKey: 'schema', status: 'blocked', question: 'OBSOLETE_QUESTION' },
      { id: 'help-answered', planId: 'plan-current', stepKey: 'schema', status: 'answered', question: 'RESOLVED_QUESTION', answer: 'PRIVATE_SAVED_ANSWER' },
      { id: 'help-current', planId: 'plan-current', stepKey: 'implementation', status: 'blocked', question,
        requesterId: 'worker-2', requestRunId: 'run-2', blocker: 'PRIVATE_FULL_BLOCKER' },
      { id: 'help-cancelled', planId: 'plan-current', stepKey: 'schema', status: 'cancelled', question: 'CANCELLED_QUESTION' },
    ],
    resume: { available: false, reusableSteps: 0, totalSteps: 2, reason: '请先保存协作问题的答复', internal: 'PRIVATE_RESUME_INTERNAL' },
  };
  const original = structuredClone(progress);
  const result = compact(progress);
  assert.equal(result.taskId, progress.taskId);
  assert.equal(result.active, false);
  assert.equal(result.canReassign, true);
  assert.equal(result.remainingRepairs, 2);
  assert.deepEqual(result.reviewerExcludedIds, ['worker-1']);
  assert.deepEqual(result.currentRuns, []);
  assert.equal(result.totalRuns, 9);
  assert.equal(result.omittedRuns, 0);
  assert.equal(result.assistance.length, 1);
  assert.equal(result.assistance[0].helpId, 'help-current');
  assert.equal(result.assistance[0].status, 'blocked');
  assert.equal(result.assistance[0].stepKey, 'implementation');
  assert.ok(question.startsWith(result.assistance[0].question));
  assert.ok(result.assistance[0].question.length < question.length);
  assert.equal(result.assistance[0].questionTruncated, true);
  assert.deepEqual(result.resume, { available: false, reusableSteps: 0, totalSteps: 2, reason: '请先保存协作问题的答复' });
  assert.equal(result.coordination.steps[0].status, 'succeeded');
  assert.deepEqual(result.coordination.steps[0].outputCheck, { status: 'passed', type: 'files',
    checkedAt: '2026-10-08T01:02:03.000Z', summary: '文件结构检查通过，仍需最终验收' });
  assert.equal(result.coordination.steps[0].checkpointValid, false, 'Historical passed checks must not hide current invalidation');
  assert.equal(result.coordination.steps[0].checkpointReason, '文件内容已变化，此前的通过记录不能用于当前恢复');
  assert.equal(result.coordination.steps[1].outputCheck, null);
  assert.equal(result.coordination.steps[1].checkpointValid, null);
  assert.deepEqual(result.coordination.steps[1].dependsOn, ['schema']);
  assert.equal(result.recentProblems[0].summary, '需要用户确认接口');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|OBSOLETE_QUESTION|RESOLVED_QUESTION|CANCELLED_QUESTION|contractHash|sha256/);
  assert.equal(result.gate, undefined, 'A passed step receipt must not invent a passed task gate');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4000);
  assert.deepEqual(progress, original, 'Compaction must not rewrite the source progress');
});

test('compact progress retains pending consultations, interrupted help and available resume counts', () => {
  const result = compact({ taskId: 'task-1', active: false, currentRuns: [], runs: [],
    coordination: { phase: 'blocked', planId: 'plan-1', steps: [] },
    assistance: ['pending', 'consulting', 'blocked'].map((status, index) => ({
      id: `help-${index}`, planId: 'plan-1', stepKey: 'step-1', status, question: '待补充信息',
      interrupted: status === 'blocked', answer: 'SHOULD_NOT_APPEAR', peerReply: 'SHOULD_NOT_APPEAR',
    })),
    resume: { available: true, reusableSteps: 1, totalSteps: 3, reason: '保留 1/3 个步骤，继续已中断求助' },
  });
  assert.deepEqual(result.assistance.map((help) => help.status), ['pending', 'consulting', 'blocked']);
  assert.equal(result.assistance[2].interrupted, true);
  assert.equal(result.assistance[0].questionTruncated, undefined);
  assert.deepEqual(result.resume, { available: true, reusableSteps: 1, totalSteps: 3, reason: '保留 1/3 个步骤，继续已中断求助' });
  assert.doesNotMatch(JSON.stringify(result), /SHOULD_NOT_APPEAR/);
});

test('compact legacy progress distinguishes absent, failed and unconfigured step checks', () => {
  const result = compact({ taskId: 'task-legacy', active: false, currentRuns: [], runs: [],
    coordination: { phase: 'blocked', round: 1, steps: [
      { key: 'old', status: 'succeeded', dependsOn: [] },
      { key: 'unchecked', status: 'succeeded', dependsOn: [], outputCheck: { status: 'not_configured', summary: '未配置交付检查' } },
      { key: 'bad', status: 'failed', dependsOn: [], outputCheck: { status: 'failed', type: 'analysis', summary: '缺少必需的分析章节' } },
    ] },
  });
  assert.deepEqual(result.assistance, []);
  assert.equal(result.resume, null);
  assert.equal(result.coordination.steps[0].outputCheck, null);
  assert.equal(result.coordination.steps[0].checkpointValid, null);
  assert.equal(result.coordination.steps[0].checkpointReason, null);
  assert.equal(result.coordination.steps[1].outputCheck.status, 'not_configured');
  assert.equal(result.coordination.steps[2].outputCheck.status, 'failed');
  assert.equal(result.coordination.steps[2].outputCheck.summary, '缺少必需的分析章节');
  assert.equal(result.gate, undefined);
});

test('compact progress bounds verbose new fields and reports omitted excess help records', () => {
  const result = compact({ taskId: 'task-1', active: false, currentRuns: [], runs: [],
    coordination: { phase: 'blocked', planId: 'plan-1', steps: [{ key: 'step-1', status: 'failed', dependsOn: [],
      checkpointValid: false, checkpointReason: '检查点已失效。'.repeat(500),
      outputCheck: { status: 'failed', type: 'files', summary: '文件内容需要检查'.repeat(1000),
        files: Array.from({ length: 8 }, (_, index) => ({ path: `out/${index}.json`, sha256: 'a'.repeat(64) })) } }] },
    assistance: Array.from({ length: 10 }, (_, index) => ({ id: `help-${index}`, planId: 'plan-1',
      stepKey: 'step-1', status: 'blocked', question: '请补充信息。'.repeat(500), answer: 'LARGE_ANSWER'.repeat(1000) })),
    resume: { available: false, reusableSteps: 0, totalSteps: 1, reason: '当前计划需要调整'.repeat(1000) },
  });
  assert.equal(result.assistance.length, 6);
  assert.equal(result.omittedAssistance, 4);
  assert.equal(result.assistance[0].helpId, 'help-4');
  assert.equal(result.assistance[5].helpId, 'help-9');
  assert.equal(result.coordination.steps[0].outputCheck.status, 'failed');
  assert.equal(result.coordination.steps[0].checkpointValid, false);
  assert.ok(result.coordination.steps[0].checkpointReason.length < 500);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8000);
  assert.doesNotMatch(JSON.stringify(result), /LARGE_ANSWER|sha256/);
});

test('compact progress preserves fresh reusable checkpoint validity and unknown validity while work is active', () => {
  const progress = { taskId: 'task-1', active: false, currentRuns: [], runs: [],
    coordination: { phase: 'blocked', steps: [{ key: 'step-1', status: 'succeeded', dependsOn: [],
      checkpointValid: true, checkpointReason: '本次核对有效，可在继续时保留',
      outputCheck: { status: 'passed', type: 'analysis', checkedAt: '2026-10-08T02:00:00.000Z', summary: '分析结构检查通过' } }] },
    resume: { available: true, reusableSteps: 1, totalSteps: 1, reason: '保留 1/1 个步骤' },
  };
  const fresh = compact(progress);
  assert.equal(fresh.coordination.steps[0].checkpointValid, true);
  assert.equal(fresh.coordination.steps[0].outputCheck.checkedAt, '2026-10-08T02:00:00.000Z');
  progress.active = true;
  progress.coordination.steps[0].checkpointValid = null;
  progress.coordination.steps[0].checkpointReason = null;
  const active = compact(progress);
  assert.equal(active.coordination.steps[0].checkpointValid, null);
  assert.equal(active.coordination.steps[0].checkpointReason, null);
  assert.equal(active.coordination.steps[0].outputCheck.status, 'passed', 'The stored receipt remains historical evidence');
});
