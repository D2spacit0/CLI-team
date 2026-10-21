import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BackendHost } from '../desktop/backend-host.mjs';
import { temporary, cleanup } from './helpers.mjs';

function hostFixture({ hangAfterStopped = false } = {}) {
  const root = temporary();
  const serverDir = path.join(root, 'server');
  fs.mkdirSync(serverDir);
  fs.writeFileSync(path.join(serverDir, 'desktop-backend.mjs'), `
const keepAlive = setInterval(() => {}, 1000);
process.on('message', (message) => {
  if (message.type === 'failure') {
    process.send({ id: message.id, type: 'error', message: 'FIXTURE_OPERATION_FAILED' });
  } else if (message.type === 'status') {
    process.send({ id: message.id, type: 'status', activeRuns: 0, queuedRuns: 0, runningTasks: 0 });
  } else if (message.type === 'shutdown') {
    if (message.onlyIfIdle) {
      process.send({ id: message.id, type: 'busy', message: 'FIXTURE_STILL_BUSY' });
    } else {
      process.send({ id: message.id, type: 'stopped' }, () => {
        if (${hangAfterStopped}) return;
        clearInterval(keepAlive);
        process.disconnect();
      });
    }
  }
});
process.send({ type: 'ready', url: 'http://127.0.0.1:43177' });
`);
  const host = new BackendHost({ appRoot: root, nodePath: process.execPath, logPath: path.join(root, 'desktop.log') });
  const errors = [];
  host.on('host-error', (error) => errors.push(error.message));
  return { root, host, errors, async close() { await host.stop(); cleanup(root); } };
}

async function bounded(promise, timeout = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Host operation did not settle before its test deadline'), { code: 'TEST_TIMEOUT' })), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

test('desktop host rejects IPC error replies, preserves a busy backend and completes normal shutdown', async () => {
  const f = hostFixture();
  try {
    await bounded(f.host.start(f.root));
    const pid = f.host.child.pid;
    await assert.rejects(f.host.request('failure'), { code: 'error', message: 'FIXTURE_OPERATION_FAILED' });
    assert.equal(f.host.pending.size, 0);
    await assert.rejects(f.host.stop({ onlyIfIdle: true }), { code: 'busy', message: 'FIXTURE_STILL_BUSY' });
    assert.equal(f.host.child.pid, pid);
    assert.equal(f.host.state.stopping, false);
    assert.equal((await f.host.request('status')).type, 'status');
    const waiting = assert.rejects(f.host.request('hold'), /断开|退出/);
    await bounded(f.host.stop());
    await waiting;
    assert.equal(f.host.child, null);
    assert.equal(f.host.state.closed, true);
    assert.equal(f.host.pending.size, 0);
    assert.equal(f.host.url, '');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await bounded(f.host.stop(), 1000);
  } finally { await f.close(); }
});

test('desktop host forcefully reclaims a backend that acknowledges shutdown but never exits', async () => {
  const f = hostFixture({ hangAfterStopped: true });
  try {
    await bounded(f.host.start(f.root));
    const pid = f.host.child.pid;
    const start = Date.now();
    await bounded(f.host.stop(), 14000);
    assert.ok(Date.now() - start >= 4000, 'the stopped acknowledgement must still wait for process exit');
    assert.ok(f.errors.some((message) => /未按时退出/.test(message)));
    assert.equal(f.host.child, null);
    assert.equal(f.host.state.closed, true);
    assert.equal(f.host.pending.size, 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await f.close(); }
});

test('desktop host promptly rejects an existing but non-executable Node path and can be stopped afterward', async () => {
  const f = hostFixture();
  try {
    const invalidExecutable = path.join(f.root, 'invalid-node.exe');
    fs.writeFileSync(invalidExecutable, 'This is a fixture, not an executable.', { mode: 0o600 });
    f.host.nodePath = invalidExecutable;
    await assert.rejects(bounded(f.host.start(f.root), 4000), (error) => error.code !== 'TEST_TIMEOUT');
    assert.equal(f.host.child, null);
    assert.equal(f.host.pending.size, 0);
    await bounded(f.host.stop(), 1000);
  } finally { await f.close(); }
});
