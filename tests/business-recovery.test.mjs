import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TeamService } from '../server/service.mjs';
import { BusinessStore } from '../server/business-store.mjs';
import { projectDay } from '../server/projects.mjs';
import { runProcess } from '../server/runner.mjs';
import { temporary, cleanup, until, success } from './helpers.mjs';

const options = { proxy: '', detect: () => ({ executable: '', prefixArgs: [] }) };
const simulatedExit = { processExitConfirmed: true, processExitProofVersion: 1,
  processExitEvidence: { confirmed: true, method: 'simulated_test_executor' } };

async function crashState({ runPatch = {}, workPatch = {}, claimed = true } = {}) {
  const root = temporary();
  const service = new TeamService({ root, ...options, agentExecutor: async () => { throw new Error('Setup must not launch a CLI'); } });
  service.store.update('settings', 'workspace', { paused: true });
  const writer = service.saveMember({ name: '恢复执行者', handle: 'recovery-writer', provider: 'custom', role: 'builder',
    executable: process.execPath, permission: 'plan', enabled: true });
  const reviewer = service.saveMember({ name: '恢复评审', handle: 'recovery-reviewer', provider: 'custom', role: 'reviewer',
    executable: process.execPath, permission: 'plan', enabled: true });
  const project = service.projects.create({ name: '恢复边界', objective: '检验已提交状态与未决执行的恢复',
    ownerId: writer.id, reviewerId: reviewer.id, memberIds: [writer.id, reviewer.id] });
  const work = service.business.createWork({ projectId: project.id, memberId: writer.id, kind: 'analysis', title: '可恢复分析',
    objective: '返回一份有明确内容的分析', output: { type: 'analysis', sections: ['summary'] } });
  service.business.admit();
  let run = service.store.list('runs').find(value => value.workItemId === work.id);
  assert.ok(run, 'a committed outbox job admits exactly one queued run');
  if (claimed) assert.equal(service.business.claim(run), true);
  run = service.store.update('runs', run.id, runPatch);
  if (run.startIssued && run.budgetId) new BusinessStore(service.store).markBudgetStarted(run.budgetId);
  service.store.update('workItems', work.id, workPatch);
  const state = { root, projectId: project.id, writerId: writer.id, workId: work.id, runId: run.id,
    originalAttemptId: run.attemptId, jobId: run.jobId, originalWorkspace: run.workspace, run };
  await service.close();
  return state;
}

function reopen(state, executor = async () => success('恢复后完成的独立分析')) {
  // These state-recovery cases use an explicit executor substitute. Actual OS
  // tree-exit proofs are exercised separately in process-supervision.test.mjs.
  return new TeamService({ root: state.root, ...options, agentExecutor: async (member, prompt, invocation) => ({
    ...(invocation.businessRun?.kind === 'accept' ? success('固定收件核验替身', { verdict: 'approve' }) : await executor(member, prompt, invocation)),
    processExitConfirmed: true, processExitEvidence: { confirmed: true, method: 'simulated_test_executor' },
  }) });
}

function sourceCliUsage(service, state) {
  const attemptIds = new Set([state.originalAttemptId, ...service.store.list('runs')
    .filter(run => run.workItemId === state.workId).map(run => run.attemptId)]);
  return new BusinessStore(service.store).budgetUsage(state.projectId, projectDay()).entries
    .filter(entry => entry.kind === 'cli' && entry.status !== 'released' && attemptIds.has(entry.key))
    .reduce((total, entry) => total + entry.amount, 0);
}

test('a committed but unstarted outbox job survives a full backend restart with a new attempt and no duplicated budget', async () => {
  const state = await crashState();
  let service, calls = 0;
  try {
    service = reopen(state, async (_member, _prompt, invocation) => {
      calls++;
      assert.equal(invocation.conversationId, null);
      assert.notEqual(invocation.workspace, state.originalWorkspace);
      return success('重新读取固定输入后完成');
    });
    const recovered = service.store.get('runs', state.runId);
    assert.equal(recovered.status, 'queued');
    assert.notEqual(recovered.attemptId, state.originalAttemptId);
    assert.equal(new BusinessStore(service.store).budgetUsage(state.projectId, projectDay()).cliCalls, 0);
    service.store.update('settings', 'workspace', { paused: false }); service.kick();
    await until(() => service.store.get('workItems', state.workId).status === 'succeeded' && service.active.size === 0);
    assert.equal(calls, 1);
    assert.equal(sourceCliUsage(service, state), 1, 'independent acceptance has its own budget; source execution is charged only once');
  } finally { await service?.close(); cleanup(state.root); }
});

test('a crash after CLI success but before validated output commit cannot strand the work or its leases', async () => {
  const state = await crashState({ runPatch: { status: 'succeeded', startIssued: true, ...simulatedExit,
    executionSucceeded: true, report: success('尚未收取的旧输出').report } });
  let service, calls = 0;
  try {
    service = reopen(state, async () => { calls++; return success('新的已检查结果'); });
    const work = service.store.get('workItems', state.workId);
    assert.notEqual(work.status, 'running', 'an executor exit is not a committed work result');
    assert.equal(service.business.memberQuarantined(state.writerId), false);
    assert.equal(new BusinessStore(service.store).listLeases().length, 0);
    service.store.update('settings', 'workspace', { paused: false }); service.kick();
    await until(() => service.store.get('workItems', state.workId).status === 'succeeded' && service.active.size === 0);
    assert.equal(calls, 1);
    assert.equal(sourceCliUsage(service, state), 2, 'the lost executed attempt remains charged alongside the fresh execution');
  } finally { await service?.close(); cleanup(state.root); }
});

