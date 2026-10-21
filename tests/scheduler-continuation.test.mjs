import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, success, until, writeDeliverable } from './helpers.mjs';

const passingGate = () => ({ passed: true, exitCode: 0, testCount: 1, skipped: 0 });
const enqueueChat = (f) => f.service.enqueue({ roomId: 'team', memberId: f.builder.id, stage: 'chat', prompt: '容量测试' });
const taskFor = (f, extra = {}) => f.service.createTask({ title: '队列交接', objective: '完成模块并验收',
  assigneeId: f.builder.id, reviewerId: f.reviewer.id, start: true, ...extra });

test('full external queue still admits review after verification without rewriting successful implementation', async () => {
  let release;
  const f = fixture({ verifier: async () => new Promise((resolve) => { release = () => resolve(passingGate()); }),
    agentExecutor: async (member, _prompt, { workspace }) => {
      if (member.role === 'builder') writeDeliverable(workspace);
      return success('产物完成', { verdict: member.role === 'reviewer' ? 'approve' : 'none' });
    } });
  try {
    const task = taskFor(f, { verification: { executable: process.execPath, args: ['--test'] } });
    await until(() => release);
    const implementation = f.service.store.list('runs').find((run) => run.taskId === task.id);
    assert.equal(f.service.queueLoad(), 1, 'verification retains the admitted process slot');
    f.service.updateSettings({ paused: true });
    const filler = Array.from({ length: 49 }, () => enqueueChat(f));
    assert.equal(f.service.queueLoad(), 50);
    assert.throws(() => enqueueChat(f), { status: 429 });
    release();
    await until(() => f.service.active.size === 0 && f.service.store.list('runs').some((run) => run.taskId === task.id && run.stage === 'review'));
    assert.equal(f.service.require('runs', implementation.id).status, 'succeeded');
    assert.equal(f.service.require('tasks', task.id).gate.status, 'passed');
    assert.equal(f.service.require('tasks', task.id).status, 'running');
    assert.equal(f.service.queueLoad(), 50);
    assert.throws(() => enqueueChat(f), { status: 429 });
    for (const run of filler) f.service.cancelRun(run.id);
    f.service.updateSettings({ paused: false });
    await until(() => f.service.require('tasks', task.id).status === 'review');
    assert.equal(f.service.require('tasks', task.id).reviewVerdict, 'approve');
    assert.equal(f.service.store.list('runs').filter((run) => run.taskId === task.id).length, 2);
  } finally { release?.(); await f.close(); }
});

test('multi-recipient capacity rejection is atomic and the last available slot remains usable', async () => {
  const f = fixture();
  try {
    f.service.updateSettings({ paused: true });
    for (let index = 0; index < 49; index++) enqueueChat(f);
    const beforeMessages = f.service.store.list('messages').length;
    assert.throws(() => f.service.send('team', { body: '不能部分派发', recipientIds: [f.builder.id, f.reviewer.id] }), { status: 429 });
    assert.equal(f.service.store.list('messages').length, beforeMessages);
    assert.equal(f.service.store.list('runs').length, 49);
    f.service.send('team', { body: '最后一个容量', recipientIds: [f.reviewer.id] });
    assert.equal(f.service.queueLoad(), 50);
    assert.equal(f.service.store.list('messages').length, beforeMessages + 1);
    assert.throws(() => f.service.send('team', { body: '已满', recipientIds: [f.builder.id] }), { status: 429 });
    assert.equal(f.service.store.list('messages').length, beforeMessages + 1);
    assert.equal(f.service.store.list('runs').length, 50);
  } finally { await f.close(); }
});

test('running delegation locks future workers and reviewer configuration while allowing descriptive edits', async () => {
  let started = false;
  const f = fixture({ agentExecutor: async (_member, _prompt, { signal }) => {
    started = true;
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ...success(), cancelled: true }), { once: true }));
  } });
  try {
    const worker = f.service.saveMember({ name: '待派工成员', handle: 'future-worker', provider: 'custom',
      role: 'builder', executable: process.execPath, permission: 'edit', enabled: true });
    const task = taskFor(f, { executionMode: 'delegated', participantIds: [worker.id] });
    await until(() => started);
    assert.equal(f.service.store.list('runs').filter((run) => run.memberId === worker.id).length, 0);
    const changes = { provider: 'codex', model: 'different-model', executable: `${process.execPath}.different`,
      prefixArgs: ['different-entry.mjs'], customArgs: ['{prompt}'], inputMode: 'argument', enabled: false,
      permission: 'plan', handle: 'different-worker', role: 'researcher' };
    for (const [field, value] of Object.entries(changes)) {
      assert.throws(() => f.service.saveMember({ [field]: value }, worker.id), { status: 409 }, field);
    }
    assert.throws(() => f.service.saveMember({ model: 'changed-owner' }, f.builder.id), { status: 409 });
    assert.throws(() => f.service.saveMember({ permission: 'edit' }, f.reviewer.id), { status: 409 });
    const updated = f.service.saveMember({ name: '可更新显示名', skills: '新增 SQL 分析描述', permission: 'edit', prefixArgs: [] }, worker.id);
    assert.equal(updated.name, '可更新显示名');
    assert.equal(updated.skills, '新增 SQL 分析描述');
    assert.equal(f.service.saveMember({ skills: '负责人协调能力' }, f.builder.id).skills, '负责人协调能力');
    f.service.cancelTask(task.id);
    await until(() => f.service.active.size === 0);
    assert.equal(f.service.saveMember({ permission: 'plan' }, worker.id).permission, 'plan');
  } finally { await f.close(); }
});

