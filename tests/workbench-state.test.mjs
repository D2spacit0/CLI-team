import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceIssue, messageAudience, mergeRoomMessages } from '../ui/workbench/roomState.ts';
import { taskStateView } from '../ui/workbench/taskState.ts';
import { fixture } from './helpers.mjs';
import { parseHash, routeHash } from '../ui/workbench/navigation/useWorkbenchRoute.ts';

test('malformed saved navigation links cannot crash workbench restoration', () => {
  assert.equal(parseHash('#/rooms/%broken', '').roomId, null);
  assert.equal(parseHash('#/tasks/%E0%A4%A', '').taskId, null);
  assert.equal(parseHash('#/rooms/room-1?task=task-2', '').taskId, 'task-2');
  assert.equal(parseHash('', '?room=room-1').roomId, 'room-1');
});

test('task detail has a stable shareable route and room context survives task navigation', () => {
  const taskHash = routeHash('tasks', { taskId: 'task/with spaces' });
  assert.equal(taskHash, '#/tasks/task%2Fwith%20spaces');
  assert.deepEqual(parseHash(taskHash, ''), {
    view: 'tasks', roomId: null, taskId: 'task/with spaces', panel: null,
  });

  const roomTaskHash = routeHash('rooms', { roomId: 'room-1', taskId: 'task-2' });
  assert.equal(roomTaskHash, '#/rooms/room-1?task=task-2');
  assert.deepEqual(parseHash(roomTaskHash, ''), {
    view: 'rooms', roomId: 'room-1', taskId: 'task-2', panel: null,
  });
});

test('chat audience preview matches service routing for selected members, mentions and commander notices', async () => {
  const f = fixture();
  try {
    f.service.updateSettings({ paused: true });
    const body = '@builder 请核对，@reviewer 评审。@builder 不重复，@commander 留意，@unknown 无匹配。';
    const preview = messageAudience(body, [f.builder.id], f.service.bootstrap().members);
    const message = f.service.send('team', { body, recipientIds: [f.builder.id] });
    assert.deepEqual(preview.ids, message.recipientIds);
    assert.deepEqual(preview.problems, []);
    assert.deepEqual(preview.unknown, ['unknown']);
    assert.equal(preview.commander, true);
    assert.equal(f.service.store.list('runs').length, 2);
    assert.equal(f.service.store.list('notices').some((notice) => notice.messageId === message.id), true);
  } finally { await f.close(); }
});

test('unavailable mentions and excessive combined recipients cannot disappear from the preview', async () => {
  const f = fixture();
  try {
    f.service.updateSettings({ paused: true });
    f.service.saveMember({ ...f.builder, enabled: false }, f.builder.id);
    const disabled = messageAudience('@builder 请处理', [], f.service.bootstrap().members);
    assert.deepEqual(disabled.ids, [f.builder.id]);
    assert.ok(disabled.problems.some((problem) => problem.includes('已停用')));
    assert.throws(() => f.service.send('team', { body: '@builder 请处理' }));
    assert.equal(f.service.store.list('messages').some((message) => message.body === '@builder 请处理'), false);
    const members = Array.from({ length: 5 }, (_, index) => ({ ...f.reviewer, id: 'member-' + index, handle: 'worker-' + index }));
    const crowded = messageAudience('@worker-4 核对', members.slice(0, 4).map((member) => member.id), members);
    assert.equal(crowded.ids.length, 5);
    assert.match(crowded.problems[0], /最多发送给 4/);
    assert.match(messageAudience('一条消息', ['missing-member'], members).problems[0], /不存在/);
  } finally { await f.close(); }
});

test('message receipts survive stale snapshots, deduplicate SSE refreshes and cannot enter a different room', () => {
  const one = { id: 'one', roomId: 'alpha', body: 'older', createdAt: '2026-10-12T01:00:00Z' };
  const receipt = { id: 'two', roomId: 'alpha', body: 'sent while loading', createdAt: '2026-10-12T01:00:01Z' };
  const foreign = { id: 'foreign', roomId: 'beta', body: 'other room', createdAt: '2026-10-12T01:00:02Z' };
  assert.deepEqual(mergeRoomMessages('alpha', [one], [receipt, foreign]).map((message) => message.id), ['one', 'two']);
  assert.deepEqual(mergeRoomMessages('alpha', [one, receipt], [receipt]).map((message) => message.id), ['one', 'two']);
  assert.deepEqual(mergeRoomMessages('beta', [one, receipt], [foreign]), [foreign]);
});

