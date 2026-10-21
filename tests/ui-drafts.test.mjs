import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { UiDrafts } from '../server/ui-drafts.mjs';
import { createApp } from '../server/app.mjs';
import { TeamService } from '../server/service.mjs';
import { createTaskDraftStore } from '../ui/taskDrafts.ts';
import { fixture, temporary, cleanup } from './helpers.mjs';

const token = 'ui-draft-test-desktop';
const newTask = { kind: 'new-task', contextId: 'team' };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function serve(service) {
  const app = createApp(service, { desktopOnly: true, desktopToken: token });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const transport = (route, options) => fetch(`${url}${route}`, { ...options, headers: { ...options.headers, 'X-CLI-Team-Desktop': token } });
  return { url, transport, async close() { app.closeStreams(); await new Promise((resolve) => server.close(resolve)); } };
}
const input = (service, scope = newTask) => ({ workspace: service.root, scope });

test('assignment drafts survive reopening and stay private to their task and execution context', async () => {
  const f = fixture();
  const server = await serve(f.service);
  try {
    const task = f.service.createTask({ title: '调整分工草稿', objective: '保留填写，用户明确保存后才改派', assigneeId: f.builder.id });
    const other = f.service.createTask({ title: '其他任务', objective: '不能看到另一任务的分工草稿', assigneeId: f.builder.id });
    const scope = { kind: 'assignment', taskId: task.id, contextId: 'run-one' };
    const cache = createTaskDraftStore(server.transport);
    const draft = cache.open(f.root, scope);
    await draft.load();
    const values = { assigneeId: f.reviewer.id, reviewerId: '', participantIds: '[]', note: '接手时保留文件\n先核对现有成果  ' };
    draft.setValues(values);
    assert.equal(await cache.flushAll(), true);
    const restored = createTaskDraftStore(server.transport).open(f.root, scope);
    assert.equal(await restored.load(), true);
    assert.deepEqual(restored.getSnapshot().values, values);
    for (const isolated of [{ ...scope, taskId: other.id }, { ...scope, contextId: 'run-two' }, { ...scope, planId: 'new-plan' }]) {
      assert.equal(new UiDrafts(f.service).read(input(f.service, isolated)).draft, null);
    }
    assert.equal(f.service.require('tasks', task.id).assigneeId, f.builder.id);
    assert.equal(f.service.store.list('runs').length, 0);
    for (const extra of [{ start: 'true' }, { save: 'true' }, { acknowledgeMissingGate: 'true' }, { participantIds: '["one","one"]' }, { note: 'x'.repeat(1201) }]) {
      assert.throws(() => new UiDrafts(f.service).write({ ...input(f.service, scope), revision: 1, values: { ...values, ...extra } }));
    }
    assert.throws(() => new UiDrafts(f.service).read(input(f.service, { ...scope, taskId: 'missing-task' })), /任务不存在/);
  } finally { await server.close(); await f.close(); }
});

test('clearing an applied assignment draft recovers from failure without restoring the old team or starting a task', async () => {
  const f = fixture();
  const server = await serve(f.service);
  let rejectClear = true;
  try {
    const task = f.service.createTask({ title: '已保存分工', objective: '清理草稿不应再次改派或启动', assigneeId: f.builder.id });
    const scope = { kind: 'assignment', taskId: task.id, contextId: 'initial' };
    const defaults = { assigneeId: f.builder.id, reviewerId: '', participantIds: '[]', note: '' };
    const cache = createTaskDraftStore((url, options) => options.method === 'DELETE' && rejectClear
      ? Promise.resolve(new Response(JSON.stringify({ error: 'DRAFT_CLEAR_UNAVAILABLE' }), { status: 503 })) : server.transport(url, options));
    const draft = cache.open(f.root, scope, defaults);
    await draft.load();
    draft.setValues({ assigneeId: f.reviewer.id, note: '交给另一成员，保留既有成果' });
    assert.equal(await draft.flush(), true);
    const updated = f.service.reassignTask(task.id, { assigneeId: f.reviewer.id, reviewerId: null, note: draft.getSnapshot().values.note });
    cache.open(f.root, scope, { ...defaults, assigneeId: updated.assigneeId });
    assert.equal(await draft.clear(), false);
    assert.equal(draft.getSnapshot().values.note, '交给另一成员，保留既有成果');
    assert.equal(draft.getSnapshot().values.assigneeId, updated.assigneeId);
    rejectClear = false;
    assert.equal(await draft.retry(), true);
    assert.deepEqual(draft.getSnapshot().values, { ...defaults, assigneeId: updated.assigneeId });
    assert.equal(f.service.require('tasks', task.id).status, 'backlog');
    assert.equal(f.service.store.list('runs').length, 0);
    assert.equal(f.service.store.list('messages').filter(message => message.taskId === task.id && message.kind === 'decision').length, 1);
  } finally { await server.close(); await f.close(); }
});

