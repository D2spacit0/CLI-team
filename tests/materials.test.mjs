import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { decodeMaterial, materialLimits, materialName } from '../server/materials.mjs';
import { fixture, success, until, writeDeliverable } from './helpers.mjs';

const upload = (name = 'reference.txt', bytes = Buffer.from('unchanged reference')) => ({
  name, contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'),
});
const create = (f, extra = {}) => f.service.createTask({
  title: 'Materials', objective: 'Use only selected copies', assigneeId: f.builder.id, ...extra,
});

test('draft material import preserves exact binary bytes and returns metadata without source paths or contents', async () => {
  const f = fixture();
  try {
    const task = create(f);
    const bytes = Buffer.from([0, 255, 10, 128, 1]);
    const record = f.service.importMaterial(task.id, upload('chapters/chapter-4.bin', bytes));
    assert.equal(record.relativePath, 'inputs/chapters/chapter-4.bin');
    assert.deepEqual(fs.readFileSync(path.join(task.workspace, record.relativePath)), bytes);
    assert.equal(record.integrity, 'verified');
    const list = f.service.taskMaterials(task.id);
    assert.equal(list.materials.length, 1);
    assert.equal(list.locked, false);
    assert.equal(JSON.stringify(list).includes('contentBase64'), false);
    assert.equal(JSON.stringify(list).includes('sourcePath'), false);
    assert.deepEqual(f.service.store.list('artifacts'), []);
    const removed = f.service.removeMaterial(task.id, record.id);
    assert.equal(removed.materials.length, 0);
    assert.equal(fs.existsSync(path.join(task.workspace, record.relativePath)), false);
  } finally { await f.close(); }
});

test('material parsing rejects traversal, Windows special paths, credential filenames and noncanonical Base64', () => {
  for (const name of ['../escape', '/root', 'C:/root', 'a\\b', 'a:stream', 'a//b', '.env',
    'dir/.env.local', 'credentials.json', 'key.pem', 'NUL.txt', 'com1.db', 'a.', 'a ', 'a/\u0000b',
    'node_modules/a', 'a/.git/config', '__pycache__/a', 'a/../b']) {
    assert.throws(() => materialName(name), /材料名称无效/, name);
  }
  for (const contentBase64 of ['@@==', 'AA', 'AAAA\n', 'AAAA====', 'AB==']) {
    assert.throws(() => decodeMaterial({ ...upload(), contentBase64 }));
  }
  assert.throws(() => decodeMaterial({ ...upload(), sha256: '0'.repeat(64) }), /SHA-256/);
  assert.throws(() => decodeMaterial({ ...upload(), sourcePath: 'C:/private.txt' }));
  assert.deepEqual(decodeMaterial(upload('empty.txt', Buffer.alloc(0))).bytes, Buffer.alloc(0));
});

test('file and task size limits are enforced, including the exact file boundary', async () => {
  assert.equal(decodeMaterial(upload('max.bin', Buffer.alloc(materialLimits.maxFileBytes))).bytes.length, materialLimits.maxFileBytes);
  assert.throws(() => decodeMaterial(upload('big.bin', Buffer.alloc(materialLimits.maxFileBytes + 1))));
  const f = fixture();
  try {
    const task = create(f);
    f.service.store.update('tasks', task.id, { materials: [{ size: materialLimits.maxTaskBytes, relativePath: 'inputs/existing' }] });
    assert.throws(() => f.service.importMaterial(task.id, upload()), /材料达到上限/);
    f.service.store.update('tasks', task.id, { materials: Array.from({ length: 64 }, (_, i) => ({ size: 0, relativePath: `inputs/${i}` })) });
    assert.throws(() => f.service.importMaterial(task.id, upload('empty.txt', Buffer.alloc(0))), /材料达到上限/);
  } finally { await f.close(); }
});

test('duplicate names, existing files and conflicting directories cannot be overwritten', async () => {
  const f = fixture();
  try {
    const task = create(f);
    const input = upload();
    f.service.importMaterial(task.id, input);
    assert.throws(() => f.service.importMaterial(task.id, input), /不能覆盖/);
    assert.throws(() => f.service.importMaterial(task.id, { ...input, name: 'REFERENCE.txt' }), /不能覆盖/);
    assert.throws(() => f.service.importMaterial(task.id, upload('reference.txt/child.txt')), /不能覆盖/);
    const existing = path.join(task.workspace, 'inputs', 'unregistered.txt');
    fs.writeFileSync(existing, 'user work');
    assert.throws(() => f.service.importMaterial(task.id, upload('unregistered.txt')), /不能覆盖/);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'user work');
    assert.equal(f.service.taskMaterials(task.id).materials.length, 1);
  } finally { await f.close(); }
});

