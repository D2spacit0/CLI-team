import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyBusinessState } from '../ui/projects/businessState.ts';
import { projectDailyStatus, projectWorkIssue } from '../ui/projects/projectDailyStatus.ts';

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
    [{ handoffStatus: undefined }, /交接记录待确认/],
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
  assert.equal(paused.title, '工作区已暂停新派工');
  assert.match(paused.detail, /不代表全部运行已结束/);
  assert.deepEqual(paused.action, { kind: 'settings', section: 'runtime', label: '查看运行设置' });
  state.workItems = [];
  const projectPaused = summarize(state, { project: { ...project, status: 'paused' } });
  assert.equal(projectPaused.title, '项目已暂停新工作');
  assert.match(projectPaused.detail, /继续项目/);
  assert.equal(projectPaused.action, undefined);
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
  assert.deepEqual({ project, state, bootstrap }, before);
});
