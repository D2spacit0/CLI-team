import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyBusinessState } from '../ui/projects/businessState.ts';
import { projectDailyStatus, projectDailySummary, projectWorkIssue } from '../ui/projects/projectDailyStatus.ts';

const now = Date.parse('2026-11-12T08:00:00.000Z');
const createdAt = '2026-11-12T07:00:00.000Z';
const project = { id: 'project-a', name: '图文项目', objective: '说明雨天出行准备', status: 'active',
  ownerId: 'owner', reviewerId: 'reviewer', memberIds: ['owner', 'reviewer'], account: null, createdAt };
const bootstrap = { workspace: { paused: false }, runs: [], members: [
  { id: 'owner', name: '负责人', provider: 'custom', role: 'builder', enabled: true, executable: 'node', permission: 'edit' },
  { id: 'reviewer', name: '独立审稿', provider: 'custom', role: 'reviewer', enabled: true, executable: 'node', permission: 'plan' },
] };
const baseWork = { id: 'work-a', projectId: project.id, memberId: 'owner', kind: 'research', title: '核对出行资料',
  objective: '核对资料并保留出处', status: 'ready', handoffStatus: 'assigned', generation: 1, createdAt };
const summarize = (state, options = {}) => projectDailyStatus(options.project || project, state,
  options.bootstrap || bootstrap, options.unavailable || false, now);
const summarizeAll = (state, options = {}) => projectDailySummary(options.project || project, state,
  options.bootstrap || bootstrap, options.unavailable || false, now);

function addReviewedContent(state, id, approved = false) {
  const content = { id, projectId: project.id, title: `完整标题：${id} 的雨天出行准备`, status: 'awaiting_approval', currentRevisionId: `version-${id}`, createdAt };
  const revision = { id: content.currentRevisionId, contentId: id, projectId: project.id, revision: 1,
    title: content.title, manifestHash: `manifest-${id}`, authorMemberIds: ['owner'] };
  state.projects = [project];
  state.contentItems.push(content);
  state.contentRevisions.push(revision);
  state.contentChecks.push({ id: `check-${id}`, contentId: id, versionId: revision.id, manifestHash: revision.manifestHash,
    evidenceType: 'machine', status: 'passed', passed: true });
  state.reviews.push({ id: `review-${id}`, contentId: id, versionId: revision.id, manifestHash: revision.manifestHash,
    evidenceType: 'agent_review', status: 'current', verdict: 'approve', memberId: 'reviewer', sourceRunId: `run-${id}` });
  state.contentEligibilities.push({ id, contentId: id, versionId: revision.id, revision: 1, status: 'eligible', valid: true,
    checkIds: [`check-${id}`], reviewIds: [`review-${id}`], reviewId: `review-${id}` });
  if (approved) state.approvals.push({ id: `approval-${id}`, contentId: id, versionId: revision.id,
    approvalDigest: `digest-${id}`, status: 'approved', createdAt });
  return content;
}

test('enabled projects do not imply work has started and closed work does not imply publication', () => {
  const state = emptyBusinessState();
  assert.equal(summarize(state).kind, 'idle');
  assert.match(summarize(state).title, /尚未开始执行/);
  state.workItems = [{ ...baseWork, status: 'succeeded', handoffStatus: 'verified' }];
  assert.equal(summarize(state).title, '当前没有未完工作');
  assert.doesNotMatch(summarize(state).title, /发布|正在/);
});

test('running and all waiting states retain their actual meanings despite accepted handoffs', () => {
  const states = new Map([
    ['running', /正在进行资料调研/], ['queued', /等待执行名额/], ['ready', /等待执行/],
    ['pending', /等待安排/], ['proposed', /待负责人采纳/], ['waiting', /等待前序成果/],
    ['waiting_dependencies', /等待前序成果/], ['waiting_answer', /等待同伴答复/],
    ['waiting_tool', /等待工具结果/], ['succeeded', /运行已结束，等待验收/],
  ]);
  for (const [status, expected] of states) {
    const state = emptyBusinessState();
    state.workItems = [{ ...baseWork, status, handoffStatus: 'accepted' }];
    const result = summarize(state);
    assert.match(result.title, expected, status);
    assert.equal(result.kind, status === 'running' ? 'running' : 'waiting', status);
    assert.equal(result.action.id, 'work-work-a', status);
    assert.deepEqual(summarizeAll(state), { primary: result, secondary: [] }, status);
  }
});

