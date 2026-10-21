import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TeamService } from '../server/service.mjs';
import { childEnvironment } from '../server/safety.mjs';
import { UiDrafts } from '../server/ui-drafts.mjs';
import { fixture, cleanup } from './helpers.mjs';

test('room creation returns one durable receipt across retries, restart and later archive', async () => {
  const f = fixture();
  let restarted, originalClosed = false;
  try {
    const input = { requestId: randomUUID(), name: '  可恢复的频道  ' };
    const room = f.service.createRoom(input);
    assert.equal(room.name, '可恢复的频道');
    assert.equal(f.service.createRoom({ ...input, name: room.name }).id, room.id);
    f.service.setRoomArchived(room.id, true);
    await f.service.close();
    originalClosed = true;
    restarted = new TeamService({ root: f.root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }) });
    const recovered = restarted.createRoom(input);
    assert.equal(recovered.id, room.id);
    assert.ok(recovered.archivedAt, 'Receipt recovery must not silently restore an archived room');
    assert.equal(restarted.store.list('rooms').length, 2);
    assert.throws(() => restarted.createRoom({ ...input, name: '另一个名字' }), error => error.status === 409);
    assert.equal(restarted.store.list('roomRequests').length, 1);
  } finally { await restarted?.close(); if (originalClosed) cleanup(f.root); else await f.close(); }
});

test('failed room receipt persistence leaves no channel and permits one clean retry', async () => {
  const f = fixture();
  try {
    const s = f.service, put = s.store.put.bind(s.store), events = [];
    s.on('change', event => events.push(event));
    const input = { requestId: randomUUID(), name: '整体创建' };
    s.store.put = (kind, value) => { if (kind === 'roomRequests') throw new Error('receipt write failed'); return put(kind, value); };
    assert.throws(() => s.createRoom(input), /receipt write failed/);
    assert.equal(s.store.list('rooms').length, 1);
    assert.equal(s.store.list('roomRequests').length, 0);
    assert.equal(events.length, 0);
    s.store.put = put;
    const created = s.createRoom(input);
    assert.equal(s.createRoom(input).id, created.id);
    assert.equal(s.store.list('rooms').length, 2);
  } finally { await f.close(); }
});

test('meeting retries recover committed work despite unavailable members or a full queue', async () => {
  const f = fixture();
  try {
    const s = f.service;
    s.updateSettings({ paused: true });
    const input = { requestId: randomUUID(), roomId: 'team', objective: ' 比较选项 ', memberIds: [f.builder.id, f.reviewer.id] };
    const meeting = s.createMeeting(input);
    for (const run of s.store.list('runs')) s.store.update('runs', run.id, { status: 'cancelled' });
    s.store.update('meetings', meeting.id, { phase: 'cancelled' });
    s.saveMember({ enabled: false }, f.builder.id);
    for (let index = 0; index < 50; index++) s.store.put('runs', { id: `capacity-${index}`, status: 'queued', roomId: 'team', memberId: f.builder.id });
    assert.equal(s.createMeeting({ ...input, objective: '比较选项' }).id, meeting.id);
    assert.equal(s.store.list('meetings').length, 1);
    assert.equal(s.store.list('runs').filter(run => run.meetingId === meeting.id).length, 2);
    assert.equal(s.store.list('messages').filter(message => message.kind === 'user').length, 1);
    for (const changes of [{ objective: '不同议题' }, { roomId: 'another-room' }, { memberIds: [...input.memberIds].reverse() }]) {
      assert.throws(() => s.createMeeting({ ...input, ...changes }), error => error.status === 409);
    }
  } finally { await f.close(); }
});

test('meeting receipt survives restart without dispatching another independent round', async () => {
  const f = fixture();
  let restarted, originalClosed = false;
  try {
    f.service.updateSettings({ paused: true });
    const input = { requestId: randomUUID(), roomId: 'team', objective: '重启后核对', memberIds: [f.builder.id, f.reviewer.id] };
    const original = f.service.createMeeting(input);
    await f.service.close();
    originalClosed = true;
    restarted = new TeamService({ root: f.root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }) });
    const recovered = restarted.createMeeting(input);
    assert.equal(recovered.id, original.id);
    assert.equal(restarted.store.list('meetings').length, 1);
    assert.equal(restarted.store.list('runs').length, 2);
    assert.equal(restarted.store.list('meetingRequests').length, 1);
  } finally { await restarted?.close(); if (originalClosed) cleanup(f.root); else await f.close(); }
});

