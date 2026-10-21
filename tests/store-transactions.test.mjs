import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { cleanup, fixture, success, temporary } from './helpers.mjs';

function stores() {
  const root = temporary();
  const filename = path.join(root, 'transactions.sqlite');
  const writer = new Store(filename), reader = new Store(filename);
  return { writer, reader, close() { reader.close(); writer.close(); cleanup(root); } };
}

test('rolling back a queued service run leaves no run, durable event, notification or process execution', async () => {
  let executions = 0;
  const f = fixture({ agentExecutor: async () => { executions++; return success(); } });
  try {
    const events = [];
    f.service.on('change', (event) => events.push(event));
    const eventCount = () => f.service.store.db.prepare('SELECT COUNT(*) AS count FROM events').get().count;
    const before = eventCount();
    assert.throws(() => f.service.store.transaction(() => {
      f.service.enqueue({ roomId: 'team', memberId: f.builder.id, prompt: '此派工必须完整回滚' });
      throw new Error('ROLLBACK_DISPATCH');
    }), /ROLLBACK_DISPATCH/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.service.store.list('runs'), []);
    assert.equal(eventCount(), before);
    assert.deepEqual(events, []);
    assert.equal(executions, 0);
    assert.equal(f.service.active.size, 0);
  } finally { await f.close(); }
});

test('nested afterCommit notifications wait for the outer commit and see data from an independent connection', () => {
  const pair = stores();
  const { writer, reader } = pair;
  const notifications = [];
  const notified = (id) => {
    assert.equal(reader.get('runs', 'outer').status, 'queued');
    assert.equal(reader.get('runs', 'inner').status, 'queued');
    notifications.push(id);
  };
  try {
    writer.transaction(() => {
      writer.put('runs', { id: 'outer', status: 'queued' });
      writer.afterCommit(() => notified('outer'));
      writer.transaction(() => {
        writer.put('runs', { id: 'inner', status: 'queued' });
        writer.afterCommit(() => notified('inner'));
      });
      assert.deepEqual(notifications, []);
      assert.equal(reader.get('runs', 'outer'), null);
      assert.equal(reader.get('runs', 'inner'), null);
    });
    assert.deepEqual(notifications.sort(), ['inner', 'outer']);
  } finally { pair.close(); }
});

test('an outer rollback discards both nested writes and their deferred commit notifications', () => {
  const pair = stores();
  const { writer, reader } = pair;
  const notifications = [];
  try {
    assert.throws(() => writer.transaction(() => {
      writer.put('runs', { id: 'outer', status: 'queued' });
      writer.afterCommit(() => notifications.push('outer'));
      writer.transaction(() => {
        writer.put('runs', { id: 'inner', status: 'queued' });
        writer.afterCommit(() => notifications.push('inner'));
      });
      assert.deepEqual(notifications, []);
      throw new Error('ROLLBACK_OUTER');
    }), /ROLLBACK_OUTER/);
    assert.deepEqual(writer.list('runs'), []);
    assert.deepEqual(reader.list('runs'), []);
    assert.deepEqual(notifications, []);
  } finally { pair.close(); }
});
