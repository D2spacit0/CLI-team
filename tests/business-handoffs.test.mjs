import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TeamService } from '../server/service.mjs';
import { temporary, cleanup, success, until } from './helpers.mjs';

const analysis = { type: 'analysis', sections: ['summary'] };
const resultFile = { type: 'files', files: [{ path: 'result.txt', format: 'text' }] };
const report = (summary, extra = {}) => success(summary, { analysis: [], business: { version: 1, actions: [] }, ...extra });
const gate = () => { let resolve, reached = false; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve() { reached = true; resolve(); }, get reached() { return reached; } }; };
const waitFor = signal => until(() => signal.reached, 10000);
const input = options => JSON.parse(fs.readFileSync(path.join(options.workspace, 'inputs', 'context.json'), 'utf8'));

function fixture(executor) {
  const root = temporary();
  const service = new TeamService({ root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }),
    // In-process fixtures explicitly model settlement, not proof of an official CLI run.
    agentExecutor: async (...args) => ({ ...await executor(...args), processExitConfirmed: true,
      processExitEvidence: { confirmed: true, method: 'simulated_test_executor' } }) });
  const member = (handle, role, permission) => service.saveMember({ name: handle, handle, provider: 'custom', role,
    permission, executable: process.execPath, enabled: true });
  const owner = member('owner', 'builder', 'edit'), writer = member('writer', 'builder', 'edit'), receiver = member('receiver', 'reviewer', 'plan');
  const project = service.business.createProject({ name: '交接闭环测试', objective: '检查实际交付，再释放后续工作', ownerId: owner.id,
    reviewerId: receiver.id, memberIds: [owner.id, writer.id, receiver.id], start: false });
  return { root, service, owner, writer, receiver, project,
    start() { service.business.updateProject(project.id, { expectedRevision: service.projects.get(project.id).revision, status: 'active' }); },
    work(fields) { return service.business.createWork({ projectId: project.id, memberId: writer.id, receiverId: receiver.id,
      kind: 'analysis', title: '交付约定结果', objective: '按照固定材料核对结果', output: analysis, ...fields }); },
    async close() { await service.close(); cleanup(root); } };
}

test('received bytes stay separate from independent acceptance and cannot release successors early', async () => {
  const received = gate(), allowAcceptance = gate();
  let f, source, successor, successorStarted = false, acceptedFile;
  const bytes = '实际交付：来源只有经验建议，没有实测提升比例。';
  f = fixture(async (member, _prompt, options) => {
    const context = input(options), assignment = context.assignment;
    if (assignment.id === source.id) {
      fs.writeFileSync(path.join(options.workspace, 'result.txt'), bytes);
      return report('文件已交付，接收方应打开实际内容核对');
    }
    if (assignment.kind === 'accept') {
      const target = assignment.acceptanceFor;
      assert.ok(target?.receiptId && target.resultDigest);
      const original = f.service.store.get('workItems', target.workItemId);
      assert.notEqual(member.id, original.memberId);
      if (target.workItemId === source.id) {
        const references = JSON.parse(fs.readFileSync(path.join(options.workspace, 'inputs', 'references.json'), 'utf8'));
        const reference = references.find(value => value.ref.id === source.id);
        assert.equal(reference.ref.digest, target.resultDigest);
        const file = reference.value.outputFiles.find(value => value.relativePath === 'result.txt');
        assert.ok(file && file.path.startsWith('inputs/'));
        assert.equal(path.isAbsolute(file.path), false);
        acceptedFile = fs.readFileSync(path.join(options.workspace, file.path), 'utf8');
        assert.equal(acceptedFile, bytes);
        assert.equal(createHash('sha256').update(acceptedFile).digest('hex'), target.files[0].sha256);
        received.resolve();
        await allowAcceptance.promise;
      }
      return report('已实际读取固定收件并逐项核对完成条件', { verdict: 'approve' });
    }
    assert.equal(assignment.id, successor.id);
    successorStarted = true;
    return report('只在上游完成独立验收后采用结果');
  });
  try {
    source = f.work({ kind: 'copy', output: resultFile, acceptanceCriteria: ['打开 result.txt 核对事实与建议的区分', '不得把成员总结当成文件内容'] });
    successor = f.work({ memberId: f.owner.id, dependencies: [source.id], title: '采用已核验结果' });
    f.start();
    await waitFor(received);
    const stored = f.service.store.get('workItems', source.id);
    const receipt = structuredClone(f.service.store.get('workReceipts', stored.currentReceiptId));
    assert.equal(stored.status, 'succeeded');
    assert.equal(stored.handoffStatus, 'received');
    assert.equal(stored.receiverId, f.receiver.id);
    assert.equal(stored.checkerId, f.owner.id);
    assert.equal(receipt.evidenceType, 'machine');
    assert.deepEqual(receipt.checks, ['input_integrity', 'declared_files']);
    assert.equal(receipt.files[0].relativePath, 'result.txt');
    assert.equal(successorStarted, false);
    assert.equal(f.service.store.get('workItems', successor.id).status, 'waiting_dependencies');
    for (let count = 0; count < 3; count++) f.service.business.handoffs.checkPending();
    const acceptances = f.service.business.works(f.project.id).filter(work => work.acceptanceFor?.receiptId === receipt.id);
    assert.equal(acceptances.length, 1, 'repeated scheduler checks must not create duplicate acceptance work');
    assert.equal(acceptances[0].memberId, f.receiver.id);
    const stages = f.service.store.list('workHandoffs').filter(event => event.workItemId === source.id).map(event => event.type);
    assert.deepEqual(stages, ['assigned', 'accepted', 'received']);
    allowAcceptance.resolve();
    await until(() => f.service.store.get('workItems', successor.id).handoffStatus === 'verified');
    assert.equal(acceptedFile, bytes);
    assert.equal(successorStarted, true);
    assert.equal(f.service.store.get('workItems', source.id).handoffStatus, 'verified');
    assert.deepEqual(f.service.store.get('workReceipts', receipt.id), receipt, 'acceptance never rewrites the machine collection receipt');
    const verification = f.service.store.list('workHandoffs').find(event => event.workItemId === source.id && event.type === 'verified');
    assert.equal(verification.evidenceType, 'agent_review');
    assert.equal(verification.actorId, f.receiver.id);
    const works = f.service.business.works(f.project.id);
    assert.equal(works.length, 4);
    assert.equal(works.filter(work => work.kind === 'accept').length, 2);
    assert.ok(works.filter(work => work.kind === 'accept').every(work => !works.some(next => next.acceptanceFor?.workItemId === work.id)), 'acceptance must not recursively accept itself');
  } finally { allowAcceptance.resolve(); await f.close(); }
});

