import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, routeHash } from '../ui/workbench/navigation/useWorkbenchRoute.ts';
import { contentGateSummary, contentState, emptyBusinessState, metricDisplay, metricValues, publicationGroup,
  revisionChanges, safeSourceUrl, unresolvedSubmission, workState } from '../ui/projects/businessState.ts';
import { createTaskDraftStore } from '../ui/taskDrafts.ts';
import { currentWorkReceipt, projectMessages, searchProject, workIsClosed, workNeedsAttention } from '../ui/projects/projectWorkspaceState.ts';

const item = { id: 'content-1', projectId: 'project-1', title: '下雨天徒步怎么准备', status: 'awaiting_approval', currentRevisionId: 'version-1', generation: 1, createdAt: '2026-11-11T01:00:00.000Z' };
const revision = { id: 'version-1', contentId: item.id, projectId: item.projectId, revision: 1, parentId: null,
  title: item.title, body: '先查天气，再确认路线。', tags: ['户外准备'], images: [{ sha256: 'one' }, { sha256: 'two' }],
  manifestHash: 'manifest-1', authorMemberIds: ['writer'], inputRefs: [], visibility: 'public', createdAt: item.createdAt };
const eligibility = { id: item.id, versionId: revision.id, revision: 1, status: 'eligible', checkIds: ['check-1'], reviewIds: ['review-1'] };
const check = { id: 'check-1', contentId: item.id, versionId: revision.id, manifestHash: revision.manifestHash, passed: true, status: 'passed' };
const review = { id: 'review-1', contentId: item.id, versionId: revision.id, manifestHash: revision.manifestHash, memberId: 'reviewer', verdict: 'approve', status: 'current' };

test('project and content links survive reload without altering existing task deep links', () => {
  assert.equal(parseHash('', '').view, 'projects');
  assert.equal(parseHash('', '?room=team').view, 'rooms');
  const hash = routeHash('projects', { projectId: 'project/图文', contentId: 'content/1' });
  const parsed = parseHash(hash, '');
  assert.equal(parsed.projectId, 'project/图文');
  assert.equal(parsed.contentId, 'content/1');
  assert.equal(parsed.view, 'projects');
  assert.deepEqual(parseHash(routeHash('rooms', { roomId: 'team', taskId: 'task-1' }), ''), {
    view: 'rooms', roomId: 'team', taskId: 'task-1', panel: null,
  });
  const pending = parseHash(routeHash('publications', { projectId: item.projectId, contentId: item.id }), '');
  assert.equal(pending.projectId, item.projectId);
  assert.equal(pending.contentId, item.id);
});

test('a possible submission remains in reconciliation even after login blocking or stale approval', () => {
  const state = emptyBusinessState();
  state.contentItems = [item]; state.contentEligibilities = [eligibility];
  state.approvals = [{ id: 'approval-1', contentId: item.id, versionId: revision.id, status: 'approved', createdAt: item.createdAt }];
  assert.equal(publicationGroup(state, item), 'queued');
  for (const status of ['blocked', 'cancelled', 'failed', 'login_required', 'unknown', 'verifying']) {
    state.attempts = [{ id: 'attempt-1', contentId: item.id, versionId: revision.id, status, submissionMayHaveOccurred: true, createdAt: item.createdAt }];
    assert.equal(unresolvedSubmission(state.attempts[0]), true, status);
    assert.equal(publicationGroup(state, item), 'unknown', status);
    assert.equal(contentState(state, item).label, '结果待核实', status);
  }
  state.attempts[0].status = 'sending';
  assert.equal(publicationGroup(state, item), 'sending');
  state.attempts[0].status = 'published';
  assert.equal(unresolvedSubmission(state.attempts[0]), false);
  assert.equal(publicationGroup(state, item), 'published');
});

test('an old approval cannot label a new version approved and legacy completion is not publication', () => {
  const state = emptyBusinessState();
  state.approvals = [{ id: 'old-approval', contentId: item.id, versionId: 'version-0', status: 'approved', createdAt: item.createdAt }];
  assert.notEqual(publicationGroup(state, item), 'queued');
  state.approvals = [];
  assert.notEqual(publicationGroup(state, { ...item, status: 'done' }), 'published');
  assert.equal(workState({ status: 'waiting_answer', waitReason: '等待视觉成员答复' }).label, '等待同伴答复');
});

