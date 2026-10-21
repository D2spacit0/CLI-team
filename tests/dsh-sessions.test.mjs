import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { DshSessionCatalog, readSessionSnapshot } from '../server/dsh-sessions.mjs';
import { fixture, temporary, cleanup } from './helpers.mjs';

const header = (extra = {}) => ({ type: 'session', id: 'research-session', version: 3, createdAt: 1789600000000,
  cwd: process.cwd(), delegationDepth: 0, ...extra });
const event = (type, data) => ({ type, seq: 1, time: 1789600001000, data });
const frame = (value) => zstdCompressSync(Buffer.from(`${JSON.stringify(value)}\n`));

test('read-only DSH snapshot reads all concatenated frames and redacts secrets', () => {
  const root = temporary();
  try {
    const filename = path.join(root, 'session.v3.jsonl.zstd');
    const bytes = Buffer.concat([
      frame(header()), frame(event('session/title', { title: '研究任务' })),
      frame(event('turn/start', {})), frame(event('assistant/message', {
        message: { content: [{ type: 'text', text: '研究结论 api_key=not-for-ui' }] },
      })), frame(event('tool/call', { name: 'write_report' })),
    ]);
    fs.writeFileSync(filename, bytes);
    const snapshot = readSessionSnapshot(filename);
    assert.equal(snapshot.title, '研究任务');
    assert.equal(snapshot.activity, 'running');
    assert.equal(snapshot.eventCount, 4);
    assert.equal(snapshot.canControl, false);
    assert.ok(snapshot.summary.includes('[REDACTED]'));
    assert.equal(createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
      createHash('sha256').update(bytes).digest('hex'));
    fs.appendFileSync(filename, frame(event('turn/end', { reason: { kind: 'completed' } })));
    assert.equal(readSessionSnapshot(filename).activity, 'idle');
  } finally { cleanup(root); }
});

test('incomplete trailing frame is observable and a corrupt completed frame is rejected', () => {
  const root = temporary();
  try {
    const filename = path.join(root, 'session.v3.jsonl.zstd');
    const last = frame(event('assistant/message', { message: { content: 'unfinished' } }));
    fs.writeFileSync(filename, Buffer.concat([frame(header()), last.subarray(0, last.length - 4)]));
    assert.equal(readSessionSnapshot(filename).partial, true);
    fs.writeFileSync(filename, Buffer.concat([frame(header()), Buffer.from('not-zstd')]));
    assert.throws(() => readSessionSnapshot(filename), /压缩数据/);
  } finally { cleanup(root); }
});

test('catalog ignores descendants and never falls back from a newer session generation', () => {
  const root = temporary();
  try {
    for (const name of ['root', 'child', 'newer']) fs.mkdirSync(path.join(root, 'sessions', 'project', name), { recursive: true });
    const write = (name, version, value) => fs.writeFileSync(path.join(root, 'sessions', 'project', name, `session.v${version}.jsonl`), `${JSON.stringify(value)}\n`);
    write('root', 3, header());
    write('child', 3, header({ id: 'child', delegationDepth: 1 }));
    write('newer', 3, header({ id: 'newer' }));
    write('newer', 5, header({ id: 'newer', version: 5 }));
    const catalog = new DshSessionCatalog(root);
    const result = catalog.list();
    assert.equal(result.sessions.length, 1);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].error, /v5/);
    assert.throws(() => catalog.get('../escape'), /不存在/);
  } finally { cleanup(root); }
});

