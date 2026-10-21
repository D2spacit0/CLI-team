import type { Member } from './types';

export interface TaskTeamSelection {
  executionMode: 'direct' | 'delegated'; assigneeId: string; reviewerId: string; participantIds: string[];
}

export function memberUnavailableReason(member: Member | undefined, { requireEdit = false }: { requireEdit?: boolean } = {}): string {
  if (!member) return '成员已不存在';
  if (member.provider === 'controller' || member.role === 'controller') return '主控会话不能作为执行成员';
  if (!member.enabled) return '成员已停用';
  if (!member.executable.trim()) return '尚未配置 CLI';
  if (member.status === 'missing') return '未检测到 CLI';
  if (requireEdit && member.permission !== 'edit') return '负责人需要文件编辑权限';
  return '';
}

export function isMemberRunnable(member: Member | undefined): member is Member {
  return !memberUnavailableReason(member);
}

export function validateTaskTeam(value: TaskTeamSelection, members: readonly Member[]): string {
  if (!['direct', 'delegated'].includes(value.executionMode)) return '请选择执行方式';
  const delegated = value.executionMode === 'delegated';
  const ownerLabel = delegated ? '负责人' : '执行者';
  if (!value.assigneeId) return `请选择${ownerLabel}`;
  const owner = members.find((member) => member.id === value.assigneeId);
  const ownerError = memberUnavailableReason(owner, { requireEdit: delegated });
  if (ownerError) return `${ownerLabel}${owner ? ` ${owner.name}` : ''}不可用：${ownerError}`;
  if (value.reviewerId) {
    if (value.reviewerId === value.assigneeId) return '独立评审者不能与负责人或执行者相同';
    const reviewer = members.find((member) => member.id === value.reviewerId);
    const reviewerError = memberUnavailableReason(reviewer);
    if (reviewerError) return `独立评审者${reviewer ? ` ${reviewer.name}` : ''}不可用：${reviewerError}`;
  }
  if (!delegated) return '';
  if (value.participantIds.length < 1 || value.participantIds.length > 4) return '请选择 1–4 名协作者';
  if (new Set(value.participantIds).size !== value.participantIds.length) return '协作者重复，请取消重复人选后重新选择';
  for (const id of value.participantIds) {
    if (id === value.assigneeId) return '负责人不能同时列为协作者，请从协作名单移除';
    if (id === value.reviewerId) return '独立评审者不能参与协作执行，请从协作名单移除';
    const member = members.find((candidate) => candidate.id === id);
    const error = memberUnavailableReason(member);
    if (error) return `协作者${member ? ` ${member.name}` : ''}不可用：${error}，请移除或更换`;
  }
  return '';
}
