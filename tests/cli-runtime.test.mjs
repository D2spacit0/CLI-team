import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildInvocation, discoverProvider, findExecutable, inspectCliEntry, OutputCollector } from '../server/adapters.mjs';
import { probeCli, runtimeFingerprint } from '../server/cli-runtime.mjs';
import { prepareDshRuntime } from '../server/dsh-runner.mjs';
import { readDshModelSettings, describeDshConfiguration } from '../server/dsh-config.mjs';
import { createApp } from '../server/app.mjs';
import { fixture, temporary, cleanup, success, until } from './helpers.mjs';

const executable = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url));
const dsh = { id: 'dsh-probe', provider: 'dsh', executable: process.execPath, prefixArgs: [executable, 'probe-only'],
  model: 'test-model', permission: 'plan' };

test('default model mode omits model overrides for every built-in CLI', () => {
  for (const provider of ['claude', 'gemini', 'codex', 'opencode', 'antigravity', 'dsh']) {
    const invocation = buildInvocation({ ...dsh, provider, model: '' }, 'test', {
      workspace: process.cwd(), logFile: path.join(process.cwd(), 'work', 'model-default.log'),
    });
    assert.ok(!invocation.args.includes('--model'), provider);
  }
});

test('Windows discovery skips npm shell shims and resolves the official Node entry', () => {
  if (process.platform !== 'win32') { assert.equal(findExecutable(process.execPath), process.execPath); return; }
  const root = temporary();
  const oldPath = process.env.PATH, oldAppData = process.env.APPDATA;
  try {
    const npm = path.join(root, 'npm');
    const entry = path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// official entry fixture');
    fs.writeFileSync(path.join(npm, 'codex'), '#!/bin/sh\n');
    process.env.PATH = npm;
    process.env.APPDATA = root;
    assert.equal(findExecutable('codex'), '');
    assert.deepEqual(discoverProvider('codex'), { executable: process.execPath, prefixArgs: [entry] });
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
    cleanup(root);
  }
});

test('finding Node alone does not validate a missing CLI JavaScript entry', async () => {
  const f = fixture();
  try {
    const broken = { executable: process.execPath, prefixArgs: [path.join(f.root, 'missing.mjs')], provider: 'dsh' };
    assert.equal(inspectCliEntry(broken).detected, false);
    const member = f.service.saveMember({ ...broken, name: 'Broken', handle: 'broken', enabled: true });
    assert.equal(member.detected, false);
    assert.equal(member.status, 'missing');
    assert.throws(() => f.service.runnable(member.id), /JS 入口/);
    const repaired = { executable: process.execPath, prefixArgs: [executable] };
    f.service.detect = () => repaired;
    f.service.discover();
    assert.deepEqual(f.service.require('members', member.id).prefixArgs, repaired.prefixArgs);
    const interpreter = await probeCli({ ...dsh, prefixArgs: [] }, { workspace: f.root });
    assert.equal(interpreter.status, 'missing');
    assert.equal(interpreter.checks.launch, 'not_checked');
  } finally { await f.close(); }
});

test('DSH connection probe performs a real handshake and model selection without a prompt or existing session', async () => {
  const root = temporary();
  try {
    const result = await probeCli(dsh, { workspace: root, dataDir: root, sourceHome: root });
    assert.equal(result.status, 'ready', result.error);
    assert.equal(result.checks.protocol, 'passed');
    assert.equal(result.checks.model, 'passed');
    assert.equal(result.checks.authentication, 'not_checked');
    assert.equal(result.diagnostics.promptSubmitted, false);
    assert.equal(result.diagnostics.session.operation, 'new');
    assert.equal(result.selectedModel, 'local/test');
    const invalid = await probeCli({ ...dsh, model: 'stale-model' }, { workspace: root, dataDir: root, sourceHome: root });
    assert.equal(invalid.status, 'failed');
    assert.equal(invalid.diagnostics.stage, 'model');
    assert.deepEqual(invalid.models, [{ id: 'local/test', name: 'test-model' }]);
    assert.equal(invalid.diagnostics.promptSubmitted, false);
    const defaults = await probeCli({ ...dsh, prefixArgs: [executable, 'default-only'], model: '' }, { workspace: root, dataDir: root, sourceHome: root });
    assert.equal(defaults.status, 'ready', defaults.error);
    assert.equal(defaults.diagnostics.requestedModel, null);
    assert.equal(defaults.selectedModel, 'local/test');
  } finally { cleanup(root); }
});