test('runtime success remains unaccepted until its handoff is verified', () => {
  const state = emptyBusinessState();
  state.workItems = [{ ...baseWork, status: 'succeeded', handoffStatus: 'received' }];
  assert.equal(summarize(state).title, '成果已收取，等待核对');
  state.workItems[0].handoffStatus = 'verified';
  assert.equal(summarize(state).kind, 'idle');
});

test('failed, returned, overdue and unfamiliar work stay visible beside healthy running work', () => {
  const cases = [
    [{ status: 'failed', handoffStatus: 'verified', error: '执行程序失败' }, /执行失败/],
    [{ status: 'interrupted' }, /运行已中断/],
    [{ status: 'ready', handoffStatus: 'returned' }, /已退回修改/],
    [{ dueAt: '2026-11-12T07:59:00.000Z' }, /已超过预计交付时间/],
    [{ status: 'unrecognized' }, /工作状态待核对/],
    [{ handoffStatus: undefined }, /工作记录待确认/],
  ];
  for (const [change, expected] of cases) {
    const state = emptyBusinessState();
    state.workItems = [{ ...baseWork, ...change }, { ...baseWork, id: 'healthy', status: 'running', handoffStatus: 'accepted' }];
    const result = summarize(state);
    assert.equal(result.kind, 'blocked');
    assert.match(result.detail, expected);
    assert.equal(result.action.id, 'work-work-a');
  }
});

test('closed or cancelled work does not become overdue attention', () => {
  for (const handoffStatus of ['verified', 'cancelled']) {
    assert.equal(projectWorkIssue({ ...baseWork, status: 'succeeded', handoffStatus,
      dueAt: '2026-11-11T00:00:00.000Z' }, now), null);
  }
});

test('pausing scheduling neither says all execution stopped nor auto-resumes it', () => {
  const state = emptyBusinessState();
  state.workItems = [{ ...baseWork, status: 'running', handoffStatus: 'accepted' }];
  const paused = summarize(state, { bootstrap: { ...bootstrap, workspace: { paused: true } } });
  assert.equal(paused.title, '工作区已暂停新工作');
  assert.match(paused.detail, /暂停不代表它们已经结束/);
  assert.deepEqual(paused.action, { kind: 'settings', section: 'runtime', label: '查看暂停设置' });
  state.workItems = [];
  const projectPaused = summarize(state, { project: { ...project, status: 'paused' } });
  assert.equal(projectPaused.title, '项目已暂停新工作');
  assert.match(projectPaused.detail, /继续项目/);
  assert.deepEqual(projectPaused.action, { kind: 'project', label: '继续项目' });
  const bothPaused = summarize(state, { project: { ...project, status: 'paused' }, bootstrap: { ...bootstrap, workspace: { paused: true } } });
  assert.deepEqual(bothPaused.action, { kind: 'settings', section: 'runtime', label: '查看暂停设置' });
});

test('a paused project has one primary action while failures and reviewable content remain available', () => {
  const state = emptyBusinessState();
  const content = addReviewedContent(state, 'reviewable');
  state.workItems = [{ ...baseWork, status: 'failed', error: '运行程序退出失败' },
    { ...baseWork, id: 'returned', handoffStatus: 'returned' },
    { ...baseWork, id: 'healthy', status: 'running', handoffStatus: 'accepted' }];
  const options = { bootstrap: { ...bootstrap, workspace: { paused: true } } };
  const result = summarizeAll(state, options);
  assert.equal(result.primary.kind, 'paused');
  assert.deepEqual(result.secondary.map(status => status.kind), ['blocked', 'awaiting']);
  assert.equal(result.secondary[0].title, '2 项工作需要处理');
  assert.equal(result.secondary[0].tone, 'danger');
  assert.equal(result.secondary[0].action.id, 'work-work-a');
  assert.equal(result.secondary[1].action.id, content.id);
  assert.equal(result.secondary[1].action.versionId, content.currentRevisionId);
  assert.deepEqual(summarize(state, options), result.primary);
  assert.ok([result.primary, ...result.secondary].every(status => !status.detail.includes(content.title)));
});