test('a late acceptance cannot verify a replaced generation or release its dependent work', async () => {
  const oldStarted = gate(), oldReturn = gate(), newProductionStarted = gate(), newProductionReturn = gate(), newStarted = gate(), newReturn = gate();
  let f, source, successor, sourceCalls = 0, successorStarted = false, oldRunId, newRunId;
  f = fixture(async (_member, _prompt, options) => {
    const { assignment } = input(options);
    if (assignment.id === source.id) {
      sourceCalls++;
      if (sourceCalls === 2) { newProductionStarted.resolve(); await newProductionReturn.promise; }
      return report(sourceCalls === 1 ? '第一代尚未验收的交付' : '第二代已根据意见修改的交付');
    }
    if (assignment.kind === 'accept') {
      if (assignment.acceptanceFor.workItemId === source.id) {
        if (assignment.acceptanceFor.generation === 1) { oldRunId = f.service.store.get('workItems', assignment.id).runId; oldStarted.resolve(); await oldReturn.promise; }
        else { newRunId = f.service.store.get('workItems', assignment.id).runId; newStarted.resolve(); await newReturn.promise; }
      }
      return report('接收方对自己读到的固定收件给出通过', { verdict: 'approve' });
    }
    assert.equal(assignment.id, successor.id);
    successorStarted = true;
    return report('使用新一代的已验收结果');
  });
  try {
    source = f.work();
    successor = f.work({ memberId: f.owner.id, dependencies: [source.id], title: '等待有效上游' });
    f.start(); await waitFor(oldStarted);
    const oldReceiptId = f.service.store.get('workItems', source.id).currentReceiptId;
    f.service.business.rework(source.id, '必须补充来源边界后重新交付');
    await waitFor(newProductionStarted);
    oldReturn.resolve();
    await until(() => f.service.store.get('runs', oldRunId).discarded === true);
    assert.equal(f.service.store.get('workItems', source.id).generation, 2);
    assert.notEqual(f.service.store.get('workItems', source.id).handoffStatus, 'verified');
    assert.equal(successorStarted, false);
    newProductionReturn.resolve(); await waitFor(newStarted);
    const next = f.service.store.get('workItems', source.id);
    assert.equal(next.status, 'succeeded');
    assert.equal(next.handoffStatus, 'received');
    assert.notEqual(next.currentReceiptId, oldReceiptId);
    assert.ok(f.service.store.get('workReceipts', oldReceiptId), 'old receipts remain available as history');
    assert.equal(successorStarted, false);
    newReturn.resolve();
    await until(() => f.service.store.get('workItems', successor.id).handoffStatus === 'verified');
    assert.equal(f.service.store.get('workItems', source.id).verificationRunId, newRunId);
    assert.equal(f.service.store.list('workHandoffs').filter(event => event.workItemId === source.id && event.generation === 1 && event.type === 'verified').length, 0);
    assert.equal(f.service.store.list('runs').filter(run => run.workItemId === source.id).length, 2);
  } finally { oldReturn.resolve(); newProductionReturn.resolve(); newReturn.resolve(); await f.close(); }
});