test('queued members reject executable configuration changes but permit unchanged fields and skills', async () => {
  const f = fixture();
  try {
    f.service.updateSettings({ paused: true });
    const run = enqueueChat(f);
    assert.throws(() => f.service.saveMember({ permission: 'plan' }, f.builder.id), { status: 409 });
    const updated = f.service.saveMember({ skills: '队列期间更新说明', permission: 'edit', executable: process.execPath }, f.builder.id);
    assert.equal(updated.skills, '队列期间更新说明');
    f.service.cancelRun(run.id);
    assert.equal(f.service.saveMember({ permission: 'plan' }, f.builder.id).permission, 'plan');
  } finally { await f.close(); }
});

test('a successfully restarted blocked task resolves its prior notices without affecting other tasks', async () => {
  const f = fixture({ agentExecutor: async () => success('未生成产物') });
  try {
    const task = taskFor(f);
    await until(() => f.service.require('tasks', task.id).status === 'blocked' && f.service.active.size === 0);
    const oldNotices = f.service.store.list('notices').filter((notice) => notice.taskId === task.id && !notice.resolved);
    assert.ok(oldNotices.length > 0);
    const unrelated = f.service.notice('decision', '其他任务待处理', { taskId: 'unrelated-task', roomId: 'team' });
    f.service.updateSettings({ paused: true });
    f.service.startTask(task.id);
    assert.equal(f.service.require('tasks', task.id).status, 'running');
    assert.ok(oldNotices.every((notice) => f.service.require('notices', notice.id).resolved));
    assert.equal(f.service.require('notices', unrelated.id).resolved, false);
  } finally { await f.close(); }
});

test('a meeting reserves a member between rounds after its current run has completed', async () => {
  let releasePeer;
  const f = fixture({ agentExecutor: async (member, prompt, { signal }) => {
    if (member.handle === 'reviewer' && prompt.includes('Round 1:')) {
      return new Promise((resolve) => {
        releasePeer = () => resolve(success('同伴第一轮结束'));
        signal.addEventListener('abort', () => resolve({ ...success(), cancelled: true }), { once: true });
      });
    }
    return success('当前轮意见完成');
  } });
  try {
    const meeting = f.service.createMeeting({ roomId: 'team', objective: '多轮比较设计', memberIds: [f.builder.id, f.reviewer.id] });
    await until(() => releasePeer && f.service.store.list('runs').some((run) => run.meetingId === meeting.id &&
      run.memberId === f.builder.id && run.status === 'succeeded') &&
      ![...f.service.active.values()].some((entry) => entry.memberId === f.builder.id));
    assert.equal(f.service.require('meetings', meeting.id).phase, 'independent');
    assert.ok(f.service.store.list('runs').filter((run) => run.memberId === f.builder.id).every((run) => run.status === 'succeeded'));
    assert.throws(() => f.service.saveMember({ model: 'different-between-rounds' }, f.builder.id), { status: 409 });
    assert.equal(f.service.saveMember({ skills: '可补充讨论专长', permission: 'edit' }, f.builder.id).skills, '可补充讨论专长');
    releasePeer();
    await until(() => f.service.require('meetings', meeting.id).phase === 'complete' && f.service.active.size === 0);
    assert.equal(f.service.saveMember({ model: 'changed-after-meeting' }, f.builder.id).model, 'changed-after-meeting');
  } finally { releasePeer?.(); await f.close(); }
});

test('discovery cannot replace a reserved member executable when its configured file disappears', async () => {
  const f = fixture({ detect: () => ({ executable: process.execPath, prefixArgs: ['discovered-entry.mjs'] }) });
  try {
    const oldExecutable = path.join(f.root, 'configured-cli.exe');
    fs.writeFileSync(oldExecutable, 'test placeholder; execution remains paused');
    f.service.saveMember({ provider: 'codex', executable: oldExecutable, prefixArgs: ['original-entry.mjs'] }, f.builder.id);
    f.service.updateSettings({ paused: true });
    const run = enqueueChat(f);
    // Model a client installation disappearing while a previously admitted run is queued.
    fs.unlinkSync(oldExecutable);
    f.service.discover();
    const reserved = f.service.require('members', f.builder.id);
    assert.equal(reserved.executable, oldExecutable);
    assert.deepEqual(reserved.prefixArgs, ['original-entry.mjs']);
    f.service.cancelRun(run.id);
    f.service.discover();
    const available = f.service.require('members', f.builder.id);
    assert.equal(available.executable, process.execPath);
    assert.deepEqual(available.prefixArgs, ['discovered-entry.mjs']);
  } finally { await f.close(); }
});