test('migrated DSH profile settings are referenced, with credentials and desktop behavior left in their official source', () => {
  const root = temporary();
  try {
    const profile = path.join(root, 'profiles', 'desktop', 'cordis.patch.yml');
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    const source = JSON.stringify([
      { id: 'agent-default-model', config: { provider: 'local', model: 'qwen' } },
      { id: 'llm-pi-ai', config: { providers: { local: { apiKey: 'sentinel-never-copy', models: [{ id: 'qwen', name: 'Qwen' }] } } } },
      { id: 'permissions', config: { mode: 'unsafe-ignored' } },
      { insert: [{ id: 'desktop-only', name: './never-execute.mjs', config: { secret: 'private' } }] },
    ]);
    fs.writeFileSync(profile, source);
    const configuration = describeDshConfiguration({ ...dsh, model: '' }, root);
    assert.equal(configuration.defaultModel, 'local/qwen');
    const settings = readDshModelSettings(configuration.sources);
    assert.deepEqual(Object.keys(settings).sort(), ['agent-default-model', 'llm-pi-ai']);
    const runtime = prepareDshRuntime({ dataDir: path.join(root, 'data'), sourceHome: root }, { ...dsh, model: '' });
    const patch = fs.readFileSync(runtime.patchFile, 'utf8');
    assert.ok(!patch.includes('sentinel-never-copy'));
    assert.ok(!patch.includes('unsafe-ignored'));
    assert.ok(!patch.includes('never-execute'));
    assert.ok(patch.includes('dsh-settings-bridge.mjs'));
    assert.equal(fs.readFileSync(profile, 'utf8'), source);
    assert.equal(runtime.env.DSH_PERMISSION_MODE, 'read-only');
    assert.deepEqual(runtime.configuration.bootstrapRoute, { provider: 'local', model: 'qwen' });
    const first = runtimeFingerprint(dsh, root);
    fs.appendFileSync(profile, '\n');
    assert.notEqual(runtimeFingerprint(dsh, root), first);
    assert.throws(() => describeDshConfiguration({ ...dsh, dshConfigProfile: 'web' }, root), /未找到/);
    fs.writeFileSync(profile, 'apiKey: [sentinel-invalid-private');
    assert.throws(() => describeDshConfiguration(dsh, root), (error) => !error.message.includes('sentinel-invalid-private'));
  } finally { cleanup(root); }
});

test('DSH legacy model settings remain supported and take precedence over profile defaults', () => {
  const root = temporary();
  try {
    fs.writeFileSync(path.join(root, 'settings.yaml'), JSON.stringify({ 'agent-default-model': { provider: 'old', model: 'kept' },
      unrelated: { api_key: 'never-persist' } }));
    const runtime = prepareDshRuntime({ dataDir: path.join(root, 'data'), sourceHome: root }, { ...dsh, model: '' });
    assert.deepEqual(runtime.configuration.bootstrapRoute, { provider: 'old', model: 'kept' });
    assert.ok(!fs.readFileSync(runtime.patchFile, 'utf8').includes('never-persist'));
  } finally { cleanup(root); }
});

