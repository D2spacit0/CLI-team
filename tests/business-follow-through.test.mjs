import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TeamService } from '../server/service.mjs';
import { temporary, cleanup, success, until } from './helpers.mjs';

const output = { type: 'analysis', sections: ['summary'] };
const report = (summary, actions = [], extra = {}) => success(summary, {
  analysis: [], business: { version: 1, actions }, ...extra,
});
const assignment = options => JSON.parse(fs.readFileSync(path.join(options.workspace, 'inputs', 'context.json'), 'utf8')).assignment;
const gate = () => {
  let release, reached = false;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, resolve() { reached = true; release(); }, get reached() { return reached; } };
};

function fixture(executor = async () => { throw new Error('This state-only regression must not launch a member'); }) {
  const root = temporary();
  const service = new TeamService({ root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }),
    // This fixture models settlement explicitly; it does not prove an official CLI or platform operation.
    agentExecutor: async (...args) => ({ ...await executor(...args), processExitConfirmed: true,
      processExitEvidence: { confirmed: true, method: 'simulated_test_executor' } }) });
  service.store.update('settings', 'workspace', { paused: true });
  clearInterval(service.business.timer);
  const member = (handle, role = 'builder') => service.saveMember({ name: handle, handle, role, provider: 'custom',
    executable: process.execPath, permission: 'plan', enabled: true });
  const owner = member('owner'), sender = member('sender'), peer = member('peer'), reviewer = member('reviewer', 'reviewer');
  const project = service.business.createProject({ name: '交接后续回归', objective: '承诺变化后拒收旧决定，咨询返工后交回原问题',
    ownerId: owner.id, reviewerId: reviewer.id, memberIds: [owner.id, sender.id, peer.id, reviewer.id], start: false });
  return { root, service, owner, sender, peer, reviewer, project,
    work(fields = {}) {
      return service.business.createWork({ projectId: project.id, memberId: sender.id, receiverId: reviewer.id,
        kind: 'analysis', title: '核对交接问题', objective: '核对来源并给出明确答复', output, ...fields });
    },
    start() {
      service.business.updateProject(project.id, { expectedRevision: service.projects.get(project.id).revision, status: 'active' });
      service.store.update('settings', 'workspace', { paused: false });
      service.kick();
    },
    async close() { await service.close(); cleanup(root); },
  };
}