test('room drafts persist independently and reject execution flags without sending any messages', async () => {
  const f = fixture();
  const server = await serve(f.service);
  try {
    const room = f.service.createRoom({ name: '另一间聊天室' });
    const cache = createTaskDraftStore(server.transport);
    const first = cache.open(f.root, { kind: 'room-message', roomId: 'team' }, { body: '', recipientIds: '[]', taskId: '' });
    const second = cache.open(f.root, { kind: 'room-message', roomId: room.id }, { body: '', recipientIds: '[]', taskId: '' });
    const beforeMessages = f.service.store.list('messages').length;
    await Promise.all([first.load(), second.load()]);
    first.setValues({ body: '第一间的 @builder 草稿\n保留空白  ', recipientIds: JSON.stringify([f.builder.id]) });
    second.setValues({ body: '另一间的内容' });
    assert.equal(await cache.flushAll(), true);
    const restored = createTaskDraftStore(server.transport).open(f.root, { kind: 'room-message', roomId: 'team' });
    assert.equal(await restored.load(), true);
    assert.equal(restored.getSnapshot().values.body, '第一间的 @builder 草稿\n保留空白  ');
    assert.equal(second.getSnapshot().values.body, '另一间的内容');
    // Sending completion clears the captured entry, leaving another room intact.
    first.setField('body', '');
    assert.equal(await first.flush(), true);
    assert.equal(second.getSnapshot().values.body, '另一间的内容');
    assert.equal(first.getSnapshot().values.recipientIds, JSON.stringify([f.builder.id]));
    const drafts = new UiDrafts(f.service);
    const request = input(f.service, { kind: 'room-message', roomId: 'team' });
    for (const values of [{ send: 'true' }, { analysisOnly: 'false' }, { acknowledgeMissingGate: 'true' },
      { recipientIds: '["one","one"]' }, { recipientIds: '["one","two","three","four","five"]' }, { body: 'x'.repeat(24001) }]) {
      assert.throws(() => drafts.write({ ...request, revision: drafts.read(request).revision, values }));
    }
    assert.throws(() => drafts.read(input(f.service, { kind: 'room-message', roomId: 'missing-room' })), /聊天室不存在/);
    assert.equal(f.service.store.list('messages').length, beforeMessages);
    assert.equal(f.service.store.list('runs').length, 0);
  } finally { await server.close(); await f.close(); }
});

test('workspace drafts survive service and port changes without copying execution or acceptance authority', async () => {
  const root = temporary();
  let service = new TeamService({ root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }) });
  let server = await serve(service);
  const fields = { title: '未完成任务', objective: '保留空格  与换行\n第二行', requirements: '一\n二', verificationCommand: '',
    executionMode: 'delegated', assigneeId: 'builder-one', reviewerId: '', participantIds: '["builder-two"]', roomId: 'team',
    sourceSessionId: '', sourceTitle: '', preparationTaskId: 'task-preparing', materialManifest: '[{"id":"file-one","name":"材料.txt","size":7,"status":"selected"}]' };
  try {
    const entry = createTaskDraftStore(server.transport).open(root, newTask);
    await entry.load();
    entry.setValues(fields);
    assert.equal(await entry.flush(), true);
    const beforeRuns = service.store.list('runs').length;
    assert.equal(beforeRuns, 0);
    assert.equal(service.store.list('tasks').length, 0);
    const oldUrl = server.url;
    await server.close();
    await service.close();
    service = new TeamService({ root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }) });
    server = await serve(service);
    const restored = createTaskDraftStore(server.transport).open(root, newTask);
    assert.equal(await restored.load(), true);
    assert.deepEqual(restored.getSnapshot().values, fields);
    assert.equal(restored.getSnapshot().restored, true);
    assert.equal(Object.hasOwn(restored.getSnapshot().values, 'start'), false);
    assert.equal(Object.hasOwn(restored.getSnapshot().values, 'acknowledgeMissingGate'), false);
    assert.equal(service.store.list('runs').length, beforeRuns);
    assert.ok(new URL(oldUrl).hostname === '127.0.0.1' && new URL(server.url).hostname === '127.0.0.1');
  } finally { await server.close(); await service.close(); cleanup(root); }
});

