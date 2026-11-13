import test from 'node:test';
import assert from 'node:assert/strict';
import { businessReturnHash, parseHash, routeHash } from '../ui/workbench/navigation/useWorkbenchRoute.ts';
import { missingProjectRoles, projectTeamDefaults } from '../ui/projects/projectTeamDefaults.ts';

test('settings and member configuration preserve the selected project and the original fixed manuscript through a reload', () => {
  const origin = routeHash('projects', { projectId: 'project-B', contentId: 'content-B', versionId: 'version/2', focusId: 'message-1', panel: 'content' });
  const settings = parseHash(routeHash('settings', { projectId: 'project-B', panel: 'account', returnTo: origin }), '');
  assert.equal(settings.projectId, 'project-B');
  assert.equal(settings.panel, 'account');
  const members = parseHash(routeHash('members', { projectId: settings.projectId, panel: 'team', returnTo: settings.returnTo }), '');
  const restored = parseHash(members.returnTo, '');
  assert.equal(restored.view, 'projects');
  assert.equal(restored.projectId, 'project-B');
  assert.equal(restored.contentId, 'content-B');
  assert.equal(restored.versionId, 'version/2');
  assert.equal(restored.focusId, 'message-1');
  assert.equal(restored.panel, 'content');
});

test('the first project draft returns to creation after member configuration without a project id', () => {
  const create = routeHash('projects', { panel: 'create' });
  const route = parseHash(routeHash('members', { returnTo: create }), '');
  assert.equal(route.returnTo, '#/projects?panel=create');
  assert.equal(parseHash(route.returnTo, '').panel, 'create');
  assert.equal(parseHash(route.returnTo, '').projectId, null);
});

test('configuration return paths accept only business views and strip executable or unrelated route options', () => {
  for (const target of ['https://example.org', 'javascript:alert(1)', '#/members', '#/settings?return=x', '#/projects/%broken', '#/projects/a/b', '#/projects?#/tasks/x']) {
    assert.equal(businessReturnHash(target), null, target);
    assert.equal(parseHash(`#/settings?return=${encodeURIComponent(target)}`, '').returnTo, undefined);
  }
  assert.equal(businessReturnHash('#/projects/p?content=c&task=foreign&return=evil&panel=unknown'), '#/projects/p?content=c');
  assert.equal(businessReturnHash('#/publications?project=p&content=c&version=v'), '#/publications?content=c&version=v&project=p');
});

const member = (id, role = 'builder', extra = {}) => ({ id, name: id, handle: id, provider: 'custom', role,
  enabled: true, status: 'idle', executable: 'node', permission: role === 'reviewer' ? 'plan' : 'edit', ...extra });
const members = [member('extra'), member('owner'), member('worker'), member('reviewer', 'reviewer')];

test('a new project inherits the authorized default team without selecting unrelated discovered clients', () => {
  const team = projectTeamDefaults(members, { ownerId: 'owner', workerIds: ['worker'], reviewerId: 'reviewer' });
  assert.deepEqual(team, { ownerId: 'owner', reviewerId: 'reviewer', memberIds: ['owner', 'worker', 'reviewer'] });
  const stale = projectTeamDefaults(members.filter(value => value.id !== 'worker'), { ownerId: 'owner', workerIds: ['worker'], reviewerId: 'reviewer' });
  assert.deepEqual(stale.memberIds, ['owner', 'worker', 'reviewer']);
  assert.equal(stale.memberIds.includes('extra'), false);
});

test('a missing default reviewer is suggested only from the saved roster', () => {
  const withoutWorker = projectTeamDefaults(members, { ownerId: 'owner', workerIds: [], reviewerId: null });
  assert.deepEqual(withoutWorker, { ownerId: 'owner', reviewerId: '', memberIds: ['owner'] });
  const withWorker = projectTeamDefaults(members, { ownerId: 'owner', workerIds: ['worker'], reviewerId: null });
  assert.deepEqual(withWorker, { ownerId: 'owner', reviewerId: 'worker', memberIds: ['owner', 'worker'] });
  const unavailableWorker = projectTeamDefaults(members.map(value => value.id === 'worker' ? { ...value, enabled: false } : value),
    { ownerId: 'owner', workerIds: ['worker'], reviewerId: null });
  assert.deepEqual(unavailableWorker, { ownerId: 'owner', reviewerId: '', memberIds: ['owner', 'worker'] });
});

test('returning from member setup fills only empty roles and never changes a saved or in-flight selection', () => {
  const defaults = projectTeamDefaults(members, { ownerId: 'owner', workerIds: ['worker'], reviewerId: 'reviewer' });
  assert.deepEqual(missingProjectRoles({ ownerId: 'owner', reviewerId: '', requestId: '' }, defaults), { reviewerId: 'reviewer' });
  assert.deepEqual(missingProjectRoles({ ownerId: 'previous-owner', reviewerId: 'previous-reviewer', requestId: '' }, defaults), {});
  assert.deepEqual(missingProjectRoles({ ownerId: '', reviewerId: '', requestId: 'pending-request' }, defaults), {});
  const firstUse = projectTeamDefaults([member('owner'), member('disabled', 'reviewer', { enabled: false }), member('self', 'controller')]);
  assert.deepEqual(firstUse, { ownerId: 'owner', reviewerId: '', memberIds: ['owner'] });
});
