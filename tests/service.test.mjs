import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TeamService } from '../server/service.mjs';
import { fixture, success, until, writeDeliverable } from './helpers.mjs';

const passingGate = async () => ({ passed: true, exitCode: 0, testCount: 3, skipped: 0, output: '3 passed' });
const basicAgent = async (member, _prompt, { workspace }) => {
  if (member.role === 'builder' && member.permission === 'edit') writeDeliverable(workspace);
  return success('已检查产物', { verdict: member.role === 'reviewer' ? 'approve' : 'none' });
};
function taskFor(f, extra = {}) {
  return f.service.createTask({ title: '文件工具', objective: '生成一个模块', assigneeId: f.builder.id,
    reviewerId: f.reviewer.id, verification: { executable: process.execPath, args: ['--test'] }, start: true, ...extra });
}

test('implementation, machine gate and independent review stop at manual acceptance', async () => {
  const f = fixture({ agentExecutor: basicAgent, verifier: passingGate });
  try {
    const task = taskFor(f);
    await until(() => f.service.require('tasks', task.id).status === 'review');
    const current = f.service.require('tasks', task.id);
    assert.equal(current.gate.status, 'passed');
    assert.equal(current.reviewVerdict, 'approve');
    assert.equal(f.service.store.list('runs').length, 2);
    assert.equal(f.service.store.list('artifacts').length, 1);
    const accepted = f.service.acceptTask(task.id, { note: '独立验收通过' });
    assert.equal(accepted.status, 'done');
  } finally { await f.close(); }
});

test('claimed success without artifacts is blocked', async () => {
  const f = fixture({ agentExecutor: async () => success(), verifier: passingGate });
  try {
    const task = taskFor(f);
    await until(() => f.service.require('tasks', task.id).status === 'blocked');
    assert.match(f.service.require('tasks', task.id).summary, /没有生成/);
  } finally { await f.close(); }
});

test('a failed machine gate is repaired outside the controller', async () => {
  let attempts = 0;
  const f = fixture({ agentExecutor: basicAgent, verifier: async () => {
    attempts++;
    return attempts === 1 ? { passed: false, exitCode: 1, output: 'PermissionError regression failed' } : passingGate();
  } });
  try {
    const task = taskFor(f);
    await until(() => f.service.require('tasks', task.id).status === 'review');
    assert.equal(attempts, 2);
    assert.equal(f.service.require('tasks', task.id).repairCount, 1);
    assert.equal(f.service.store.list('runs').filter((run) => run.stage === 'implement').length, 2);
  } finally { await f.close(); }
});

test('serious findings block approval and repair rounds are bounded', async () => {
  const f = fixture({ agentExecutor: async (member, prompt, options) => {
    if (member.role === 'builder') return basicAgent(member, prompt, options);
    return success('存在严重问题', { verdict: 'approve', findings: [{ severity: 'major', text: '边界错误' }] });
  }, verifier: passingGate });
  try {
    f.service.updateSettings({ repairLimit: 1 });
    const task = taskFor(f);
    await until(() => f.service.require('tasks', task.id).status === 'blocked');
    assert.equal(f.service.require('tasks', task.id).repairCount, 1);
    assert.match(f.service.require('tasks', task.id).summary, /返工上限/);
  } finally { await f.close(); }
});

test('changed artifacts cannot reuse a passing gate at final acceptance', async () => {
  const f = fixture({ agentExecutor: basicAgent, verifier: passingGate });
  try {
    const task = taskFor(f);
    await until(() => f.service.require('tasks', task.id).status === 'review');
    writeDeliverable(task.workspace, 'changed after validation');
    assert.throws(() => f.service.acceptTask(task.id, { note: '通过' }), /产物已变化/);
    assert.equal(f.service.require('tasks', task.id).gate.status, 'stale');
  } finally { await f.close(); }
});

test('no configured verification requires explicit manual acknowledgement', async () => {
  const f = fixture({ agentExecutor: basicAgent });
  try {
    const task = taskFor(f, { verification: null });
    await until(() => f.service.require('tasks', task.id).status === 'review');
    assert.throws(() => f.service.acceptTask(task.id, { note: '通过' }), /自动化验收证据/);
    assert.equal(f.service.acceptTask(task.id, { note: '人工检查了文件', acknowledgeMissingGate: true }).status, 'done');
  } finally { await f.close(); }
});

test('read-only mutations and permission-denial claims fail closed', async () => {
  const f = fixture({ agentExecutor: async (_member, _prompt, { workspace }) => {
    writeDeliverable(workspace);
    return success();
  } });
  try {
    f.service.send('team', { body: '只读检查', recipientIds: [f.reviewer.id] });
    await until(() => f.service.store.list('runs')[0]?.status === 'failed');
    assert.ok(f.service.store.list('runs')[0].riskFlags.includes('read_only_workspace_changed'));
  } finally { await f.close(); }
});

