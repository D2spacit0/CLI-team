import type { ManagedTeam, Member } from '../types';
import { isMemberRunnable } from '../memberAvailability.ts';

export function projectTeamDefaults(members: readonly Member[], managed?: ManagedTeam | null) {
  const available = members.filter(isMemberRunnable);
  if (managed) {
    const ownerId = managed.ownerId || '';
    const authorizedReviewers = available.filter(member => member.id !== ownerId && managed.workerIds.includes(member.id));
    const reviewerId = managed.reviewerId || authorizedReviewers.find(member => member.role === 'reviewer')?.id
      || authorizedReviewers[0]?.id || '';
    // A saved roster is the authorization boundary; unrelated discovered clients are not added.
    return { ownerId, reviewerId, memberIds: [...new Set([ownerId, ...managed.workerIds, reviewerId].filter(Boolean))] };
  }
  const ownerId = available.find(member => member.permission === 'edit' && member.role === 'builder')?.id
    || available.find(member => member.permission === 'edit')?.id || '';
  const reviewerId = available.find(member => member.id !== ownerId && member.role === 'reviewer')?.id
    || available.find(member => member.id !== ownerId)?.id || '';
  return { ownerId, reviewerId, memberIds: [...new Set([ownerId, reviewerId].filter(Boolean))] };
}

export function missingProjectRoles(fields: Record<string, string>, defaults: ReturnType<typeof projectTeamDefaults>) {
  if (fields.requestId) return {};
  const changes: Record<string, string> = {};
  if (!fields.ownerId && defaults.ownerId) changes.ownerId = defaults.ownerId;
  const ownerId = fields.ownerId || defaults.ownerId;
  if (!fields.reviewerId && defaults.reviewerId && defaults.reviewerId !== ownerId) changes.reviewerId = defaults.reviewerId;
  return changes;
}
