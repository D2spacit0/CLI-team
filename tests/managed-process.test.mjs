import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { fixture, until } from './helpers.mjs';

test('one HTTP objective traverses real CLI planning, rejection, repair and automatic delivery', async () => {
  const f = fixture();
  const app = createApp(f.service);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = async (route, body, method = 'POST') => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, result.error);
    return result;
  };
  try {
    const prefixArgs = [fileURLToPath(new URL('./fixtures/managed-cli.mjs', import.meta.url))];
    f.service.saveMember({ prefixArgs }, f.builder.id);
    f.service.saveMember({ prefixArgs }, f.reviewer.id);
    const worker = f.service.saveMember({ name: '固定协议协作者', handle: 'managed-process-worker', provider: 'custom',
      executable: process.execPath, prefixArgs, enabled: true, permission: 'edit' });
    await send('/api/settings', { managedTeam: { ownerId: f.builder.id, workerIds: [worker.id], reviewerId: f.reviewer.id,
      verification: { executable: process.execPath, args: [fileURLToPath(new URL('./fixtures/managed-acceptance.mjs', import.meta.url))] },
      autoDeliver: true } }, 'PATCH');
    const request = { requestId: randomUUID(), objective: '由主控完成模块并交付' };
    const task = await send('/api/requests', request);
    const result = await until(() => {
      const current = f.service.require('tasks', task.id);
      return ['done', 'blocked', 'review'].includes(current.status) && !f.service.active.size && current;
    }, 60000);
    assert.equal(result.status, 'done', result.summary);
    assert.equal(result.repairCount, 1);
    assert.equal(result.delivery.status, 'delivered');
    const evidence = f.service.require('evidence', result.gate.evidenceId);
    assert.equal(evidence.testCount, 1);
    assert.equal(evidence.skipped, 0);
    assert.equal(evidence.artifactRevision, result.delivery.artifactRevision);
    const runs = f.service.store.list('runs');
    assert.equal(runs.length, 8);
    assert.ok(runs.every((run) => run.status === 'succeeded' && run.exitCode === 0));
    assert.deepEqual(runs.map((run) => run.stage), ['plan', 'delegate', 'step_review', 'delegate', 'step_review', 'implement', 'review', 'final_review']);
    assert.equal((await send('/api/requests', request)).id, task.id);
    assert.equal(f.service.store.list('runs').length, 8);
  } finally {
    app.closeStreams();
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});