test('queue pause and peer hop limit prevent uncontrolled loops', async () => {
  let f;
  f = fixture({ agentExecutor: async (member) => success('转交意见', {
    handoff: { to: member.handle === 'builder' ? 'reviewer' : 'builder', message: '请复核' },
  }) });
  try {
    f.service.updateSettings({ paused: true, maxHops: 1 });
    f.service.send('team', { body: '开始', recipientIds: [f.builder.id] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(f.service.store.list('runs')[0].status, 'queued');
    f.service.updateSettings({ paused: false });
    await until(() => f.service.store.list('runs').length === 2 && f.service.store.list('runs').every((run) => run.status === 'succeeded'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.service.store.list('runs').length, 2);
    assert.ok(f.service.messages('team').some((message) => message.body.includes('往返上限')));
  } finally { await f.close(); }
});

test('run details explain why a queued job has not started', async () => {
  const f = fixture({ agentExecutor: basicAgent });
  try {
    f.service.updateSettings({ paused: true });
    f.service.send('team', { body: '等待调度', recipientIds: [f.builder.id] });
    const run = f.service.store.list('runs').find((item) => item.memberId === f.builder.id);
    const details = f.service.runDetails(run.id);
    assert.equal(details.run.status, 'queued');
    assert.match(details.waitReason, /全局调度已暂停/);
    assert.equal(details.logTail, '');
  } finally { await f.close(); }
});

test('bounded council has independent and challenge rounds plus one synthesis', async () => {
  const f = fixture({ agentExecutor: async () => success('方案与剩余分歧') });
  try {
    const meeting = f.service.createMeeting({ roomId: 'team', objective: '比较两个设计',
      memberIds: [f.builder.id, f.reviewer.id] });
    await until(() => f.service.require('meetings', meeting.id).phase === 'complete');
    const runs = f.service.store.list('runs');
    assert.equal(runs.length, 5);
    assert.equal(runs.filter((run) => run.stage === 'independent').length, 2);
    assert.equal(runs.filter((run) => run.stage === 'challenge').length, 2);
    assert.equal(runs.filter((run) => run.stage === 'synthesis').length, 1);
    assert.equal(f.service.inbox().pendingCount, 1);
  } finally { await f.close(); }
});

test('a completed no-go discussion preserves objections across all five rounds', async () => {
  const prompts = [];
  const f = fixture({ agentExecutor: async (_member, prompt) => {
    prompts.push(prompt);
    return success('Do not proceed: source data and authorization are unresolved', {
      verdict: 'changes_requested', findings: [{ severity: 'major', text: 'Source summary missing' }],
    });
  } });
  try {
    const meeting = f.service.createMeeting({ roomId: 'team', objective: 'Should writing proceed?',
      memberIds: [f.builder.id, f.reviewer.id] });
    await until(() => f.service.require('meetings', meeting.id).phase === 'complete');
    assert.equal(prompts.length, 5);
    for (const prompt of prompts) {
      assert.match(prompt, /status field describes completion of this assignment/);
      assert.match(prompt, /completed analysis recommending no-go/);
    }
    assert.match(f.service.require('meetings', meeting.id).summary, /Do not proceed/);
    assert.ok(f.service.store.list('runs').every((run) => run.report.verdict === 'changes_requested'));
  } finally { await f.close(); }
});

test('an actually blocked discussion stops with the member and reason in its receipt', async () => {
  const f = fixture({ agentExecutor: async (member) => success(
    member.role === 'builder' ? 'Cannot analyze: required source is unreadable' : 'Analysis complete',
    { status: member.role === 'builder' ? 'blocked' : 'complete' },
  ) });
  try {
    const meeting = f.service.createMeeting({ roomId: 'team', objective: 'Analyze unavailable evidence',
      memberIds: [f.builder.id, f.reviewer.id] });
    await until(() => f.service.require('meetings', meeting.id).phase === 'blocked');
    const result = f.service.require('meetings', meeting.id);
    assert.equal(f.service.store.list('runs').length, 2);
    assert.ok(result.summary.includes(f.builder.name));
    assert.match(result.summary, /required source is unreadable/);
    assert.equal(f.service.inbox().notices[0].summary, result.summary);
  } finally { await f.close(); }
});

test('cancellation aborts a running agent and does not start review', async () => {
  const f = fixture({ agentExecutor: async (_member, _prompt, { signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ ...success(), cancelled: true }), { once: true });
  }) });
  try {
    const task = taskFor(f, { verification: null });
    await until(() => f.service.active.size === 1);
    f.service.cancelTask(task.id);
    await until(() => f.service.active.size === 0);
    assert.equal(f.service.require('tasks', task.id).status, 'cancelled');
    assert.equal(f.service.store.list('runs').length, 1);
    assert.equal(f.service.store.list('runs')[0].status, 'cancelled');
  } finally { await f.close(); }
});

