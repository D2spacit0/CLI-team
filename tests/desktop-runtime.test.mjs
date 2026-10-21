import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startWorkbench } from '../server/runtime.mjs';
import { killChild } from '../server/safety.mjs';
import { temporary, cleanup } from './helpers.mjs';

const desktopToken = 'desktop-test-capability-0123456789abcdef0123456789abcdef';
const desktopHeaders = { 'X-CLI-Team-Desktop': desktopToken };
function prepare() {
  const root = temporary();
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>Desktop test</title>PRIVATE_WORKBENCH');
  fs.writeFileSync(path.join(distDir, 'application.js'), '/* PRIVATE_APPLICATION_ASSET */');
  return { root, options: { root, distDir, port: 0, desktopOnly: true, desktopToken } };
}
const get = (runtime, route, headers = {}) => fetch(`${runtime.url}${route}`, { headers, signal: AbortSignal.timeout(5000) });
function backendMessage(child, predicate) {
  return new Promise((resolve, reject) => {
    const finish = (error, message) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(message);
    };
    const onMessage = (message) => { if (predicate(message)) finish(null, message); };
    const onExit = () => finish(new Error('Backend exited before its IPC reply'));
    const timer = setTimeout(() => finish(new Error('Backend IPC reply timed out')), 10000);
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}
function launchBackend(f) {
  const env = { ...process.env, CLI_TEAM_ROOT: f.root, CLI_TEAM_ASSET_ROOT: f.root, CLI_TEAM_DESKTOP_TOKEN: desktopToken };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(fileURLToPath(new URL('../server/desktop-backend.mjs', import.meta.url)), [], {
    cwd: f.root, execPath: process.execPath, execArgv: [], env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
}
async function disposeBackend(backend) {
  if (!backend) return;
  if (backend.child.connected) backend.child.disconnect();
  const timeout = setTimeout(() => killChild(backend.child), 5000);
  try { await backend.exited; } finally { clearTimeout(timeout); }
}

test('desktop runtime protects HTML, assets, API and streams while preserving the controller interface', async () => {
  const f = prepare();
  let runtime;
  try {
    runtime = await startWorkbench(f.options);
    assert.equal(new URL(runtime.url).hostname, '127.0.0.1');
    assert.equal(new URL(runtime.url).search, '');
    for (const route of ['/', '/application.js', '/api/health', '/api/bootstrap', '/api/events', '/api/artifacts/missing']) {
      const response = await get(runtime, route);
      assert.equal(response.status, 401, route);
      assert.doesNotMatch(await response.text(), /PRIVATE_WORKBENCH|PRIVATE_APPLICATION_ASSET/);
    }
    assert.equal((await get(runtime, '/api/bootstrap', { 'X-CLI-Team-Desktop': 'wrong-token' })).status, 401);
    assert.equal((await get(runtime, `/api/bootstrap?desktopToken=${desktopToken}`)).status, 401);
    assert.match(await (await get(runtime, '/', desktopHeaders)).text(), /PRIVATE_WORKBENCH/);
    assert.match(await (await get(runtime, '/application.js', desktopHeaders)).text(), /PRIVATE_APPLICATION_ASSET/);
    assert.equal((await get(runtime, '/api/bootstrap', desktopHeaders)).status, 200);
    assert.equal((await get(runtime, '/api/control/status', desktopHeaders)).status, 401);
    const controllerToken = fs.readFileSync(path.join(f.root, '.team', 'controller.token'), 'utf8').trim();
    assert.ok(controllerToken.length >= 32);
    const controllerHeaders = { Authorization: `Bearer ${controllerToken}` };
    assert.equal((await get(runtime, '/api/control/status', controllerHeaders)).status, 200);
    assert.equal((await get(runtime, '/api/bootstrap', controllerHeaders)).status, 200);
    const crossOrigin = await fetch(`${runtime.url}/api/rooms`, { method: 'POST',
      headers: { ...desktopHeaders, 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' },
      body: JSON.stringify({ name: 'Should not be created' }), signal: AbortSignal.timeout(5000) });
    assert.equal(crossOrigin.status, 403);
    const descriptor = fs.readFileSync(path.join(f.root, '.team', 'server.json'), 'utf8');
    assert.equal(descriptor.includes(desktopToken), false);
    assert.equal(descriptor.includes(controllerToken), false);
    assert.equal(runtime.url.includes(desktopToken), false);
  } finally { await runtime?.close(); cleanup(f.root); }
});

test('a duplicate workspace startup preserves the original lock, descriptor and live data', async () => {
  const f = prepare();
  let runtime, duplicate;
  try {
    runtime = await startWorkbench(f.options);
    const room = runtime.service.createRoom({ name: '原实例数据' });
    const lockPath = path.join(f.root, '.team', 'service.lock');
    const descriptorPath = path.join(f.root, '.team', 'server.json');
    const originalLock = fs.readFileSync(lockPath, 'utf8');
    const originalDescriptor = fs.readFileSync(descriptorPath, 'utf8');
    await assert.rejects(async () => { duplicate = await startWorkbench(f.options); });
    assert.equal(fs.readFileSync(lockPath, 'utf8'), originalLock);
    assert.equal(fs.readFileSync(descriptorPath, 'utf8'), originalDescriptor);
    assert.equal(runtime.service.require('rooms', room.id).name, '原实例数据');
    assert.equal((await get(runtime, '/api/bootstrap', desktopHeaders)).status, 200);
  } finally { await duplicate?.close(); await runtime?.close(); cleanup(f.root); }
});

test('closing the desktop runtime drains streams, releases its port and lock, and preserves workspace data', async () => {
  const f = prepare();
  let runtime, reopened, portProbe, reader;
  try {
    runtime = await startWorkbench(f.options);
    const room = runtime.service.createRoom({ name: '下次启动保留' });
    const workspaceFile = path.join(runtime.service.workspaceRoot, 'keep.txt');
    fs.writeFileSync(workspaceFile, 'preserved deliverable');
    const tokenPath = path.join(f.root, '.team', 'controller.token');
    const originalToken = fs.readFileSync(tokenPath, 'utf8');
    const stream = await get(runtime, '/api/events', desktopHeaders);
    assert.equal(stream.status, 200);
    reader = stream.body.getReader();
    assert.equal((await reader.read()).done, false);
    const port = Number(new URL(runtime.url).port);
    await runtime.close();
    await runtime.close();
    assert.equal((await reader.read()).done, true);
    assert.equal(fs.existsSync(path.join(f.root, '.team', 'service.lock')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.team', 'server.json')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.team', 'team.sqlite')), true);
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), originalToken);
    assert.equal(fs.readFileSync(workspaceFile, 'utf8'), 'preserved deliverable');
    portProbe = net.createServer();
    await new Promise((resolve, reject) => {
      portProbe.once('error', reject);
      portProbe.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => portProbe.close(resolve));
    reopened = await startWorkbench(f.options);
    assert.equal(reopened.service.require('rooms', room.id).name, '下次启动保留');
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), originalToken);
  } finally {
    await reader?.cancel().catch(() => {});
    if (portProbe?.listening) await new Promise((resolve) => portProbe.close(resolve));
    await reopened?.close(); await runtime?.close(); cleanup(f.root);
  }
});

