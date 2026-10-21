import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomHistory, RoomHistoryCache } from '../ui/workbench/messageHistory.ts';
import { fixture } from './helpers.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function seed(service, count, roomId = 'team', taskFor = () => undefined) {
  return service.store.transaction(() => Array.from({ length: count }, (_, index) =>
    service.message(roomId, 'user', '历史测试', `历史 ${index}`, { taskId: taskFor(index) })));
}
const ids = history => history.getSnapshot().messages.map(message => message.id);

test('opened history survives refresh, and more than one page of missed messages is filled without gaps', async () => {
  const f = fixture();
  try {
    const initial = seed(f.service, 235);
    const requests = [];
    const history = new RoomHistory('team', async (room, query) => {
      requests.push(query);
      return f.service.messagePage(room, query);
    });
    await history.refresh();
    assert.deepEqual(ids(history), initial.slice(-100).map(message => message.id));
    await history.loadOlder();
    assert.deepEqual(ids(history), initial.slice(-200).map(message => message.id));
    const missed = seed(f.service, 245);
    requests.length = 0;
    await history.refresh();
    assert.deepEqual(ids(history), [...initial.slice(-200), ...missed].map(message => message.id));
    assert.equal(requests.length, 3);
    assert.ok(requests.every(query => query.after && !query.before));
    await history.loadOlder();
    assert.deepEqual(ids(history), [...initial, ...missed].map(message => message.id));
    assert.equal(history.getSnapshot().hasOlder, false);
    await history.refresh();
    assert.equal(ids(history).length, 480);
  } finally { await f.close(); }
});

test('history failures retain the page and cursor, with independent refresh and older-page retries', async () => {
  const f = fixture();
  try {
    const initial = seed(f.service, 230);
    let failOlder = true, failRefresh = false;
    const history = new RoomHistory('team', async (room, query) => {
      if (query?.before && failOlder) throw new Error('OLDER_PAGE_FAILED');
      if (query?.after && failRefresh) throw new Error('REFRESH_FAILED');
      return f.service.messagePage(room, query);
    });
    await history.refresh();
    const original = ids(history);
    await history.loadOlder();
    assert.deepEqual(ids(history), original);
    assert.match(history.getSnapshot().olderError, /OLDER_PAGE_FAILED/);
    assert.equal(history.getSnapshot().error, null);
    await history.refresh();
    assert.match(history.getSnapshot().olderError, /OLDER_PAGE_FAILED/, '刷新最新消息不应抹掉历史加载失败');
    failOlder = false;
    await history.loadOlder();
    assert.deepEqual(ids(history), initial.slice(-200).map(message => message.id));
    assert.equal(history.getSnapshot().olderError, null);
    const latest = seed(f.service, 1)[0];
    failRefresh = true;
    await history.refresh();
    assert.equal(ids(history).length, 200);
    assert.match(history.getSnapshot().error, /REFRESH_FAILED/);
    failRefresh = false;
    await history.refresh();
    assert.equal(ids(history).at(-1), latest.id);
    assert.equal(history.getSnapshot().error, null);
  } finally { await f.close(); }
});

test('concurrent refreshes are coalesced and an arrival after an in-flight snapshot is still retrieved', async () => {
  const f = fixture();
  try {
    const initial = seed(f.service, 130);
    const captured = deferred(), release = deferred();
    let calls = 0, concurrent = 0, maximum = 0;
    const history = new RoomHistory('team', async (room, query) => {
      calls++;
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      try {
        const result = f.service.messagePage(room, query);
        if (calls === 1) { captured.resolve(); await release.promise; }
        return result;
      } finally { concurrent--; }
    });
    const reading = history.refresh();
    await captured.promise;
    const later = seed(f.service, 23);
    const repeats = Array.from({ length: 12 }, () => history.refresh());
    release.resolve();
    await Promise.all([reading, ...repeats]);
    assert.equal(maximum, 1);
    assert.equal(calls, 2);
    assert.deepEqual(ids(history), [...initial.slice(-100), ...later].map(message => message.id));
    calls = 0;
    await Promise.all([history.loadOlder(), history.loadOlder(), history.loadOlder()]);
    assert.equal(calls, 1, '重复翻页点击不能跳过一页');
    assert.deepEqual(ids(history), [...initial, ...later].map(message => message.id));
  } finally { await f.close(); }
});

test('a failed catch-up continues after the last committed page without losing subsequent messages', async () => {
  const f = fixture();
  try {
    const initial = seed(f.service, 1);
    let afterRequests = 0, inject = true;
    const history = new RoomHistory('team', async (room, query) => {
      if (query?.after && ++afterRequests === 2 && inject) throw new Error('SECOND_PAGE_FAILED');
      return f.service.messagePage(room, query);
    });
    await history.refresh();
    const missed = seed(f.service, 230);
    await history.refresh();
    assert.equal(ids(history).length, 101);
    assert.match(history.getSnapshot().error, /SECOND_PAGE_FAILED/);
    inject = false;
    await history.refresh();
    assert.deepEqual(ids(history), [...initial, ...missed].map(message => message.id));
  } finally { await f.close(); }
});

