import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, success, until, writeDeliverable } from './helpers.mjs';
import { deliverRoomMessage } from '../ui/workbench/rooms/messageDelivery.ts';

test('retrying an accepted chat request returns its receipt without repeating dispatch or notices', async () => {
  const f = fixture();
  try {
    const s = f.service;
    s.updateSettings({ paused: true });
    const input = { requestId: randomUUID(), body: '@commander 核对消息', recipientIds: [f.builder.id] };
    const first = s.send('team', input);
    const retry = s.send('team', input);
    assert.equal(retry.id, first.id);
    assert.equal(s.store.list('runs').length, 1);
    assert.equal(s.store.list('messages').filter(m => m.kind === 'user').length, 1);
    assert.equal(s.store.list('notices').length, 1);
    assert.throws(() => s.send('team', { ...input, body: '不同消息' }), /请求/);
    assert.throws(() => s.send('team', input, 'controller'), /请求/);
  } finally { await f.close(); }
});

test('a lost chat response can be recovered after reopening without repeating model work or discarding an edited draft', async () => {
  const f = fixture();
  try {
    const s = f.service;
    s.updateSettings({ paused: true });
    let saved = {};
    const draft = () => ({ values: { ...saved }, setField(name, value) { this.values[name] = value; }, async flush() { saved = { ...this.values }; return true; } });
    let posts = 0;
    const transport = {
      getMessageReceipt: async (roomId, requestId) => s.messageReceipt(roomId, requestId),
      sendMessage: async (roomId, body, recipientIds, analysisOnly, taskId, requestId) => {
        posts++;
        const message = s.send(roomId, { body, recipientIds, analysisOnly, taskId, requestId });
        if (posts === 1) throw new Error('response lost after commit');
        return message;
      },
    };
    const input = { body: '回执丢失后核对原消息', recipientIds: [f.builder.id], analysisOnly: true };
    await assert.rejects(deliverRoomMessage('team', input, draft(), '', transport), /response lost/);
    assert.ok(saved.sendRequestId);
    const recovered = await deliverRoomMessage('team', input, draft(), '成员此时已经不可用，也应能找回回执', transport);
    assert.equal(recovered.clearBody, true);
    assert.equal(posts, 1);
    assert.equal(s.store.list('runs').length, 1);
    const edited = await deliverRoomMessage('team', { ...input, body: '尚未发送的新草稿' }, draft(), '', transport);
    assert.equal(edited.message.id, recovered.message.id);
    assert.equal(edited.clearBody, false);
    const restoredMode = await deliverRoomMessage('team', { ...input, analysisOnly: false }, draft(), '', transport);
    assert.equal(restoredMode.clearBody, false, '恢复草稿不得默默扩大旧发送请求的权限');
    assert.equal(posts, 1);
  } finally { await f.close(); }
});

test('a partially failed multi-recipient dispatch leaves no message, run or notification to duplicate on retry', async () => {
  const f = fixture();
  try {
    const s = f.service;
    s.updateSettings({ paused: true });
    const events = [];
    s.on('change', event => events.push(event));
    const original = s.enqueue.bind(s);
    let calls = 0;
    s.enqueue = (...args) => { if (++calls === 2) throw new Error('simulated storage failure'); return original(...args); };
    assert.throws(() => s.send('team', { body: '两个成员都应收到', recipientIds: [f.builder.id, f.reviewer.id] }), /storage failure/);
    assert.equal(s.store.list('runs').length, 0);
    assert.equal(s.store.list('messages').length, 0);
    assert.equal(events.length, 0);
  } finally { await f.close(); }
});

test('a full queue rejects immediate task creation without leaving phantom tasks or channels', async () => {
  const f = fixture();
  try {
    const s = f.service;
    s.updateSettings({ paused: true });
    for (let index = 0; index < 50; index++) s.store.put('runs', { id: `busy-${index}`, status: 'queued', roomId: 'team', memberId: f.builder.id });
    const roomsBefore = s.store.list('rooms').length;
    assert.throws(() => s.createTask({ title: '应整体拒绝', objective: '队列满时不能留下一份未知待办', assigneeId: f.builder.id, start: true }), /队列已满/);
    assert.equal(s.store.list('tasks').length, 0);
    assert.equal(s.store.list('rooms').length, roomsBefore);
    assert.equal(fs.readdirSync(s.workspaceRoot).length, 0);
  } finally { await f.close(); }
});