test('drafts isolate task, plan, question, delivery context and workspace; historical drafts stay historical', async () => {
  const f = fixture();
  const other = fixture();
  try {
    const drafts = new UiDrafts(f.service);
    const task = f.service.createTask({ title: '一', objective: '一', assigneeId: f.builder.id });
    const another = f.service.createTask({ title: '二', objective: '二', assigneeId: f.builder.id });
    for (const id of ['help-one', 'help-two']) f.service.store.put('assistance', { id, taskId: task.id, planId: 'plan-old' });
    const scope = { kind: 'assistance', taskId: task.id, planId: 'plan-old', questionId: 'help-one' };
    drafts.write({ ...input(f.service, scope), values: { answer: '旧计划的答案' }, revision: 0 });
    assert.equal(drafts.read(input(f.service, { ...scope, questionId: 'help-two' })).draft, null);
    assert.throws(() => drafts.read(input(f.service, { ...scope, taskId: another.id })), /不匹配/);
    assert.throws(() => drafts.read(input(f.service, { ...scope, planId: 'plan-new' })), /不匹配/);
    f.service.store.update('tasks', task.id, { coordination: { planId: 'plan-new', phase: 'planning', steps: [], round: 2 } });
    assert.equal(drafts.read(input(f.service, scope)).draft.values.answer, '旧计划的答案');
    const revision = { kind: 'revision', taskId: task.id, planId: 'plan-old', contextId: 'run-old' };
    drafts.write({ ...input(f.service, revision), values: { feedback: '修改意见' }, revision: 0 });
    assert.equal(drafts.read(input(f.service, { ...revision, planId: 'plan-new' })).draft, null);
    assert.equal(drafts.read(input(f.service, { ...revision, contextId: 'run-new' })).draft, null);
    assert.equal(drafts.read(input(f.service, { ...revision, taskId: another.id })).draft, null);
    assert.equal(new UiDrafts(other.service).read(input(other.service)).draft, null);
    assert.throws(() => drafts.write({ ...input(other.service), values: { title: '不能串工作区' }, revision: 0 }), /工作区已变化/);
    assert.equal(f.service.store.list('runs').length, 0);
  } finally { await f.close(); await other.close(); }
});

test('draft HTTP routes enforce desktop/origin protection, exact fields and bounded preparation JSON', async () => {
  const f = fixture();
  const changes = [];
  f.service.on('change', (event) => changes.push(event));
  const server = await serve(f.service);
  const send = (body, method = 'PUT', headers = {}) => server.transport('/api/ui-drafts', { method,
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${server.url}/api/ui-drafts/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input(f.service)) })).status, 401);
    assert.equal((await send({ ...input(f.service), revision: 0, values: { title: 'x' } }, 'PUT', { Origin: 'https://outside.invalid' })).status, 403);
    for (const values of [{ start: 'true' }, { acknowledgeMissingGate: 'true' }, { title: { text: 'invalid' } },
      { participantIds: 'not-json' }, { participantIds: '["one","one"]' }, { participantIds: '[1]' }, { materialManifest: '[{"id":"one","name":"x","status":"imported","file":"C:/private"}]' },
      { materialManifest: '[{"id":"one","name":".env","status":"selected"}]' }, { materialManifest: '[{"id":"one","name":"x","status":"selected","size":8388609}]' },
      { materialManifest: '[{"id":"one","name":"x","status":"selected","sha256":"invalid"}]' }]) {
      assert.equal((await send({ ...input(f.service), revision: 0, values })).status, 400, JSON.stringify(values));
    }
    assert.equal((await send({ ...input(f.service, { kind: 'new-task', contextId: '../../other' }), revision: 0, values: {} })).status, 400);
    assert.equal((await send({ ...input(f.service), revision: 0, values: { objective: '字'.repeat(24000), requirements: '字'.repeat(36000) } })).status, 413);
    const valid = await send({ ...input(f.service), revision: 0, values: { title: '草稿', participantIds: '[]', materialManifest: '[]' } });
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get('cache-control'), 'no-store');
    const state = f.service.bootstrap();
    assert.equal(Object.hasOwn(state, 'uiDrafts'), false);
    assert.deepEqual(changes, [], 'Private drafts do not enter the task event stream');
  } finally { await server.close(); await f.close(); }
});

