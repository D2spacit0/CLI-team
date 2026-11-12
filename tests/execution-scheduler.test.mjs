import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, success, until } from './helpers.mjs';

test('an incomplete queued run is explicitly held without crashing dispatch or releasing its member reservation', async () => {
  const calls = [];
  const f = fixture({ agentExecutor: async member => { calls.push(member.id); return success('有效运行正常完成'); } });
  try {
    f.service.updateSettings({ paused: true });
    const malformed = { id: 'incomplete-run', memberId: f.builder.id, status: 'queued' };
    f.service.store.put('runs', malformed);
    const events = [];
    f.service.on('change', event => { if (event.type === 'dispatch.blocked' && event.payload.id === malformed.id) events.push(event); });
    const valid = f.service.enqueue({ roomId: 'team', memberId: f.reviewer.id, stage: 'chat', prompt: '后续有效工作仍需执行' });
    f.service.updateSettings({ paused: false });
    await until(() => f.service.store.get('runs', valid.id).status === 'succeeded' && f.service.active.size === 0);
    const held = f.service.store.get('runs', malformed.id);
    assert.equal(held.status, 'queued', 'the saved queue reservation must not be silently released');
    assert.equal(held.dispatchCheck.status, 'blocked');
    assert.equal(held.dispatchCheck.code, 'invalid_run_context');
    assert.equal(held.dispatchCheck.evidenceType, 'machine');
    assert.match(held.error, /roomId/);
    assert.match(held.summary, /未派发/);
    assert.equal(held.startedAt, undefined);
    assert.equal(held.outputCheck, undefined);
    assert.deepEqual(calls, [f.reviewer.id]);
    assert.throws(() => f.service.saveMember({ permission: 'plan' }, f.builder.id), { status: 409 });
    for (let count = 0; count < 3; count++) f.service.pump();
    assert.equal(events.length, 1, 'repeated pumping must not flood diagnostics for the same malformed record');
    assert.deepEqual(f.service.store.get('runs', malformed.id).dispatchCheck, held.dispatchCheck);
    const cancelled = f.service.cancelRun(malformed.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(f.service.saveMember({ permission: 'plan' }, f.builder.id).permission, 'plan');
  } finally { await f.close(); }
});

test('missing or unknown dispatch identities never reach SQLite binding errors or the executor', async () => {
  let calls = 0;
  const f = fixture({ agentExecutor: async () => { calls++; return success(); } });
  try {
    f.service.updateSettings({ paused: true });
    const cases = [
      { id: 'missing-member', roomId: 'team', stage: 'chat' },
      { id: 'unknown-member', memberId: 'missing-record', roomId: 'team', stage: 'chat' },
      { id: 'unknown-room', memberId: f.builder.id, roomId: 'missing-room', stage: 'chat' },
      { id: 'missing-stage', memberId: f.builder.id, roomId: 'team' },
      { id: 'missing-business-context', memberId: f.builder.id, workflowKind: 'business', stage: 'analysis' },
      { id: 'missing-business-generation', memberId: f.builder.id, workflowKind: 'business', stage: 'analysis',
        projectId: 'project', workItemId: 'work', attemptId: 'attempt', jobId: 'job' },
    ];
    for (const run of cases) f.service.store.put('runs', { ...run, status: 'queued' });
    f.service.updateSettings({ paused: false });
    await until(() => cases.every(run => f.service.store.get('runs', run.id).dispatchCheck?.status === 'blocked'));
    assert.equal(calls, 0);
    assert.equal(f.service.active.size, 0);
    for (const run of cases) {
      const stored = f.service.store.get('runs', run.id);
      assert.equal(stored.status, 'queued');
      assert.match(stored.error, /未派发/);
      assert.equal(stored.process, undefined);
      assert.equal(stored.outputCheck, undefined);
    }
  } finally { await f.close(); }
});
