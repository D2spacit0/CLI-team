import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { materialLimits } from '../server/materials.mjs';
import {
  addTaskInputFiles, defaultMaterialLimits, encodeMaterialFile, importTaskInputs, removeTaskInput,
  restoreTaskInputs, serializeTaskInputs, validateMaterialFiles,
} from '../ui/taskInputFiles.ts';

const file = (name, text = name) => new File([text], name);
const selection = (...files) => addTaskInputFiles([], files).items;
const material = (name, text = name) => ({
  id: `material-${name}`, name, size: Buffer.byteLength(text), relativePath: `inputs/${name}`,
  sha256: createHash('sha256').update(text).digest('hex'), importedAt: new Date().toISOString(), integrity: 'verified',
});
function memoryTransport(initial = []) {
  const state = { materials: initial, uploads: [], removed: [], reads: 0, locked: false, beforeImport: null, afterImport: null, onRead: null };
  const transport = {
    getMaterials: async (taskId) => {
      state.reads++;
      await state.onRead?.(state);
      return { taskId, locked: state.locked, limits: defaultMaterialLimits, materials: state.materials.map((item) => ({ ...item })) };
    },
    importMaterial: async (taskId, name, contentBase64, sha256) => {
      state.uploads.push({ taskId, name });
      await state.beforeImport?.(name);
      assert.equal(state.materials.some((item) => item.name.toLowerCase() === name.toLowerCase()), false, 'duplicate POST must not happen');
      const bytes = Buffer.from(contentBase64, 'base64');
      assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
      const record = { id: `material-${name}`, name, relativePath: `inputs/${name}`, size: bytes.length,
        sha256, importedAt: new Date().toISOString(), integrity: 'verified' };
      state.materials.push(record);
      await state.afterImport?.(name);
      return record;
    },
    removeMaterial: async (taskId, id) => {
      state.removed.push(id);
      state.materials = state.materials.filter((item) => item.id !== id);
      return transport.getMaterials(taskId);
    },
  };
  return { state, transport };
}
const imports = (f, items, options = {}, onUpdate = () => {}) => importTaskInputs('draft-1', items, onUpdate, { transport: f.transport, ...options });

test('pre-task file limits match the service and reject duplicate selections, counts, and combined size', () => {
  assert.deepEqual(defaultMaterialLimits, materialLimits);
  assert.match(validateMaterialFiles([{ name: 'a.txt', size: 1 }, { name: 'A.txt', size: 1 }]), /同名/);
  assert.match(validateMaterialFiles([{ name: 'big.bin', size: materialLimits.maxFileBytes + 1 }]), /上限/);
  assert.match(validateMaterialFiles(Array.from({ length: 65 }, (_, i) => ({ name: `${i}.txt`, size: 0 }))), /数量/);
  assert.match(validateMaterialFiles(Array.from({ length: 5 }, (_, i) => ({ name: `${i}.txt`, size: materialLimits.maxFileBytes }))), /合计/);
  assert.equal(validateMaterialFiles([{ name: 'max.bin', size: materialLimits.maxFileBytes }]), '');
  for (const name of ['.env', 'credentials.json', 'CON.txt', 'C:\\private.txt', '/private', '../a.txt', 'a.']) {
    assert.match(validateMaterialFiles([{ name, size: 1 }]), /名称无效/, name);
  }
});

