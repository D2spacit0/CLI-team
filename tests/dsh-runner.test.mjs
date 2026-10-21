import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeDsh, prepareDshRuntime, selectDshModel } from '../server/dsh-runner.mjs';
import { temporary, cleanup } from './helpers.mjs';

const executable = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url));
async function run(mode, { permission = 'plan', ...extra } = {}) {
  const root = temporary();
  try {
    return await executeDsh({ provider: 'dsh', executable: process.execPath, prefixArgs: [executable, mode],
      permission, model: 'test-model' }, 'test', {
      workspace: root, dataDir: root, sourceHome: root, streamLog: path.join(root, 'run.log'), timeoutMinutes: 0.1,
      ...extra,
    });
  } finally { cleanup(root); }
}

test('DSH uses real ACP framing, config selection and a persistent session ID', async () => {
  const first = await run('success');
  assert.equal(first.success, true, first.error);
  assert.equal(first.conversationId, 'fake-session');
  assert.equal(first.report.summary, 'DSH ACP fixture');
  const resumed = await run('success', { conversationId: 'fake-session' });
  assert.equal(resumed.success, true, resumed.error);
});

test('DSH repeated tool failures stop before exhausting the timeout', async () => {
  const started = Date.now();
  const result = await run('loop');
  assert.equal(result.success, false);
  assert.ok(result.riskFlags.includes('repeated_tool_failure'));
  assert.equal(result.timedOut, false);
  assert.ok(Date.now() - started < 4000);
});

test('DSH members have separate runtime homes and discussion patches', () => {
  const root = temporary();
  try {
    const options = { dataDir: root, sourceHome: root };
    const first = prepareDshRuntime(options, { id: 'dsh-builder', permission: 'edit' });
    const second = prepareDshRuntime(options, { id: 'dsh-reviewer', permission: 'plan' });
    const discussion = prepareDshRuntime({ ...options, analysisOnly: true }, { id: 'dsh-builder', permission: 'plan' });
    assert.notEqual(first.home, second.home);
    assert.equal(fs.statSync(first.home).isDirectory(), true);
    assert.equal(fs.statSync(second.home).isDirectory(), true);
    assert.equal(first.home, discussion.home);
    assert.notEqual(first.patchFile, discussion.patchFile);
    assert.equal(second.env.DSH_PERMISSION_MODE, 'read-only');
  } finally { cleanup(root); }
});

test('DSH resume lock failure never silently creates a fresh session', async () => {
  const result = await run('locked', { conversationId: 'original' });
  assert.equal(result.success, false);
  assert.match(result.error, /lock/);
  assert.equal(result.conversationId, null);
});

test('DSH preserves ACP error details and distinguishes a failed resume from a submitted task', async () => {
  const result = await run('missing-provider', { conversationId: 'original' });
  assert.equal(result.success, false);
  assert.match(result.error, /no adapter registered/);
  assert.ok(!JSON.stringify(result).includes('secret-never-log'));
  assert.ok(!JSON.stringify(result).includes('secret-header-never-log'));
  assert.equal(result.diagnostics.stage, 'resume');
  assert.equal(result.diagnostics.code, '-32603');
  assert.equal(result.diagnostics.method, 'session/resume');
  assert.equal(result.diagnostics.promptSubmitted, false);
  assert.equal(result.diagnostics.session.requestedId, 'original');
  assert.equal(result.diagnostics.session.id, null);
  assert.equal(result.diagnostics.session.state, 'failed');
  assert.ok(!result.riskFlags.includes('unstructured_report'));
});

test('DSH refuses incompatible protocols and unadvertised resume support before submitting work', async () => {
  const wrong = await run('wrong-version');
  assert.match(wrong.error, /协议版本/);
  assert.equal(wrong.diagnostics.stage, 'initialize');
  assert.equal(wrong.diagnostics.promptSubmitted, false);
  const unsupported = await run('no-resume', { conversationId: 'original' });
  assert.match(unsupported.error, /未声明会话恢复能力/);
  assert.equal(unsupported.conversationId, null);
});

test('DSH permission denial is failure even if the model claims complete', async () => {
  const result = await run('denied');
  assert.equal(result.success, false);
  assert.ok(result.riskFlags.includes('permission_denied'));
});

test('unavailable tools in pure analysis remain warnings, not false execution failures', async () => {
  const result = await run('unavailable', { analysisOnly: true });
  assert.equal(result.success, true, result.error);
  assert.equal(result.warnings.length, 1);
  const normalTask = await run('unavailable');
  assert.equal(normalTask.success, false);
  assert.ok(normalTask.riskFlags.includes('tool_failed'));
});

test('a DSH soft permission denial is never downgraded to an analysis warning', async () => {
  const result = await run('soft-denied', { analysisOnly: true });
  assert.equal(result.success, false);
  assert.ok(result.riskFlags.includes('permission_denied'));
});