test('connection checks reserve their member and invalidate results when execution configuration changes', async () => {
  let release;
  const f = fixture({ probe: async () => new Promise((resolve) => { release = () => resolve({ status: 'available', checkedAt: new Date().toISOString() }); }) });
  try {
    const checking = f.service.probeMember(f.builder.id);
    assert.equal(f.service.members().find((member) => member.id === f.builder.id).runtime.checking, true);
    await assert.rejects(f.service.probeMember(f.builder.id), /正在参与/);
    assert.throws(() => f.service.saveMember({ model: 'new' }, f.builder.id), /暂不能修改/);
    assert.throws(() => f.service.runnable(f.builder.id), /检查接入/);
    f.service.saveMember({ skills: 'updated' }, f.builder.id);
    release();
    const probed = await checking;
    assert.equal(probed.runtime.status, 'available');
    assert.equal(probed.runtime.checking, false);
    f.service.saveMember({ model: 'new' }, f.builder.id);
    assert.equal(f.service.members().find((member) => member.id === f.builder.id).runtime.status, 'unchecked');
    assert.equal(f.service.store.list('runs').length, 0);
    assert.equal(f.service.store.list('conversations').length, 0);
  } finally { await f.close(); }
});

test('a failed resume retains the prior mapping but never reports the old ID as a confirmed session', async () => {
  const f = fixture({ agentExecutor: async () => ({ success: false, error: 'resume failed', response: '', report: null,
    conversationId: null, exitCode: 0, riskFlags: ['provider_error'], diagnostics: { transport: 'acp', stage: 'resume',
      promptSubmitted: false, session: { operation: 'resume', requestedId: 'old-session', id: null, state: 'failed' } } }) });
  try {
    f.service.store.put('conversations', { id: `team:${f.builder.id}`, conversationId: 'old-session' });
    f.service.send('team', { body: 'task', recipientIds: [f.builder.id] });
    await until(() => f.service.store.list('runs').find((run) => run.status === 'failed'));
    const run = f.service.store.list('runs')[0];
    assert.equal(run.conversationId, null);
    assert.equal(run.runtime.session.requestedId, 'old-session');
    assert.equal(f.service.store.get('conversations', `team:${f.builder.id}`).conversationId, 'old-session');
    f.service.store.put('conversations', { id: `team:${f.builder.id}:plan`, conversationId: 'other-stage' });
    f.service.resetConversation('team', f.builder.id, { confirm: true, runId: run.id });
    assert.equal(f.service.store.get('conversations', `team:${f.builder.id}`), null);
    assert.equal(f.service.store.get('conversations', `team:${f.builder.id}:plan`).conversationId, 'other-stage');
    f.service.store.put('conversations', { id: `team:${f.builder.id}`, conversationId: 'new-session' });
    assert.throws(() => f.service.resetConversation('team', f.builder.id, { confirm: true, runId: run.id }), /已经变化/);
    assert.equal(f.service.store.get('conversations', `team:${f.builder.id}`).conversationId, 'new-session');
  } finally { await f.close(); }
});

test('CLI failure events retain their reason and cannot be masked by a later successful exit/result', () => {
  for (const provider of ['codex', 'claude', 'gemini', 'opencode']) {
    const collector = new OutputCollector(provider, process.cwd());
    collector.line(JSON.stringify({ type: 'error', error: { message: 'service unavailable', data: { details: 'access_token=secret-do-not-log' } } }));
    collector.line(JSON.stringify({ type: 'result', result: success().response }));
    const result = collector.finish(0);
    assert.equal(result.success, false);
    assert.match(result.error, /service unavailable/);
    assert.ok(!result.error.includes('secret-do-not-log'));
  }
});

test('connection check HTTP endpoint keeps loopback origin protection and distinguishes inspection from model execution', async () => {
  const f = fixture();
  const app = createApp(f.service);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/members/${f.builder.id}/probe`;
  try {
    const bad = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://invalid.example' }, body: '{}' });
    assert.equal(bad.status, 403);
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    const member = await response.json();
    assert.equal(member.runtime.checks.entry, 'passed');
    assert.equal(member.runtime.checks.launch, 'not_checked');
    assert.equal(member.runtime.status, 'unchecked');
    assert.equal(f.service.store.list('runs').length, 0);
  } finally {
    app.closeStreams();
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});