test('a committed work result survives a crash before lease cleanup without rerunning its CLI', async () => {
  const state = await crashState({ runPatch: { status: 'succeeded', startIssued: true, ...simulatedExit,
    executionSucceeded: true, report: success('已经提交的成果').report, outputCheck: { status: 'passed', evidenceType: 'machine' } },
  workPatch: { status: 'succeeded', outputDigest: 'committed-output', resultDigest: 'committed-output', summary: '已经提交的成果' } });
  let service, calls = 0;
  try {
    service = reopen(state, async () => { calls++; return success('不应重复执行'); });
    assert.equal(service.store.get('workItems', state.workId).status, 'succeeded');
    assert.equal(service.store.get('workItems', state.workId).resultDigest, 'committed-output');
    const durable = new BusinessStore(service.store);
    assert.equal(durable.listLeases().length, 0);
    assert.equal(durable.getJob(state.jobId).status, 'succeeded');
    service.store.update('settings', 'workspace', { paused: false }); service.kick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
  } finally { await service?.close(); cleanup(state.root); }
});

test('cancelled status written before an unconfirmed process exit still quarantines the member on restart', async () => {
  const state = await crashState({ runPatch: { status: 'cancelled', startIssued: true, processExitConfirmed: false,
    process: { phase: 'spawned', pid: process.pid, spawnedAt: new Date().toISOString() } },
  workPatch: { status: 'interrupted', generation: 2 } });
  let service;
  try {
    service = reopen(state);
    assert.equal(service.business.memberQuarantined(state.writerId), true);
    const quarantines = service.store.list('businessQuarantines').filter(entry => entry.runId === state.runId && !entry.resolvedAt);
    assert.equal(quarantines.length, 1);
    const durable = new BusinessStore(service.store);
    assert.equal(durable.getJob(state.jobId).status, 'quarantined');
    assert.equal(durable.listLeases().some(lease => lease.resource === `member:${state.writerId}`), true);
    assert.equal(durable.budgetUsage(state.projectId, projectDay()).cliCalls, 1);
  } finally { await service?.close(); cleanup(state.root); }
});

test('a missing root PID alone cannot prove that its descendant processes have exited', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  const state = await crashState({ runPatch: { status: 'running', startIssued: true, processExitConfirmed: false,
    process: { phase: 'spawned', pid, spawnedAt: new Date().toISOString() } } });
  let service;
  try {
    service = reopen(state);
    assert.equal(service.business.memberQuarantined(state.writerId), true);
    assert.equal(new BusinessStore(service.store).listLeases().some(lease => lease.resource === `member:${state.writerId}`), true);
    assert.notEqual(service.store.get('workItems', state.workId).status, 'running');
    assert.equal(new BusinessStore(service.store).budgetUsage(state.projectId, projectDay()).cliCalls, 1);
  } finally { await service?.close(); cleanup(state.root); }
});

test('a legacy true exit flag and committed output cannot bypass missing tree supervision proof', async () => {
  const state = await crashState({ runPatch: { status: 'succeeded', startIssued: true, processExitConfirmed: true,
    executionSucceeded: true, outputCheck: { status: 'passed', evidenceType: 'machine' },
    process: { phase: 'exited', pid: process.pid, exitCode: 0 } },
  workPatch: { status: 'succeeded', resultDigest: 'legacy-output', outputDigest: 'legacy-output' } });
  let service;
  try {
    service = reopen(state);
    assert.equal(service.business.memberQuarantined(state.writerId), true);
    assert.equal(new BusinessStore(service.store).getJob(state.jobId).status, 'quarantined');
    assert.equal(new BusinessStore(service.store).listLeases().some(lease => lease.resource === `member:${state.writerId}`), true);
    assert.notEqual(service.store.get('workItems', state.workId).status, 'succeeded');
  } finally { await service?.close(); cleanup(state.root); }
});

test('an unresolved process tree retains shared capacity even when another member is ready', async () => {
  const state = await crashState({ runPatch: { status: 'running', startIssued: true, processExitConfirmed: false,
    process: { phase: 'spawned', pid: process.pid } } });
  let service, calls = 0;
  try {
    service = reopen(state, async () => { calls++; return success('不应超出实际进程容量'); });
    service.store.update('settings', 'workspace', { paused: false, maxParallel: 1 });
    const spare = service.saveMember({ name: '其他成员', handle: 'spare-after-crash', provider: 'custom', role: 'builder',
      permission: 'plan', executable: process.execPath, enabled: true });
    const result = service.enqueue({ roomId: 'team', memberId: spare.id, stage: 'chat', prompt: '等待进程容量释放' });
    service.kick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.equal(service.active.size, 0);
    assert.equal(service.store.list('runs').find(run => run.memberId === spare.id).status, 'queued');
  } finally { await service?.close(); cleanup(state.root); }
});