test('machine checks, independent review and invalidated eligibility remain separate UI facts', () => {
  const passed = contentGateSummary(revision, eligibility, [check], [review]);
  assert.equal(passed.machinePassed, true); assert.equal(passed.reviewPassed, true);
  assert.equal(contentGateSummary(revision, eligibility, [], [review]).machinePassed, false);
  assert.equal(contentGateSummary(revision, eligibility, [check], [{ ...review, memberId: 'writer' }]).reviewPassed, false);
  assert.equal(contentGateSummary(revision, eligibility, [check], [{ ...review, status: 'unverified' }]).reviewPassed, false);
  assert.equal(contentGateSummary(revision, eligibility, [check], [{ ...review, versionId: 'version-old' }]).reviewPassed, false);
  assert.equal(contentGateSummary(revision, eligibility, [{ ...check, manifestHash: 'old-manifest' }], [review]).machinePassed, false);
  const stale = contentGateSummary(revision, { ...eligibility, status: 'invalid', reason: '资料已纠正' }, [check], [review]);
  assert.equal(stale.machinePassed, false); assert.equal(stale.reviewPassed, false);
  assert.equal(stale.machine.label, '检查已失效');
  assert.equal(stale.review.label, '审稿已失效');
  assert.equal(contentGateSummary(revision, { ...eligibility, reviewIds: ['missing'] }, [check], [review]).reviewPassed, false);
  assert.equal(contentGateSummary(revision, { ...eligibility, reviewIds: ['old', review.id], reviewId: review.id }, [check], [{ ...review, id: 'old', verdict: 'changes_requested' }, review]).reviewPassed, true);
});

test('metric absence is never rendered as zero and source links do not execute content', () => {
  assert.equal(metricDisplay({ name: 'likes', value: 0 }).value, '0');
  assert.equal(metricDisplay({ name: 'likes', value: null }).value, '未取得');
  assert.equal(metricDisplay({ name: 'impressions', value: 0, status: 'unavailable' }).missing, true);
  assert.equal(metricDisplay({ name: 'clickThroughRate', value: null }).label, '点击率');
  const values = metricValues({ noteId: 'note', metrics: { likes: 0, impressions: null }, source: 'platform' });
  assert.equal(values[0].value, 0); assert.equal(values[1].value, null);
  assert.equal(safeSourceUrl('javascript:alert(1)'), null);
  assert.equal(safeSourceUrl('file:///C:/private'), null);
  assert.equal(safeSourceUrl('https://example.com/source'), 'https://example.com/source');
});

test('version comparison detects image order and publication scope without mutating either revision', () => {
  const before = structuredClone(revision);
  const after = { ...revision, id: 'version-2', revision: 2, parentId: revision.id,
    images: [...revision.images].reverse(), visibility: 'private', schedule: { kind: 'scheduled', startsAt: '2026-11-12T01:00:00.000Z' } };
  const changes = revisionChanges(revision, after);
  assert.ok(changes.includes('图片内容或顺序已调整'));
  assert.ok(changes.includes('可见范围已调整'));
  assert.ok(changes.includes('发布时间已调整'));
  assert.deepEqual(revision, before);
});

test('project drafts are isolated by workspace and exact content version and cannot store approval', async () => {
  const sent = [];
  const draftStore = createTaskDraftStore(async (_url, options) => {
    const body = JSON.parse(options.body);
    sent.push(body);
    return { ok: true, status: 200, json: async () => ({ workspace: body.workspace, revision: body.revision === undefined ? 0 : body.revision + 1,
      draft: body.values ? { values: body.values, updatedAt: item.createdAt } : null }) };
  });
  const first = draftStore.open('D:/workspace', { kind: 'content-revision-request', contentId: item.id, versionId: revision.id }, { feedback: '', requestId: '' });
  const second = draftStore.open('D:/workspace', { kind: 'content-revision-request', contentId: item.id, versionId: 'version-2' }, { feedback: '', requestId: '' });
  await first.load(); await second.load();
  first.setField('feedback', '核对天气资料的发布日期'); await first.flush();
  assert.equal(second.getSnapshot().values.feedback, '');
  assert.equal(first.getSnapshot().values.feedback, '核对天气资料的发布日期');
  const writes = sent.length;
  first.setValues({ confirmed: 'true' }); await first.flush();
  assert.match(first.getSnapshot().error, /不能保存执行或验收授权/);
  assert.equal(sent.length, writes);
  assert.notEqual(draftStore.open('D:/other-workspace', { kind: 'content-revision-request', contentId: item.id, versionId: revision.id }), first);
  const projectDraft = draftStore.open('D:/workspace', { kind: 'project-brief', projectId: item.projectId });
  await projectDraft.load(); projectDraft.setValues({ objective: '持续图文运营', brief: '保留事实来源', expectedRevision: '3' });
  await draftStore.flushAll();
  assert.equal(projectDraft.getSnapshot().values.expectedRevision, '3');
});

