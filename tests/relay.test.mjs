import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, success, until, writeDeliverable } from './helpers.mjs';

const snapshot = {
  sessionId: 'desktop-session', title: 'Research', activity: 'running',
  workspace: 'Z:\\never-open-source', summary: 'api_key=never-copy-this',
  lastRequest: 'Continue the original research', eventCount: 10,
  updatedAt: '2026-09-17T00:00:00.000Z', canControl: false,
};
const options = (extra = {}) => ({ dshCatalog: { get: () => snapshot }, ...extra });
const create = (f, extra = {}) => f.service.createTask({
  title: 'Independent relay', objective: 'Audit supplied copies', assigneeId: f.builder.id,
  sourceSessionId: snapshot.sessionId, ...extra,
});

test('an external relay stages a redacted excerpt without starting or transferring a desktop session', async () => {
  const f = fixture(options());
  try {
    const task = create(f);
    assert.equal(task.status, 'backlog');
    assert.equal(task.sourceContext.sessionId, snapshot.sessionId);
    assert.deepEqual(fs.readdirSync(task.workspace), ['relay-context.json']);
    const text = fs.readFileSync(path.join(task.workspace, task.sourceContext.file), 'utf8');
    const context = JSON.parse(text);
    assert.equal(context.sourceControlTransferred, false);
    assert.equal(context.historyComplete, false);
    assert.equal(context.sourceMayContinue, true);
    assert.ok(text.includes('[REDACTED]'));
    assert.ok(!text.includes('never-copy-this'));
    assert.ok(!text.includes(snapshot.workspace));
    assert.equal(f.service.store.list('conversations').length, 0);
    assert.equal(f.service.store.list('runs').length, 0);
    assert.equal(f.service.store.list('externalSessions').length, 0);
  } finally { await f.close(); }
});

test('a relay starts a new managed session and cannot count its input excerpt as a deliverable', async () => {
  let observed;
  const f = fixture(options({ agentExecutor: async (_member, prompt, invocation) => {
    observed = { prompt, ...invocation };
    return success();
  } }));
  try {
    const task = create(f, { start: true });
    await until(() => f.service.require('tasks', task.id).status === 'blocked');
    assert.equal(observed.conversationId, null);
    assert.equal(observed.workspace, task.workspace);
    assert.match(observed.prompt, /NOT a desktop session takeover/);
    assert.match(observed.prompt, /original session and source directory are NOT authorized/);
    assert.match(f.service.require('tasks', task.id).summary, /没有生成任何任务产物/);
  } finally { await f.close(); }
});

test('tampered relay context blocks before launching a CLI', async () => {
  let calls = 0;
  const f = fixture(options({ agentExecutor: async () => { calls++; return success(); } }));
  try {
    const task = create(f);
    fs.appendFileSync(path.join(task.workspace, task.sourceContext.file), '\nchanged');
    f.service.startTask(task.id);
    await until(() => f.service.require('tasks', task.id).status === 'blocked');
    assert.equal(calls, 0);
    assert.ok(f.service.store.list('runs')[0].riskFlags.includes('relay_context_changed'));
  } finally { await f.close(); }
});

test('a member cannot rewrite relay provenance while claiming completion', async () => {
  const f = fixture(options({ agentExecutor: async (_member, _prompt, { workspace }) => {
    writeDeliverable(workspace);
    fs.writeFileSync(path.join(workspace, 'relay-context.json'), '{"sourceControlTransferred":true}');
    return success();
  } }));
  try {
    const task = create(f, { start: true });
    await until(() => f.service.require('tasks', task.id).status === 'blocked');
    assert.ok(f.service.store.list('runs')[0].riskFlags.includes('relay_context_changed'));
  } finally { await f.close(); }
});

test('an unavailable external source creates no phantom relay task or workspace', async () => {
  const f = fixture({ dshCatalog: { get: () => { throw new Error('unsupported source'); } } });
  try {
    assert.throws(() => create(f), /unsupported source/);
    assert.equal(f.service.store.list('tasks').length, 0);
    assert.deepEqual(fs.readdirSync(f.service.workspaceRoot), []);
  } finally { await f.close(); }
});

test('a relay with a real deliverable still requires the normal gate and independent acceptance', async () => {
  const f = fixture(options({
    agentExecutor: async (member, _prompt, { workspace }) => {
      if (member.permission === 'edit') writeDeliverable(workspace);
      return success('Copy checked', { verdict: member.role === 'reviewer' ? 'approve' : 'none' });
    },
    verifier: async () => ({ passed: true, exitCode: 0, testCount: 1, skipped: 0, output: '1 passed' }),
  }));
  try {
    const task = create(f, { start: true, reviewerId: f.reviewer.id,
      verification: { executable: process.execPath, args: ['--test'] } });
    await until(() => f.service.require('tasks', task.id).status === 'review');
    assert.equal(f.service.store.list('runs').length, 2);
    assert.equal(f.service.require('tasks', task.id).gate.status, 'passed');
    const accepted = f.service.acceptTask(task.id, { note: 'Independent evidence checked' });
    assert.equal(accepted.status, 'done');
    assert.equal(JSON.parse(fs.readFileSync(path.join(task.workspace, 'relay-context.json'), 'utf8')).sourceControlTransferred, false);
  } finally { await f.close(); }
});