test('workspaces with a writer are serialized across different members', async () => {
  let live = 0;
  let maximum = 0;
  const f = fixture({ agentExecutor: async () => {
    live++;
    maximum = Math.max(maximum, live);
    await new Promise((resolve) => setTimeout(resolve, 35));
    live--;
    return success();
  } });
  try {
    f.service.send('team', { body: '协作', recipientIds: [f.builder.id, f.reviewer.id] });
    await until(() => f.service.store.list('runs').length === 2 && f.service.store.list('runs').every((run) => run.status === 'succeeded'));
    assert.equal(maximum, 1);
  } finally { await f.close(); }
});

test('service restart marks queued jobs interrupted without replay', async () => {
  const f = fixture({ agentExecutor: basicAgent });
  let restarted;
  try {
    f.service.updateSettings({ paused: true });
    f.service.send('team', { body: '排队', recipientIds: [f.builder.id] });
    await f.service.close();
    restarted = new TeamService({ root: f.root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }), agentExecutor: basicAgent });
    assert.equal(restarted.store.list('runs')[0].status, 'interrupted');
    assert.equal(restarted.active.size, 0);
  } finally {
    if (restarted) await restarted.close();
    // The first instance is already closed; cleanup remains inside the test root.
    const { cleanup } = await import('./helpers.mjs');
    cleanup(f.root);
  }
});

test('same member keeps a room-specific session without sharing another room', async () => {
  const sessions = [];
  const f = fixture({ agentExecutor: async (_member, _prompt, options) => {
    sessions.push(options.conversationId);
    return success();
  } });
  try {
    f.service.send('team', { body: '第一条', recipientIds: [f.reviewer.id] });
    await until(() => f.service.active.size === 0 && sessions.length === 1);
    f.service.send('team', { body: '第二条', recipientIds: [f.reviewer.id] });
    await until(() => f.service.active.size === 0 && sessions.length === 2);
    const room = f.service.createRoom({ name: '另一个房间' });
    f.service.send(room.id, { body: '新会话', recipientIds: [f.reviewer.id] });
    await until(() => f.service.active.size === 0 && sessions.length === 3);
    assert.deepEqual(sessions, [null, 'test-conversation', null]);
  } finally { await f.close(); }
});

test('verification changing files invalidates the evidence', async () => {
  let target;
  const f = fixture({ agentExecutor: basicAgent, verifier: async () => {
    fs.writeFileSync(path.join(target, 'result.mjs'), 'changed by verifier');
    return passingGate();
  } });
  try {
    const task = taskFor(f);
    target = task.workspace;
    await until(() => f.service.require('tasks', task.id).status === 'blocked');
    assert.equal(f.service.require('tasks', task.id).gate.status, 'stale');
  } finally { await f.close(); }
});

test('explicit conversation reset removes only the mapping and never replays work', async () => {
  const sessions = [];
  const f = fixture({ agentExecutor: async (_member, _prompt, options) => {
    sessions.push(options.conversationId);
    return success();
  } });
  try {
    f.service.send('team', { body: 'first', recipientIds: [f.reviewer.id] });
    await until(() => f.service.active.size === 0 && sessions.length === 1);
    assert.throws(() => f.service.resetConversation('team', f.reviewer.id, {}), /确认/);
    f.service.resetConversation('team', f.reviewer.id, { confirm: true });
    assert.equal(f.service.store.list('runs').length, 1);
    assert.equal(f.service.store.get('conversations', `team:${f.reviewer.id}`), null);
    f.service.send('team', { body: 'fresh', recipientIds: [f.reviewer.id] });
    await until(() => f.service.active.size === 0 && sessions.length === 2);
    assert.deepEqual(sessions, [null, null]);
    f.service.updateSettings({ paused: true });
    f.service.send('team', { body: 'queued', recipientIds: [f.reviewer.id] });
    assert.throws(() => f.service.resetConversation('team', f.reviewer.id, { confirm: true }), /执行尚未结束/);
  } finally { await f.close(); }
});

test('analysis-only messages downgrade editors and keep that mode on peer handoff', async () => {
  const seen = [];
  const f = fixture({ agentExecutor: async (member, _prompt, options) => {
    seen.push({ permission: member.permission, analysisOnly: options.analysisOnly });
    return success('analysis', { handoff: seen.length === 1 ? { to: 'reviewer', message: 'check' } : null });
  } });
  try {
    f.service.send('team', { body: 'reason only', recipientIds: [f.builder.id], analysisOnly: true });
    await until(() => f.service.active.size === 0 && seen.length === 2);
    assert.deepEqual(seen, [{ permission: 'plan', analysisOnly: true }, { permission: 'plan', analysisOnly: true }]);
  } finally { await f.close(); }
});