test('runtime success cannot close a handoff and returned or failed work stays in view', () => {
  const work = { id: 'work-1', projectId: item.projectId, status: 'succeeded', generation: 2, objective: '交付整稿', createdAt: item.createdAt };
  assert.equal(workIsClosed(work), false);
  assert.equal(workState(work).label, '运行已结束，待验收');
  assert.equal(workIsClosed({ ...work, handoffStatus: 'received' }), false);
  assert.equal(workState({ ...work, handoffStatus: 'received' }).label, '成果已收取，待核对');
  assert.equal(workIsClosed({ ...work, handoffStatus: 'verified' }), true);
  assert.equal(workIsClosed({ ...work, handoffStatus: 'cancelled' }), true);
  const returned = { ...work, handoffStatus: 'returned', status: 'ready' };
  assert.equal(workIsClosed(returned), false);
  assert.equal(workNeedsAttention(returned), true);
  assert.equal(workNeedsAttention({ ...work, handoffStatus: 'verified', status: 'failed' }), true);
  assert.equal(workNeedsAttention({ ...work, dueAt: '2026-11-10T00:00:00.000Z' }, Date.parse(item.createdAt)), true);
});

test('receipt display requires exact project, generation and result digest', () => {
  const work = { id: 'work-1', projectId: item.projectId, generation: 2, resultDigest: 'current-result' };
  const receipt = { id: 'receipt-1', projectId: work.projectId, workItemId: work.id, generation: 2,
    resultDigest: 'current-result', createdAt: item.createdAt, evidenceType: 'machine' };
  assert.equal(currentWorkReceipt(work, [receipt]), receipt);
  for (const change of [{ projectId: 'other' }, { workItemId: 'other' }, { generation: 1 }, { resultDigest: 'old' }, { evidenceType: 'agent_claim' }]) {
    assert.equal(currentWorkReceipt(work, [{ ...receipt, ...change }]), null);
  }
  assert.equal(currentWorkReceipt({ ...work, resultDigest: undefined }, [receipt]), null);
  assert.equal(currentWorkReceipt({ ...work, currentReceiptId: 'different-receipt' }, [receipt]), null);
  assert.equal(currentWorkReceipt({ ...work, currentReceiptId: null }, [receipt]), null);
  assert.equal(currentWorkReceipt({ ...work, currentReceiptId: receipt.id }, [receipt]), receipt);
});

test('the project conversation preserves the original owner answer and does not substitute acceptance commentary', () => {
  const state = emptyBusinessState();
  state.collaborationThreads = [{ id: 'thread-1', projectId: item.projectId, kind: 'message', requesterId: 'user', recipientId: 'owner',
    workItemId: 'source-work', question: '请补充雨天出行准备', answer: '我会先核对路线关闭信息，再调整选题。',
    status: 'resolved', createdAt: item.createdAt, answeredAt: '2026-11-11T02:00:00.000Z' }];
  state.workItems = [{ id: 'accept-work', projectId: item.projectId, kind: 'accept', memberId: 'checker', summary: '本次运行的结构符合交付标准', status: 'succeeded' }];
  state.actions = [{ id: 'contribute-1', projectId: item.projectId, type: 'contribute', result: { threadId: 'thread-1' }, input: { message: '重复答复' }, createdAt: item.createdAt }];
  const messages = projectMessages(state, item.projectId);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].evidenceType, 'user_instruction');
  assert.equal(messages[1].actorId, 'owner');
  assert.equal(messages[1].body, state.collaborationThreads[0].answer);
  assert.equal(messages[1].evidenceType, 'agent_claim');
  assert.equal(messages.some(message => message.body.includes('结构符合')), false);
});

test('project search finds messages, handoffs and exact manuscript versions without crossing project scope', () => {
  const state = emptyBusinessState();
  state.contentItems = [item];
  state.contentRevisions = [revision, { ...revision, id: 'version-2', revision: 2, parentId: revision.id, title: '晴天登山', body: '换个选题', createdAt: '2026-11-11T03:00:00.000Z' }];
  state.workItems = [{ id: 'work-1', projectId: item.projectId, title: '调整文案', objective: '核对来源', generation: 2, createdAt: item.createdAt }];
  state.workHandoffs = [{ id: 'event-1', projectId: item.projectId, workItemId: 'work-1', generation: 2, message: '雨天路线资料已收取', createdAt: item.createdAt }];
  state.collaborationThreads = [{ id: 'thread-1', projectId: item.projectId, requesterId: 'user', question: '雨天准备要说清楚', createdAt: item.createdAt },
    { id: 'other-thread', projectId: 'another-project', requesterId: 'user', question: '雨天私有资料', createdAt: item.createdAt }];
  const results = searchProject(state, item.projectId, '雨天');
  assert.ok(results.some(result => result.id === 'work-work-1'));
  assert.ok(results.some(result => result.id === 'message-thread-1'));
  assert.ok(results.some(result => result.kind === 'content' && result.contentId === item.id && result.versionId === revision.id));
  assert.equal(results.some(result => result.id.includes('other-thread')), false);
  assert.deepEqual(searchProject(state, item.projectId, '   '), []);
  const route = parseHash(routeHash('projects', { projectId: item.projectId, contentId: item.id, versionId: revision.id, focusId: 'message-thread-1', panel: 'resources' }), '');
  assert.equal(route.versionId, revision.id);
  assert.equal(route.focusId, 'message-thread-1');
  assert.equal(route.panel, 'resources');
});