async function waitForBusiness(f, predicate) {
  try { return await until(predicate, 10000); }
  catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify({
      works: f.service.business.works(f.project.id).map(work => ({ id: work.id, kind: work.kind, generation: work.generation,
        status: work.status, handoffStatus: work.handoffStatus, waitReason: work.waitReason, attemptCount: work.attemptCount })),
      runs: f.service.store.list('runs').filter(run => run.projectId === f.project.id).map(run => ({ kind: run.businessKind,
        status: run.status, error: run.error, discarded: run.discarded })),
      threads: f.service.store.list('collaborationThreads').map(thread => ({ id: thread.id, status: thread.status, reason: thread.reason })),
    })}`);
  }
}

test('a changed delivery promise rejects an earlier coordinator action and closes its obsolete contract', async () => {
  const f = fixture();
  try {
    const originalDueAt = new Date(Date.now() - 60000).toISOString();
    const nextDueAt = new Date(Date.now() + 2 * 3600000).toISOString();
    const target = f.work({ dueAt: originalDueAt });
    f.service.store.update('workItems', target.id, { status: 'blocked', handoffStatus: 'blocked', attemptCount: 1 });
    const earlier = f.work({ memberId: f.owner.id, kind: 'coordinate', title: '处理原交期阻碍',
      resolutionFor: { workItemId: target.id, generation: target.generation, dueAt: originalDueAt, reason: '原交期已到' } });
    const newer = f.work({ memberId: f.owner.id, kind: 'coordinate', title: '根据新信息调整承诺' });
    const earlierRun = { id: 'earlier-coordinator-run', projectId: f.project.id, workItemId: earlier.id,
      memberId: f.owner.id, generation: earlier.generation, businessKind: 'coordinate' };
    const newerRun = { id: 'newer-coordinator-run', projectId: f.project.id, workItemId: newer.id,
      memberId: f.owner.id, generation: newer.generation, businessKind: 'coordinate' };
    // These stored work contracts exercise the action guard before any executor is admitted.
    f.service.business.resolveWork(newerRun, { workItemId: target.id, generation: target.generation,
      decision: 'defer', dueAt: nextDueAt, reason: '负责人已经根据新资料接受新的交期' });
    const afterDeferral = f.service.store.get('workItems', target.id);
    assert.equal(afterDeferral.dueAt, nextDueAt);
    assert.equal(afterDeferral.originalDueAt, originalDueAt);
    assert.equal(afterDeferral.attemptCount, 1);
    assert.throws(() => f.service.business.resolveWork(earlierRun, { workItemId: target.id, generation: target.generation,
      decision: 'cancel', reason: '迟到的旧决定仍以原逾期为依据' }), /承诺|交期|过期|失效|变化|改变|关闭/);
    assert.equal(f.service.store.get('workItems', target.id).status, 'blocked');
    assert.equal(f.service.store.get('workItems', target.id).dueAt, nextDueAt);
    f.service.business.updateProject(f.project.id, { expectedRevision: f.service.projects.get(f.project.id).revision, status: 'active' });
    f.service.business.handoffs.checkPending();
    const obsolete = f.service.store.get('workItems', earlier.id);
    assert.equal(obsolete.status, 'cancelled');
    assert.equal(obsolete.handoffStatus, 'cancelled');
    assert.equal(f.service.store.list('runs').length, 0, 'retiring the old contract does not require another CLI call');
    assert.equal(f.service.store.list('workReceipts').length, 0, 'an owner decision must not manufacture a collection receipt');
  } finally { await f.close(); }
});

test('a blocked consultation can be retried, accepted and delivered back to its unchanged source work', async () => {
  const answer = '已核对原资料，没有实测百分比；正文只能标注为经验建议。';
  let f, source, consultId, consultCalls = 0, sourceCalls = 0, consultAccepted = false;
  const sourceAnswers = [];
  f = fixture(async (member, _prompt, options) => {
    const input = assignment(options);
    if (input.id === source.id) {
      sourceCalls++;
      if (sourceCalls === 1) return report('需要同伴核对来源中的测量口径', [
        { type: 'ask_peer', memberId: f.peer.id, question: '资料是否真的提供了实测百分比？', references: [] },
      ], { status: 'needs_help' });
      assert.equal(consultAccepted, true, 'the source only resumes after independent acceptance of the new answer');
      assert.equal(input.answers.length, 1);
      assert.equal(input.answers[0].summary, answer);
      assert.equal(input.answers[0].workItemId, consultId);
      assert.equal(input.answers[0].evidenceType, 'agent_claim');
      sourceAnswers.push(...input.answers);
      return report('已经采用原问题的有效答复，移除了未经测量的百分比');
    }
    if (input.kind === 'consult') {
      consultId = input.id; consultCalls++;
      return consultCalls === 1 ? report('当前材料不足，尚不能确认数字来源', [], { status: 'blocked' }) : report(answer);
    }
    if (input.kind === 'coordinate') {
      assert.equal(member.id, f.owner.id);
      assert.equal(input.resolutionFor.workItemId, consultId);
      assert.equal(input.resolutionFor.attemptCount, 1);
      return report('负责人让原咨询成员在相同问题范围内核对后重交', [{ type: 'resolve_work',
        workItemId: consultId, generation: input.resolutionFor.generation, decision: 'retry', reason: '保留原问题并重新核对已有来源' }]);
    }
    assert.equal(input.kind, 'accept');
    if (input.acceptanceFor.workItemId === consultId) {
      assert.equal(member.id, f.owner.id);
      assert.equal(input.acceptanceFor.summary, answer);
      consultAccepted = true;
    }
    return report('核对固定答复与收件记录，当前交付符合约定', [], { verdict: 'approve' });
  });
  try {
    source = f.work(); f.start();
    await waitForBusiness(f, () => f.service.store.get('workItems', source.id).handoffStatus === 'verified');
    await waitForBusiness(f, () => f.service.active.size === 0);
    const completed = f.service.store.get('workItems', source.id);
    const consult = f.service.store.get('workItems', consultId);
    assert.equal(completed.generation, source.generation, 'retrying the answer does not replace the original question');
    assert.equal(sourceCalls, 2);
    assert.equal(consultCalls, 2);
    assert.equal(completed.attemptCount, 2);
    assert.equal(consult.attemptCount, 2);
    assert.equal(consult.handoffStatus, 'verified');
    assert.equal(sourceAnswers.length, 1);
    assert.equal(sourceAnswers[0].generation, consult.generation);
    assert.equal(sourceAnswers[0].runId, consult.runId);
    const thread = f.service.store.get('collaborationThreads', sourceAnswers[0].threadId);
    assert.equal(thread.sourceWorkItemId, source.id);
    assert.equal(thread.workItemId, consultId);
    assert.equal(thread.status, 'resolved');
    assert.equal(thread.answerRunId, consult.runId);
    assert.equal(thread.resolutionRunId, completed.runId);
    const receipt = f.service.store.get('workReceipts', consult.currentReceiptId);
    assert.equal(receipt.evidenceType, 'machine');
    const verification = f.service.store.list('workHandoffs').find(event => event.workItemId === consultId &&
      event.generation === consult.generation && event.type === 'verified');
    assert.equal(verification.evidenceType, 'agent_review');
    assert.equal(verification.actorId, f.owner.id);
    assert.equal(f.service.store.list('businessHelpChains')[0].rounds, 1, 'retrying the same consultation must not consume a second peer-question round');
  } finally { await f.close(); }
});

test('retrying an old consultation cannot restore or answer a source generation that has already been replaced', async () => {
  const ownerEntered = gate(), allowOwner = gate(), replacementEntered = gate(), allowReplacement = gate();
  let f, source, consultId, decisionId, sourceCalls = 0, consultCalls = 0, replacementInput;
  f = fixture(async (_member, _prompt, options) => {
    const input = assignment(options);
    if (input.id === source.id) {
      sourceCalls++;
      if (sourceCalls === 1) return report('向同伴提出第一代问题', [
        { type: 'ask_peer', memberId: f.peer.id, question: '请核对第一代资料', references: [] },
      ], { status: 'needs_help' });
      replacementInput = input;
      replacementEntered.resolve(); await allowReplacement.promise;
      return report('依据新的问题范围完成交付，不采用已终结的旧咨询');
    }
    if (input.kind === 'consult') {
      consultId = input.id; consultCalls++;
      return consultCalls === 1 ? report('原问题缺少依据，无法作答', [], { status: 'blocked' }) : report('这条旧问题答复不应注入新一代工作');
    }
    if (input.kind === 'coordinate') {
      decisionId = input.id;
      assert.equal(input.resolutionFor.workItemId, consultId);
      ownerEntered.resolve(); await allowOwner.promise;
      return report('迟到的协调决定仍要求重试旧咨询', [{ type: 'resolve_work', workItemId: consultId,
        generation: input.resolutionFor.generation, decision: 'retry', reason: '仍按旧问题恢复原咨询' }]);
    }
    assert.equal(input.kind, 'accept');
    return report('核对当前固定交付，未采用旧问题的答复', [], { verdict: 'approve' });
  });
  try {
    source = f.work(); f.start();
    await waitForBusiness(f, () => ownerEntered.reached);
    const originalConsult = f.service.store.get('workItems', consultId);
    const originalThreadId = originalConsult.threadId;
    assert.equal(originalConsult.consultation.sourceGeneration, source.generation);
    f.service.business.rework(source.id, '用户已经替换了问题范围，旧咨询不再适用');
    await waitForBusiness(f, () => replacementEntered.reached);
    allowOwner.resolve();
    await waitForBusiness(f, () => {
      const pending = f.service.business.works(f.project.id).filter(work => work.id !== source.id &&
        ['ready', 'queued', 'running', 'waiting_dependencies'].includes(work.status));
      return pending.length === 0 && [...f.service.active.keys()].every(runId => runId === f.service.store.get('workItems', source.id).runId);
    });
    const replacement = f.service.store.get('workItems', source.id);
    assert.equal(replacement.generation, source.generation + 1);
    assert.equal(replacement.status, 'running');
    assert.deepEqual(replacementInput.answers, []);
    assert.deepEqual(replacement.answers || [], []);
    assert.equal(consultCalls, 1, 'an obsolete consultation is not restarted for a replacement question');
    assert.equal(f.service.store.get('collaborationThreads', originalThreadId).status, 'superseded');
    assert.notEqual(f.service.store.get('workItems', decisionId).handoffStatus, 'verified', 'a rejected old retry cannot be recorded as an applied owner decision');
    allowReplacement.resolve();
    await waitForBusiness(f, () => f.service.store.get('workItems', source.id).handoffStatus === 'verified');
    assert.equal(sourceCalls, 2);
    assert.deepEqual(f.service.store.get('workItems', source.id).answers || [], []);
  } finally { allowOwner.resolve(); allowReplacement.resolve(); await f.close(); }
});
