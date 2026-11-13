import type { Bootstrap, BusinessProject, BusinessSnapshot, BusinessWorkItem, ContentItem } from '../types';
import { memberUnavailableReason } from '../memberAvailability.ts';
import { contentState, currentContentVersion, publicationAttemptForDisplay, publicationGroup, workState, type BusinessStateLabel, type BusinessTone } from './businessState.ts';
import { projectContentTitle, workIsClosed, workNeedsAttention, workRoleName } from './projectWorkspaceState.ts';

export type ProjectSettingsSection = 'account' | 'team' | 'runtime';
type DailyAction = { kind: 'work'; id: string; label: string }
  | { kind: 'content'; id: string; versionId?: string; label: string }
  | { kind: 'settings'; section: ProjectSettingsSection; label: string };
export interface ProjectDailyStatus {
  kind: 'unavailable' | 'archived' | 'unknown' | 'blocked' | 'paused' | 'team' | 'awaiting' | 'sending' | 'queued' | 'running' | 'waiting' | 'idle';
  title: string; detail: string; tone: BusinessTone; action?: DailyAction;
}
const workStatuses = new Set(['proposed', 'pending', 'ready', 'queued', 'running', 'waiting', 'waiting_dependencies',
  'waiting_answer', 'waiting_tool', 'checking', 'reviewing', 'completed', 'succeeded', 'done',
  'interrupted', 'blocked', 'failed', 'cancelled', 'superseded']);
const handoffStatuses = new Set(['assigned', 'accepted', 'received', 'verified', 'returned', 'blocked', 'cancelled']);

/** A missing handoff or an unfamiliar status is not evidence of active execution. */
export function projectWorkIssue(work: BusinessWorkItem, time = Date.now()): BusinessStateLabel | null {
  if (workNeedsAttention(work, time)) {
    if (['failed', 'blocked', 'interrupted'].includes(work.status) || ['returned', 'blocked'].includes(work.handoffStatus || '')) return workState(work);
    return { label: '已超过预计交付时间', tone: 'attention', detail: work.waitReason || work.error || '尚未完成交接，请查看当前记录。' };
  }
  if (workIsClosed(work)) return null;
  if (!workStatuses.has(work.status)) return { label: '工作状态待核对', tone: 'attention', detail: work.waitReason || work.error };
  if (!handoffStatuses.has(work.handoffStatus || '')) return { label: '交接记录待确认', tone: 'attention', detail: work.waitReason || work.error };
  return null;
}

