import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store, restoreLegacySnapshot } from '../server/store.mjs';
import { Store as LegacyStore } from './fixtures/legacy-store-v0.1.mjs';
import { BusinessStore } from '../server/business-store.mjs';
import { ProjectService, projectDay } from '../server/projects.mjs';
import { ContentRevisionService, contentDigest } from '../server/content-revisions.mjs';
import { buildProjectContext } from '../server/project-context.mjs';
import { inside } from '../server/safety.mjs';

const base = path.resolve('work/tests');
fs.mkdirSync(base, { recursive: true });
const temporary = () => fs.mkdtempSync(path.join(base, 'business-data-'));
const cleanup = root => {
  const resolved = fs.realpathSync(root);
  if (resolved === fs.realpathSync(base) || !inside(fs.realpathSync(base), resolved)) throw new Error('Unsafe test cleanup');
  fs.rmSync(resolved, { recursive: true, force: true });
};
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
function png(shade = 235) {
  const chunk = (name, data) => {
    const type = Buffer.from(name), header = Buffer.alloc(4), checksum = Buffer.alloc(4);
    header.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([header, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(320); header.writeUInt32BE(480, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((320 * 3 + 1) * 480, shade);
  for (let row = 0; row < 480; row++) rows[row * (320 * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function fixture() {
  const root = temporary(), dataDir = path.join(root, '.team'), store = new Store(path.join(dataDir, 'team.sqlite'));
  store.put('members', { id: 'writer', name: '写作', provider: 'custom', enabled: true });
  store.put('members', { id: 'reviewer', name: '审稿', provider: 'custom', enabled: true });
  const content = new ContentRevisionService({ store, dataDir });
  const projects = new ProjectService({ store, dataDir, onInvalidate: event => content.invalidateDependencies(event) });
  const project = projects.create({ name: '图文项目', objective: '分享可核实的实用经验', ownerId: 'writer', reviewerId: 'reviewer', memberIds: ['writer', 'reviewer'] });
  return { root, dataDir, store, content, projects, project, durable: new BusinessStore(store), close() { store.close(); cleanup(root); } };
}
const note = (extra = {}) => ({ title: '记录实用经验', body: '这是有来源的完整中文稿件。', tags: ['经验'],
  sources: [{ kind: 'user', label: '用户提供的项目简报' }], authorMemberIds: ['writer'],
  images: [{ bytes: png(), source: { kind: 'template', label: '本地信息卡' }, templateVersion: 'card-v1', renderCheck: { passed: true } }], ...extra });
function approveReview(f, item, revision, index = 1) {
  f.store.put('workItems', { id: `review-work-${index}`, projectId: f.project.id, contentId: item.id, kind: 'review',
    generation: 1, currentAttemptId: `review-attempt-${index}` });
  f.store.put('runs', { id: `review-run-${index}`, workflowKind: 'business', projectId: f.project.id,
    memberId: 'reviewer', workItemId: `review-work-${index}`, attemptId: `review-attempt-${index}`, generation: 1,
    status: 'succeeded', executionSucceeded: true });
  return f.content.recordReview(item.id, revision.id, { memberId: 'reviewer', verdict: 'approve', summary: '已核对来源、图文一致性和表达。', sourceRunId: `review-run-${index}` });
}

test('legacy writer barriers reject already open, prepared and newly opened old Store writes, while isolated rollback remains usable', () => {
  const root = temporary(), dataDir = path.join(root, '.team'), filename = path.join(dataDir, 'team.sqlite');
  const workspaceRoot = path.join(root, 'workspaces'), workspace = path.join(workspaceRoot, 'legacy-task');
  fs.mkdirSync(workspace, { recursive: true }); fs.writeFileSync(path.join(workspace, 'result.txt'), '旧成果原文');
  fs.writeFileSync(path.join(workspace, 'auth.json'), 'do-not-copy');
  fs.mkdirSync(path.join(workspaceRoot, 'room-team')); fs.writeFileSync(path.join(workspaceRoot, 'room-team', 'notes.txt'), '房间材料');
  const old = new LegacyStore(filename); let migrated, opened, restored;
  try {
    old.put('tasks', { id: 'legacy-task', workspace, status: 'done', summary: '旧验收含义保持原样' });
    old.put('rooms', { id: 'room-team', kind: 'team' });
    old.put('uiDrafts', { id: 'draft', title: '还未发送' });
    old.event('legacy', { taskId: 'legacy-task' });
    const prepared = old.db.prepare('UPDATE entities SET data=? WHERE kind=? AND id=?');
    migrated = new Store(filename, { workspaceRoot });
    const before = migrated.get('tasks', 'legacy-task');
    assert.throws(() => prepared.run('{"id":"legacy-task","status":"running"}', 'tasks', 'legacy-task'), /cli_team_writer_version/);
    assert.throws(() => old.put('tasks', { ...before, status: 'running' }), /cli_team_writer_version/);
    assert.throws(() => old.event('old-recovery', {}), /cli_team_writer_version/);
    assert.throws(() => old.remove('tasks', 'legacy-task'), /cli_team_writer_version/);
    assert.throws(() => old.transaction(() => { old.update('tasks', 'legacy-task', { status: 'running' }); old.event('recovered', {}); }), /cli_team_writer_version/);
    opened = new LegacyStore(filename);
    assert.throws(() => opened.put('settings', { id: 'workspace' }), /cli_team_writer_version/);
    assert.deepEqual(migrated.get('tasks', 'legacy-task'), before);
    assert.equal(migrated.db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
    migrated.put('settings', { id: 'new-writer', value: true });
    const destination = path.join(root, 'isolated-old-workspace');
    const rollback = restoreLegacySnapshot(migrated.migrationBackup, destination);
    restored = new LegacyStore(rollback.databasePath);
    assert.equal(restored.get('tasks', 'legacy-task').status, 'done');
    assert.equal(restored.get('tasks', 'legacy-task').workspace, path.join(destination, 'workspaces', 'legacy-task'));
    assert.equal(fs.readFileSync(path.join(destination, 'workspaces', 'legacy-task', 'result.txt'), 'utf8'), '旧成果原文');
    assert.equal(fs.readFileSync(path.join(destination, 'workspaces', 'room-team', 'notes.txt'), 'utf8'), '房间材料');
    assert.equal(fs.existsSync(path.join(destination, 'workspaces', 'legacy-task', 'auth.json')), false);
    restored.put('settings', { id: 'workspace', paused: true });
    assert.equal(restored.get('uiDrafts', 'draft').title, '还未发送');
    assert.throws(() => restoreLegacySnapshot(migrated.migrationBackup, root), /独立目录/);
  } finally { restored?.close(); opened?.close(); migrated?.close(); old.close(); cleanup(root); }
});

test('legacy migration refuses unfinished work before installing schema or changing task meanings', () => {
  const root = temporary(), filename = path.join(root, '.team', 'team.sqlite'), old = new LegacyStore(filename);
  try {
    old.put('runs', { id: 'old-running', status: 'queued', memberId: 'writer' });
    assert.throws(() => new Store(filename), /旧工作区仍有运行/);
    assert.equal(old.get('runs', 'old-running').status, 'queued');
    assert.equal(old.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='schema_meta'").get().n, 0);
    old.update('runs', 'old-running', { status: 'cancelled' });
    const upgraded = new Store(filename); upgraded.close();
  } finally { old.close(); cleanup(root); }
});

test('durable jobs survive reopen, claims are exclusive, and expired leases do not prove a process stopped', () => {
  const root = temporary(), filename = path.join(root, 'team.sqlite');
  let first = new Store(filename), second;
  try {
    const queue = new BusinessStore(first);
    const job = queue.enqueueJob({ key: 'work:one:g1', kind: 'business_work', projectId: 'p', workItemId: 'one', generation: 1, payload: { a: 1 } });
    assert.equal(queue.enqueueJob({ key: 'work:one:g1', kind: 'business_work', projectId: 'p', workItemId: 'one', generation: 1, payload: { a: 1 } }).id, job.id);
    assert.throws(() => queue.enqueueJob({ key: 'work:one:g1', kind: 'business_work', projectId: 'p', workItemId: 'one', generation: 1, payload: { a: 2 } }), /不同输入/);
    first.close(); first = new Store(filename); second = new Store(filename);
    const left = new BusinessStore(first), right = new BusinessStore(second);
    const claimed = left.claimJob(job.id, { ownerId: 'left' });
    assert.equal(right.claimJob(job.id, { ownerId: 'right' }), null);
    assert.throws(() => right.requeueJob(job.id), /未确认/);
    assert.equal(left.finishJob(job.id, 'stale-token'), false);
    assert.equal(left.finishJob(job.id, claimed.leaseToken), true);
    const lease = left.acquireLease('member:writer', { ownerId: 'left', generation: 1 });
    first.db.prepare("UPDATE resource_leases SET expires_at='2000-01-01T00:00:00.000Z'").run();
    assert.equal(right.acquireLease('member:writer', { ownerId: 'right', generation: 2 }), null);
    assert.equal(left.releaseLease(lease.resource, 'old-token'), false);
    assert.equal(left.releaseLease(lease.resource, lease.token), true);
    assert.equal(right.acquireLease('member:writer', { ownerId: 'right', generation: 2 }).generation, 2);
  } finally { second?.close(); first.close(); cleanup(root); }
});

test('request deduplication and budget/content reservations roll back together and cannot exceed shared limits', () => {
  const f = fixture();
  const other = new Store(f.store.filename), contender = new BusinessStore(other);
  try {
    assert.throws(() => f.store.transaction(() => {
      f.durable.reserveBudget({ projectId: f.project.id, day: '2026-11-11', key: 'rollback' });
      f.durable.enqueueJob({ key: 'rollback', kind: 'business_work' });
      throw new Error('ROLLBACK');
    }), /ROLLBACK/);
    assert.equal(f.durable.budgetUsage(f.project.id, '2026-11-11').cliCalls, 0);
    assert.equal(f.durable.listJobs().length, 0);
    const budget = f.durable.reserveBudget({ projectId: f.project.id, day: '2026-11-11', key: 'a', limit: 1 });
    assert.equal(contender.reserveBudget({ projectId: f.project.id, day: '2026-11-11', key: 'b', limit: 1 }), null);
    f.durable.markBudgetStarted(budget.id);
    assert.equal(f.durable.releaseUnstartedBudget(budget.id, { confirmedNotStarted: true }), false);
    for (let index = 0; index < 3; index++) assert.equal(contender.reserveContentSlot({ projectId: f.project.id, contentId: `draft-${index}` }), true);
    assert.equal(f.durable.reserveContentSlot({ projectId: f.project.id, contentId: 'fourth' }), false);
    assert.equal(f.durable.reserveContentSlot({ projectId: f.project.id, contentId: 'draft-0' }), true);
    f.store.put('publicationAttempts', { id: 'unknown', contentId: 'draft-0', status: 'unknown', submissionMayHaveOccurred: true });
    assert.throws(() => f.durable.releaseContentSlot('draft-0', { reason: 'abandoned' }), /未决/);
    let times = 0;
    assert.deepEqual(f.durable.requestOnce('request', 'digest', () => ({ result: ++times })), { result: 1 });
    assert.deepEqual(contender.requestOnce('request', 'digest', () => ({ result: ++times })), { result: 1 });
    assert.throws(() => contender.requestOnce('request', 'changed', () => null), /其他内容/);
    assert.equal(times, 1);
  } finally { other.close(); f.close(); }
});

test('project cycles are unique per local day and multi-day recovery only opens the current cycle', () => {
  const f = fixture();
  try {
    assert.equal(projectDay('Asia/Shanghai', new Date('2026-11-11T23:00:00Z')), '2026-11-12');
    const previous = f.projects.startCycle(f.project.id, { at: new Date('2026-11-01T00:00:00Z') });
    assert.equal(f.projects.startCycle(f.project.id, { at: new Date('2026-11-11T00:00:00Z') }).id, previous.id);
    f.projects.finishCycle(previous.id);
    assert.equal(f.projects.startCycle(f.project.id, { at: new Date('2026-11-01T02:00:00Z') }).id, previous.id);
    const current = f.projects.startCycle(f.project.id, { at: new Date('2026-11-11T00:00:00Z') });
    assert.equal(current.day, '2026-11-11');
    assert.equal(f.store.list('productionCycles').length, 2);
    assert.throws(() => f.store.put('productionCycles', { id: 'duplicate', projectId: f.project.id, day: '2026-11-12', status: 'active' }), /UNIQUE/);
  } finally { f.close(); }
});

test('content checks validate real image bytes and remain separate from verified independent review', () => {
  const f = fixture();
  try {
    const item = f.content.createItem(f.project.id), revision = f.content.createRevision(item.id, note());
    assert.equal(f.content.inspectRevision(revision.id).passed, true);
    assert.equal(f.content.getBundle(item.id).eligibility.status, 'pending');
    assert.throws(() => f.content.recordReview(item.id, revision.id, { memberId: 'writer', verdict: 'approve', summary: '自己批准' }), /作者不能/);
    f.content.recordReview(item.id, revision.id, { memberId: 'reviewer', verdict: 'approve', summary: '来源未核验的自述' });
    assert.equal(f.content.getBundle(item.id).eligibility.status, 'pending');
    approveReview(f, item, revision);
    assert.equal(f.content.getBundle(item.id).eligibility.status, 'eligible');
    assert.equal(f.content.getBundle(item.id).checks[0].evidenceType, 'machine');
    const assetPath = revision.images[0].path;
    fs.writeFileSync(assetPath, png(100));
    assert.equal(f.content.inspectRevision(revision.id).passed, false);
    assert.throws(() => f.content.createRevision(item.id, note({ images: [{ bytes: Buffer.from('not an image'), source: 'invalid' }] })), /图片/);
  } finally { f.close(); }
});

test('fact corrections atomically revoke only dependent eligibility, approval and queued publish work', () => {
  const f = fixture();
  try {
    const fact = f.projects.addFact(f.project.id, { type: 'fact', content: '来源记录的数值为 10', sources: [{ label: '用户原始表格', kind: 'user' }] }, { adopt: true });
    const dependent = f.content.createItem(f.project.id), independent = f.content.createItem(f.project.id);
    const first = f.content.createRevision(dependent.id, note({ inputRefs: [{ kind: 'projectFacts', id: fact.id, revision: 1 }] }));
    const other = f.content.createRevision(independent.id, note());
    approveReview(f, dependent, first, 1); approveReview(f, independent, other, 2);
    f.store.put('publicationApprovals', { id: 'approval-1', contentId: dependent.id, status: 'approved' });
    f.store.put('publicationApprovals', { id: 'approval-2', contentId: independent.id, status: 'approved' });
    const queued = f.durable.enqueueJob({ key: 'publish-1', kind: 'publication.send', payload: { contentId: dependent.id } });
    f.projects.reviseFact(f.project.id, fact.id, { type: 'fact', content: '来源修正后数值为 12', sources: [{ label: '修正版表格', kind: 'user' }] });
    assert.equal(f.content.getBundle(dependent.id).eligibility.status, 'invalid');
    assert.equal(f.store.get('publicationApprovals', 'approval-1').status, 'revoked');
    assert.equal(f.durable.getJob(queued.id).status, 'cancelled');
    assert.equal(f.content.getBundle(independent.id).eligibility.status, 'eligible');
    assert.equal(f.store.get('publicationApprovals', 'approval-2').status, 'approved');
    assert.equal(f.store.get('contentRevisions', first.id).body, first.body);
    assert.throws(() => f.store.update('contentRevisions', first.id, { body: '覆盖历史' }), /immutable/);
    assert.throws(() => f.content.recordReview(dependent.id, first.id, { memberId: 'reviewer', verdict: 'approve', summary: '旧审查' }), /旧版本/);
  } finally { f.close(); }
});

test('fixed attempt inputs contain actual dependency copies and collection rejects tampering, links and stale work', () => {
  const f = fixture();
  try {
    const asset = f.content.storeAsset(Buffer.from('{"result":"原成果"}'), { projectId: f.project.id, mime: 'application/json' });
    f.store.put('workItems', { id: 'upstream', projectId: f.project.id, generation: 1, outputDigest: 'digest', outputFiles: [asset], workspace: 'C:\\private-original' });
    f.store.put('workItems', { id: 'downstream', projectId: f.project.id, generation: 1 });
    const attempt = f.content.prepareAttempt({ projectId: f.project.id, workItemId: 'downstream', generation: 1, attemptId: 'first',
      inputRefs: [{ kind: 'work', id: 'upstream', generation: 1, digest: 'digest' }],
      context: { assignment: { acceptanceFor: { workItemId: 'upstream', generation: 1, receiptId: 'receipt-1',
        resultDigest: 'digest', objective: '核对原成果', acceptanceCriteria: ['结果可读取'], files: [asset] } } } });
    const refs = fs.readFileSync(path.join(attempt.workspace, 'inputs', 'references.json'), 'utf8');
    assert.equal(refs.includes(asset.path.replaceAll('\\', '\\\\')), false);
    assert.equal(refs.includes('private-original'), false);
    const copy = attempt.inputs.find(input => input.path.startsWith('inputs/materials/'));
    assert.ok(copy);
    assert.equal(contentDigest(fs.readFileSync(path.join(attempt.workspace, copy.path))), asset.sha256);
    const acceptance = JSON.parse(fs.readFileSync(path.join(attempt.workspace, 'inputs/context.json'), 'utf8')).assignment.acceptanceFor;
    assert.equal(acceptance.receiptId, 'receipt-1');
    assert.match(acceptance.files[0].path, /^inputs\/materials\//);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(attempt.workspace, acceptance.files[0].path), 'utf8')), { result: '原成果' });
    fs.writeFileSync(path.join(attempt.workspace, 'note.json'), '{"title":"交付"}');
    const collected = f.content.collectAttempt(attempt, { outputs: [{ path: 'note.json', format: 'json' }] });
    assert.equal(collected.files.length, 1);
    assert.throws(() => f.content.collectAttempt(attempt, { outputs: [{ path: '../outside.json' }] }), /名称无效/);
    assert.throws(() => f.content.collectAttempt(attempt, { outputs: [{ path: 'note.json' }], isCurrent: () => false }), /旧 attempt/);
    fs.writeFileSync(path.join(attempt.workspace, copy.path), 'tampered');
    assert.throws(() => f.content.collectAttempt(attempt, { outputs: [{ path: 'note.json' }] }), /固定输入被修改/);
    const next = f.content.prepareAttempt({ projectId: f.project.id, workItemId: 'downstream', generation: 1, attemptId: 'second' });
    fs.linkSync(asset.path, path.join(next.workspace, 'linked.json'));
    assert.throws(() => f.content.collectAttempt(next, { outputs: [{ path: 'linked.json' }] }), /链接/);
    assert.throws(() => f.content.prepareAttempt({ projectId: f.project.id, workItemId: 'downstream', generation: 1, attemptId: 'second' }), /全新的独立/);
  } finally { f.close(); }
});

test('only a schedule change reuses an identified review while revoking the old publication scope', () => {
  const f = fixture();
  try {
    const item = f.content.createItem(f.project.id), first = f.content.createRevision(item.id, note());
    const review = approveReview(f, item, first);
    f.store.put('publicationApprovals', { id: 'schedule-approval', contentId: item.id, status: 'approved' });
    const job = f.durable.enqueueJob({ key: 'schedule-publish', kind: 'publication.send', payload: { contentId: item.id } });
    const next = f.content.createRevision(item.id, note({ schedule: { kind: 'scheduled', startsAt: new Date(Date.now() + 86400000).toISOString() } }));
    const bundle = f.content.getBundle(item.id), reused = bundle.reviews.find(entry => entry.id === bundle.eligibility.reviewId);
    assert.notEqual(next.manifestHash, first.manifestHash, 'the human publication approval covers the new schedule');
    assert.equal(next.reviewScopeDigest, first.reviewScopeDigest);
    assert.equal(bundle.eligibility.valid, true);
    assert.equal(bundle.item.status, 'awaiting_approval');
    assert.equal(reused.evidenceReuse, 'schedule_only');
    assert.equal(reused.reusedFromReviewId, review.id);
    assert.equal(reused.sourceRunId, review.sourceRunId, 'reuse must not invent a new independent review run');
    assert.equal(reused.sourceReviewedAt, review.createdAt);
    assert.equal(f.store.get('publicationApprovals', 'schedule-approval').status, 'revoked');
    assert.equal(f.durable.getJob(job.id).status, 'cancelled');
    const changed = f.content.createRevision(item.id, note({ body: '正文已经变更，必须重新核对。' }));
    assert.notEqual(changed.reviewScopeDigest, next.reviewScopeDigest);
    assert.equal(f.content.getBundle(item.id).eligibility.valid, false);
    assert.equal(f.content.getBundle(item.id).eligibility.reviewId, null);
  } finally { f.close(); }
});

test('invalidating a material atomically revokes content that used it through a colleague result', () => {
  const f = fixture();
  try {
    const asset = f.content.storeAsset(Buffer.from('待更正的用户资料'), { projectId: f.project.id, mime: 'text/plain' });
    f.store.put('projectMaterials', { id: 'indirect-material', projectId: f.project.id, assetId: asset.id, name: '资料.txt',
      status: 'active', revision: 1, sha256: asset.sha256, size: asset.size, mime: asset.mime });
    f.store.put('workItems', { id: 'source-research', projectId: f.project.id, generation: 1, outputDigest: 'research-result',
      inputRefs: [{ kind: 'material', id: 'indirect-material', revision: 1, digest: asset.sha256 }],
      handoffStatus: 'delivered', receiverId: 'writer', checkerId: 'reviewer', dueAt: '2026-11-13T12:00:00Z' });
    const item = f.content.createItem(f.project.id), version = f.content.createRevision(item.id,
      note({ inputRefs: [{ kind: 'work', id: 'source-research', generation: 1, digest: 'research-result' }] }));
    approveReview(f, item, version);
    f.store.put('publicationApprovals', { id: 'indirect-approval', contentId: item.id, status: 'approved' });
    const colleague = buildProjectContext(f.store, f.project.id).colleagues.find(work => work.id === 'source-research');
    assert.equal(colleague.handoffStatus, 'delivered');
    assert.equal(colleague.receiverId, 'writer'); assert.equal(colleague.checkerId, 'reviewer');
    assert.equal(colleague.dueAt, '2026-11-13T12:00:00Z');
    f.store.transaction(() => {
      f.store.update('projectMaterials', 'indirect-material', { status: 'invalid' });
      f.content.invalidateDependencies({ projectId: f.project.id, refs: [{ kind: 'material', id: 'indirect-material' }], reason: '用户材料已失效' });
    });
    assert.equal(f.content.getBundle(item.id).eligibility.status, 'invalid');
    assert.equal(f.store.get('publicationApprovals', 'indirect-approval').status, 'revoked');
    assert.equal(buildProjectContext(f.store, f.project.id).materials.length, 0);
    assert.throws(() => f.content.resolveRef(f.project.id, { kind: 'material', id: 'indirect-material' }), /素材已失效/);
  } finally { f.close(); }
});

test('unpinned references become versioned inputs and a changed source cannot qualify unchanged local bytes', () => {
  const f = fixture();
  try {
    f.store.put('workItems', { id: 'source', projectId: f.project.id, generation: 1, outputDigest: 'original', outputFiles: [] });
    f.store.put('workItems', { id: 'acceptance', projectId: f.project.id, generation: 1 });
    const attempt = f.content.prepareAttempt({ projectId: f.project.id, workItemId: 'acceptance', generation: 1,
      attemptId: 'pinned-acceptance', inputRefs: [{ kind: 'work', id: 'source' }] });
    assert.equal(attempt.inputRefs[0].generation, 1);
    assert.equal(attempt.inputRefs[0].digest, 'original');
    assert.equal(f.content.inspectAttemptInputs(attempt), true);
    f.store.update('workItems', 'source', { generation: 2, outputDigest: 'replaced' });
    assert.throws(() => f.content.collectAttempt(attempt), /generation 已变化/);
  } finally { f.close(); }
});

test('independent host processes deduplicate one outbox job and cannot over-reserve a shared budget', async () => {
  const root = temporary(), filename = path.join(root, 'concurrent.sqlite');
  const store = new Store(filename);
  const storeModule = new URL('../server/store.mjs', import.meta.url).href;
  const queueModule = new URL('../server/business-store.mjs', import.meta.url).href;
  const worker = name => new Promise((resolve, reject) => {
    const script = `import {Store} from ${JSON.stringify(storeModule)};import {BusinessStore} from ${JSON.stringify(queueModule)};` +
      `const store=new Store(${JSON.stringify(filename)});const queue=new BusinessStore(store);` +
      `const job=queue.enqueueJob({key:'one-job',kind:'business.run',payload:{same:true}});` +
      `const budget=queue.reserveBudget({projectId:'p',day:'2026-11-12',key:${JSON.stringify(name)},limit:1});` +
      `store.close();console.log(JSON.stringify({job:job.id,reserved:Boolean(budget)}));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(error));
      else { try { resolve(JSON.parse(output)); } catch (cause) { reject(cause); } }
    });
  });
  try {
    const receipts = await Promise.all([worker('one'), worker('two'), worker('three')]);
    assert.equal(new Set(receipts.map(receipt => receipt.job)).size, 1);
    assert.equal(receipts.filter(receipt => receipt.reserved).length, 1);
    assert.equal(new BusinessStore(store).budgetUsage('p', '2026-11-12').cliCalls, 1);
  } finally { store.close(); cleanup(root); }
});

test('possible external submission keeps the approval history and content slot even when upstream data is invalidated', () => {
  const f = fixture();
  try {
    const item = f.content.createItem(f.project.id), revision = f.content.createRevision(item.id, note());
    approveReview(f, item, revision);
    f.store.put('publicationApprovals', { id: 'sent-approval', contentId: item.id, status: 'approved' });
    f.store.put('publicationAttempts', { id: 'sent-attempt', approvalId: 'sent-approval', contentId: item.id, status: 'unknown', submissionMayHaveOccurred: true });
    f.content.invalidateContent(item.id, '资料已经纠正');
    assert.equal(f.store.get('publicationAttempts', 'sent-attempt').status, 'unknown');
    assert.equal(f.store.get('publicationAttempts', 'sent-attempt').submissionMayHaveOccurred, true);
    assert.equal(f.store.get('publicationAttempts', 'sent-attempt').dependencyWarning, '资料已经纠正');
    assert.equal(f.store.get('publicationApprovals', 'sent-approval').status, 'approved');
    assert.throws(() => f.content.abandon(item.id), /未决/);
    assert.equal(f.durable.budgetUsage(f.project.id, projectDay()).contentSlots, 1);
  } finally { f.close(); }
});

test('project material references and material tool replies receive fixed copies, while context separates verified metrics from unknown results', () => {
  const f = fixture();
  try {
    const asset = f.content.storeAsset(Buffer.from('用户原始调研资料'), { projectId: f.project.id, mime: 'text/plain', source: { kind: 'user_import' } });
    f.store.put('projectMaterials', { id: 'material-text', projectId: f.project.id, assetId: asset.id, name: '调研.txt',
      sha256: asset.sha256, revision: 1, mime: asset.mime, size: asset.size });
    f.store.put('publicationAttempts', { id: 'proven', projectId: f.project.id, contentId: 'old-content', status: 'published',
      verification: { matched: true, noteId: 'note-real' }, noteId: 'note-real' });
    f.store.put('publicationAttempts', { id: 'unproven', projectId: f.project.id, contentId: 'unknown-content', status: 'unknown', verification: { matched: false } });
    f.store.put('metricsSnapshots', { id: 'public-likes', projectId: f.project.id, publicationAttemptId: 'proven', name: 'likes', value: 3, source: 'public-note' });
    f.store.put('metricsSnapshots', { id: 'private-exposure', projectId: f.project.id, publicationAttemptId: 'proven', name: 'impressions', value: null, status: 'unavailable', reason: '后台未提供' });
    f.store.put('metricsSnapshots', { id: 'unproven-metric', projectId: f.project.id, publicationAttemptId: 'unproven', name: 'likes', value: 999 });
    const context = buildProjectContext(f.store, f.project.id);
    assert.equal(context.materials[0].id, 'material-text');
    assert.equal(context.materials[0].evidenceType, 'user_material', 'legacy user provenance comes from the registered import');
    f.store.put('projectMaterials', { id: 'agent-material', projectId: f.project.id, assetId: asset.id, name: '成员提交',
      evidenceType: 'agent_submission', submittedBy: 'writer', sha256: asset.sha256, revision: 1 });
    f.store.put('projectMaterials', { id: 'unknown-material', projectId: f.project.id, name: '来源未核实', revision: 1 });
    const labels = buildProjectContext(f.store, f.project.id).materials;
    assert.equal(labels.find(material => material.id === 'agent-material').evidenceType, 'agent_submission');
    assert.equal(labels.find(material => material.id === 'unknown-material').evidenceType, 'unverified_material');
    assert.equal(JSON.stringify(context).includes(asset.path), false);
    assert.equal(context.metrics.length, 2);
    assert.equal(context.metrics.find(metric => metric.name === 'impressions').value, null);
    assert.equal(context.publications[0].noteId, 'note-real');
    f.store.put('workItems', { id: 'use-material', projectId: f.project.id, generation: 1 });
    const attempt = f.content.prepareAttempt({ projectId: f.project.id, workItemId: 'use-material', generation: 1, attemptId: 'with-material',
      inputRefs: [{ kind: 'material', id: 'material-text', revision: 1, digest: asset.sha256 }],
      context: { toolResults: [{ assetId: asset.id, type: 'material', sha256: asset.sha256 }] } });
    assert.equal(attempt.inputs.filter(input => input.path.startsWith('inputs/materials/')).length, 1);
    const inputContext = JSON.parse(fs.readFileSync(path.join(attempt.workspace, 'inputs/context.json'), 'utf8'));
    assert.match(inputContext.toolResults[0].asset.path, /^inputs\/materials\//);
    assert.equal(fs.readFileSync(path.join(attempt.workspace, inputContext.toolResults[0].asset.path), 'utf8'), '用户原始调研资料');
  } finally { f.close(); }
});