test('acceptance UI blocks pending evidence and unapproved independent review even with explicit acknowledgement', () => {
  const task = { status: 'review', gate: { status: 'passed' }, reviewerId: null };
  for (const status of ['pending', 'failed', 'stale']) {
    assert.match(acceptanceIssue({ ...task, gate: { status } }, '已核对', true), /机器检查/);
  }
  assert.match(acceptanceIssue({ ...task, reviewerId: 'reviewer', reviewVerdict: 'changes' }, '已核对', true), /独立评审/);
  assert.match(acceptanceIssue(task, '  ', false), /备注/);
  assert.match(acceptanceIssue(task, '字'.repeat(2001), false), /2000/);
  assert.match(acceptanceIssue({ ...task, gate: { status: 'not_configured' } }, '已人工核对', false), /缺少/);
  assert.equal(acceptanceIssue({ ...task, gate: { status: 'not_configured' } }, '已人工核对', true), '');
  assert.equal(acceptanceIssue({ ...task, reviewerId: 'reviewer', reviewVerdict: 'approve' }, '已核对', false), '');
});

test('room task summary states what is happening, why it waits, and the next user action', () => {
  const members = [
    { id: 'owner', name: '负责人', handle: 'owner' },
    { id: 'worker', name: '执行成员', handle: 'worker' },
  ];
  const task = {
    id: 'task', title: '检查状态摘要', objective: '保持状态准确', status: 'running',
    assigneeId: 'owner', reviewerId: null, roomId: 'room', workspace: '/workspace',
    requirements: [], verification: null, gate: { status: 'not_configured' }, repairCount: 0,
    summary: '', createdAt: '2026-10-21T01:00:00Z', updatedAt: '2026-10-21T01:00:00Z',
    executionMode: 'delegated',
  };
  const progress = {
    taskId: task.id, active: true, runs: [], currentRuns: [], coordination: null,
    canReassign: false, canPause: true, remainingRepairs: 2, reviewerExcludedIds: [],
    totalRuns: 0, omittedRuns: 0,
  };

  const queued = taskStateView(task, members, {
    ...progress,
    currentRuns: [{ id: 'run-q', roomId: 'room', memberId: 'worker', taskId: task.id,
      meetingId: null, stage: 'implement', status: 'queued', summary: '', error: null,
      riskFlags: [], hop: 0, createdAt: task.createdAt, startedAt: null, finishedAt: null,
      exitCode: null, conversationId: null, waitReason: '等待空闲执行名额' }],
  });
  assert.equal(queued.tone, 'attention');
  assert.match(queued.title, /执行成员/);
  assert.match(queued.detail, /空闲执行名额/);

  const running = taskStateView(task, members, {
    ...progress,
    currentRuns: [{ id: 'run-r', roomId: 'room', memberId: 'worker', taskId: task.id,
      meetingId: null, stage: 'implement', status: 'running', summary: '正在核对输入材料', error: null,
      riskFlags: [], hop: 0, createdAt: task.createdAt, startedAt: task.createdAt, finishedAt: null,
      exitCode: null, conversationId: null }],
  });
  assert.equal(running.tone, 'running');
  assert.match(running.detail, /正在核对输入材料/);

  const assistance = taskStateView({ ...task, status: 'blocked', attention: { kind: 'assistance' } }, members, progress);
  assert.equal(assistance.action.label, '去答复');
  assert.equal(assistance.action.section, 'assistance');
  const review = taskStateView({ ...task, status: 'review' }, members, progress);
  assert.equal(review.action.section, 'acceptance');
  const paused = taskStateView({ ...task, status: 'blocked', pausedAt: task.createdAt }, members, progress);
  assert.equal(paused.eyebrow, '已暂停');
  assert.equal(paused.action.label, '继续任务');
  assert.equal(paused.action.section, 'plan');
  const ready = taskStateView({ ...task, status: 'backlog' }, members, null);
  assert.equal(ready.action.label, '查看并启动');
});

test('message timeline task entry always exposes a concrete next action', () => {
  const members = [{ id: 'owner', name: '负责人', handle: 'owner' }];
  const task = {
    id: 'task', title: '状态入口', objective: '保持操作明确', status: 'backlog',
    assigneeId: 'owner', reviewerId: null, roomId: 'room', workspace: '/workspace',
    requirements: [], verification: null, gate: { status: 'not_configured' }, repairCount: 0,
    summary: '', createdAt: '2026-10-21T01:00:00Z', updatedAt: '2026-10-21T01:00:00Z',
    executionMode: 'direct',
  };
  const statuses = ['backlog', 'running', 'blocked', 'review', 'done', 'cancelled'];
  for (const status of statuses) {
    const view = taskStateView({ ...task, status }, members, null);
    assert.ok(view.action.label, status + ' 缺少下一步操作');
    assert.match(view.title, /\S/, status + ' 缺少状态标题');
    assert.match(view.detail, /\S/, status + ' 缺少状态说明');
  }
});