test('cleared draft revisions reject delayed writes while leaving other scopes intact', async () => {
  const f = fixture();
  try {
    const drafts = new UiDrafts(f.service);
    const first = drafts.write({ ...input(f.service), values: { title: '待提交' }, revision: 0 });
    const otherScope = { kind: 'new-task', contextId: 'another-room' };
    drafts.write({ ...input(f.service, otherScope), values: { title: '另一个任务' }, revision: 0 });
    const removed = drafts.remove({ ...input(f.service), revision: first.revision });
    assert.equal(removed.draft, null);
    assert.ok(removed.revision > first.revision);
    assert.throws(() => drafts.write({ ...input(f.service), values: { title: '迟到请求' }, revision: first.revision }), /其他窗口更新/);
    assert.throws(() => drafts.write({ ...input(f.service), values: { title: '初次写入也迟到' }, revision: 0 }), /其他窗口更新/);
    assert.equal(drafts.read(input(f.service)).draft, null);
    assert.equal(drafts.read(input(f.service, otherScope)).draft.values.title, '另一个任务');
  } finally { await f.close(); }
});

test('typing while restoration is in flight preserves both untouched saved fields and the latest input', async () => {
  const f = fixture();
  const server = await serve(f.service);
  const gate = deferred();
  try {
    const drafts = new UiDrafts(f.service);
    drafts.write({ ...input(f.service), values: { title: '已保存标题', objective: '已保存目标' }, revision: 0 });
    const cache = createTaskDraftStore(async (route, options) => { if (route.endsWith('/read')) await gate.promise; return server.transport(route, options); });
    const entry = cache.open(f.root, newTask, { title: '', objective: '' });
    const loading = entry.load();
    entry.setField('objective', '恢复期间新输入\n不得被覆盖');
    assert.equal(entry.getSnapshot().values.objective, '恢复期间新输入\n不得被覆盖');
    gate.resolve();
    assert.equal(await loading, true);
    assert.equal(await cache.flushAll(), true);
    assert.deepEqual(entry.getSnapshot().values, { title: '已保存标题', objective: '恢复期间新输入\n不得被覆盖' });
    assert.deepEqual(drafts.read(input(f.service)).draft.values, entry.getSnapshot().values);
    assert.equal(cache.open(f.root, newTask), entry, 'Dialog unmount/remount reuses the same draft entry');
  } finally { gate.resolve(); await server.close(); await f.close(); }
});

test('queued edits finish before clear and a later edit survives clear completion', async () => {
  const f = fixture();
  const server = await serve(f.service);
  const entered = deferred(), gate = deferred();
  let pauseDelete = false;
  try {
    const cache = createTaskDraftStore(async (route, options) => {
      if (options.method === 'DELETE' && pauseDelete) { entered.resolve(); await gate.promise; }
      return server.transport(route, options);
    });
    const entry = cache.open(f.root, newTask, { title: '' });
    await entry.load();
    entry.setField('title', '第一版');
    entry.setField('title', '准备提交的第二版');
    pauseDelete = true;
    const clearing = entry.clear();
    await entered.promise;
    entry.setField('title', '提交后新写的下一项');
    gate.resolve();
    assert.equal(await clearing, true);
    assert.equal(await cache.flushAll(), true);
    assert.equal(entry.getSnapshot().values.title, '提交后新写的下一项');
    assert.equal(new UiDrafts(f.service).read(input(f.service)).draft.values.title, '提交后新写的下一项');
  } finally { gate.resolve(); await server.close(); await f.close(); }
});

