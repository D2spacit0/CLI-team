import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TeamService } from '../server/service.mjs';
import { temporary, cleanup, success, until } from './helpers.mjs';

const analysis = { type: 'analysis', sections: ['summary'] };

function fixture(executor = async () => { throw new Error('This fixture must not launch a member'); }) {
  const root = temporary();
  const service = new TeamService({ root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }),
    agentExecutor: async (...args) => ({ ...await executor(...args), processExitConfirmed: true,
      processExitEvidence: { confirmed: true, method: 'simulated_test_executor' } }) });
  service.store.update('settings', 'workspace', { paused: true });
  const member = (handle, role, permission) => service.saveMember({ name: handle, handle, provider: 'custom', role,
    permission, executable: process.execPath, enabled: true });
  const owner = member('owner', 'builder', 'edit'), writer = member('writer', 'builder', 'edit'), reviewer = member('reviewer', 'reviewer', 'plan');
  const project = service.projects.create({ name: '业务边界回归', objective: '让有效责任与实际证据决定下一棒',
    ownerId: owner.id, reviewerId: reviewer.id, memberIds: [owner.id, writer.id, reviewer.id] });
  return { root, service, owner, writer, reviewer, project,
    work(fields = {}) { return service.business.createWork({ projectId: project.id, memberId: writer.id, kind: 'analysis',
      title: '核对当前材料', objective: '按来源说明结果', output: analysis, ...fields }); },
    start() { service.store.update('settings', 'workspace', { paused: false }); service.kick(); },
    async close() { await service.close(); cleanup(root); } };
}

function assignment(options) {
  return JSON.parse(fs.readFileSync(path.join(options.workspace, 'inputs', 'context.json'), 'utf8')).assignment;
}

function defer(assigned) {
  return success('材料尚不具备条件，明确保留未完事项并改期', { business: { version: 1, actions: [{ type: 'resolve_work',
    workItemId: assigned.resolutionFor.workItemId, generation: assigned.resolutionFor.generation,
    decision: 'defer', reason: '先处理当前阻碍，不能声明成果通过', dueAt: new Date(Date.now() + 3600000).toISOString() }] } });
}

test('removing a queued worker revokes admission and preserves the original commitment for the current owner', async () => {
  const f = fixture();
  try {
    const work = f.work();
    f.service.business.admit();
    const run = f.service.store.list('runs').find(item => item.workItemId === work.id);
    assert.equal(run.status, 'queued');
    f.service.business.updateProject(f.project.id, { expectedRevision: f.project.revision,
      memberIds: [f.owner.id, f.reviewer.id] });
    f.service.business.admit();
    const current = f.service.store.get('workItems', work.id);
    assert.equal(current.status, 'blocked');
    assert.equal(current.handoffStatus, 'blocked');
    assert.equal(current.waitKind, 'authorization');
    assert.equal(current.originalDueAt, work.originalDueAt);
    assert.equal(f.service.business.policy(run, f.writer), null);
    assert.equal(f.service.store.get('runs', run.id).status, 'cancelled');
    assert.equal(f.service.store.list('runs').some(item => item.memberId === f.writer.id && ['queued', 'running'].includes(item.status)), false);
    assert.ok(f.service.business.works(f.project.id).some(item => item.resolutionFor?.workItemId === work.id && item.memberId === f.owner.id));
    assert.equal(f.service.active.size, 0);
  } finally { await f.close(); }
});

test('a former owner remaining on the roster cannot keep coordinating under the old authority', async () => {
  const f = fixture();
  try {
    const work = f.work({ memberId: f.owner.id, kind: 'coordinate' });
    f.service.business.admit();
    const run = f.service.store.list('runs').find(item => item.workItemId === work.id);
    f.service.business.updateProject(f.project.id, { expectedRevision: f.project.revision, ownerId: f.writer.id });
    f.service.business.admit();
    const current = f.service.store.get('workItems', work.id);
    assert.equal(current.status, 'blocked');
    assert.equal(current.checkerId, f.writer.id);
    assert.equal(current.originalDueAt, work.originalDueAt);
    assert.equal(f.service.business.claim(run), false);
    assert.ok(f.service.business.works(f.project.id).some(item => item.resolutionFor?.workItemId === work.id && item.memberId === f.writer.id));
    assert.ok(f.service.store.list('workHandoffs').some(event => event.workItemId === work.id && event.type === 'responsibility_changed'));
  } finally { await f.close(); }
});

test('a failed business tool remains unfinished and reaches an explicit owner decision', async () => {
  const f = fixture(async (_member, _prompt, options) => {
    const assigned = assignment(options);
    if (assigned.resolutionFor) return defer(assigned);
    return success('需要读取已登记材料', { status: 'needs_help', business: { version: 1, actions: [{
      type: 'request_tool', tool: 'material.read', arguments: { materialId: 'missing-material' },
    }] } });
  });
  try {
    const work = f.work(); f.start();
    await until(() => f.service.business.works(f.project.id).some(item => item.resolutionFor?.workItemId === work.id && item.handoffStatus === 'verified'));
    const current = f.service.store.get('workItems', work.id);
    assert.equal(current.status, 'blocked');
    assert.equal(current.handoffStatus, 'blocked');
    assert.equal(current.attemptCount, 1);
    assert.ok(f.service.store.list('workHandoffs').some(event => event.workItemId === work.id && event.type === 'escalated'));
    assert.equal(f.service.business.durable.listJobs({ kind: 'business.tool' })[0].status, 'failed');
    assert.equal(f.service.store.list('workReceipts').some(receipt => receipt.workItemId === work.id), false);
  } finally { await f.close(); }
});