test('links in input paths are rejected without changing their target', async () => {
  const f = fixture();
  try {
    const task = create(f);
    const outside = path.join(f.root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(task.workspace, 'inputs'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.service.importMaterial(task.id, upload()), /链接/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { await f.close(); }
});

test('inputs alone and new files inside inputs never count as deliverables', async () => {
  const f = fixture({ agentExecutor: async (_member, _prompt, { workspace }) => {
    fs.writeFileSync(path.join(workspace, 'inputs', 'not-a-deliverable.txt'), 'extra input');
    return success();
  } });
  try {
    const task = create(f);
    f.service.importMaterial(task.id, upload());
    f.service.startTask(task.id);
    await until(() => f.service.require('tasks', task.id).status === 'blocked');
    assert.match(f.service.require('tasks', task.id).summary, /没有生成任何任务产物/);
    assert.deepEqual(f.service.store.list('artifacts'), []);
  } finally { await f.close(); }
});

test('input tampering and missing input block before invoking the member', async () => {
  for (const mode of ['changed', 'missing']) {
    let calls = 0;
    const f = fixture({ agentExecutor: async () => { calls++; return success(); } });
    try {
      const task = create(f);
      const record = f.service.importMaterial(task.id, upload());
      const file = path.join(task.workspace, record.relativePath);
      if (mode === 'changed') fs.writeFileSync(file, 'tampered');
      else fs.unlinkSync(file);
      assert.equal(f.service.taskMaterials(task.id).materials[0].integrity, mode);
      f.service.startTask(task.id);
      await until(() => f.service.require('tasks', task.id).status === 'blocked');
      assert.equal(calls, 0);
      assert.ok(f.service.store.list('runs')[0].riskFlags.includes('input_integrity_changed'));
    } finally { await f.close(); }
  }
});

test('a claimed successful edit cannot hide input tampering or advance to verification', async () => {
  let verified = false;
  const f = fixture({ agentExecutor: async (_member, _prompt, { workspace }) => {
    writeDeliverable(workspace);
    fs.appendFileSync(path.join(workspace, 'inputs', 'reference.txt'), 'tampered');
    return success('All done');
  }, verifier: async () => { verified = true; return { passed: true }; } });
  try {
    const task = create(f, { verification: { executable: process.execPath, args: [] } });
    f.service.importMaterial(task.id, upload());
    f.service.startTask(task.id);
    await until(() => f.service.require('tasks', task.id).status === 'blocked');
    assert.equal(verified, false);
    assert.match(f.service.require('tasks', task.id).summary, /输入材料/);
    assert.ok(f.service.store.list('runs')[0].riskFlags.includes('input_integrity_changed'));
  } finally { await f.close(); }
});

test('material import and removal lock on first start, even while queued or after failure', async () => {
  const f = fixture({ agentExecutor: async () => success() });
  try {
    f.service.updateSettings({ paused: true });
    const task = create(f);
    const record = f.service.importMaterial(task.id, upload());
    f.service.startTask(task.id);
    assert.equal(f.service.taskMaterials(task.id).locked, true);
    assert.throws(() => f.service.importMaterial(task.id, upload('other.txt')), /首次启动前/);
    assert.throws(() => f.service.removeMaterial(task.id, record.id), /首次启动前/);
    f.service.updateSettings({ paused: false });
    await until(() => f.service.require('tasks', task.id).status === 'blocked');
    assert.throws(() => f.service.importMaterial(task.id, upload('other.txt')), /首次启动前/);
  } finally { await f.close(); }
});

test('material removal refuses changed user work and tolerates a missing draft input', async () => {
  const f = fixture();
  try {
    const task = create(f);
    const record = f.service.importMaterial(task.id, upload());
    const file = path.join(task.workspace, record.relativePath);
    fs.writeFileSync(file, 'user work');
    assert.throws(() => f.service.removeMaterial(task.id, record.id), /拒绝删除/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'user work');
    fs.unlinkSync(file);
    assert.equal(f.service.removeMaterial(task.id, record.id).materials.length, 0);
  } finally { await f.close(); }
});

test('a material-backed task passes normal review, but input edits after review invalidate acceptance', async () => {
  const prompts = [];
  const f = fixture({ agentExecutor: async (member, prompt, { workspace }) => {
    prompts.push(prompt);
    if (member.permission === 'edit') writeDeliverable(workspace);
    return success('Checked', { verdict: member.role === 'reviewer' ? 'approve' : 'none' });
  }, verifier: async () => ({ passed: true, exitCode: 0, testCount: 1, skipped: 0 }) });
  try {
    const task = create(f, { reviewerId: f.reviewer.id, verification: { executable: process.execPath, args: [] } });
    const material = f.service.importMaterial(task.id, upload());
    f.service.startTask(task.id);
    await until(() => f.service.require('tasks', task.id).status === 'review');
    assert.equal(f.service.require('tasks', task.id).gate.status, 'passed');
    assert.deepEqual(f.service.store.list('artifacts').map((item) => item.relativePath), ['result.mjs']);
    assert.ok(prompts.every((prompt) => prompt.includes('inputs/reference.txt') && prompt.includes('Inputs alone are not deliverables')));
    fs.writeFileSync(path.join(task.workspace, material.relativePath), 'changed after review');
    assert.throws(() => f.service.acceptTask(task.id, { note: 'Checked' }), /产物已变化/);
    assert.equal(f.service.require('tasks', task.id).gate.status, 'stale');
  } finally { await f.close(); }
});

test('HTTP material uploads use a route-specific limit and keep local origin and JSON protections', async () => {
  const f = fixture();
  const app = createApp(f.service);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const task = create(f);
  const route = `${url}/api/tasks/${task.id}/materials`;
  const headers = { 'Content-Type': 'application/json' };
  try {
    const body = JSON.stringify(upload('large.bin', Buffer.alloc(300 * 1024)));
    const response = await fetch(route, { method: 'POST', headers, body });
    assert.equal(response.status, 201);
    const material = await response.json();
    assert.equal(material.size, 300 * 1024);
    assert.equal((await fetch(`${url}/api/rooms`, { method: 'POST', headers, body })).status, 413);
    assert.equal((await fetch(route, { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' }, body })).status, 403);
    assert.equal((await fetch(route, { method: 'POST', body: 'plain text' })).status, 415);
    assert.equal((await fetch(route, { method: 'POST', headers, body: JSON.stringify({ sourcePath: 'C:/private' }) })).status, 400);
    assert.equal((await fetch(`${route}/${material.id}`, { method: 'DELETE', headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await fetch(`${route}/${material.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await (await fetch(route)).json()).materials.length, 0);
  } finally {
    app.closeStreams();
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});