test('owner deferral preserves the original promise and leaves failed work unfinished without repeated wakeups', async () => {
  let f, source;
  const originalDueAt = new Date(Date.now() + 1800000).toISOString();
  const nextDueAt = new Date(Date.now() + 2 * 3600000).toISOString();
  f = fixture(async (member, _prompt, options) => {
    const { assignment } = input(options);
    if (assignment.id === source.id) return report('所需材料缺失，无法完成', { status: 'blocked' });
    assert.equal(assignment.kind, 'coordinate');
    assert.equal(member.id, f.owner.id);
    assert.equal(assignment.resolutionFor.workItemId, source.id);
    assert.equal(assignment.resolutionFor.originalDueAt, originalDueAt);
    assert.equal(assignment.resolutionFor.attemptCount, 1);
    return report('等待补充材料，保留原承诺并记录新日期', { business: { version: 1, actions: [{ type: 'resolve_work',
      workItemId: source.id, generation: assignment.resolutionFor.generation, decision: 'defer', reason: '输入仍缺失，不能声称完成', dueAt: nextDueAt }] } });
  });
  try {
    source = f.work({ dueAt: originalDueAt });
    f.start();
    await until(() => f.service.business.works(f.project.id).some(work => work.resolutionFor?.workItemId === source.id && work.handoffStatus === 'verified'));
    const stored = f.service.store.get('workItems', source.id);
    assert.equal(stored.status, 'blocked');
    assert.equal(stored.handoffStatus, 'blocked');
    assert.equal(stored.originalDueAt, originalDueAt);
    assert.equal(stored.dueAt, nextDueAt);
    assert.equal(stored.attemptCount, 1);
    assert.equal(stored.currentReceiptId, undefined);
    for (let count = 0; count < 5; count++) f.service.business.handoffs.checkPending();
    await until(() => f.service.active.size === 0);
    assert.equal(f.service.business.works(f.project.id).length, 2);
    assert.equal(f.service.store.list('runs').length, 2);
    const changed = f.service.store.list('workHandoffs').find(event => event.workItemId === source.id && event.type === 'rescheduled');
    assert.equal(changed.originalDueAt, originalDueAt);
    assert.equal(changed.previousDueAt, originalDueAt);
    assert.equal(changed.dueAt, nextDueAt);
    assert.equal(changed.evidenceType, 'owner_decision');
  } finally { await f.close(); }
});

test('an owner who only reports a blocker cannot complete resolution or spawn unbounded coordinator work', async () => {
  let f, source;
  f = fixture(async (_member, _prompt, options) => input(options).assignment.id === source.id
    ? report('需要未提供的材料', { status: 'blocked' })
    : report('负责人声称已处理，但没有明确重试、改期或取消'));
  try {
    source = f.work(); f.start();
    const decision = await until(() => f.service.business.works(f.project.id).find(work => work.resolutionFor?.workItemId === source.id));
    await until(() => f.service.store.get('workItems', decision.id).attemptCount === 3 && f.service.store.get('workItems', decision.id).status === 'failed');
    for (let count = 0; count < 5; count++) f.service.business.handoffs.checkPending();
    assert.equal(f.service.business.works(f.project.id).filter(work => work.kind === 'coordinate').length, 1);
    assert.equal(f.service.store.get('workItems', source.id).handoffStatus, 'blocked');
    assert.equal(f.service.store.get('workItems', decision.id).handoffStatus, 'blocked');
    assert.equal(f.service.store.list('workReceipts').length, 0);
    assert.ok(f.service.store.list('runs').filter(run => run.workItemId === decision.id).every(run => /明确处理动作/.test(run.error)));
    assert.equal(f.service.store.list('publicationApprovals').length, 0);
  } finally { await f.close(); }
});