test('encoding hashes and imports the same single read of binary data, including an empty file', async () => {
  for (const bytes of [Buffer.from([0, 255, 128, 2, 13, 10]), Buffer.alloc(0)]) {
    const input = file('binary.bin', bytes);
    let reads = 0;
    const read = input.arrayBuffer.bind(input);
    input.arrayBuffer = async () => { reads++; return read(); };
    const encoded = await encodeMaterialFile(input);
    assert.equal(reads, 1);
    assert.equal(encoded.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(Buffer.from(encoded.contentBase64, 'base64'), bytes);
  }
});

test('a rejected selection keeps existing files; a missing file can be reselected by name', () => {
  const original = selection(file('a.txt'));
  const duplicate = addTaskInputFiles(original, [file('b.txt'), file('A.txt')]);
  assert.match(duplicate.error, /已选择/);
  assert.deepEqual(duplicate.items, original);
  const recovered = restoreTaskInputs([{ name: 'a.txt', status: 'selected' }]);
  assert.match(addTaskInputFiles(recovered, [file('b.txt')], undefined, recovered[0].id).error, /同名/);
  const selected = addTaskInputFiles(recovered, [file('a.txt')]);
  assert.equal(selected.error, undefined);
  assert.equal(selected.items[0].id, recovered[0].id);
  assert.equal(selected.items[0].status, 'selected');
  assert.ok(selected.items[0].file);
});

test('saved drafts retain only the bounded material manifest; restarting cannot recover File objects or raw paths', () => {
  const items = selection(file('notes.txt'));
  Object.assign(items[0], { sha256: 'a'.repeat(64), materialId: 'material-1', error: 'C:\\Users\\private.txt', sourcePath: '/private/a' });
  Object.defineProperty(items[0].file, 'path', { value: 'C:\\Users\\private.txt' });
  const saved = serializeTaskInputs(items);
  assert.deepEqual(saved, [{ id: items[0].id, name: 'notes.txt', size: 9, status: 'selected', sha256: 'a'.repeat(64), materialId: 'material-1' }]);
  assert.equal(JSON.stringify(saved).includes('private'), false);
  const restored = restoreTaskInputs([...saved, { name: 'done.txt', status: 'imported', sha256: 'b'.repeat(64) }, { name: 'C:\\private', status: 'imported' }]);
  assert.equal(restored.length, 2);
  assert.equal(restored[0].status, 'missing');
  assert.equal(restored[1].status, 'imported');
  assert.ok(restored.every((item) => !item.file));
  assert.equal(restored[0].id, items[0].id);
  assert.equal(restored[0].sha256, 'a'.repeat(64));
  assert.equal(restored[0].materialId, 'material-1');
});

test('failure keeps completed imports and selected files; single-file retry never uploads earlier successes again', async () => {
  const f = memoryTransport();
  let fail = true;
  f.state.beforeImport = (name) => { if (name === 'b.txt' && fail) { fail = false; throw new Error('temporary failure'); } };
  const updates = [];
  const first = await imports(f, selection(file('a.txt'), file('b.txt'), file('c.txt')), {}, (items) => updates.push(items));
  assert.equal(first.complete, false);
  assert.deepEqual(first.items.map((item) => item.status), ['imported', 'failed', 'selected']);
  assert.match(first.error, /b.txt/);
  assert.ok(first.items[1].file);
  assert.ok(updates.some((items) => items[1].status === 'uploading'));
  const second = await imports(f, first.items, { onlyId: first.items[1].id });
  assert.equal(second.complete, false, 'one retry must not claim remaining unimported files are ready');
  assert.deepEqual(second.items.map((item) => item.status), ['imported', 'imported', 'selected']);
  const final = await imports(f, second.items);
  assert.equal(final.complete, true);
  assert.deepEqual(f.state.uploads.map((item) => item.name), ['a.txt', 'b.txt', 'b.txt', 'c.txt']);
  assert.ok(f.state.uploads.every((item) => item.taskId === 'draft-1'));
  const repeated = await imports(f, final.items);
  assert.equal(repeated.complete, true);
  assert.equal(f.state.uploads.length, 4);
});

test('a lost successful upload response is reconciled before retry and does not duplicate the import', async () => {
  const f = memoryTransport();
  f.state.afterImport = () => { throw new Error('connection lost after commit'); };
  const first = await imports(f, selection(file('a.txt')));
  assert.equal(first.complete, true);
  assert.equal(first.items[0].status, 'imported');
  assert.equal((await imports(f, first.items)).complete, true);
  assert.equal(f.state.uploads.length, 1);
});

test('a restored draft reuses verified imported files but cannot start until remaining files are reselected', async () => {
  const f = memoryTransport([material('a.txt')]);
  const restored = restoreTaskInputs([{ name: 'a.txt', status: 'imported', sha256: material('a.txt').sha256,
    materialId: material('a.txt').id }, { name: 'b.txt', status: 'selected' }]);
  const waiting = await imports(f, restored);
  assert.equal(waiting.complete, false);
  assert.deepEqual(waiting.items.map((item) => item.status), ['imported', 'missing']);
  assert.equal(f.state.uploads.length, 0);
  const attached = addTaskInputFiles(waiting.items, [file('b.txt')]).items;
  const final = await imports(f, attached);
  assert.equal(final.complete, true);
  assert.deepEqual(f.state.uploads.map((item) => item.name), ['b.txt']);
});

test('an unconfirmed saved selection cannot claim a coincidentally same-named server material without its File', async () => {
  const f = memoryTransport([material('a.txt', 'different contents')]);
  const items = restoreTaskInputs([{ name: 'a.txt', status: 'selected' }]);
  const missing = await imports(f, items);
  assert.equal(missing.complete, false);
  const attached = addTaskInputFiles(missing.items, [file('a.txt')]).items;
  const conflict = await imports(f, attached);
  assert.equal(conflict.complete, false);
  assert.match(conflict.items[0].error, /内容不同/);
  assert.equal(f.state.uploads.length, 0);
  assert.equal(f.state.materials[0].sha256, material('a.txt', 'different contents').sha256);
});

test('a persisted hash reconciles an interrupted upload without requiring the already imported File again', async () => {
  const f = memoryTransport([material('a.txt')]);
  const saved = restoreTaskInputs([{ name: 'a.txt', status: 'selected', sha256: material('a.txt').sha256 }]);
  const result = await imports(f, saved);
  assert.equal(result.complete, true);
  assert.equal(result.items[0].materialId, material('a.txt').id);
  assert.equal(f.state.uploads.length, 0);
});

test('legacy imported labels without hashes and replaced material identities never authorize a start', async () => {
  const f = memoryTransport([material('a.txt')]);
  const old = await imports(f, restoreTaskInputs([{ name: 'a.txt', status: 'imported' }]));
  assert.equal(old.complete, false);
  assert.equal(old.items[0].status, 'missing');
  const replaced = await imports(f, restoreTaskInputs([{ name: 'a.txt', status: 'imported',
    sha256: material('a.txt').sha256, materialId: 'material-before' }]));
  assert.equal(replaced.complete, false);
  assert.equal(f.state.uploads.length, 0);
  const reselected = addTaskInputFiles(replaced.items, [file('a.txt')]).items;
  assert.equal((await imports(f, reselected)).complete, true);
  assert.equal(f.state.uploads.length, 0);
});

test('already imported input version changes cannot be silently reused or overwritten', async () => {
  const f = memoryTransport();
  const first = await imports(f, selection(file('a.txt')));
  f.state.materials = [material('a.txt', 'new external version')];
  const changed = await imports(f, first.items);
  assert.equal(changed.complete, false);
  assert.equal(changed.items[0].status, 'failed');
  assert.equal(f.state.uploads.length, 1);
});

test('a locked task or changed input never reports ready, including a draft with zero selected files', async () => {
  const locked = memoryTransport();
  locked.state.locked = true;
  assert.equal((await imports(locked, [])).complete, false);
  const changed = memoryTransport([{ ...material('a.txt'), integrity: 'changed' }]);
  const result = await imports(changed, selection(file('b.txt')));
  assert.equal(result.complete, false);
  assert.match(result.error, /变化或缺失/);
  assert.equal(changed.state.uploads.length, 0);
});

test('zero materials can be ready and current server limits are checked before an upload', async () => {
  const f = memoryTransport();
  assert.equal((await imports(f, [])).complete, true);
  const transport = { ...f.transport, getMaterials: async (taskId) => ({
    ...(await f.transport.getMaterials(taskId)), limits: { ...defaultMaterialLimits, maxFileBytes: 2 },
  }) };
  const result = await importTaskInputs('draft-1', selection(file('a.txt', 'three')), () => {}, { transport });
  assert.equal(result.complete, false);
  assert.match(result.error, /上限/);
  assert.equal(f.state.uploads.length, 0);
});

test('overlapping import requests are rejected and an interrupted owner cannot mark a task ready', async () => {
  const f = memoryTransport();
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  f.state.afterImport = async () => { entered(); await new Promise((resolve) => { release = resolve; }); };
  const items = selection(file('a.txt'));
  let active = true;
  let updates = 0;
  const first = imports(f, items, { isCurrent: () => active }, () => { updates++; });
  await started;
  const duplicate = await imports(f, items);
  assert.equal(duplicate.complete, false);
  assert.match(duplicate.error, /正在导入/);
  active = false;
  const beforeRelease = updates;
  release();
  const stopped = await first;
  assert.equal(stopped.complete, false);
  assert.equal(updates, beforeRelease);
  const retried = await imports(f, items);
  assert.equal(retried.complete, true);
  assert.equal(f.state.uploads.length, 1);
});

test('last material verification detects input drift before reporting ready', async () => {
  const f = memoryTransport();
  f.state.onRead = (state) => { if (state.reads === 2) state.materials[0].integrity = 'missing'; };
  const result = await imports(f, selection(file('a.txt')));
  assert.equal(result.complete, false);
  assert.match(result.error, /变化或缺失/);
  assert.equal(result.items[0].status, 'failed');
  assert.equal(result.items[0].verified, false);
});

test('removing a prepared material checks its identity and leaves other files untouched', async () => {
  const f = memoryTransport([material('a.txt'), material('b.txt')]);
  const result = await imports(f, selection(file('a.txt')));
  await removeTaskInput('draft-1', result.items[0], f.transport);
  assert.deepEqual(f.state.materials.map((item) => item.name), ['b.txt']);
  await removeTaskInput('draft-1', result.items[0], f.transport);
  assert.equal(f.state.removed.length, 1);
  f.state.materials.push(material('a.txt', 'new version'));
  await assert.rejects(removeTaskInput('draft-1', result.items[0], f.transport), /已经变化/);
  assert.equal(f.state.materials.length, 2);
});