test('desktop runtime refuses public bind addresses and an empty desktop capability', async () => {
  const f = prepare();
  let unexpected;
  try {
    for (const host of ['0.0.0.0', '192.0.2.1', '::']) {
      await assert.rejects(async () => { unexpected = await startWorkbench({ ...f.options, host }); });
      assert.equal(fs.existsSync(path.join(f.root, '.team', 'service.lock')), false);
    }
    await assert.rejects(async () => { unexpected = await startWorkbench({ ...f.options, desktopToken: '' }); });
    assert.equal(fs.existsSync(path.join(f.root, '.team', 'service.lock')), false);
  } finally { await unexpected?.close(); cleanup(f.root); }
});

for (const location of ['project', 'data']) {
  test(`desktop startup respects a security hold in the ${location} directory before acquiring a lock`, async () => {
    const f = prepare();
    let unexpected;
    try {
      const dataDir = path.join(f.root, 'desktop-data');
      const holdDir = location === 'project' ? path.join(f.root, '.team') : dataDir;
      fs.mkdirSync(holdDir);
      const holdPath = path.join(holdDir, 'security-hold.json');
      fs.writeFileSync(holdPath, 'invalid JSON still blocks startup');
      await assert.rejects(async () => { unexpected = await startWorkbench({ ...f.options, dataDir }); }, /paused for security review/);
      assert.equal(fs.readFileSync(holdPath, 'utf8'), 'invalid JSON still blocks startup');
      assert.equal(fs.existsSync(path.join(dataDir, 'service.lock')), false);
      assert.equal(fs.existsSync(path.join(dataDir, 'server.json')), false);
      assert.equal(fs.existsSync(path.join(dataDir, 'team.sqlite')), false);
    } finally { await unexpected?.close(); cleanup(f.root); }
  });
}