for (const stage of ['dispatch', 'receipt']) test(`meeting creation rolls back messages, jobs and events after ${stage} failure`, async () => {
  const f = fixture();
  try {
    const s = f.service;
    s.updateSettings({ paused: true });
    const enqueue = s.enqueue.bind(s), put = s.store.put.bind(s.store), events = [];
    s.on('change', event => events.push(event));
    let count = 0;
    s.enqueue = (...args) => { if (stage === 'dispatch' && ++count === 2) throw new Error('test storage failure'); return enqueue(...args); };
    s.store.put = (kind, value) => { if (stage === 'receipt' && kind === 'meetingRequests') throw new Error('test storage failure'); return put(kind, value); };
    const input = { requestId: randomUUID(), roomId: 'team', objective: '全部成功才开始', memberIds: [f.builder.id, f.reviewer.id] };
    assert.throws(() => s.createMeeting(input), /test storage failure/);
    for (const kind of ['meetings', 'meetingRequests', 'messages', 'runs']) assert.equal(s.store.list(kind).length, 0, kind);
    assert.equal(events.length, 0);
    s.enqueue = enqueue; s.store.put = put;
    const created = s.createMeeting(input);
    assert.equal(s.createMeeting(input).id, created.id);
    assert.equal(s.store.list('runs').length, 2);
  } finally { await f.close(); }
});

test('invalid meeting inputs and queue capacity fail before any discussion or message appears', async () => {
  const f = fixture();
  try {
    const s = f.service;
    s.updateSettings({ paused: true });
    const input = { requestId: randomUUID(), roomId: 'team', objective: '边界检查', memberIds: [f.builder.id, f.reviewer.id] };
    for (const changes of [{ objective: '   ' }, { memberIds: [f.builder.id] },
      { memberIds: [f.builder.id, f.builder.id] }, { memberIds: [f.builder.id, 'missing'] },
      { memberIds: ['1', '2', '3', '4', '5'] }, { roomId: 'missing' }]) assert.throws(() => s.createMeeting({ ...input, ...changes }));
    s.saveMember({ enabled: false }, f.builder.id);
    assert.throws(() => s.createMeeting(input), /停用|不可用/);
    s.saveMember({ enabled: true }, f.builder.id);
    for (let index = 0; index < 49; index++) s.store.put('runs', { id: `capacity-${index}`, status: 'queued', roomId: 'team', memberId: f.builder.id });
    assert.throws(() => s.createMeeting(input), /队列已满/);
    for (const kind of ['meetings', 'meetingRequests', 'messages']) assert.equal(s.store.list(kind).length, 0, kind);
    assert.equal(s.store.list('runs').length, 49);
  } finally { await f.close(); }
});

test('channel and meeting drafts stay isolated and never grant execution or create model work', async () => {
  const f = fixture();
  try {
    const s = f.service, drafts = new UiDrafts(s);
    const other = s.createRoom({ name: '独立草稿频道' });
    const request = scope => ({ workspace: s.root, scope });
    const scopes = [{ kind: 'room-create' }, { kind: 'meeting-create', roomId: 'team' }, { kind: 'meeting-create', roomId: other.id }];
    const values = [{ name: '尚未创建', requestId: randomUUID() },
      { objective: '未提交的讨论', memberIds: JSON.stringify([f.builder.id, f.reviewer.id]), requestId: randomUUID() },
      { objective: '另一频道的草稿', memberIds: '[]', requestId: '' }];
    for (let index = 0; index < scopes.length; index++) drafts.write({ ...request(scopes[index]), revision: 0, values: values[index] });
    for (let index = 0; index < scopes.length; index++) assert.deepEqual(drafts.read(request(scopes[index])).draft.values, values[index]);
    for (const scope of scopes) for (const extra of [{ start: 'true' }, { analysisOnly: 'false' }, { permission: 'edit' }]) {
      assert.throws(() => drafts.write({ ...request(scope), revision: 1, values: extra }));
    }
    assert.throws(() => drafts.read(request({ kind: 'meeting-create', roomId: 'missing' })), /聊天室不存在/);
    assert.equal(s.store.list('rooms').length, 2);
    for (const kind of ['meetings', 'runs', 'messages', 'roomRequests', 'meetingRequests']) assert.equal(s.store.list(kind).length, 0, kind);
  } finally { await f.close(); }
});

test('explicit direct connections clear only child proxies and preserve both bypass lists', () => {
  const original = process.env;
  try {
    process.env = { ...original, HTTP_PROXY: 'http://upper.invalid:8080', HTTPS_PROXY: 'http://upper.invalid:8080',
      ALL_PROXY: 'http://upper.invalid:8080', http_proxy: 'http://lower.invalid:8081', https_proxy: 'http://lower.invalid:8081',
      all_proxy: 'http://lower.invalid:8081', NO_PROXY: 'upper.example', no_proxy: 'lower.example' };
    const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
    const inherited = childEnvironment();
    const direct = childEnvironment('');
    const proxied = childEnvironment('http://workspace.invalid:8082');
    for (const key of keys) {
      assert.equal(inherited[key], process.env[key]);
      assert.equal(Object.hasOwn(direct, key), false);
      assert.equal(proxied[key], 'http://workspace.invalid:8082');
      assert.match(process.env[key], /upper\.invalid|lower\.invalid/);
    }
    assert.equal(direct.NO_PROXY, direct.no_proxy);
    for (const host of ['localhost', '127.0.0.1', '::1', 'upper.example', 'lower.example']) assert.ok(direct.NO_PROXY.split(',').includes(host));
    assert.equal(process.env.NO_PROXY, 'upper.example');
    assert.equal(process.env.no_proxy, 'lower.example');
  } finally { process.env = original; }
});
