import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { manifest } from '../server/safety.mjs';
import { createApp } from '../server/app.mjs';
import { fixture, success } from './helpers.mjs';

test('HTTP API rejects cross-origin mutation and protects controller endpoints', async () => {
  const f = fixture({ agentExecutor: async () => success() });
  const app = createApp(f.service, { controllerToken: 'test-controller-token' });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/api/bootstrap`)).status, 200);
    assert.equal((await fetch(`${url}/api/control/inbox`)).status, 401);
    assert.equal((await fetch(`${url}/api/control/inbox`, { headers: { Authorization: 'Bearer test-controller-token' } })).status, 200);
    const evil = await fetch(`${url}/api/rooms`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' }, body: '{"name":"bad"}' });
    assert.equal(evil.status, 403);
    const forgedHostStatus = await new Promise((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port: server.address().port,
        path: '/api/bootstrap', headers: { Host: 'attacker.invalid' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
    });
    assert.equal(forgedHostStatus, 403);
    const wrongType = await fetch(`${url}/api/rooms`, { method: 'POST', body: 'name=bad' });
    assert.equal(wrongType.status, 415);
    const malformed = await fetch(`${url}/api/rooms`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{broken' });
    assert.equal(malformed.status, 400);
    assert.equal(f.service.store.list('rooms').length, 1);
  } finally {
    app.closeStreams();
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});

test('archive and preview HTTP routes preserve reversible state and origin protection', async () => {
  const f = fixture();
  const app = createApp(f.service);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body = {}) => fetch(`${url}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const room = await (await post('/api/rooms', { name: 'One project' })).json();
    const task = await (await post('/api/tasks', {
      title: 'Draft', objective: 'write', assigneeId: f.builder.id, roomId: room.id, category: 'test',
    })).json();
    assert.equal(task.roomId, room.id);
    fs.writeFileSync(path.join(task.workspace, 'chapter.txt'), '<script>not executable</script>');
    f.service.recordArtifacts(task, manifest(task.workspace));
    const artifact = f.service.store.list('artifacts')[0];
    const preview = await fetch(`${url}/api/artifacts/${artifact.id}/preview`);
    assert.match(preview.headers.get('content-type'), /application\/json/);
    assert.equal((await preview.json()).text, '<script>not executable</script>');
    const download = await fetch(`${url}/api/artifacts/${artifact.id}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.equal(await download.text(), '<script>not executable</script>');
    fs.writeFileSync(path.join(task.workspace, 'chapter.txt'), 'changed');
    assert.equal((await fetch(`${url}/api/artifacts/${artifact.id}`)).status, 409);
    const rejected = await fetch(`${url}/api/tasks/${task.id}/archive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://outside.invalid' }, body: '{}',
    });
    assert.equal(rejected.status, 403);
    assert.equal((await post(`/api/rooms/${room.id}/archive`)).status, 409);
    assert.equal((await post(`/api/tasks/${task.id}/archive`)).status, 200);
    assert.equal((await (await fetch(`${url}/api/bootstrap`)).json()).tasks.length, 0);
    assert.equal((await (await fetch(`${url}/api/bootstrap?archived=1`)).json()).tasks.length, 1);
    assert.equal((await post(`/api/rooms/${room.id}/archive`)).status, 200);
    assert.equal((await post(`/api/tasks/${task.id}/restore`)).status, 200);
    const restored = await (await fetch(`${url}/api/bootstrap`)).json();
    assert.equal(restored.tasks[0].status, 'backlog');
    assert.equal(restored.rooms.length, 2);
    assert.equal(restored.runs.length, 0);
    assert.equal((await post(`/api/rooms/${room.id}/restore`)).status, 200);
  } finally {
    app.closeStreams();
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});

test('message receipts remain readable after delivery and cannot cross room or sender boundaries', async () => {
  const f = fixture();
  f.service.updateSettings({ paused: true });
  const app = createApp(f.service, { controllerToken: 'test-controller-token' });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const requestId = randomUUID();
    const endpoint = `${url}/api/rooms/team/message-requests/${requestId}`;
    assert.equal((await (await fetch(endpoint)).json()).message, null);
    const input = { requestId, body: '回执测试', recipientIds: [f.builder.id] };
    const send = () => fetch(`${url}/api/rooms/team/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const first = await (await send()).json();
    const receipt = await (await fetch(endpoint)).json();
    assert.equal(receipt.message.id, first.id);
    assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal((await (await send()).json()).id, first.id);
    const other = f.service.createRoom({ name: '其他频道' });
    assert.equal((await fetch(`${url}/api/rooms/${other.id}/message-requests/${requestId}`)).status, 409);
    assert.equal((await fetch(endpoint, { headers: { Authorization: 'Bearer test-controller-token' } })).status, 409);
    assert.equal(f.service.store.list('runs').length, 1);
  } finally {
    app.closeStreams();
    await new Promise(resolve => server.close(resolve));
    await f.close();
  }
});