test('an explicitly rejected no-op edit is a warning only for a permitted editor', async () => {
  const editor = await run('noop-edit', { permission: 'edit' });
  assert.equal(editor.success, true);
  assert.equal(editor.warnings.length, 1);
  const reader = await run('noop-edit');
  assert.equal(reader.success, false);
  assert.ok(reader.riskFlags.includes('tool_failed'));
  const analysis = await run('noop-edit', { permission: 'edit', analysisOnly: true });
  assert.equal(analysis.success, false);
});

test('read-before-edit recovery is a warning only for authorized workspace paths', async () => {
  const editor = await run('read-first', { permission: 'edit' });
  assert.equal(editor.success, true);
  assert.equal(editor.warnings.length, 1);
  const outside = await run('outside-read-first', { permission: 'edit' });
  assert.equal(outside.success, false);
  assert.ok(outside.riskFlags.includes('tool_failed'));
  const reader = await run('read-first');
  assert.equal(reader.success, false);
});

test('repeated unavailable tools still hit the deliberate analysis loop limit', async () => {
  const result = await run('unavailable-loop', { analysisOnly: true });
  assert.equal(result.success, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.warnings.length, 3);
  assert.ok(result.riskFlags.includes('repeated_tool_failure'));
});

test('DSH timeout and cancellation settle and reap the owned child', async () => {
  const timed = await run('wait', { timeoutMinutes: 0.01 });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.success, false);
  const signal = AbortSignal.timeout(400);
  const cancelled = await run('wait', { signal });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.success, false);
});

test('DSH model selection rejects ambiguous and missing model names', () => {
  const field = { id: 'model', options: [
    { name: 'same', value: 'a' }, { name: 'same', value: 'b' },
  ] };
  assert.throws(() => selectDshModel([field], 'same'), /唯一匹配/);
  assert.throws(() => selectDshModel([field], 'missing'), /唯一匹配/);
  assert.deepEqual(selectDshModel([{ id: 'model', options: [{
    group: 'local', options: [{ name: 'Qwen', value: '["local","test"]' }],
  }] }], 'local/test'), { configId: 'model', value: '["local","test"]' });
});

async function recoveryRun(mode) {
  const root = temporary();
  try {
    const entry = path.join(root, 'client/lib/bin.mjs');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(path.join(root, 'client/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', type: 'module' }));
    fs.writeFileSync(entry, `import ${JSON.stringify(new URL('./fixtures/fake-dsh.mjs', import.meta.url).href)};`);
    fs.writeFileSync(path.join(root, 'settings.yaml'), JSON.stringify({ 'agent-default-model': { provider: 'local', model: 'qwen38' } }));
    const result = await executeDsh({ id: 'dsh-recovery-fixture', provider: 'dsh', executable: process.execPath,
      prefixArgs: [entry, mode], permission: 'plan', model: '' }, '只发送一次', {
      workspace: root, dataDir: root, sourceHome: root, streamLog: path.join(root, 'run.log'),
      timeoutMinutes: 0.1, conversationId: 'fake-session', analysisOnly: true,
    });
    return { result, requests: JSON.parse(fs.readFileSync(path.join(root, 'fixture-requests.json'), 'utf8')),
      temporaryReceipts: fs.readdirSync(path.join(root, 'dsh-runtime/dsh-recovery-fixture')).filter(name => /^resume-/.test(name)) };
  } finally { cleanup(root); }
}

test('DSH applies and verifies recovered selection before sending once to the same native session', async () => {
  const { result, requests, temporaryReceipts } = await recoveryRun('recovery-success');
  assert.equal(result.success, true, result.error);
  assert.equal(result.conversationId, 'fake-session');
  assert.deepEqual(requests, ['initialize', 'session/resume', 'session/set_config_option', 'session/prompt', 'session/close']);
  assert.deepEqual(result.diagnostics.modelRecovery, { from: 'local/Qwen3.8-27B', to: 'local/qwen38', reason: 'UNKNOWN_MODEL', state: 'applied' });
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(temporaryReceipts, []);
});

test('DSH refuses an unconfirmed replacement model without submitting or creating a session', async () => {
  const { result, requests, temporaryReceipts } = await recoveryRun('recovery-unconfirmed');
  assert.equal(result.success, false);
  assert.match(result.error, /未确认恢复后的模型/);
  assert.equal(result.diagnostics.promptSubmitted, false);
  assert.equal(result.diagnostics.modelRecovery.state, 'pending');
  assert.deepEqual(requests, ['initialize', 'session/resume', 'session/set_config_option', 'session/close']);
  assert.deepEqual(temporaryReceipts, []);
});

test('DSH rejects recovery evidence for a different session or a model different from current settings', async () => {
  for (const mode of ['recovery-wrong-session', 'recovery-wrong-target']) {
    const { result, requests, temporaryReceipts } = await recoveryRun(mode);
    assert.equal(result.success, false);
    assert.match(result.error, /恢复记录无法确认|恢复模型与当前设置不一致/);
    assert.equal(result.diagnostics.promptSubmitted, false);
    assert.deepEqual(requests, ['initialize', 'session/resume', 'session/close']);
    assert.deepEqual(temporaryReceipts, []);
  }
});
