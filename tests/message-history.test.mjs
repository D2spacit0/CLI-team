import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { cleanup, fixture, temporary } from './helpers.mjs';

test('message pages traverse a busy room without gaps, duplicates or timestamp ordering assumptions', async () => {
  const f = fixture();
  try {
    const other = f.service.createRoom({ name: '其他房间' });
    const expected = [];
    f.service.store.transaction(() => {
      for (let index = 0; index < 237; index++) {
        const message = f.service.message('team', 'user', '用户', `正文 ${index}`);
        f.service.store.update('messages', message.id, { createdAt: index % 2 ? '2026-10-15T00:00:00.000Z' : '2026-10-14T00:00:00.000Z' });
        expected.push(message.id);
        f.service.message(other.id, 'user', '用户', '其他房间内容');
      }
    });
    const list = f.service.store.list.bind(f.service.store);
    f.service.store.list = kind => {
      assert.notEqual(kind, 'messages', '分页不得读取全体房间消息');
      return list(kind);
    };
    const latest = f.service.messagePage('team');
    assert.equal(latest.messages.length, 100);
    assert.equal(latest.hasMore, true);
    assert.deepEqual(latest.messages.map(message => message.id), expected.slice(-100));
    const collected = [...latest.messages];
    let page = latest;
    while (page.hasMore) {
      page = f.service.messagePage('team', { before: page.nextCursor });
      collected.unshift(...page.messages);
    }
    assert.equal(page.nextCursor, null);
    assert.deepEqual(collected.map(message => message.id), expected);
    assert.ok(collected.every((message, index) => !index || message.sequence > collected[index - 1].sequence));
    assert.deepEqual(f.service.messages('team'), latest.messages.map(({ sequence, ...message }) => message));
    let cursor = expected[0];
    const forward = [];
    do {
      page = f.service.messagePage('team', { after: cursor, limit: 37 });
      forward.push(...page.messages);
      cursor = page.nextCursor;
    } while (page.hasMore);
    assert.deepEqual(forward.map(message => message.id), expected.slice(1));
    assert.equal(f.service.messagePage('team', { before: expected[0] }).messages.length, 0);
    assert.equal(f.service.messagePage('team', { after: expected.at(-1) }).messages.length, 0);
    const appended = f.service.message('team', 'user', '用户', '后来新增的消息');
    assert.deepEqual(f.service.messagePage('team', { after: expected.at(-1) }).messages.map(message => message.id), [appended.id]);
  } finally { await f.close(); }
});

test('archive filtering precedes the page limit and archived cursors remain valid for their own room', async () => {
  const f = fixture();
  try {
    const room = f.service.createRoom({ name: '带归档任务的房间' });
    const task = f.service.createTask({ title: '可归档任务', objective: '保留消息', assigneeId: f.builder.id, roomId: room.id, start: false });
    const expected = [];
    f.service.store.transaction(() => {
      for (let index = 0; index < 220; index++) {
        expected.push(f.service.message(room.id, 'user', '用户', `记录 ${index}`, { taskId: index >= 20 && index < 180 ? task.id : undefined }));
      }
    });
    const before = f.service.messagePage(room.id);
    f.service.setTaskArchived(task.id, true);
    const filtered = f.service.messagePage(room.id);
    assert.notEqual(filtered.visibilityKey, before.visibilityKey);
    assert.equal(filtered.hasMore, false);
    assert.deepEqual(filtered.messages.map(message => message.id), expected.filter(message => !message.taskId).map(message => message.id));
    assert.deepEqual(f.service.messagePage(room.id, { after: expected[100].id }).messages.map(message => message.id), expected.slice(180).map(message => message.id));
    f.service.setRoomArchived(room.id, true);
    assert.deepEqual(f.service.messagePage(room.id).messages.map(message => message.id), expected.slice(-100).map(message => message.id));
    f.service.setRoomArchived(room.id, false);
    f.service.setTaskArchived(task.id, false);
    const restored = f.service.messagePage(room.id);
    assert.equal(restored.visibilityKey, before.visibilityKey);
    assert.deepEqual(restored.messages, before.messages);
  } finally { await f.close(); }
});

test('message pagination validates cursors and keeps the original HTTP array route compatible', async () => {
  const f = fixture();
  const app = createApp(f.service);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const other = f.service.createRoom({ name: '另一个房间' });
    const own = f.service.message('team', 'user', '用户', '本房间');
    const foreign = f.service.message(other.id, 'user', '用户', '另一房间');
    const request = query => fetch(`${base}/api/rooms/team/messages/page${query}`);
    assert.equal((await request('')).status, 200);
    const page = await (await request('?limit=1')).json();
    assert.equal(page.messages[0].id, own.id);
    assert.equal(page.hasMore, false);
    const legacy = await (await fetch(`${base}/api/rooms/team/messages`)).json();
    assert.deepEqual(legacy, [own]);
    for (const query of ['?limit=0', '?limit=201', '?limit=-1', '?limit=1.5', '?limit=abc', '?limit=',
      '?limit=10&limit=20', '?before=', '?before=missing', `?after=${foreign.id}`,
      `?before=${own.id}&after=${own.id}`, '?unexpected=1']) {
      assert.equal((await request(query)).status, 400, query);
    }
    assert.equal((await fetch(`${base}/api/rooms/missing/messages/page`)).status, 404);
    assert.equal((await request(`?before=${encodeURIComponent("' OR 1=1 --")}`)).status, 400);
    assert.deepEqual(f.service.messages('team'), [own]);
  } finally {
    app.closeStreams();
    await new Promise(resolve => server.close(resolve));
    await f.close();
  }
});

test('opening an existing SQLite store adds the room index without rewriting message order or content', () => {
  const root = temporary();
  const filename = path.join(root, 'old.sqlite');
  let store;
  try {
    const old = new DatabaseSync(filename);
    old.exec('CREATE TABLE entities (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id))');
    const insert = old.prepare('INSERT INTO entities(kind,id,data) VALUES(?,?,?)');
    for (const id of ['last-alphabetically', 'a-first-alphabetically']) insert.run('messages', id, JSON.stringify({ id, roomId: 'room', body: id }));
    const original = old.prepare('SELECT rowid, data FROM entities ORDER BY rowid').all();
    old.close();
    store = new Store(filename);
    assert.deepEqual(store.db.prepare('SELECT rowid, data FROM entities ORDER BY rowid').all(), original);
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM entities
      WHERE kind = 'messages' AND json_extract(data, '$.roomId') = ? AND rowid < ? ORDER BY rowid DESC LIMIT 101`).all('room', 99);
    assert.ok(plan.some(row => row.detail.includes('messages_by_room')), JSON.stringify(plan));
    assert.ok(!plan.some(row => /TEMP B-TREE/.test(row.detail)), '房间分页不应对全部消息临时排序');
    const page = store.roomMessages('room', { limit: 100, includeArchived: false });
    assert.deepEqual(page.messages.map(message => message.body), ['last-alphabetically', 'a-first-alphabetically']);
  } finally { store?.close(); cleanup(root); }
});
