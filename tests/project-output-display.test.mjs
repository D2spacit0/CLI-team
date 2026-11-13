import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyBusinessState } from '../ui/projects/businessState.ts';
import { currentProjectOutput, projectOutputDisplay } from '../ui/projects/projectOutputDisplay.ts';

const createdAt = '2026-11-13T01:00:00.000Z';
const laterAt = '2026-11-13T02:00:00.000Z';
const latestAt = '2026-11-13T03:00:00.000Z';

function fixture() {
  const item = { id: 'content-a', projectId: 'project-a', title: '当前新稿标题', status: 'ready',
    currentRevisionId: 'version-new', generation: 2, createdAt };
  const old = { id: 'version-submitted', contentId: item.id, projectId: item.projectId, revision: 1,
    title: '实际提交时的标题', body: '这一段正文属于已提交、仍待核实的版本。', tags: [],
    images: [{ sha256: 'submitted-cover' }], manifestHash: 'submitted-manifest', authorMemberIds: ['owner'], createdAt };
  const current = { ...old, id: item.currentRevisionId, revision: 2, title: item.title,
    body: '这是一份后续新草稿，不能当成已提交的正文。', images: [{ sha256: 'new-cover' }], createdAt: laterAt };
  const attempt = { id: 'attempt-submitted', contentId: item.id, projectId: item.projectId, versionId: old.id,
    status: 'unknown', submissionMayHaveOccurred: true, createdAt };
  const state = { ...emptyBusinessState(), projects: [{ id: item.projectId, status: 'active', reviewerId: 'reviewer' }],
    contentItems: [item], contentRevisions: [old, current], attempts: [attempt] };
  return { state, item, old, current, attempt };
}

test('an unknown submission keeps its original text and cover after a newer draft and failed retry', () => {
  const { state, item, old, current, attempt } = fixture();
  state.attempts.push({ ...attempt, id: 'later-failure', versionId: current.id, status: 'failed',
    submissionMayHaveOccurred: false, createdAt: latestAt });
  const output = projectOutputDisplay(state, item);
  assert.equal(output.frozen, true);
  assert.equal(output.versionId, old.id);
  assert.equal(output.title, old.title);
  assert.equal(output.body, old.body);
  assert.deepEqual(output.revision.images, old.images);
});

test('a sending attempt determines the displayed version even with another unresolved attempt', () => {
  const { state, item, old, current, attempt } = fixture();
  state.attempts = [
    { ...attempt, status: 'sending', submissionMayHaveOccurred: false },
    { ...attempt, id: 'later-unknown', versionId: current.id, createdAt: laterAt },
  ];
  const output = projectOutputDisplay(state, item);
  assert.equal(output.frozen, true);
  assert.equal(output.versionId, old.id);
  assert.equal(output.revision.id, old.id);
  assert.equal(output.body, old.body);
});

test('a missing or mismatched frozen revision cannot borrow a new draft or another project manuscript', () => {
  for (const replacement of [null, { projectId: 'another-project' }, { contentId: 'another-content' }]) {
    const { state, item, old, current } = fixture();
    state.contentRevisions = [current, ...(replacement ? [{ ...old, ...replacement }] : [])];
    const output = projectOutputDisplay(state, item);
    assert.equal(output.frozen, true);
    assert.equal(output.versionId, old.id, 'the open-content action must still receive the submitted version id');
    assert.equal(output.revision, null);
    assert.notEqual(output.title, current.title);
    assert.notEqual(output.body, current.body);
    assert.match(output.body, /尚未读取/);
  }
});

test('a newer resolution of the same attempt removes the stale submission freeze', () => {
  const { state, item, current, attempt } = fixture();
  state.attempts = [attempt, { ...attempt, status: 'published', updatedAt: latestAt }];
  const output = projectOutputDisplay(state, item);
  assert.equal(output.frozen, false);
  assert.equal(output.versionId, current.id);
  assert.equal(output.body, current.body);
});

test('an explicitly selected manuscript from this project takes precedence over its default result', () => {
  const { state, item, current } = fixture();
  const selected = { ...item, id: 'selected-content', title: '用户选择的另一篇稿件', currentRevisionId: 'selected-version' };
  state.contentItems.push(selected);
  state.contentRevisions.push({ ...current, id: selected.currentRevisionId, contentId: selected.id, title: selected.title });
  const output = currentProjectOutput(state, item.projectId, selected.id);
  assert.equal(output.item.id, selected.id);
  assert.equal(output.versionId, selected.currentRevisionId);
  assert.equal(output.title, selected.title);
  assert.equal(output.frozen, false);
});

test('foreign and removed selections fall back within the current project without leaking content', () => {
  const { state, item, current } = fixture();
  const foreign = { ...item, id: 'foreign-content', projectId: 'project-b', title: '另一个项目的资料', currentRevisionId: 'foreign-version' };
  state.contentItems.unshift(foreign);
  state.contentRevisions.push({ ...current, id: foreign.currentRevisionId, contentId: foreign.id, projectId: foreign.projectId, title: foreign.title });
  for (const selectedId of [foreign.id, 'removed-content']) {
    const output = currentProjectOutput(state, item.projectId, selectedId);
    assert.equal(output.item.id, item.id);
    assert.equal(output.item.projectId, item.projectId);
    assert.notEqual(output.title, foreign.title);
  }
  assert.equal(currentProjectOutput(state, 'nonexistent-project', item.id), null);
});

test('the default shows the unresolved manuscript before newer ordinary work without mutating the snapshot', () => {
  const { state, item, current } = fixture();
  const newer = { ...item, id: 'newer-content', currentRevisionId: 'newer-version', updatedAt: latestAt };
  state.contentItems.unshift(newer);
  state.contentRevisions.push({ ...current, id: newer.currentRevisionId, contentId: newer.id, createdAt: latestAt });
  const before = structuredClone(state);
  assert.equal(currentProjectOutput(state, item.projectId).item.id, item.id);
  assert.deepEqual(state, before, 'choosing a featured result cannot reorder or rewrite service records');
  state.attempts = [];
  assert.equal(currentProjectOutput(state, item.projectId).item.id, newer.id);
});

test('empty projects and unversioned manuscripts never display an arbitrary stored revision', () => {
  assert.equal(currentProjectOutput(emptyBusinessState(), 'project-a'), null);
  const { state, item, old } = fixture();
  state.attempts = [];
  item.currentRevisionId = null;
  item.currentDraftVersionId = old.id;
  assert.equal(currentProjectOutput(state, item.projectId).versionId, old.id);
  item.currentDraftVersionId = null;
  const output = currentProjectOutput(state, item.projectId);
  assert.equal(output.versionId, null);
  assert.equal(output.revision, null);
  assert.equal(output.frozen, false);
  assert.match(output.body, /尚未形成/);
});