test('all exceptional categories use one priority order and omit routine running or waiting work', () => {
  const state = emptyBusinessState();
  addReviewedContent(state, 'reviewable');
  addReviewedContent(state, 'scheduled', true);
  state.contentItems.push({ id: 'unknown', projectId: project.id, currentRevisionId: 'unknown-newer', createdAt },
    { id: 'sending', projectId: project.id, currentRevisionId: 'sending-newer', createdAt });
  state.attempts = [{ id: 'unknown-attempt', contentId: 'unknown', versionId: 'unknown-frozen', status: 'unknown', submissionMayHaveOccurred: true, createdAt },
    { id: 'sending-attempt', contentId: 'sending', versionId: 'sending-frozen', status: 'sending', submissionMayHaveOccurred: true, createdAt },
    { id: 'later-failure', contentId: 'sending', versionId: 'sending-newer', status: 'failed', submissionMayHaveOccurred: false, createdAt: '2026-11-12T07:30:00.000Z' }];
  state.workItems = [{ ...baseWork, status: 'failed' },
    { ...baseWork, id: 'running', status: 'running', handoffStatus: 'accepted' },
    { ...baseWork, id: 'waiting', status: 'queued', handoffStatus: 'accepted' }];
  const options = { bootstrap: { ...bootstrap, workspace: { paused: true }, members: bootstrap.members.filter(member => member.id !== 'reviewer') } };
  const result = summarizeAll(state, options);
  assert.deepEqual([result.primary, ...result.secondary].map(status => status.kind), ['unknown', 'sending', 'paused', 'team', 'blocked', 'awaiting', 'queued']);
  assert.equal(result.primary.action.versionId, 'unknown-frozen');
  assert.equal(result.secondary[0].action.versionId, 'sending-frozen');
  state.attempts = state.attempts.filter(attempt => attempt.contentId !== 'unknown');
  assert.equal(summarizeAll(state, options).primary.kind, 'sending');
  state.attempts = [];
  assert.equal(summarizeAll(state, options).primary.kind, 'paused');
  options.bootstrap.workspace.paused = false;
  assert.equal(summarizeAll(state, options).primary.kind, 'team');
  options.bootstrap.members = bootstrap.members;
  assert.equal(summarizeAll(state, options).primary.kind, 'blocked');
  state.workItems = state.workItems.filter(work => work.status !== 'failed');
  assert.equal(summarizeAll(state, options).primary.kind, 'awaiting');
  state.contentItems = state.contentItems.filter(content => content.id !== 'reviewable');
  assert.equal(summarizeAll(state, options).primary.kind, 'queued');
  state.contentItems = [];
  assert.deepEqual(summarizeAll(state, options).secondary, []);
  assert.equal(summarizeAll(state, options).primary.kind, 'running');
});

test('archive suppresses inactive project actions without hiding unresolved or sending publications', () => {
  const state = emptyBusinessState();
  addReviewedContent(state, 'reviewable');
  state.workItems = [{ ...baseWork, status: 'failed' }];
  const options = { project: { ...project, status: 'archived' }, bootstrap: { ...bootstrap, workspace: { paused: true }, members: [] } };
  assert.deepEqual(summarizeAll(state, options), { primary: { kind: 'archived', title: '项目已归档', detail: '历史对话和稿件仍可查看。', tone: 'neutral' }, secondary: [] });
  state.contentItems.push({ id: 'unknown', projectId: project.id, currentRevisionId: 'newer', createdAt },
    { id: 'sending', projectId: project.id, currentRevisionId: 'newer-sending', createdAt });
  state.attempts = [{ id: 'unknown-attempt', contentId: 'unknown', versionId: 'frozen', status: 'unknown', submissionMayHaveOccurred: true, createdAt },
    { id: 'sending-attempt', contentId: 'sending', versionId: 'frozen-sending', status: 'sending', submissionMayHaveOccurred: true, createdAt }];
  const result = summarizeAll(state, options);
  assert.equal(result.primary.kind, 'unknown');
  assert.equal(result.primary.action.versionId, 'frozen');
  assert.deepEqual(result.secondary.map(status => status.kind), ['sending']);
  assert.equal(result.secondary[0].action.versionId, 'frozen-sending');
  const unavailable = summarizeAll(state, { ...options, unavailable: true });
  assert.equal(unavailable.primary.kind, 'unavailable');
  assert.equal(unavailable.primary.action, undefined);
  assert.deepEqual(unavailable.secondary, []);
});