test('resume cannot reset an exhausted attempt budget or silently close its handoff', async () => {
  const f = fixture();
  try {
    const work = f.work();
    f.service.store.update('workItems', work.id, { attemptCount: 3 });
    f.service.business.pauseProject(f.project.id);
    f.service.business.resumeProject(f.project.id);
    const current = f.service.store.get('workItems', work.id);
    assert.equal(current.status, 'failed');
    assert.equal(current.handoffStatus, 'blocked');
    assert.equal(current.attemptCount, 3);
    assert.ok(f.service.business.works(f.project.id).some(item => item.resolutionFor?.workItemId === work.id));
    assert.equal(current.originalDueAt, work.originalDueAt);
    assert.ok(f.service.store.list('workHandoffs').some(event => event.workItemId === work.id && event.type === 'interrupted'));
  } finally { await f.close(); }
});

test('an approve claim with major findings cannot verify a receipt or release dependent work', async () => {
  let source, successor, successorStarted = false;
  const f = fixture(async (_member, _prompt, options) => {
    const assigned = assignment(options);
    if (assigned.resolutionFor) return defer(assigned);
    if (assigned.kind === 'accept') return success('声明通过却仍有重大事实问题', { verdict: 'approve',
      findings: [{ severity: 'major', text: '主要结论没有实际来源' }] });
    if (assigned.id === successor.id) successorStarted = true;
    return success('来源为成员经验判断，等待接收方核查');
  });
  try {
    source = f.work(); successor = f.work({ memberId: f.owner.id, dependencies: [source.id] }); f.start();
    await until(() => f.service.business.works(f.project.id).some(item => item.kind === 'accept' && item.acceptanceFor?.workItemId === source.id && item.status === 'failed'));
    assert.equal(f.service.store.get('workItems', source.id).handoffStatus, 'received');
    assert.equal(successorStarted, false);
    assert.equal(f.service.store.get('workItems', successor.id).status, 'waiting_dependencies');
    assert.equal(f.service.store.list('workHandoffs').some(event => event.workItemId === source.id && event.type === 'verified'), false);
    assert.ok(f.service.store.list('runs').filter(run => run.businessKind === 'accept').every(run => /重大问题/.test(run.error)));
  } finally { await f.close(); }
});

test('material reads preserve controller provenance and reject revoked material', async () => {
  const f = fixture();
  try {
    const material = f.service.business.importMaterial(f.project.id, { name: 'controller-note.txt',
      contentBase64: Buffer.from('主控提交的说明，并非用户实测记录').toString('base64') }, 'controller:test');
    const work = f.work(); f.service.business.admit();
    const run = f.service.store.list('runs').find(item => item.workItemId === work.id);
    const action = { tool: 'material.read', arguments: { materialId: material.id } };
    const result = await f.service.business.readTool(action, run.id);
    assert.equal(result.evidenceType, 'controller_submission');
    assert.equal(result.text, '主控提交的说明，并非用户实测记录');
    f.service.store.update('projectMaterials', material.id, { status: 'revoked' });
    await assert.rejects(() => f.service.business.readTool(action, run.id), /素材已失效/);
    assert.throws(() => f.service.business.validateRefs(f.project.id, [{ kind: 'material', id: material.id }]), /输入版本已经失效/);
  } finally { await f.close(); }
});

test('returning exhausted work invalidates its dependent generation while preserving spent attempts', async () => {
  const f = fixture();
  try {
    const source = f.work(), dependent = f.work({ memberId: f.owner.id, dependencies: [source.id] });
    f.service.store.update('workItems', source.id, { attemptCount: 3, status: 'succeeded', handoffStatus: 'verified', resultDigest: 'old-result' });
    f.service.store.update('workItems', dependent.id, { status: 'ready' });
    f.service.business.admit();
    const run = f.service.store.list('runs').find(item => item.workItemId === dependent.id);
    f.service.business.rework(source.id, '已核查发现旧结论缺少依据，不能继续使用');
    const returned = f.service.store.get('workItems', source.id), next = f.service.store.get('workItems', dependent.id);
    assert.equal(returned.status, 'failed');
    assert.equal(returned.handoffStatus, 'blocked');
    assert.equal(returned.attemptCount, 3);
    assert.equal(returned.generation, 2);
    assert.equal(next.generation, 2);
    assert.equal(f.service.store.get('runs', run.id).status, 'cancelled');
    assert.equal(f.service.business.claim(run), false);
    assert.ok(f.service.business.works(f.project.id).some(item => item.resolutionFor?.workItemId === source.id));
  } finally { await f.close(); }
});

test('cancelling a current business run closes its handoff and dependent work explicitly', async () => {
  const f = fixture();
  try {
    const source = f.work(), dependent = f.work({ memberId: f.owner.id, dependencies: [source.id] });
    f.service.business.admit();
    const run = f.service.store.list('runs').find(item => item.workItemId === source.id);
    f.service.cancelRun(run.id);
    assert.equal(f.service.store.get('runs', run.id).status, 'cancelled');
    assert.equal(f.service.store.get('workItems', source.id).handoffStatus, 'cancelled');
    assert.equal(f.service.store.get('workItems', dependent.id).handoffStatus, 'cancelled');
    assert.ok(f.service.store.list('workHandoffs').some(event => event.workItemId === source.id && event.type === 'cancelled' && event.actorId === 'user'));
  } finally { await f.close(); }
});