test('v4 snapshots read native message and model events without surfacing subagent sessions', () => {
  const root = temporary();
  try {
    const folder = path.join(root, 'sessions', 'project', 'native-v4');
    fs.mkdirSync(folder, { recursive: true });
    const filename = path.join(folder, 'session.v4.jsonl.zstd');
    const bytes = Buffer.concat([
      frame(header({ id: 'native-v4', version: 4, isSeeded: false })),
      frame(event('user/message', { role: 'user', content: [{ type: 'text', text: '新版中的用户请求' }] })),
      frame(event('request/context', { provider: 'local', model: 'qwen38', contextWindow: 130000 })),
      frame(event('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '新版回复' }] } })),
      frame(event('turn/end', { reason: { kind: 'completed' } })),
    ]);
    fs.writeFileSync(filename, bytes);
    const catalog = new DshSessionCatalog(root);
    const snapshot = catalog.get('native-v4');
    assert.equal(snapshot.lastRequest, '新版中的用户请求');
    assert.equal(snapshot.summary, '新版回复');
    assert.equal(snapshot.model, 'qwen38');
    assert.equal(snapshot.provider, 'local');
    assert.equal(snapshot.activity, 'idle');
    assert.equal(snapshot.formatVersion, 4);
    assert.equal(snapshot.canControl, false);
    assert.deepEqual(fs.readFileSync(filename), bytes);
    for (const [name, lineage] of [['parent', { parentSession: 'native-v4' }], ['origin', { origin: 'subagent' }]]) {
      const child = path.join(root, 'sessions', 'project', name);
      fs.mkdirSync(child);
      fs.writeFileSync(path.join(child, 'session.v4.jsonl'), JSON.stringify(header({ id: name, version: 4, isSeeded: true, ...lineage })) + '\n');
    }
    assert.equal(catalog.list().sessions.length, 1);
    assert.throws(() => catalog.get('parent'), /不存在/);
    assert.throws(() => catalog.get('origin'), /不存在/);
  } finally { cleanup(root); }
});

test('ambiguous encodings of the same generation are reported instead of arbitrarily selected', () => {
  const root = temporary();
  try {
    const directory = path.join(root, 'sessions', 'project', 'research-session');
    fs.mkdirSync(directory, { recursive: true });
    const plain = path.join(directory, 'session.v3.jsonl');
    fs.writeFileSync(plain, `${JSON.stringify(header())}\n`);
    const catalog = new DshSessionCatalog(root);
    assert.equal(catalog.list().sessions.length, 1);
    fs.writeFileSync(`${plain}.zstd`, frame(header()));
    const result = catalog.list();
    assert.equal(result.sessions.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].error, /多个编码/);
    assert.throws(() => catalog.get('research-session'), /多个编码/);
    fs.unlinkSync(plain);
    assert.equal(catalog.get('research-session').sessionId, 'research-session');
  } finally { cleanup(root); }
});

test('importing a running external task is idempotent observation and never enqueues work', async () => {
  let sequence = 1;
  const f = fixture({ dshCatalog: {
    get: (sessionId) => ({ sessionId, title: '研究', mode: 'observe', canControl: false, activity: 'running', eventCount: sequence++ }),
  } });
  try {
    const first = f.service.importDshSession({ sessionId: 'research' });
    const second = f.service.importDshSession({ sessionId: 'research' });
    assert.equal(first.id, second.id);
    assert.equal(f.service.bootstrap().externalSessions.length, 1);
    assert.equal(f.service.store.list('runs').length, 0);
    assert.equal(second.canControl, false);
    assert.equal(second.eventCount, 2);
  } finally { await f.close(); }
});

test('direct lookup keeps an imported session available beyond the newest 100', () => {
  const root = temporary();
  try {
    for (let index = 0; index < 101; index++) {
      const id = `session-${String(index).padStart(3, '0')}`;
      const directory = path.join(root, 'sessions', 'project', id);
      fs.mkdirSync(directory, { recursive: true });
      const filename = path.join(directory, 'session.v3.jsonl');
      fs.writeFileSync(filename, `${JSON.stringify(header({ id }))}\n`);
      fs.utimesSync(filename, 1789600000 + index, 1789600000 + index);
    }
    const catalog = new DshSessionCatalog(root);
    assert.equal(catalog.list().sessions.length, 100);
    assert.equal(catalog.list().sessions.some((item) => item.sessionId === 'session-000'), false);
    assert.equal(catalog.get('session-000').sessionId, 'session-000');
  } finally { cleanup(root); }
});