test('project reasons remain visible with aggregated failed work even when paused', () => {
  const state = emptyBusinessState();
  state.workItems = [{ ...baseWork, status: 'failed', error: '工具执行失败' }];
  const options = { project: { ...project, status: 'paused', waitReason: '缺少所需资料', blockers: ['缺少所需资料', '运行额度已用完'] } };
  const result = summarizeAll(state, options);
  assert.equal(result.primary.kind, 'paused');
  assert.deepEqual(result.secondary.map(status => status.kind), ['blocked']);
  assert.match(result.secondary[0].detail, /工具执行失败/);
  assert.match(result.secondary[0].detail, /缺少所需资料；运行额度已用完/);
  state.workItems = [];
  assert.deepEqual(summarizeAll(state, options).secondary[0].action, { kind: 'settings', section: 'runtime', label: '查看项目条件' });
});

test('reviewable summaries still require exact machine evidence and independent review', () => {
  for (const change of [
    state => { state.contentChecks = []; },
    state => { state.contentChecks[0].evidenceType = 'agent_claim'; },
    state => { state.reviews[0].memberId = 'owner'; },
    state => { state.reviews[0].status = 'unverified'; },
    state => { state.contentEligibilities[0].valid = false; },
    state => { state.contentEligibilities[0].versionId = 'old-version'; },
  ]) {
    const state = emptyBusinessState();
    addReviewedContent(state, 'reviewable');
    change(state);
    const result = summarizeAll(state, { bootstrap: { ...bootstrap, workspace: { paused: true } } });
    assert.equal(result.primary.kind, 'paused');
    assert.equal(result.secondary.some(status => status.kind === 'awaiting'), false);
  }
});

test('uncertain publication takes precedence and opens its frozen version rather than a newer draft', () => {
  const state = emptyBusinessState();
  state.contentItems = [{ id: 'content-a', projectId: project.id, currentRevisionId: 'newer-version', createdAt }];
  state.attempts = [{ id: 'attempt-a', contentId: 'content-a', versionId: 'submitted-version',
    status: 'login_required', submissionMayHaveOccurred: true, createdAt }];
  state.workItems = [{ ...baseWork, status: 'failed' }];
  const result = summarize(state, { bootstrap: { ...bootstrap, workspace: { paused: true } } });
  assert.equal(result.kind, 'unknown');
  assert.deepEqual(result.action, { kind: 'content', id: 'content-a', versionId: 'submitted-version', label: '核实发布结果' });
});

test('a later failed request cannot redirect reconciliation to a different manuscript version', () => {
  const state = emptyBusinessState();
  state.contentItems = [{ id: 'content-a', projectId: project.id, currentRevisionId: 'newer-version', createdAt }];
  state.attempts = [{ id: 'submitted-attempt', contentId: 'content-a', versionId: 'submitted-version',
    status: 'unknown', submissionMayHaveOccurred: true, createdAt },
  { id: 'later-failed-attempt', contentId: 'content-a', versionId: 'newer-version', status: 'failed',
    submissionMayHaveOccurred: false, createdAt: '2026-11-12T07:30:00.000Z' }];
  const result = summarize(state);
  assert.equal(result.kind, 'unknown');
  assert.deepEqual(result.action, { kind: 'content', id: 'content-a', versionId: 'submitted-version', label: '核实发布结果' });
});

test('unavailable data never turns a retained snapshot into a current success or idle state', () => {
  const state = emptyBusinessState();
  state.workItems = [{ ...baseWork, status: 'running' }];
  const result = summarize(state, { unavailable: true });
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.action, undefined);
  assert.match(result.title, /暂时无法确认/);
  assert.deepEqual(summarizeAll(state, { unavailable: true }).secondary, []);
});

test('team setup is a specific next action while no unrelated members are selected', () => {
  const state = emptyBusinessState();
  const result = summarize(state, { bootstrap: { ...bootstrap, members: bootstrap.members.filter(member => member.id !== 'reviewer') } });
  assert.equal(result.kind, 'team');
  assert.equal(result.action.section, 'team');
  assert.match(result.detail, /独立审稿成员不可用/);
});

test('another project cannot change the current project status and inputs remain untouched', () => {
  const state = emptyBusinessState();
  state.workItems = [{ ...baseWork, projectId: 'project-b', status: 'failed' }];
  state.contentItems = [{ id: 'content-b', projectId: 'project-b', currentRevisionId: 'b', createdAt }];
  state.attempts = [{ contentId: 'content-b', versionId: 'b', status: 'unknown', submissionMayHaveOccurred: true, createdAt }];
  const before = structuredClone({ project, state, bootstrap });
  assert.equal(summarize(state).kind, 'idle');
  assert.equal(summarizeAll(state).primary.kind, 'idle');
  assert.deepEqual(summarizeAll(state).secondary, []);
  assert.deepEqual({ project, state, bootstrap }, before);
});