test('an unreadable existing service lock is preserved instead of being reclaimed', async () => {
  const f = prepare();
  let unexpected;
  try {
    const dataDir = path.join(f.root, '.team');
    fs.mkdirSync(dataDir);
    const lockPath = path.join(dataDir, 'service.lock');
    fs.writeFileSync(lockPath, '{damaged lock');
    await assert.rejects(async () => { unexpected = await startWorkbench(f.options); });
    assert.equal(fs.readFileSync(lockPath, 'utf8'), '{damaged lock');
    assert.equal(fs.existsSync(path.join(dataDir, 'server.json')), false);
  } finally { await unexpected?.close(); cleanup(f.root); }
});

test('a failed desktop startup releases its own lock so corrected assets can start normally', async () => {
  const f = prepare();
  let runtime;
  try {
    await assert.rejects(() => startWorkbench({ ...f.options, distDir: path.join(f.root, 'missing-dist') }));
    assert.equal(fs.existsSync(path.join(f.root, '.team', 'service.lock')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.team', 'server.json')), false);
    runtime = await startWorkbench(f.options);
    assert.equal((await get(runtime, '/api/bootstrap', desktopHeaders)).status, 200);
  } finally { await runtime?.close(); cleanup(f.root); }
});

test('the desktop backend correlates status and shutdown replies and exits without leaving a service lock', async () => {
  const f = prepare();
  let backend;
  try {
    backend = launchBackend(f);
    const ready = await backendMessage(backend.child, (message) => message.type === 'ready');
    assert.equal(new URL(ready.url).hostname, '127.0.0.1');
    const statusReply = backendMessage(backend.child, (message) => message.id === 'status-test');
    backend.child.send({ type: 'status', id: 'status-test' });
    const status = await statusReply;
    assert.equal(status.type, 'status');
    assert.equal(status.activeRuns, 0);
    assert.equal(status.queuedRuns, 0);
    assert.equal(status.runningTasks, 0);
    const stoppedReply = backendMessage(backend.child, (message) => message.id === 'shutdown-test');
    backend.child.send({ type: 'shutdown', id: 'shutdown-test', onlyIfIdle: true });
    assert.equal((await stoppedReply).type, 'stopped');
    assert.deepEqual(await backend.exited, { code: 0, signal: null });
    assert.equal(fs.existsSync(path.join(f.root, '.team', 'service.lock')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.team', 'server.json')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.team', 'team.sqlite')), true);
  } finally { await disposeBackend(backend); cleanup(f.root); }
});

test('disconnecting the desktop parent stops its backend and retains existing task data', async () => {
  const f = prepare();
  let backend;
  try {
    backend = launchBackend(f);
    const ready = await backendMessage(backend.child, (message) => message.type === 'ready');
    const response = await fetch(`${ready.url}/api/rooms`, { method: 'POST',
      headers: { ...desktopHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '父进程关闭前的频道' }),
      signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 201);
    backend.child.disconnect();
    const timeout = setTimeout(() => killChild(backend.child), 5000);
    try { assert.deepEqual(await backend.exited, { code: 0, signal: null }); } finally { clearTimeout(timeout); }
    assert.equal(fs.existsSync(path.join(f.root, '.team', 'service.lock')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.team', 'server.json')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.team', 'team.sqlite')), true);
  } finally { await disposeBackend(backend); cleanup(f.root); }
});

test('a backend that encounters a live workspace lock reports an error and exits without touching the owner', async () => {
  const f = prepare();
  let runtime, backend;
  try {
    runtime = await startWorkbench(f.options);
    const lockPath = path.join(f.root, '.team', 'service.lock');
    const descriptorPath = path.join(f.root, '.team', 'server.json');
    const lock = fs.readFileSync(lockPath, 'utf8');
    const descriptor = fs.readFileSync(descriptorPath, 'utf8');
    backend = launchBackend(f);
    const failure = await backendMessage(backend.child, (message) => message.type === 'error');
    assert.match(failure.message, /已经运行/);
    assert.deepEqual(await backend.exited, { code: 1, signal: null });
    assert.equal(fs.readFileSync(lockPath, 'utf8'), lock);
    assert.equal(fs.readFileSync(descriptorPath, 'utf8'), descriptor);
    assert.equal((await get(runtime, '/api/bootstrap', desktopHeaders)).status, 200);
  } finally { await disposeBackend(backend); await runtime?.close(); cleanup(f.root); }
});