test('save and clear failures retain memory text, report failure, and retry the latest corrected content', async () => {
  const f = fixture();
  const server = await serve(f.service);
  let failWrite = true, failClear = false;
  try {
    const cache = createTaskDraftStore((route, options) => {
      if ((options.method === 'PUT' && failWrite) || (options.method === 'DELETE' && failClear)) {
        return Promise.resolve(new Response(JSON.stringify({ error: '模拟磁盘写入失败' }), { status: 503 }));
      }
      return server.transport(route, options);
    });
    const entry = cache.open(f.root, newTask, { title: '' });
    await entry.load();
    entry.setField('title', '必须保留');
    assert.equal(await cache.flushAll(), false);
    assert.equal(entry.getSnapshot().values.title, '必须保留');
    assert.match(entry.getSnapshot().error, /尚未保存/);
    failWrite = false;
    entry.setField('title', '已经修订的新文字');
    assert.equal(await cache.flushAll(), true);
    assert.equal(new UiDrafts(f.service).read(input(f.service)).draft.values.title, '已经修订的新文字');
    failClear = true;
    assert.equal(await entry.clear(), false);
    assert.equal(entry.getSnapshot().values.title, '已经修订的新文字');
    assert.match(entry.getSnapshot().error, /尚未清除/);
    failClear = false;
    assert.equal(await entry.retry(), true);
    assert.equal(entry.getSnapshot().values.title, '');
    assert.equal(new UiDrafts(f.service).read(input(f.service)).draft, null);
  } finally { await server.close(); await f.close(); }
});

test('another window cannot silently replace a newer draft; explicit retry preserves local text', async () => {
  const f = fixture();
  const server = await serve(f.service);
  try {
    const first = createTaskDraftStore(server.transport).open(f.root, newTask, { title: '' });
    const otherCache = createTaskDraftStore(server.transport);
    const second = otherCache.open(f.root, newTask, { title: '' });
    await Promise.all([first.load(), second.load()]);
    first.setField('title', '窗口一已经保存');
    assert.equal(await first.flush(), true);
    second.setField('title', '窗口二仍保留的文字');
    assert.equal(await otherCache.flushAll(), false);
    assert.match(second.getSnapshot().error, /其他窗口更新/);
    assert.equal(second.getSnapshot().values.title, '窗口二仍保留的文字');
    assert.equal(new UiDrafts(f.service).read(input(f.service)).draft.values.title, '窗口一已经保存');
    assert.equal(await second.retry(), true);
    assert.equal(new UiDrafts(f.service).read(input(f.service)).draft.values.title, '窗口二仍保留的文字');
  } finally { await server.close(); await f.close(); }
});

test('failed restoration never replaces the stored draft with defaults and allows local typing before retry', async () => {
  const f = fixture();
  const server = await serve(f.service);
  let failRead = true;
  try {
    const drafts = new UiDrafts(f.service);
    drafts.write({ ...input(f.service), values: { title: '磁盘中的标题', objective: '磁盘中的目标' }, revision: 0 });
    const cache = createTaskDraftStore((route, options) => route.endsWith('/read') && failRead
      ? Promise.resolve(new Response(JSON.stringify({ error: '暂时无法读取' }), { status: 503 })) : server.transport(route, options));
    const entry = cache.open(f.root, newTask, { title: '', objective: '' });
    assert.equal(await entry.load(), false);
    assert.equal(entry.getSnapshot().ready, true, 'A failed read must still allow typing into memory');
    assert.equal(entry.getSnapshot().loaded, false, 'Material preparation must not treat a failed restore as a loaded draft');
    entry.setField('objective', '读失败后输入的目标');
    assert.equal(await cache.flushAll(), false);
    assert.equal(entry.getSnapshot().values.objective, '读失败后输入的目标');
    assert.deepEqual(drafts.read(input(f.service)).draft.values, { title: '磁盘中的标题', objective: '磁盘中的目标' });
    failRead = false;
    assert.equal(await entry.retry(), true);
    assert.equal(entry.getSnapshot().loaded, true);
    assert.deepEqual(drafts.read(input(f.service)).draft.values, { title: '磁盘中的标题', objective: '读失败后输入的目标' });
  } finally { await server.close(); await f.close(); }
});

