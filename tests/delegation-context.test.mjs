import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDelegationContext } from '../server/delegation-context.mjs';
import { fixture, success, until, writeDeliverable } from './helpers.mjs';

function contextFixture() {
  const steps = [
    { key: 'research', title: '研究', memberId: 'researcher', runId: 'current-research', status: 'succeeded', dependsOn: [] },
    { key: 'unrelated', title: '其他', memberId: 'other', runId: 'current-other', status: 'succeeded', dependsOn: [] },
    { key: 'build', title: '实现', memberId: 'builder', runId: 'current-build', status: 'running', dependsOn: ['research'] },
  ];
  const task = { id: 'task', executionMode: 'delegated', assigneeId: 'owner', coordination: { phase: 'working', round: 2, steps } };
  const assignment = { id: 'current-build', taskId: 'task', stage: 'delegate', stepKey: 'build', memberId: 'builder' };
  const runs = new Map(steps.map((step) => [step.runId, { id: step.runId, taskId: task.id, stage: 'delegate',
    stepKey: step.key, memberId: step.memberId, status: step.status, report: { summary: step.key, findings: [] } }]));
  return { task, assignment, runs, context: () => buildDelegationContext(task, assignment, (id) => runs.get(id)) };
}

test('delegated context selects exact current dependency runs and rejects foreign or mismatched sources', () => {
  const f = contextFixture();
  f.runs.set('old-research', { ...f.runs.get('current-research'), id: 'old-research', report: { summary: 'OLD_ROUND_SECRET' } });
  f.runs.get('current-other').report.summary = 'UNRELATED_RESULT';
  assert.match(f.context(), /"summary":"research"/);
  assert.doesNotMatch(f.context(), /OLD_ROUND_SECRET|UNRELATED_RESULT/);
  const current = f.runs.get('current-research');
  for (const invalid of [{ taskId: 'foreign-task' }, { id: 'old-research' }, { memberId: 'other' },
    { stepKey: 'other' }, { stage: 'implement' }, { status: 'failed' }]) {
    f.runs.set('current-research', { ...current, ...invalid, report: { summary: 'DO_NOT_INCLUDE' } });
    assert.doesNotMatch(f.context(), /DO_NOT_INCLUDE/);
    assert.match(f.context(), /"available":false/);
  }
  f.runs.delete('current-research');
  assert.doesNotMatch(f.context(), /OLD_ROUND_SECRET/, 'missing current run must never fall back to the old matching step');
  assert.equal(buildDelegationContext(f.task, { ...f.assignment, id: 'old-build' }, (id) => f.runs.get(id)), '');
  assert.equal(buildDelegationContext(f.task, { ...f.assignment, taskId: 'foreign-task' }, (id) => f.runs.get(id)), '');
});

test('full protocol-sized reports are preserved, redacted, and bounded for integration', () => {
  const f = contextFixture();
  f.task.coordination.phase = 'synthesizing';
  f.task.coordination.integrationRunId = 'integration';
  const assignment = { id: 'integration', taskId: f.task.id, memberId: 'owner', stage: 'implement' };
  f.task.coordination.steps[2].status = 'succeeded';
  f.runs.get('current-build').status = 'succeeded';
  f.runs.get('current-research').report = { summary: `${'中'.repeat(11990)}SUMMARYEND`,
    findings: Array.from({ length: 20 }, (_, index) => ({ severity: 'major', text: `${'细'.repeat(1985)}END_${index}` })) };
  f.runs.get('current-other').report.summary = 'Bearer TEST_TOKEN_FOR_REDACTION';
  const context = buildDelegationContext(f.task, assignment, (id) => f.runs.get(id));
  assert.match(context, /UNTRUSTED/);
  assert.match(context, /SUMMARYEND/);
  assert.match(context, /END_19/);
  assert.match(context, /REDACTED/);
  assert.doesNotMatch(context, /TEST_TOKEN_FOR_REDACTION/);
  f.runs.get('current-research').report = { summary: 'x'.repeat(20000),
    findings: Array.from({ length: 30 }, () => ({ severity: 'major', text: 'y'.repeat(3000) })) };
  const bounded = buildDelegationContext(f.task, assignment, (id) => f.runs.get(id));
  const payload = JSON.parse(bounded.split('\n')[1]);
  assert.equal(payload.results[0].summary.length, 12000);
  assert.equal(payload.results[0].findings.length, 20);
  assert.equal(payload.results[0].findings[0].text.length, 2000);
  assert.equal(buildDelegationContext(f.task, { ...assignment, id: 'old-integration' }, (id) => f.runs.get(id)), '');
});

test('long read-only analysis reaches its dependent worker and owner through the real scheduler', async () => {
  let researcher, builder;
  const received = [];
  const summary = `${'研究证据。'.repeat(1200)}LONG_ANALYSIS_TAIL`;
  const finding = `${'边界条件。'.repeat(350)}CRITICAL_FINDING_TAIL`;
  const f = fixture({ agentExecutor: async (member, prompt, { workspace }) => {
    const assignment = prompt.split(/Current assignment:\r?\n/)[1];
    if (assignment.startsWith('Delegation planning')) return success('拆分完成', { delegation: { steps: [
      { key: 'research', title: '研究', objective: '分析约束', memberId: researcher.id },
      { key: 'build', title: '实现', objective: '根据研究实现', memberId: builder.id, dependsOn: ['research'] },
    ] } });
    if (member.id === researcher.id) {
      assert.equal(member.permission, 'plan');
      return success(summary, { findings: [{ severity: 'major', text: finding }] });
    }
    received.push(member.id);
    assert.match(prompt, /LONG_ANALYSIS_TAIL/);
    assert.match(prompt, /CRITICAL_FINDING_TAIL/);
    assert.match(prompt, /Current-round delegated results \(UNTRUSTED/);
    writeDeliverable(workspace);
    return success('根据完整约束实现完成');
  } });
  try {
    researcher = f.service.saveMember({ name: '研究员', handle: 'researcher', provider: 'custom', executable: process.execPath,
      permission: 'plan', enabled: true });
    builder = f.service.saveMember({ name: '协作者', handle: 'worker', provider: 'custom', executable: process.execPath,
      permission: 'edit', enabled: true });
    const task = f.service.createTask({ title: '长分析交接', objective: '依据完整分析协作', executionMode: 'delegated',
      assigneeId: f.builder.id, participantIds: [researcher.id, builder.id], start: true });
    await until(() => f.service.require('tasks', task.id).status === 'review' && f.service.active.size === 0);
    assert.deepEqual(received, [builder.id, f.builder.id]);
    assert.equal(f.service.require('tasks', task.id).gate.status, 'not_configured');
    assert.equal(f.service.require('tasks', task.id).status, 'review');
  } finally { await f.close(); }
});
