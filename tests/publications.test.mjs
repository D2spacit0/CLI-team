import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { BusinessStore } from '../server/business-store.mjs';
import { PublicationService } from '../server/publications.mjs';

const testRoot = path.resolve('work/publication-tests');
fs.mkdirSync(testRoot, { recursive: true });
function fixture({ schedule = { kind: 'immediate' }, published = false } = {}) {
  const root = fs.mkdtempSync(path.join(testRoot, 'case-'));
  const store = new Store(path.join(root, 'state.sqlite'));
  const queue = new BusinessStore(store);
  let time = Date.parse('2026-11-11T03:00:00.000Z');
  const project = { id: 'project-publishing', status: 'active', reviewerId: 'reviewer', account: { id: 'account-123', name: '测试账号', platform: 'xiaohongshu', connectorVersion: 'test-1' } };
  const item = { id: 'content-a', projectId: project.id, status: 'awaiting_approval', currentRevisionId: 'version-1' };
  const revision = { id: 'version-1', contentId: item.id, projectId: project.id, title: '已审稿件', body: '完整正文', tags: ['记录'], visibility: 'public', schedule,
    images: [{ sha256: 'a'.repeat(64), path: path.join(root, 'image.png'), width: 1080, height: 1440, mime: 'image/png' }],
    manifestHash: 'b'.repeat(64), authorMemberIds: ['author'], inputRefs: [] };
  const eligibility = { id: item.id, contentId: item.id, versionId: revision.id, revision: 1, status: 'eligible', valid: true,
    checkIds: ['check-1'], reviewIds: ['review-1'], reviewId: 'review-1', inputRefs: [] };
  const check = { id: 'check-1', versionId: revision.id, contentId: item.id, status: 'passed', passed: true, manifestHash: revision.manifestHash };
  const review = { id: 'review-1', versionId: revision.id, contentId: item.id, status: 'current', verdict: 'approve', memberId: 'reviewer',
    sourceRunId: 'run-review', manifestHash: revision.manifestHash };
  const run = { id: 'run-review', workItemId: 'work-review', projectId: project.id, memberId: 'reviewer', workflowKind: 'business', status: 'succeeded', executionSucceeded: true, generation: 1, attemptId: 'review-attempt-1' };
  const work = { id: 'work-review', kind: 'review', projectId: project.id, generation: 1, currentAttemptId: 'review-attempt-1' };
  for (const [kind, value] of [['projects', project], ['contentItems', item], ['contentRevisions', revision], ['contentEligibilities', eligibility],
    ['contentChecks', check], ['reviews', review], ['runs', run], ['workItems', work]]) store.put(kind, value);
  queue.reserveContentSlot({ projectId: project.id, contentId: item.id });
  const state = { version: 'test-1', status: 'ready', account: project.account, capabilities: { publish: true, read: true } };
  const calls = { publish: 0, verify: 0 };
  const makeEvidence = attempt => ({
    creation: { noteId: '0123456789abcdef01234567', accountId: attempt.account.id },
    uploads: attempt.payload.images.map((image, index) => ({ index, sha256: image.sha256, platformImageId: `image-${index}` })),
    readback: { noteId: '0123456789abcdef01234567', accountId: attempt.account.id, title: attempt.payload.title, body: attempt.payload.body,
      tags: attempt.payload.tags, imageIds: attempt.payload.images.map((_image, index) => `image-${index}`),
      source: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567', collectedAt: new Date(time).toISOString() },
  });
  const connector = { version: 'test-1', status: () => structuredClone(state), probe: async () => structuredClone(state),
    publish: async attempt => { calls.publish++; return { call: { completed: true }, evidence: published ? makeEvidence(attempt) : { success: true } }; },
    verify: async attempt => { calls.verify++; return { connection: state, evidence: published ? makeEvidence(attempt) : attempt.evidence,
      blocked: state.status !== 'ready', reason: state.status !== 'ready' ? '登录失效，等待回读' : '未取得完整平台证据' }; }, close: async () => {} };
  const options = { store, root, connector, now: () => time,
    resolveSnapshot: (_contentId, versionId) => ({ item: store.get('contentItems', item.id), project: store.get('projects', project.id),
      revision: store.get('contentRevisions', versionId || revision.id), eligibility: store.get('contentEligibilities', item.id),
      checks: store.list('contentChecks'), reviews: store.list('reviews') }),
    inspectRevision: () => ({ passed: true, manifestHash: revision.manifestHash }) };
  const service = new PublicationService(options);
  const session = service.createDesktopApprovalSession({ workspace: root, desktopSession: 'desktop-human-session-123' });
  const begin = () => session.begin({ contentId: item.id, versionId: revision.id, expectedDigest: service.preview(item.id, revision.id).approvalDigest });
  const approve = () => session.confirm(begin().nonce);
  return { root, store, queue, project, item, revision, eligibility, service, options, session, begin, approve, connector, calls, state,
    setTime: next => { time = next; }, advance: amount => { time += amount; },
    async close() { await service.close(); store.close(); const resolved = fs.realpathSync(root); if (!resolved.startsWith(fs.realpathSync(testRoot) + path.sep)) throw new Error('Invalid cleanup'); fs.rmSync(resolved, { recursive: true }); } };
}

test('native challenge binds preview, source review, session and expiry without accepting caller actor', async () => {
  const f = fixture();
  try {
    assert.equal(f.service.preview(f.item.id).canApprove, true);
    assert.throws(() => f.session.begin({ contentId: f.item.id, versionId: f.revision.id, expectedDigest: '0'.repeat(64), actor: 'user' }));
    const cancelled = f.begin(); f.session.cancel(cancelled.nonce);
    assert.throws(() => f.session.confirm(cancelled.nonce), /超时|变化/);
    assert.equal(f.store.list('publicationApprovals').length, 0);
    const navigated = f.begin(); f.session.invalidate();
    assert.throws(() => f.session.confirm(navigated.nonce), /超时|变化/);
    const expired = f.begin(); f.advance(120001);
    assert.throws(() => f.session.confirm(expired.nonce), /超时/);
    const edited = f.begin(); f.store.update('contentEligibilities', f.item.id, { revision: 2 });
    assert.throws(() => f.session.confirm(edited.nonce), /改变/);
    f.store.update('reviews', 'review-1', { sourceRunId: null });
    assert.equal(f.service.preview(f.item.id).canApprove, false);
    assert.equal(f.store.list('publicationApprovals').length, 0);
  } finally { await f.close(); }
});

test('concurrent approvals and parent retries create one durable approval and send job', async () => {
  const f = fixture();
  try {
    const a = f.begin(), b = f.begin();
    const first = f.session.confirm(a.nonce);
    assert.deepEqual(f.session.confirm(a.nonce), first);
    assert.equal(f.session.confirm(b.nonce).approvalId, first.approvalId);
    assert.equal(f.store.list('publicationApprovals').length, 1);
    assert.equal(f.queue.listJobs({ kind: 'publication.send' }).length, 1);
    const saved = JSON.stringify(f.store.list('publicationApprovals'));
    assert.equal(saved.includes(a.nonce), false);
    assert.equal(saved.includes('desktop-human-session-123'), false);
    assert.equal(f.store.list('publicationApprovals')[0].actor.channel, 'desktop-native-dialog');
  } finally { await f.close(); }
});

test('publication crash after sending persists ambiguity, survives recovery, and never replays submit', async () => {
  const f = fixture();
  let restarted;
  try {
    f.approve();
    const job = f.queue.listJobs({ kind: 'publication.send' })[0];
    const attempt = f.service.beginSending(job);
    assert.equal(attempt.submissionMayHaveOccurred, true);
    restarted = new PublicationService(f.options);
    restarted.recover();
    await restarted.tick();
    assert.equal(f.calls.publish, 0);
    assert.equal(f.store.get('publicationAttempts', attempt.id).status, 'unknown');
    assert.equal(f.queue.budgetUsage(f.project.id, '2026-11-11').contentSlots, 1);
    assert.equal(f.service.revoke(attempt.approvalId).revoked, false);
    f.state.status = 'login_required';
    await restarted.verify(attempt.id);
    assert.equal(f.store.get('publicationAttempts', attempt.id).submissionMayHaveOccurred, true);
    f.state.status = 'ready'; f.advance(60001); await restarted.tick();
    assert.equal(f.calls.publish, 0);
    assert.throws(() => f.approve(), /可能已经提交/);
  } finally { await restarted?.close(); await f.close(); }
});

test('a successful connector call without platform identity and asset mappings remains unknown', async () => {
  const f = fixture();
  try {
    f.approve(); await f.service.tick();
    assert.equal(f.calls.publish, 1);
    assert.equal(f.store.list('publicationAttempts')[0].status, 'unknown');
    await f.service.tick();
    assert.equal(f.calls.publish, 1);
    assert.equal(f.queue.budgetUsage(f.project.id, '2026-11-11').contentSlots, 1);
  } finally { await f.close(); }
});

test('only exact verified publication releases the content slot and cannot be republished', async () => {
  const f = fixture({ published: true });
  try {
    f.approve(); await f.service.tick();
    const attempt = f.store.list('publicationAttempts')[0];
    assert.equal(attempt.status, 'published');
    assert.equal(attempt.verification.matched, true);
    assert.equal(f.queue.budgetUsage(f.project.id, '2026-11-11').contentSlots, 0);
    await f.service.tick(); assert.equal(f.calls.publish, 1);
    assert.equal(f.service.preview(f.item.id).canApprove, false);
  } finally { await f.close(); }
});

test('upstream invalidation, pause and expired local windows all stop queue dispatch', async () => {
  const f = fixture();
  try {
    const approval = f.approve();
    f.store.update('projects', f.project.id, { status: 'paused' });
    await f.service.tick(); assert.equal(f.calls.publish, 0);
    f.store.update('projects', f.project.id, { status: 'active' });
    f.store.update('contentEligibilities', f.item.id, { revision: 2, status: 'invalid', valid: false, reason: '来源事实已经纠正' });
    await f.service.tick(); assert.equal(f.calls.publish, 0);
    assert.equal(f.store.get('publicationApprovals', approval.approvalId).status, 'blocked');
  } finally { await f.close(); }
  const scheduled = fixture({ schedule: { kind: 'scheduled', startsAt: '2026-11-11T03:30:00.000Z' } });
  try {
    const approval = scheduled.approve();
    await scheduled.service.tick(); assert.equal(scheduled.calls.publish, 0);
    scheduled.advance(40 * 60000 + 1); await scheduled.service.tick();
    assert.equal(scheduled.calls.publish, 0);
    assert.equal(scheduled.store.get('publicationApprovals', approval.approvalId).status, 'expired');
  } finally { await scheduled.close(); }
});