test('late room reads and workspace caches cannot replace another room, and inactive caches are bounded', async () => {
  const f = fixture();
  try {
    const beta = f.service.createRoom({ name: '房间 B' });
    const alphaMessages = seed(f.service, 230);
    const betaMessages = seed(f.service, 3, beta.id);
    const captured = deferred(), release = deferred();
    let blockAlpha = true;
    const cache = new RoomHistoryCache(async (room, query) => {
      const result = f.service.messagePage(room, query);
      if (room === 'team' && blockAlpha) { blockAlpha = false; captured.resolve(); await release.promise; }
      return result;
    }, 2);
    const alpha = cache.get('workspace-one', 'team');
    const pending = alpha.refresh();
    await captured.promise;
    const current = cache.get('workspace-one', beta.id);
    const unsubscribe = current.subscribe(() => {});
    await current.refresh();
    release.resolve();
    await pending;
    assert.deepEqual(ids(current), betaMessages.map(message => message.id));
    assert.deepEqual(ids(alpha), alphaMessages.slice(-100).map(message => message.id));
    await alpha.loadOlder();
    assert.equal(cache.get('workspace-one', 'team'), alpha);
    const otherWorkspace = cache.get('workspace-two', 'team');
    assert.notEqual(otherWorkspace, alpha);
    assert.equal(otherWorkspace.getSnapshot().ready, false);
    assert.equal(cache.get('workspace-one', beta.id), current, '正在显示的房间不能被缓存回收');
    assert.notEqual(cache.get('workspace-one', 'team'), alpha, '最旧且未显示的缓存应可回收');
    unsubscribe();
  } finally { await f.close(); }
});

test('archiving and restoring messages rebuilds the opened range even when its first or all rows disappear', async () => {
  const f = fixture();
  try {
    const task = f.service.createTask({ title: '消息归档范围', objective: '核对范围', assigneeId: f.builder.id, roomId: 'team', start: false });
    const initial = seed(f.service, 230, 'team', () => task.id);
    const history = new RoomHistory('team', async (room, query) => f.service.messagePage(room, query));
    await history.refresh();
    await history.loadOlder();
    assert.deepEqual(ids(history), initial.slice(-200).map(message => message.id));
    f.service.setTaskArchived(task.id, true);
    await history.refresh();
    assert.equal(ids(history).length, 0);
    assert.equal(history.getSnapshot().ready, true);
    f.service.setTaskArchived(task.id, false);
    await history.refresh();
    assert.deepEqual(ids(history), initial.slice(-200).map(message => message.id));
    assert.equal(history.getSnapshot().hasOlder, true);
  } finally { await f.close(); }
});

test('one older-page request still expands history when an archive change first requires rebuilding its range', async () => {
  const f = fixture();
  try {
    const task = f.service.createTask({ title: '翻页时归档', objective: '一次操作加载更早记录', assigneeId: f.builder.id, roomId: 'team', start: false });
    const initial = seed(f.service, 330, 'team', index => index % 3 === 0 ? task.id : undefined);
    const history = new RoomHistory('team', async (room, query) => f.service.messagePage(room, query));
    await history.refresh();
    f.service.setTaskArchived(task.id, true);
    await history.loadOlder();
    assert.equal(history.getSnapshot().olderError, null);
    assert.deepEqual(ids(history), initial.filter(message => !message.taskId).slice(-200).map(message => message.id));
  } finally { await f.close(); }
});

test('visibility changes in the middle of a history rebuild cannot publish a mixed archive snapshot', async () => {
  const f = fixture();
  try {
    const task = f.service.createTask({ title: '读取期间归档', objective: '检查一致性', assigneeId: f.builder.id, roomId: 'team', start: false });
    seed(f.service, 230, 'team', index => index % 2 ? task.id : undefined);
    let arm = false;
    const history = new RoomHistory('team', async (room, query) => {
      const page = f.service.messagePage(room, query);
      if (arm && !query?.after && !query?.before) { arm = false; f.service.setTaskArchived(task.id, false); }
      return page;
    });
    await history.refresh();
    await history.loadOlder();
    await history.loadOlder();
    f.service.setTaskArchived(task.id, true);
    arm = true;
    await history.refresh();
    assert.equal(history.getSnapshot().error, null);
    assert.equal(history.getSnapshot().messages.length, 230);
    assert.equal(history.getSnapshot().messages.filter(message => message.taskId === task.id).length, 115);
  } finally { await f.close(); }
});