test('editing after a failed clear keeps unchanged preparation identifiers and never retries the old delete', async () => {
  const f = fixture();
  const server = await serve(f.service);
  let failDelete = true, deletes = 0;
  try {
    const cache = createTaskDraftStore((route, options) => {
      if (options.method === 'DELETE') {
        deletes++;
        if (failDelete) return Promise.resolve(new Response(JSON.stringify({ error: '模拟清除失败' }), { status: 503 }));
      }
      return server.transport(route, options);
    });
    const entry = cache.open(f.root, newTask, { title: '', preparationTaskId: '', materialManifest: '[]' });
    await entry.load();
    entry.setValues({ title: '已经创建的准备任务', preparationTaskId: 'task-existing', materialManifest: '[]' });
    assert.equal(await entry.flush(), true);
    assert.equal(await entry.clear(), false);
    assert.equal(await cache.flushAll(), false, 'An unrelated flush must not repeat a failed discard');
    assert.equal(deletes, 1);
    failDelete = false;
    entry.setField('materialManifest', '[{"id":"file-one","name":"材料.txt","status":"selected"}]');
    assert.equal(await cache.flushAll(), true);
    assert.equal(deletes, 1);
    const values = new UiDrafts(f.service).read(input(f.service)).draft.values;
    assert.equal(values.title, '已经创建的准备任务');
    assert.equal(values.preparationTaskId, 'task-existing');
    assert.equal(JSON.parse(values.materialManifest).length, 1);
  } finally { await server.close(); await f.close(); }
});

test('a cleared dialog immediately reopens with the new mode and room defaults', async () => {
  const f = fixture();
  const server = await serve(f.service);
  try {
    const cache = createTaskDraftStore(server.transport);
    const first = cache.open(f.root, newTask, { title: '', executionMode: 'delegated', roomId: 'room-a', sourceSessionId: 'session-old' });
    assert.equal(await first.load(), true);
    first.setField('title', '已经提交的任务');
    assert.equal(await cache.flushAll(), true);
    assert.equal(await first.clear(), true);
    const nextDefaults = { title: '', executionMode: 'direct', roomId: 'room-b' };
    const reopened = cache.open(f.root, newTask, nextDefaults);
    assert.equal(reopened, first);
    assert.equal(await cache.flushAll(), true);
    assert.deepEqual(reopened.getSnapshot().values, nextDefaults);
    assert.equal(reopened.getSnapshot().restored, false);
    const drafts = new UiDrafts(f.service);
    assert.equal(drafts.read(input(f.service)).draft, null, 'Opening with defaults must not recreate the cleared draft');
    reopened.setField('title', '从单人入口创建的下一项');
    assert.equal(await cache.flushAll(), true);
    assert.deepEqual(drafts.read(input(f.service)).draft.values, { ...nextDefaults, title: '从单人入口创建的下一项' });
  } finally { await server.close(); await f.close(); }
});

test('an untouched empty dialog adopts the latest defaults after loading and on later opens', async () => {
  const f = fixture();
  const server = await serve(f.service);
  const gate = deferred();
  try {
    const cache = createTaskDraftStore(async (route, options) => {
      if (route.endsWith('/read')) await gate.promise;
      return server.transport(route, options);
    });
    const initial = { title: '', executionMode: 'delegated', roomId: 'room-a' };
    const entry = cache.open(f.root, newTask, initial);
    const loading = entry.load();
    const duringRead = { title: '', executionMode: 'direct', roomId: 'room-b' };
    cache.open(f.root, newTask, duringRead);
    assert.deepEqual(entry.getSnapshot().values, initial, 'Defaults wait until the server confirms there is no stored draft');
    gate.resolve();
    assert.equal(await loading, true);
    assert.deepEqual(entry.getSnapshot().values, duringRead);
    const latest = { title: '', executionMode: 'delegated', roomId: 'room-c' };
    cache.open(f.root, newTask, latest);
    assert.deepEqual(entry.getSnapshot().values, latest);
    assert.equal(await cache.flushAll(), true);
    assert.equal(new UiDrafts(f.service).read(input(f.service)).draft, null);
  } finally { gate.resolve(); await server.close(); await f.close(); }
});

