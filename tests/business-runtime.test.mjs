import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { TeamService } from '../server/service.mjs';
import { createApp } from '../server/app.mjs';
import { executeAgent } from '../server/runner.mjs';
import { temporary, cleanup, success, until } from './helpers.mjs';

const outputAnalysis = { type: 'analysis', sections: ['summary'] };
const outputNote = { type: 'files', files: [{ path: 'note.json', format: 'json' }] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const report = (summary, actions = [], extra = {}) => success(summary, { business: { version: 1, actions }, analysis: [], ...extra });
const makePlan = (owner, visual, reviewer) => [
  { key: 'copy', kind: 'copy', memberId: owner.id, dependsOn: [], output: outputAnalysis },
  { key: 'visual', kind: 'visual', memberId: visual.id, dependsOn: [], output: outputAnalysis },
  { key: 'integrate', kind: 'integrate', memberId: owner.id, dependsOn: ['copy', 'visual'], output: outputNote },
  { key: 'review', kind: 'review', memberId: reviewer.id, dependsOn: ['integrate'], output: outputAnalysis },
].map(work => ({ type: 'propose_work', ...work, title: `完成${work.kind}`, objective: `交付当前稿件${work.kind}`, inputRefs: [] }));

// Valid PNG test data exercises actual file collection/CRC/decompression. It is not a template renderer acceptance proof.
function pngFixture() {
  const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) { c ^= byte; for (let bit = 0; bit < 8; bit++) c = c >>> 1 ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const type = Buffer.from(name), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); type.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([type, data])), out.length - 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(1080); header.writeUInt32BE(1440, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((1080 * 3 + 1) * 1440, 240); for (let row = 0; row < 1440; row++) pixels[row * (1080 * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const image = pngFixture();
const renderStub = async spec => ({ buffer: image, width: 1080, height: 1440, templateId: spec.template, templateVersion: 'fixture-template-1',
  renderCheck: { passed: true, overflow: false, fixture: true } });
function writeNote(workspace, change = '') {
  fs.writeFileSync(path.join(workspace, 'note.json'), JSON.stringify({ title: '安排好每天第一步',
    body: `先写下今天要完成的一件事，再把第一步缩小到十五分钟可以开始的动作。${change}`, tags: ['工作方法'],
    sources: [{ label: '受控本地验收稿件' }], images: [{ template: 'cover', title: '明确今天第一步', accent: 'blue' }],
    requiresRealPhotos: false, changeSummary: change || '采用文案与视觉成员的交付' }));
}

function setup(executor, { real = false, requestChanges = false } = {}) {
  const root = temporary();
  const service = new TeamService({ root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }),
    // A stub's simulated settlement is explicit; only real=true exercises OS exit evidence.
    contentRenderer: renderStub, agentExecutor: real ? executeAgent : async (...args) => ({ ...await executor(...args), processExitConfirmed: true,
      processExitEvidence: { confirmed: true, method: 'simulated_test_executor' } }) });
  const args = real ? [path.resolve('tests/fixtures/business-cli.mjs'), ...(requestChanges ? ['--request-changes-once'] : [])] : [];
  const member = (name, role, permission) => service.saveMember({ name, handle: name, role, permission, provider: 'custom',
    executable: process.execPath, prefixArgs: args, enabled: true });
  const owner = member('owner', 'builder', 'edit'), visual = member('visual', 'builder', 'edit'), reviewer = member('reviewer', 'reviewer', 'plan');
  const project = ({ start = true, ...extra } = {}) => service.business.createProject({ name: '持续运营验收', objective: '制作有来源的工作方法图文',
    ownerId: owner.id, reviewerId: reviewer.id, memberIds: [owner.id, visual.id, reviewer.id], start, ...extra });
  const activate = value => service.business.updateProject(value.id, { expectedRevision: service.projects.get(value.id).revision, status: 'active' });
  return { root, service, owner, visual, reviewer, project, activate, async close() { await service.close(); cleanup(root); } };
}

async function readyContent(f, projectId, timeout = 12000) {
  try { return await until(() => f.service.store.list('contentItems').find(item => item.projectId === projectId && item.status === 'awaiting_approval'), timeout); }
  catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify({ work: f.service.business.works(projectId).map(work => ({ kind: work.kind,
      status: work.status, handoffStatus: work.handoffStatus, generation: work.generation, reason: work.waitReason, feedback: work.feedback })),
      runs: f.service.store.list('runs').filter(run => run.projectId === projectId).map(run => ({ kind: run.businessKind, status: run.status, error: run.error,
        riskFlags: run.riskFlags })), eligibility: f.service.store.list('contentEligibilities').filter(value => value.projectId === projectId) })}`);
  }
}

test('business work shares the legacy executor limit and runs independent members concurrently before fixed draft review', async () => {
  let f;
  const legacy = gate(), creators = gate();
  const active = new Set(), intervals = [], calls = [];
  let peak = 0;
  f = setup(async (member, prompt, options) => {
    assert.equal(active.has(member.id), false, 'a member must never run two concurrent attempts');
    active.add(member.id); peak = Math.max(peak, active.size);
    const kind = options.businessRun?.kind || 'legacy'; calls.push(kind);
    const marker = { kind, start: process.hrtime.bigint() }; intervals.push(marker);
    try {
      if (kind === 'legacy') { await legacy.promise; return report('旧任务对话完成'); }
      assert.equal(options.conversationId, null);
      if (kind === 'plan') return report('负责人实际分工', makePlan(f.owner, f.visual, f.reviewer));
      if (kind === 'copy' || kind === 'visual') { await creators.promise; return report(`${kind}交付`); }
      if (kind === 'integrate') { assert.match(prompt, /copy交付/); assert.match(prompt, /visual交付/); writeNote(options.workspace); return report('整合完整稿件'); }
      return report('独立审稿通过', [], { verdict: 'approve' });
    } finally { marker.end = process.hrtime.bigint(); active.delete(member.id); }
  });
  try {
    const oldMember = f.service.saveMember({ name: 'legacy', handle: 'legacy', provider: 'custom', role: 'builder', permission: 'plan', executable: process.execPath, enabled: true });
    f.service.enqueue({ roomId: 'team', memberId: oldMember.id, stage: 'chat', prompt: '旧记录保留兼容' });
    await until(() => calls.includes('legacy'));
    const project = f.project();
    await until(() => calls.includes('copy') || calls.includes('visual'));
    assert.equal(active.size, 2);
    legacy.resolve();
    await until(() => calls.includes('copy') && calls.includes('visual'));
    assert.equal(active.size, 2); creators.resolve();
    const content = await readyContent(f, project.id);
    const bundle = f.service.contentRevisions.getBundle(content.id);
    assert.equal(bundle.eligibility.status, 'eligible');
    assert.equal(bundle.revision.images[0].mime, 'image/png');
    assert.equal(f.service.contentRevisions.inspectRevision(bundle.revision.id).passed, true);
    assert.equal(bundle.reviews.at(-1).memberId, f.reviewer.id);
    assert.equal(peak, 2);
    const copy = intervals.find(entry => entry.kind === 'copy'), visual = intervals.find(entry => entry.kind === 'visual');
    assert.ok(copy.start < visual.end && visual.start < copy.end, 'independent CLI calls must actually overlap');
    const runs = f.service.store.list('runs').filter(run => run.workflowKind === 'business');
    assert.equal(new Set(runs.map(run => run.workspace)).size, runs.length);
    assert.ok(runs.every(run => run.nativeSession.operation === 'new' && run.outputCheck?.status === 'passed'));
    assert.equal(f.service.store.list('publicationApprovals').length, 0);
  } finally { legacy.resolve(); creators.resolve(); await f.close(); }
});

test('direct peer question creates recipient work, releases the sender, returns on the same thread and starts a new native session', async () => {
  let f;
  const calls = [];
  f = setup(async (member, prompt, options) => {
    const kind = options.businessRun.kind;
    calls.push({ kind, workspace: options.workspace, conversationId: options.conversationId });
    if (kind === 'analysis' && calls.filter(call => call.kind === 'analysis').length === 1) return report('需要核对数字口径', [
      { type: 'ask_peer', memberId: f.visual.id, question: '这条数字来自哪里？', references: [] }], { status: 'needs_help' });
    if (kind === 'consult') return report('资料没有测量值，正文只能写为建议');
    if (kind === 'accept') return report('已核对固定收件中的来源边界与答复', [], { verdict: 'approve' });
    assert.match(prompt, /资料没有测量值/);
    return report('已依据答复去掉未经测量的数字');
  });
  try {
    const project = f.project({ start: false });
    const work = f.service.business.createWork({ projectId: project.id, memberId: f.owner.id, kind: 'analysis', title: '核对资料', objective: '回答具体问题', output: outputAnalysis });
    f.activate(project);
    await until(() => f.service.store.get('workItems', work.id).handoffStatus === 'verified');
    const threads = f.service.store.list('collaborationThreads');
    assert.equal(threads.length, 1); assert.equal(threads[0].status, 'resolved');
    assert.equal(threads[0].recipientId, f.visual.id); assert.ok(threads[0].answerRunId); assert.ok(threads[0].resolutionRunId);
    assert.equal(f.service.store.get('workItems', work.id).attemptCount, 2);
    assert.deepEqual(calls.map(call => call.kind), ['analysis', 'consult', 'accept', 'analysis', 'accept']);
    assert.ok(calls.every(call => call.conversationId === null));
    assert.equal(new Set(calls.map(call => call.workspace)).size, 5);
    const firstRun = f.service.store.list('runs').find(run => run.businessKind === 'analysis');
    const count = f.service.store.list('businessActions').length;
    assert.equal(f.service.business.collaboration.apply(firstRun, firstRun.report.business).discarded, true);
    assert.equal(f.service.store.list('businessActions').length, count);
  } finally { await f.close(); }
});

test('missing declared delivery cannot submit collaborator actions or create unbounded work', async () => {
  let f;
  const deferredUntil = new Date(Date.now() + 2 * 3600000).toISOString();
  f = setup(async (_member, _prompt, options) => {
    if (options.businessRun.kind === 'coordinate') {
      const { assignment } = JSON.parse(fs.readFileSync(path.join(options.workspace, 'inputs', 'context.json'), 'utf8'));
      assert.equal(assignment.resolutionFor.attemptCount, 3);
      return report('尝试已用尽，保留缺件并明确改期', [{ type: 'resolve_work', workItemId: assignment.resolutionFor.workItemId,
        generation: assignment.resolutionFor.generation, decision: 'defer', reason: '仍缺少约定文件，等待明确材料', dueAt: deferredUntil }]);
    }
    return report('声称交付完成，但没有写文件', [{ type: 'propose_work', key: 'escape', kind: 'analysis', title: '不该启动', objective: '扩大范围',
      memberId: f.visual.id, output: outputAnalysis, dependsOn: [], inputRefs: [] }]);
  });
  try {
    const project = f.project({ start: false });
    const work = f.service.business.createWork({ projectId: project.id, memberId: f.owner.id, kind: 'copy', title: '交付文件', objective: '必须有实际结果', output: outputNote });
    f.activate(project);
    await until(() => f.service.store.get('workItems', work.id).status === 'failed');
    assert.equal(f.service.store.get('workItems', work.id).attemptCount, 3);
    await until(() => f.service.business.works(project.id).some(item => item.resolutionFor?.workItemId === work.id && item.handoffStatus === 'verified'));
    const source = f.service.store.get('workItems', work.id);
    assert.equal(source.handoffStatus, 'blocked');
    assert.equal(source.dueAt, deferredUntil);
    assert.equal(source.originalDueAt, work.originalDueAt);
    assert.equal(f.service.business.works(project.id).length, 2);
    assert.equal(f.service.store.list('businessActions').filter(action => action.sourceWorkItemId === work.id).length, 0);
    assert.equal(f.service.store.list('runs').filter(run => run.projectId === project.id).length, 4);
  } finally { await f.close(); }
});

test('independent review requesting changes produces a new immutable draft and repeats the gates', async () => {
  let f, reviews = 0, integrations = 0;
  f = setup(async (_member, _prompt, options) => {
    const kind = options.businessRun.kind;
    if (kind === 'plan') return report('明确分工', makePlan(f.owner, f.visual, f.reviewer));
    if (kind === 'integrate') { integrations++; writeNote(options.workspace, integrations > 1 ? '并注明这是一条经验建议。' : ''); return report('已整合本轮修改'); }
    if (kind === 'review') { reviews++; return report(reviews === 1 ? '请标注经验建议，避免写成实测事实' : '来源和表达已修改', [], { verdict: reviews === 1 ? 'changes_requested' : 'approve' }); }
    if (kind === 'accept') return report('固定成员收件已独立核验', [], { verdict: 'approve' });
    return report('提供有来源的交付');
  });
  try {
    const project = f.project();
    const content = await readyContent(f, project.id);
    const versions = f.service.store.list('contentRevisions').filter(version => version.contentId === content.id);
    assert.equal(versions.length, 2); assert.equal(integrations, 2); assert.equal(reviews, 2);
    assert.equal(versions[1].parentId, versions[0].id); assert.notEqual(versions[1].manifestHash, versions[0].manifestHash);
    assert.equal(f.service.store.list('contentChecks').filter(check => check.versionId === versions[0].id)[0].status, 'invalid');
    assert.equal(f.service.store.get('contentEligibilities', content.id).versionId, versions[1].id);
  } finally { await f.close(); }
});

test('persisted project pause rejects a late member result and prevents new work until resumed', async () => {
  let f;
  const pending = gate(), entered = gate();
  f = setup(async () => { entered.resolve(); await pending.promise; return report('迟到结果不应被采纳'); });
  try {
    const project = f.project({ start: false });
    const work = f.service.business.createWork({ projectId: project.id, memberId: f.owner.id, kind: 'analysis', title: '等待中的成员', objective: '等待明确结果', output: outputAnalysis });
    f.activate(project); await entered.promise;
    f.service.business.pauseProject(project.id);
    assert.equal(f.service.projects.get(project.id).status, 'paused');
    pending.resolve(); await until(() => f.service.active.size === 0);
    const stored = f.service.store.get('workItems', work.id);
    assert.notEqual(stored.status, 'succeeded'); assert.equal(stored.outputDigest, undefined);
    assert.ok(f.service.store.list('runs').find(run => run.workItemId === work.id).discarded);
    await pause(30); assert.equal(f.service.store.list('runs').filter(run => run.workItemId === work.id).length, 1);
  } finally { pending.resolve(); await f.close(); }
});

test('immediate resume waits for the old executor to exit and automatically verifies a fresh attempt', async () => {
  let f, entered = false, acceptedReceiptId = null;
  const oldExit = gate(), calls = [];
  f = setup(async (_member, _prompt, options) => {
    const { assignment } = JSON.parse(fs.readFileSync(path.join(options.workspace, 'inputs', 'context.json'), 'utf8'));
    calls.push({ kind: assignment.kind, workspace: options.workspace, conversationId: options.conversationId });
    if (assignment.kind === 'accept') {
      acceptedReceiptId = assignment.acceptanceFor.receiptId;
      assert.equal(assignment.acceptanceFor.summary, '恢复后新的有效结果');
      return report('独立核验恢复后新收件', [], { verdict: 'approve' });
    }
    assert.equal(assignment.kind, 'analysis');
    if (calls.filter(call => call.kind === 'analysis').length === 1) {
      entered = true;
      // Deliberately ignore abort until the gate opens, as a slowly exiting process would.
      await oldExit.promise;
      return report('旧结果不可采纳');
    }
    return report('恢复后新的有效结果');
  });
  try {
    const project = f.project({ start: false });
    f.activate(project);
    const cycle = f.service.projects.startCycle(project.id);
    const work = f.service.business.createWork({ projectId: project.id, cycleId: cycle.id, memberId: f.owner.id,
      kind: 'analysis', title: '暂停中的成员', objective: '恢复后重新核对资料', output: outputAnalysis });
    await until(() => entered);
    const original = f.service.store.get('runs', f.service.store.get('workItems', work.id).runId);
    assert.equal(f.service.active.has(original.id), true);
    f.service.business.pauseProject(project.id);
    f.service.business.resumeProject(project.id);
    assert.equal(f.service.projects.get(project.id).status, 'active');
    assert.equal(f.service.active.has(original.id), true, 'resume is requested while the old executor is still active');
    assert.equal(calls.length, 1, 'a fresh executor cannot overlap its unconfirmed predecessor');
    assert.equal(f.service.business.durable.budgetUsage(project.id, cycle.day).cliCalls, 1);

    oldExit.resolve();
    await until(() => f.service.store.get('workItems', work.id).handoffStatus === 'verified');
    const stored = f.service.store.get('workItems', work.id);
    const attempts = f.service.store.list('runs').filter(run => run.workItemId === work.id);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].discarded, true);
    assert.notEqual(attempts[0].outputCheck?.status, 'passed');
    assert.notEqual(attempts[1].attemptId, original.attemptId);
    assert.notEqual(attempts[1].workspace, original.workspace);
    assert.equal(attempts[1].generation, original.generation + 1);
    assert.equal(attempts[1].nativeSession.operation, 'new');
    assert.equal(stored.summary, '恢复后新的有效结果');
    assert.equal(stored.currentReceiptId, acceptedReceiptId);
    assert.notEqual(stored.verifiedBy, stored.memberId);
    assert.equal(stored.attemptCount, 2);
    assert.deepEqual(calls.map(call => call.kind), ['analysis', 'analysis', 'accept']);
    assert.ok(calls.every(call => call.conversationId === null));
    assert.equal(f.service.store.list('workReceipts').filter(receipt => receipt.workItemId === work.id).length, 1);
    assert.equal(f.service.store.get('productionCycles', cycle.id).status, 'complete');
    assert.equal(stored.originalDueAt, work.originalDueAt);
    const budget = f.service.business.durable.budgetUsage(project.id, cycle.day);
    assert.equal(budget.cliCalls, 3, 'discarding an already started attempt must not refund its CLI budget');
    assert.equal(budget.entries.filter(entry => entry.kind === 'cli').length, 3);
    assert.ok(budget.entries.every(entry => entry.started && entry.status === 'consumed'));
    assert.deepEqual(new Set(budget.entries.map(entry => entry.key)),
      new Set(f.service.store.list('runs').filter(run => run.projectId === project.id).map(run => run.attemptId)));
  } finally { oldExit.resolve(); await f.close(); }
});

test('rejected plan cancels its old assignments and executes only the accepted replacement plan', async () => {
  let f, planCount = 0, replacementAwaitingAcceptance = false;
  const approveReplacement = gate(), productionCalls = [];
  const originalDueAt = new Date(Date.now() + 3600000).toISOString();
  const revisedDueAt = new Date(Date.now() + 7200000).toISOString();
  f = setup(async (_member, _prompt, options) => {
    const { assignment } = JSON.parse(fs.readFileSync(path.join(options.workspace, 'inputs', 'context.json'), 'utf8'));
    if (assignment.kind === 'plan') {
      planCount++;
      return report(`负责人提交方案${planCount}`, makePlan(f.owner, f.visual, f.reviewer).map(action => ({ ...action,
        title: `方案${planCount} ${action.kind}`, objective: `方案${planCount}：${action.objective}`,
        dueAt: planCount === 1 ? originalDueAt : revisedDueAt })));
    }
    if (assignment.kind === 'accept') {
      const source = f.service.store.get('workItems', assignment.acceptanceFor.workItemId);
      if (source.kind === 'plan') {
        if (assignment.acceptanceFor.generation === 1) return report('原计划的来源分工不清，请重新派工', [], { verdict: 'changes_requested' });
        assert.equal(assignment.acceptanceFor.generation, 2);
        replacementAwaitingAcceptance = true;
        await approveReplacement.promise;
      }
      return report('已独立核对当前固定收件', [], { verdict: 'approve' });
    }
    productionCalls.push({ id: assignment.id, kind: assignment.kind, objective: assignment.objective });
    if (assignment.kind === 'integrate') writeNote(options.workspace);
    return report('方案2成员交付已核对', [], { verdict: assignment.kind === 'review' ? 'approve' : 'none' });
  });
  try {
    const project = f.project();
    await until(() => replacementAwaitingAcceptance);
    const assignments = f.service.business.works(project.id);
    const retired = assignments.filter(work => work.title.startsWith('方案1 '));
    const replacement = assignments.filter(work => work.title.startsWith('方案2 '));
    assert.equal(retired.length, 4);
    assert.equal(replacement.length, 4);
    assert.ok(retired.every(work => work.status === 'cancelled' && work.handoffStatus === 'cancelled'),
      'every assignment derived from the rejected plan must be explicitly cancelled');
    assert.deepEqual(productionCalls, [], 'production waits for independent acceptance of the replacement plan');
    assert.ok(replacement.every(work => work.handoffStatus === 'assigned' && work.status === 'waiting_dependencies'));
    for (const current of replacement) {
      const previous = retired.find(work => work.dispatchedBy.key === current.dispatchedBy.key);
      assert.equal(current.dispatchedBy.workItemId, previous.dispatchedBy.workItemId);
      assert.equal(current.dispatchedBy.generation, previous.dispatchedBy.generation + 1);
      assert.equal(current.replacesWorkItemId, previous.id);
      assert.equal(previous.attemptCount, 0);
      assert.equal(current.attemptCount, previous.attemptCount);
      assert.equal(previous.originalDueAt, originalDueAt);
      assert.equal(current.originalDueAt, originalDueAt);
      assert.equal(current.dueAt, revisedDueAt);
      const changedDue = f.service.store.list('workHandoffs').find(event => event.workItemId === current.id && event.type === 'rescheduled');
      assert.equal(changedDue.originalDueAt, originalDueAt);
      assert.equal(changedDue.previousDueAt, originalDueAt);
      assert.equal(changedDue.dueAt, revisedDueAt);
    }

    approveReplacement.resolve();
    const content = await readyContent(f, project.id);
    await until(() => f.service.store.get('productionCycles', content.cycleId)?.status !== 'active');
    assert.equal(planCount, 2);
    assert.deepEqual(Object.fromEntries(['copy', 'visual', 'integrate', 'review'].map(kind =>
      [kind, productionCalls.filter(call => call.kind === kind).length])), { copy: 1, visual: 1, integrate: 1, review: 1 });
    assert.ok(productionCalls.every(call => call.objective.startsWith('方案2：')));
    assert.ok(retired.every(work => !f.service.store.list('runs').some(run => run.workItemId === work.id)),
      'cancelled assignments must never have started a production attempt');
    assert.equal(f.service.store.list('contentItems').filter(item => item.projectId === project.id).length, 1);
    assert.equal(f.service.store.list('contentRevisions').filter(version => version.contentId === content.id).length, 1);
    assert.equal(f.service.store.get('contentEligibilities', content.id).status, 'eligible');
    assert.equal(f.service.store.get('productionCycles', content.cycleId).status, 'complete',
      'retiring a rejected plan must not mark the successful replacement cycle as cancelled');
    assert.ok(replacement.every(work => f.service.store.get('workItems', work.id).attemptCount === 1));
    const cycle = f.service.store.get('productionCycles', content.cycleId);
    const budget = f.service.business.durable.budgetUsage(project.id, cycle.day);
    assert.equal(budget.cliCalls, 10, 'both plan and acceptance attempts remain charged, while cancelled unstarted work consumes nothing');
    assert.equal(budget.contentSlots, 1);
    const entries = budget.entries.filter(entry => entry.kind === 'cli');
    const runs = f.service.store.list('runs').filter(run => run.projectId === project.id);
    assert.equal(entries.length, 10);
    assert.equal(runs.length, 10);
    assert.ok(entries.every(entry => entry.started && entry.status === 'consumed'));
    assert.deepEqual(new Set(entries.map(entry => entry.key)), new Set(runs.map(run => run.attemptId)));
    assert.equal(f.service.store.list('publicationApprovals').length, 0);
    assert.equal(f.service.store.list('publicationAttempts').length, 0);
  } finally { approveReplacement.resolve(); await f.close(); }
});

test('replanning after started assignments carries spent attempts, the original promise and consumed budgets', async () => {
  let f, plans = 0, oldCopyCalls = 0, oldCopyWaiting = false, oldVisualWaiting = false;
  const oldExit = gate();
  const originalDueAt = new Date(Date.now() + 3600000).toISOString();
  const revisedDueAt = new Date(Date.now() + 10800000).toISOString();
  f = setup(async (_member, _prompt, options) => {
    const { assignment } = JSON.parse(fs.readFileSync(path.join(options.workspace, 'inputs', 'context.json'), 'utf8'));
    if (assignment.kind === 'plan') {
      plans++;
      return report(`负责人提交方案${plans}`, makePlan(f.owner, f.visual, f.reviewer).map(action => ({ ...action,
        title: `方案${plans} ${action.kind}`, objective: `方案${plans}：${action.objective}`,
        dueAt: plans === 1 ? originalDueAt : revisedDueAt })));
    }
    if (assignment.kind === 'accept') return report('独立核验本次固定收件', [], { verdict: 'approve' });
    if (assignment.objective.startsWith('方案1：')) {
      if (assignment.kind === 'copy') {
        oldCopyCalls++;
        if (oldCopyCalls === 1) return { ...report('本次缺少有效依据，执行失败'), success: false, exitCode: 1 };
        assert.equal(oldCopyCalls, 2);
        oldCopyWaiting = true;
      } else {
        assert.equal(assignment.kind, 'visual');
        oldVisualWaiting = true;
      }
      await oldExit.promise;
      return report('原计划的迟到结果不能放进新方案');
    }
    if (assignment.kind === 'integrate') writeNote(options.workspace);
    return report('方案2的成员交付', [], { verdict: assignment.kind === 'review' ? 'approve' : 'none' });
  });
  try {
    const project = f.project();
    await until(() => oldCopyWaiting && oldVisualWaiting);
    const original = f.service.business.works(project.id);
    const plan = original.find(work => work.kind === 'plan');
    const oldCopy = original.find(work => work.kind === 'copy');
    const oldVisual = original.find(work => work.kind === 'visual');
    assert.equal(plan.handoffStatus, 'verified');
    assert.equal(oldCopy.attemptCount, 2);
    assert.equal(oldVisual.attemptCount, 1);
    assert.equal(f.service.active.has(oldCopy.runId), true);
    assert.equal(f.service.active.has(oldVisual.runId), true);
    f.service.business.rework(plan.id, '来源方案改变，需要重新安排同一批责任工作');
    assert.equal(f.service.store.get('workItems', oldCopy.id).handoffStatus, 'cancelled');
    assert.equal(f.service.store.get('workItems', oldVisual.id).handoffStatus, 'cancelled');
    oldExit.resolve();

    const content = await readyContent(f, project.id);
    const replacement = f.service.business.works(project.id).filter(work => work.title.startsWith('方案2 '));
    const copy = replacement.find(work => work.kind === 'copy');
    const visual = replacement.find(work => work.kind === 'visual');
    assert.equal(plans, 2);
    assert.equal(copy.replacesWorkItemId, oldCopy.id);
    assert.equal(visual.replacesWorkItemId, oldVisual.id);
    assert.equal(copy.attemptCount, 3, 'new assignment identity must retain both already spent copy attempts');
    assert.equal(visual.attemptCount, 2, 'discarding an old result does not reset its attempt count');
    assert.equal(copy.attemptCount, f.service.projects.get(project.id).limits.maxAttempts);
    assert.ok(replacement.every(work => work.originalDueAt === originalDueAt && work.dueAt === revisedDueAt));
    assert.ok(replacement.every(work => work.handoffStatus === 'verified'));
    const runs = f.service.store.list('runs').filter(run => run.projectId === project.id);
    assert.equal(runs.filter(run => run.workItemId === copy.id).length, 1);
    assert.equal(runs.filter(run => run.workItemId === oldCopy.id).length, 2);
    assert.equal(f.service.store.get('runs', oldCopy.runId).discarded, true);
    assert.equal(f.service.store.get('runs', oldVisual.runId).discarded, true);
    assert.equal(f.service.store.list('workReceipts').filter(receipt => [oldCopy.id, oldVisual.id].includes(receipt.workItemId)).length, 0);
    const cycle = f.service.store.get('productionCycles', content.cycleId);
    assert.equal(cycle.status, 'complete');
    const budget = f.service.business.durable.budgetUsage(project.id, cycle.day);
    const entries = budget.entries.filter(entry => entry.kind === 'cli');
    assert.equal(runs.length, 13);
    assert.equal(budget.cliCalls, 13);
    assert.equal(entries.length, 13);
    assert.ok(entries.every(entry => entry.started && entry.status === 'consumed'));
    assert.deepEqual(new Set(entries.map(entry => entry.key)), new Set(runs.map(run => run.attemptId)));
    assert.equal(budget.contentSlots, 1);
    assert.equal(f.service.store.list('contentRevisions').filter(version => version.contentId === content.id).length, 1);
    assert.equal(f.service.store.list('publicationApprovals').length, 0);
    assert.equal(f.service.store.list('publicationAttempts').length, 0);
  } finally { oldExit.resolve(); await f.close(); }
});

test('controlled real CLI processes go from objective through fixed draft rejection to a new verified revision without publishing', async () => {
  const f = setup(null, { real: true, requestChanges: true });
  try {
    const project = f.project(); const content = await readyContent(f, project.id, 24000);
    const runs = f.service.store.list('runs').filter(run => run.projectId === project.id);
    const counts = Object.fromEntries(['plan', 'copy', 'visual', 'integrate', 'review', 'accept'].map(kind => [kind, runs.filter(run => run.businessKind === kind).length]));
    assert.deepEqual(counts, { plan: 1, copy: 1, visual: 1, integrate: 2, review: 2, accept: 3 });
    assert.equal(runs.length, 10);
    assert.ok(runs.every(run => run.process?.pid > 0 && run.processExitConfirmed && run.nativeSession.operation === 'new'));
    assert.ok(runs.every(run => run.processExitProofVersion === 1 && run.processExitEvidence?.confirmed === true &&
      run.processExitEvidence.method !== 'simulated_test_executor'));
    assert.equal(new Set(runs.map(run => run.process.pid)).size, 10);
    assert.ok(runs.every(run => /受控真实Node进程/.test(run.summary)));
    const revisions = f.service.store.list('contentRevisions').filter(version => version.contentId === content.id);
    assert.equal(revisions.length, 2);
    assert.equal(revisions[1].parentId, revisions[0].id);
    assert.notEqual(revisions[1].manifestHash, revisions[0].manifestHash);
    assert.doesNotMatch(revisions[0].body, /尚无实测对照数据/);
    assert.match(revisions[1].body, /尚无实测对照数据/);
    const reviews = f.service.store.list('reviews').filter(review => review.contentId === content.id);
    assert.deepEqual(reviews.map(review => review.verdict), ['changes_requested', 'approve']);
    assert.equal(reviews[1].versionId, revisions[1].id);
    const author = f.service.business.works(project.id).find(work => work.kind === 'integrate');
    assert.equal(author.handoffStatus, 'verified');
    assert.equal(f.service.store.get('workReceipts', author.currentReceiptId).versionId, revisions[1].id);
    assert.equal(f.service.store.get('contentEligibilities', content.id).status, 'eligible');
    assert.equal(f.service.store.list('publicationApprovals').length, 0);
    assert.equal(f.service.store.list('publicationAttempts').length, 0);
    assert.equal(f.service.publications.preview(content.id).canApprove, false, 'no test process or rendering stub grants publishing permission');
  } finally { await f.close(); }
});

test('controller and desktop HTTP identities cannot request or forge publication approval', async () => {
  const f = setup(async () => report('unused'));
  let server;
  try {
    const token = 'controller-publication-test-secret';
    const app = createApp(f.service, { controllerToken: token, desktopToken: 'desktop-http-test', desktopOnly: true });
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const headers of [{ Authorization: `Bearer ${token}` }, { 'X-CLI-Team-Desktop': 'desktop-http-test' }]) {
      for (const endpoint of ['/api/publications/approve', '/api/content/fake/approve', '/api/publications/fake/approve']) {
        const response = await fetch(url + endpoint, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: 'user', confirmed: true }) });
        assert.ok([403, 404, 405].includes(response.status), `${endpoint}: ${response.status}`);
      }
    }
    assert.equal(f.service.store.list('publicationApprovals').length, 0);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await f.close(); }
});