test('cancelling a task stops its dedicated-room meeting while unrelated shared-room work remains queued', async () => {
  const f = fixture();
  try {
    const s = f.service;
    s.updateSettings({ paused: true });
    const task = s.createTask({ title: '专属频道任务', objective: '取消应停止本任务所有运行', assigneeId: f.builder.id, start: true });
    const meeting = s.createMeeting({ roomId: task.roomId, objective: '任务讨论', memberIds: [f.builder.id, f.reviewer.id] });
    const unrelated = s.send('team', { body: '大厅独立消息', recipientIds: [f.reviewer.id] });
    s.cancelTask(task.id);
    assert.equal(s.require('meetings', meeting.id).phase, 'cancelled');
    assert.ok(s.store.list('runs').filter(run => run.roomId === task.roomId).every(run => run.status === 'cancelled'));
    assert.equal(s.store.list('runs').find(run => run.triggerMessageId === unrelated.id).status, 'queued');
    assert.equal(s.require('tasks', task.id).summary, '任务已取消');
  } finally { await f.close(); }
});

test('artifact downloads reject changed bytes just as previews and final acceptance do', async () => {
  const f = fixture({ agentExecutor: async (_member, _prompt, options) => { writeDeliverable(options.workspace); return success(); } });
  try {
    const s = f.service;
    const task = s.createTask({ title: '成果版本', objective: '只下载本次交付内容', assigneeId: f.builder.id, start: true });
    await until(() => s.require('tasks', task.id).status === 'review');
    const artifact = s.store.list('artifacts')[0];
    assert.equal(s.artifactFile(artifact.id).artifact.sha256, artifact.sha256);
    fs.writeFileSync(path.join(task.workspace, artifact.relativePath), 'changed after review');
    assert.throws(() => s.artifactFile(artifact.id), /改变/);
  } finally { await f.close(); }
});

test('attention actions use current unanswered questions instead of summary keywords or old feedback', async () => {
  const f = fixture();
  try {
    const s = f.service;
    const task = s.createTask({ title: '真实待办', objective: '行动提示应与当前状态一致', assigneeId: f.builder.id });
    const attention = () => s.bootstrap().tasks.find(item => item.id === task.id).attention;
    s.store.update('tasks', task.id, { status: 'blocked', summary: '用户主动暂停、求助、协助都是模型自述', pendingFeedback: '旧返工意见' });
    assert.deepEqual(attention(), { kind: 'blocked' });
    const help = { id: 'current-help', taskId: task.id, ownerId: f.builder.id, requesterId: f.reviewer.id,
      planId: 'current-plan', stepKey: 'step', status: 'blocked', interrupted: false };
    s.store.update('tasks', task.id, { coordination: { phase: 'blocked', planId: help.planId,
      steps: [{ key: 'step', helpId: help.id, memberId: help.requesterId, status: 'waiting' }] } });
    s.store.put('assistance', help);
    assert.deepEqual(attention(), { kind: 'blocked' }, '已有返工要求时应引导重新规划，不能跳到不可提交的旧答复');
    s.store.update('tasks', task.id, { pendingFeedback: null });
    assert.deepEqual(attention(), { kind: 'assistance', helpId: help.id });
    s.store.update('assistance', help.id, { status: 'answered' });
    assert.deepEqual(attention(), { kind: 'blocked' });
    s.store.update('assistance', help.id, { status: 'blocked', planId: 'historical-plan' });
    assert.deepEqual(attention(), { kind: 'blocked' });
    s.store.update('tasks', task.id, { pausedAt: new Date().toISOString() });
    assert.deepEqual(attention(), { kind: 'paused' });
  } finally { await f.close(); }
});