/** Summarize the current snapshot without promoting project enablement or CLI success to completion. */
export function projectDailyStatus(project: BusinessProject, state: BusinessSnapshot, bootstrap: Bootstrap,
  unavailable = false, time = Date.now()): ProjectDailyStatus {
  if (unavailable) return { kind: 'unavailable', title: '项目状态暂时无法确认', detail: '恢复读取后，再核对最新进展。', tone: 'attention' };
  const work = state.workItems.filter(item => item.projectId === project.id)
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  const open = work.filter(item => !workIsClosed(item));
  const contents = state.contentItems.filter(item => item.projectId === project.id)
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  const contentAction = (item: ContentItem, label = '查看整稿'): DailyAction => ({ kind: 'content', id: item.id,
    versionId: publicationGroup(state, item) === 'unknown' ? publicationAttemptForDisplay(state.attempts, item.id)?.versionId || undefined : currentContentVersion(item) || undefined, label });
  const workAction = (item: BusinessWorkItem, label: string): DailyAction => ({ kind: 'work', id: `work-${item.id}`, label });
  const unknown = contents.filter(item => publicationGroup(state, item) === 'unknown');
  if (unknown.length) return { kind: 'unknown', title: `${unknown.length} 篇发布结果待核实`, tone: 'attention',
    detail: '先核实是否已发布，原提交保持冻结。', action: contentAction(unknown[0], '核实发布结果') };
  if (project.status === 'archived') return { kind: 'archived', title: '项目已归档', detail: '历史对话和稿件仍可查看。', tone: 'neutral' };
  const issues = open.map(item => ({ item, issue: projectWorkIssue(item, time) })).filter(entry => entry.issue !== null);
  if (issues.length) {
    const { item, issue } = issues[0];
    return { kind: 'blocked', title: `${issues.length} 项工作需要接续`, tone: issue!.tone,
      detail: `${item.title || workRoleName(item)} · ${issue!.label}${issue!.detail ? `：${issue!.detail}` : ''}`,
      action: workAction(item, '查看原因与进展') };
  }
  const running = open.find(item => item.status === 'running');
  if (bootstrap.workspace.paused || project.status === 'paused') return { kind: 'paused', tone: 'attention',
    title: bootstrap.workspace.paused ? '工作区已暂停新派工' : '项目已暂停新工作',
    detail: running ? '已有工作仍标记执行中；暂停不代表全部运行已结束。'
      : bootstrap.workspace.paused ? '需要继续时，在运行设置中恢复调度。' : '需要继续时，点击会话右上方的“继续项目”。',
    ...(bootstrap.workspace.paused ? { action: { kind: 'settings', section: 'runtime', label: '查看运行设置' } as DailyAction } : {}) };
  const ownerIssue = memberUnavailableReason(bootstrap.members.find(member => member.id === project.ownerId), { requireEdit: true });
  const reviewerIssue = !project.reviewerId || project.reviewerId === project.ownerId ? '还需要一位不同成员独立审稿。'
    : memberUnavailableReason(bootstrap.members.find(member => member.id === project.reviewerId));
  if (ownerIssue || reviewerIssue) return { kind: 'team', title: '项目团队需要配置', tone: 'attention',
    detail: ownerIssue ? `负责人不可用：${ownerIssue}` : `独立审稿成员不可用：${reviewerIssue}`,
    action: { kind: 'settings', section: 'team', label: '配置项目团队' } };
  if (project.status === 'attention' || project.waitReason || project.blockers?.length) return { kind: 'blocked', tone: 'attention',
    title: '项目有待处理事项', detail: project.waitReason || project.blockers?.join('；') || '先查看项目运行条件，再决定如何继续。',
    action: { kind: 'settings', section: 'runtime', label: '查看运行条件' } };
  const awaiting = contents.filter(item => publicationGroup(state, item) === 'awaiting');
  if (awaiting.length) return { kind: 'awaiting', title: `${awaiting.length} 篇整稿可以审阅`, tone: 'ready',
    detail: '查看正文和配图，再确认本版发布条件或提出修改。', action: contentAction(awaiting[0]) };
  const sending = contents.find(item => publicationGroup(state, item) === 'sending');
  if (sending) return { kind: 'sending', title: '稿件正在提交，等待确认结果', tone: 'working',
    detail: projectContentTitle(state, sending.id), action: contentAction(sending, '查看发布进度') };
  const queued = contents.find(item => publicationGroup(state, item) === 'queued');
  if (queued) return { kind: 'queued', title: '稿件已批准，等待按排期执行', tone: 'neutral',
    detail: projectContentTitle(state, queued.id), action: contentAction(queued, '查看发布安排') };
  if (running) return { kind: 'running', title: `正在进行${workRoleName(running)}`, tone: 'working',
    detail: running.title || running.objective, action: workAction(running, '查看当前工作') };
  const waiting = open[0];
  if (waiting) {
    const names: Record<string, string> = { proposed: '工作待负责人采纳', pending: '工作等待安排', ready: '工作等待执行',
      queued: '工作等待执行名额', waiting: '工作等待前序成果', waiting_dependencies: '工作等待前序成果',
      waiting_answer: '工作等待同伴答复', waiting_tool: '工作等待工具结果', checking: '工作成果正在检查',
      reviewing: '工作成果正在审查', completed: '运行已结束，等待验收', succeeded: '运行已结束，等待验收',
      done: '运行已结束，等待验收', superseded: '工作已被替代，等待交接确认' };
    return { kind: 'waiting', title: waiting.handoffStatus === 'received' ? '成果已收取，等待核对' : names[waiting.status] || '工作状态待确认',
      detail: waiting.waitReason || waiting.title || waiting.objective, tone: 'neutral', action: workAction(waiting, '查看等待原因') };
  }
  const preparing = contents.find(item => publicationGroup(state, item) === 'preparing');
  if (preparing) {
    const status = contentState(state, preparing);
    return { kind: 'waiting', title: status.label, detail: status.detail || projectContentTitle(state, preparing.id),
      tone: status.tone === 'working' ? 'neutral' : status.tone, action: contentAction(preparing) };
  }
  return { kind: 'idle', title: work.length ? '当前没有未完工作' : '项目已建立，尚未开始执行',
    detail: '可以在下方补充要求，历史对话与成果会保留。', tone: 'neutral' };
}