test('new defaults preserve both restored drafts and drafts saved by the current window', async () => {
  const f = fixture();
  const server = await serve(f.service);
  try {
    const defaults = { title: '', executionMode: 'delegated', roomId: 'room-a' };
    const otherDefaults = { title: '', executionMode: 'direct', roomId: 'room-b' };
    const drafts = new UiDrafts(f.service);
    const stored = { ...defaults, title: '从磁盘恢复的任务', preparationTaskId: 'task-existing' };
    drafts.write({ ...input(f.service), values: stored, revision: 0 });
    const cache = createTaskDraftStore(server.transport);
    const restored = cache.open(f.root, newTask, defaults);
    assert.equal(await restored.load(), true);
    cache.open(f.root, newTask, otherDefaults);
    assert.equal(restored.getSnapshot().restored, true);
    assert.deepEqual(restored.getSnapshot().values, stored);
    assert.deepEqual(drafts.read(input(f.service)).draft.values, stored);

    const freshScope = { kind: 'new-task', contextId: 'saved-this-window' };
    const fresh = cache.open(f.root, freshScope, defaults);
    assert.equal(await fresh.load(), true);
    fresh.setField('title', '本窗口已经保存的任务');
    assert.equal(await cache.flushAll(), true);
    assert.equal(fresh.getSnapshot().restored, false, 'A newly saved draft still needs protection without a restored marker');
    cache.open(f.root, freshScope, otherDefaults);
    const saved = { ...defaults, title: '本窗口已经保存的任务' };
    assert.deepEqual(fresh.getSnapshot().values, saved);
    assert.deepEqual(drafts.read(input(f.service, freshScope)).draft.values, saved);
  } finally { await server.close(); await f.close(); }
});

test('reopening with different defaults preserves edits during a pending write and after a failed save', async () => {
  const f = fixture();
  const server = await serve(f.service);
  const entered = deferred(), gate = deferred();
  let failWrite = true;
  try {
    const cache = createTaskDraftStore(async (route, options) => {
      if (options.method === 'PUT') {
        entered.resolve();
        await gate.promise;
        if (failWrite) return new Response(JSON.stringify({ error: '模拟保存失败' }), { status: 503 });
      }
      return server.transport(route, options);
    });
    const defaults = { title: '', executionMode: 'delegated', roomId: 'room-a' };
    const entry = cache.open(f.root, newTask, defaults);
    await entry.load();
    entry.setField('title', '尚未写入磁盘的输入');
    await entered.promise;
    cache.open(f.root, newTask, { title: '', executionMode: 'direct', roomId: 'room-b' });
    const edited = { ...defaults, title: '尚未写入磁盘的输入' };
    assert.deepEqual(entry.getSnapshot().values, edited);
    gate.resolve();
    assert.equal(await cache.flushAll(), false);
    cache.open(f.root, newTask, { title: '', executionMode: 'direct', roomId: 'room-c' });
    assert.deepEqual(entry.getSnapshot().values, edited);
    assert.match(entry.getSnapshot().error, /尚未保存/);
    assert.equal(new UiDrafts(f.service).read(input(f.service)).draft, null);
    failWrite = false;
    assert.equal(await entry.retry(), true);
    assert.deepEqual(entry.getSnapshot().values, edited);
    assert.deepEqual(new UiDrafts(f.service).read(input(f.service)).draft.values, edited);
  } finally { gate.resolve(); await server.close(); await f.close(); }
});

test('pending or failed clear defers new defaults until an explicit successful retry', async () => {
  const f = fixture();
  const server = await serve(f.service);
  const entered = deferred(), gate = deferred();
  let failDelete = true, deletes = 0;
  try {
    const cache = createTaskDraftStore(async (route, options) => {
      if (options.method === 'DELETE') {
        deletes++;
        entered.resolve();
        await gate.promise;
        if (failDelete) return new Response(JSON.stringify({ error: '模拟清除失败' }), { status: 503 });
      }
      return server.transport(route, options);
    });
    const initial = { title: '', executionMode: 'delegated', roomId: 'room-a' };
    const entry = cache.open(f.root, newTask, initial);
    await entry.load();
    const clearing = entry.clear();
    await entered.promise;
    cache.open(f.root, newTask, { title: '', executionMode: 'direct', roomId: 'room-b' });
    assert.deepEqual(entry.getSnapshot().values, initial);
    gate.resolve();
    assert.equal(await clearing, false);
    assert.equal(await cache.flushAll(), false);
    const latest = { title: '', executionMode: 'direct', roomId: 'room-c' };
    cache.open(f.root, newTask, latest);
    assert.deepEqual(entry.getSnapshot().values, initial);
    assert.match(entry.getSnapshot().error, /尚未清除/);
    assert.equal(deletes, 1);
    failDelete = false;
    assert.equal(await entry.retry(), true);
    assert.deepEqual(entry.getSnapshot().values, latest);
    assert.equal(new UiDrafts(f.service).read(input(f.service)).draft, null);
    assert.equal(deletes, 2);
  } finally { gate.resolve(); await server.close(); await f.close(); }
});
