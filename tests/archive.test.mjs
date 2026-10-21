import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, success, until, writeDeliverable } from './helpers.mjs';

const draft = (f, extra = {}) => f.service.createTask({
  title: 'Chapter', objective: 'Write a chapter', assigneeId: f.builder.id, ...extra,
});

test('archiving a task hides its room, artifacts and notices without deleting evidence', async () => {
  const f = fixture({ agentExecutor: async (_member, _prompt, { workspace }) => {
    writeDeliverable(workspace);
    return success();
  } });
  try {
    const task = draft(f, { start: true });
    await until(() => f.service.require('tasks', task.id).status === 'review' && f.service.active.size === 0);
    const runs = f.service.store.list('runs').length;
    f.service.setTaskArchived(task.id, true);
    const hidden = f.service.bootstrap();
    assert.equal(hidden.tasks.length, 0);
    assert.equal(hidden.artifacts.length, 0);
    assert.equal(hidden.runs.length, 0);
    assert.equal(hidden.rooms.length, 1);
    assert.equal(f.service.inbox().pendingCount, 0);
    assert.equal(hidden.archived.tasks, 1);
    assert.equal(f.service.bootstrap({ includeArchived: true }).artifacts.length, 1);
    assert.throws(() => f.service.startTask(task.id), /归档/);
    assert.throws(() => f.service.acceptTask(task.id, { note: 'checked', acknowledgeMissingGate: true }), /归档/);
    assert.throws(() => f.service.cancelTask(task.id), /归档/);
    assert.throws(() => f.service.send(task.roomId, { body: 'hello' }), /归档/);
    assert.ok(fs.existsSync(path.join(task.workspace, 'result.mjs')));
    f.service.setTaskArchived(task.id, false);
    assert.equal(f.service.bootstrap().tasks[0].status, 'review');
    assert.equal(f.service.inbox().pendingCount, 1);
    assert.equal(f.service.store.list('runs').length, runs, 'restore does not replay work');
  } finally { await f.close(); }
});

test('shared channel tasks have independent sessions and input locks', async () => {
  const seen = [];
  const f = fixture({ agentExecutor: async (_member, _prompt, options) => {
    seen.push({ workspace: options.workspace, conversationId: options.conversationId });
    writeDeliverable(options.workspace);
    return { ...success(), conversationId: `session-${seen.length}` };
  } });
  try {
    const room = f.service.createRoom({ name: 'Research' });
    const first = draft(f, { roomId: room.id, start: true });
    await until(() => f.service.active.size === 0 && seen.length === 1);
    const second = draft(f, { roomId: room.id });
    assert.equal(f.service.bootstrap().rooms.length, 2);
    assert.equal(f.service.taskMaterials(second.id).locked, false);
    const bytes = Buffer.from('previous chapter');
    f.service.importMaterial(second.id, { name: 'previous.txt', contentBase64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex') });
    f.service.startTask(second.id);
    await until(() => f.service.active.size === 0 && seen.length === 2);
    f.service.startTask(second.id, 'Revise');
    await until(() => f.service.active.size === 0 && seen.length === 3);
    assert.deepEqual(seen.map((item) => item.conversationId), [null, null, 'session-2']);
    assert.notEqual(seen[0].workspace, seen[1].workspace);
    f.service.resetConversation(room.id, f.builder.id, { confirm: true, taskId: second.id });
    assert.equal(f.service.store.get('conversations', `${second.id}:${f.builder.id}`), null);
    assert.ok(f.service.store.get('conversations', `${first.id}:${f.builder.id}`));
    f.service.setTaskArchived(first.id, true);
    assert.equal(f.service.require('rooms', room.id).archivedAt, undefined);
    assert.throws(() => f.service.setRoomArchived(room.id, true), /未归档任务/);
    f.service.setTaskArchived(second.id, true);
    f.service.setRoomArchived(room.id, true);
    f.service.setTaskArchived(second.id, false);
    assert.equal(f.service.require('rooms', room.id).archivedAt, null);
  } finally { await f.close(); }
});

test('active tasks and channels cannot be hidden and the lobby is permanent', async () => {
  const f = fixture();
  try {
    f.service.updateSettings({ paused: true });
    const task = draft(f, { start: true });
    assert.throws(() => f.service.setTaskArchived(task.id, true), /仍在执行/);
    assert.throws(() => f.service.setRoomArchived(task.roomId, true), /仍在执行/);
    assert.throws(() => f.service.setRoomArchived('team', true), /大厅/);
    const room = f.service.createRoom({ name: 'Discussion' });
    f.service.send(room.id, { body: 'Check', recipientIds: [f.reviewer.id] });
    assert.throws(() => f.service.setRoomArchived(room.id, true), /仍有运行/);
    assert.throws(() => draft(f, { roomId: task.roomId }), /专属频道/);
    f.service.cancelTask(task.id);
    f.service.setTaskArchived(task.id, true);
    assert.throws(() => draft(f, { roomId: task.roomId }), /归档/);
  } finally { await f.close(); }
});

test('legacy dedicated-channel sessions resume and explicit reset clears both mappings', async () => {
  const conversations = [];
  const f = fixture({ agentExecutor: async (_member, _prompt, options) => {
    conversations.push(options.conversationId);
    writeDeliverable(options.workspace);
    return success();
  } });
  try {
    const task = draft(f);
    f.service.store.put('conversations', { id: `${task.roomId}:${f.builder.id}`, conversationId: 'legacy-session' });
    f.service.startTask(task.id);
    await until(() => f.service.active.size === 0 && conversations.length === 1);
    assert.deepEqual(conversations, ['legacy-session']);
    f.service.resetConversation(task.roomId, f.builder.id, { confirm: true });
    assert.equal(f.service.store.get('conversations', `${task.roomId}:${f.builder.id}`), null);
    assert.equal(f.service.store.get('conversations', `${task.id}:${f.builder.id}`), null);
    f.service.startTask(task.id, 'revise');
    await until(() => f.service.active.size === 0 && conversations.length === 2);
    assert.deepEqual(conversations, ['legacy-session', null]);
  } finally { await f.close(); }
});

test('artifact text preview uses verified bytes and rejects unpreviewable files', async () => {
  const f = fixture();
  try {
    const task = draft(f);
    fs.writeFileSync(path.join(task.workspace, 'chapter.txt'), 'A chapter');
    fs.writeFileSync(path.join(task.workspace, 'app.html'), '<script>bad()</script>');
    const { manifest } = await import('../server/safety.mjs');
    f.service.recordArtifacts(task, manifest(task.workspace));
    const files = f.service.store.list('artifacts');
    const chapter = files.find((item) => item.name === 'chapter.txt');
    assert.equal(f.service.artifactPreview(chapter.id).text, 'A chapter');
    assert.throws(() => f.service.artifactPreview(files.find((item) => item.name === 'app.html').id), /下载/);
    fs.writeFileSync(path.join(task.workspace, 'chapter.txt'), 'changed');
    assert.throws(() => f.service.artifactPreview(chapter.id), /改变/);
  } finally { await f.close(); }
});