test('a real Windows job receipt recovers a persisted attempt without trusting a root exit flag',
  { skip: process.platform !== 'win32' }, async () => {
    const proofRoot = temporary();
    let state, service, processState;
    try {
      const execution = await runProcess({ executable: process.execPath, args: ['-e', 'process.stdout.write("supervised fixture")'],
        cwd: proofRoot, proxy: '', timeoutMs: 3000, logFile: path.join(proofRoot, 'supervised.log'),
        onProcess: value => { processState = value; } });
      assert.equal(execution.processExitEvidence.method, 'windows_job_empty');
      assert.equal(fs.existsSync(processState.supervision.receiptPath), true);
      state = await crashState({ runPatch: { status: 'running', startIssued: true, processExitConfirmed: false, process: processState } });
      service = reopen(state);
      assert.equal(service.business.memberQuarantined(state.writerId), false);
      assert.equal(service.store.get('runs', state.runId).recoveryProof.method, 'windows_job_empty');
      assert.equal(new BusinessStore(service.store).listLeases().length, 0);
      assert.equal(service.store.get('workItems', state.workId).status, 'ready');
      assert.equal(new BusinessStore(service.store).budgetUsage(state.projectId, projectDay()).cliCalls, 1);
    } finally { await service?.close(); if (state) cleanup(state.root); cleanup(proofRoot); }
  });

test('recovering an exited old generation never overwrites a newer queued attempt', async () => {
  const state = await crashState({ runPatch: { status: 'succeeded', startIssued: true, ...simulatedExit, executionSucceeded: true },
    workPatch: { generation: 2, status: 'queued', currentAttemptId: 'new-attempt', runId: 'new-run' } });
  let seed, service;
  try {
    // Populate the newer committed queue using Store only, so no recovery observes a half-built fixture.
    const { Store } = await import('../server/store.mjs');
    seed = new Store(`${state.root}/.team/team.sqlite`);
    const queue = new BusinessStore(seed);
    const job = queue.enqueueJob({ key: `${state.workId}:generation2`, kind: 'business.run', projectId: state.projectId,
      workItemId: state.workId, generation: 2, payload: { ordinal: 2, contentId: null } });
    seed.put('runs', { ...state.run, id: 'new-run', generation: 2, attemptId: 'new-attempt', status: 'queued', jobId: job.id,
      startIssued: false, processExitConfirmed: false, memberLease: null, workLease: null, leaseToken: null, budgetId: null });
    seed.update('workItems', state.workId, { jobId: job.id });
    seed.close(); seed = null;
    service = reopen(state);
    const work = service.store.get('workItems', state.workId), run = service.store.get('runs', 'new-run');
    assert.equal(work.generation, 2);
    assert.equal(work.status, 'queued');
    assert.equal(work.runId, 'new-run');
    assert.equal(work.currentAttemptId, run.attemptId);
    assert.equal(run.generation, 2);
    assert.equal(new BusinessStore(service.store).listLeases().length, 0);
  } finally { seed?.close(); await service?.close(); cleanup(state.root); }
});

test('an unstarted cancelled generation is cleaned up without reviving it over a newer queue entry', async () => {
  const state = await crashState({ runPatch: { status: 'cancelled', startIssued: false, processExitConfirmed: false },
    workPatch: { generation: 2, status: 'queued', currentAttemptId: 'replacement-attempt', runId: 'replacement-run' } });
  let seed, service;
  try {
    const { Store } = await import('../server/store.mjs');
    seed = new Store(`${state.root}/.team/team.sqlite`);
    const queue = new BusinessStore(seed);
    const job = queue.enqueueJob({ key: `${state.workId}:replacement`, kind: 'business.run', projectId: state.projectId,
      workItemId: state.workId, generation: 2, payload: { ordinal: 2, contentId: null } });
    seed.put('runs', { ...state.run, id: 'replacement-run', generation: 2, attemptId: 'replacement-attempt', status: 'queued', jobId: job.id,
      startIssued: false, memberLease: null, workLease: null, leaseToken: null, budgetId: null });
    seed.update('workItems', state.workId, { jobId: job.id });
    seed.close(); seed = null;
    service = reopen(state);
    const work = service.store.get('workItems', state.workId), replacement = service.store.get('runs', 'replacement-run');
    assert.equal(work.generation, 2);
    assert.equal(work.status, 'queued');
    assert.equal(work.runId, replacement.id);
    assert.equal(work.currentAttemptId, replacement.attemptId);
    assert.notEqual(service.store.get('runs', state.runId).status, 'queued');
    assert.notEqual(new BusinessStore(service.store).getJob(state.jobId).status, 'queued');
    assert.equal(new BusinessStore(service.store).budgetUsage(state.projectId, projectDay()).cliCalls, 0);
    assert.equal(new BusinessStore(service.store).listLeases().length, 0);
  } finally { seed?.close(); await service?.close(); cleanup(state.root); }
});
