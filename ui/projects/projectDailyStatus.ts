import type { Bootstrap, BusinessProject, BusinessSnapshot, BusinessWorkItem, ContentItem } from '../types';
import { memberUnavailableReason } from '../memberAvailability.ts';
import { contentState, currentContentVersion, publicationAttemptForDisplay, publicationGroup, workState, type BusinessStateLabel, type BusinessTone } from './businessState.ts';
import { workIsClosed, workNeedsAttention, workRoleName } from './projectWorkspaceState.ts';

export type ProjectSettingsSection = 'account' | 'team' | 'runtime';
export type DailyAction = { kind: 'work'; id: string; label: string }
  | { kind: 'content'; id: string; versionId?: string; label: string }
  | { kind: 'settings'; section: ProjectSettingsSection; label: string }
  | { kind: 'project'; label: '继续项目' };
export interface ProjectDailyStatus {
  kind: 'unavailable' | 'archived' | 'unknown' | 'blocked' | 'paused' | 'team' | 'awaiting' | 'sending' | 'queued' | 'running' | 'waiting' | 'idle';
  title: string; detail: string; tone: BusinessTone; action?: DailyAction;
}
export interface ProjectDailySummary {
  primary: ProjectDailyStatus;
  secondary: ProjectDailyStatus[];
}
const workStatuses = new Set(['proposed', 'pending', 'ready', 'queued', 'running', 'waiting', 'waiting_dependencies',
  'waiting_answer', 'waiting_tool', 'checking', 'reviewing', 'completed', 'succeeded', 'done',
  'interrupted', 'blocked', 'failed', 'cancelled', 'superseded']);
const handoffStatuses = new Set(['assigned', 'accepted', 'received', 'verified', 'returned', 'blocked', 'cancelled']);

/** A missing handoff or an unfamiliar status is not evidence of active execution. */
export function projectWorkIssue(work: BusinessWorkItem, time = Date.now()): BusinessStateLabel | null {
  if (workNeedsAttention(work, time)) {
    if (['failed', 'blocked', 'interrupted'].includes(work.status) || ['returned', 'blocked'].includes(work.handoffStatus || '')) return workState(work);
    return { label: '已超过预计交付时间', tone: 'attention', detail: work.waitReason || work.error || '工作还没有完成，请查看当前记录。' };
  }
  if (workIsClosed(work)) return null;
  if (!workStatuses.has(work.status)) return { label: '工作状态待核对', tone: 'attention', detail: work.waitReason || work.error };
  if (!handoffStatuses.has(work.handoffStatus || '')) return { label: '工作记录待确认', tone: 'attention', detail: work.waitReason || work.error };
  return null;
}

/** Summarize the current snapshot without promoting project enablement or CLI success to completion. */
export function projectDailySummary(project: BusinessProject, state: BusinessSnapshot, bootstrap: Bootstrap,
  unavailable = false, time = Date.now()): ProjectDailySummary {
  if (unavailable) return { primary: { kind: 'unavailable', title: '项目状态暂时无法确认', detail: '恢复读取后，再核对最新进展。', tone: 'attention' }, secondary: [] };
  const work = state.workItems.filter(item => item.projectId === project.id)
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  const open = work.filter(item => !workIsClosed(item));
  const contents = state.contentItems.filter(item => item.projectId === project.id)
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
    .map(item => ({ item, group: publicationGroup(state, item) }));
  const contentAction = (item: ContentItem, label = '查看内容', frozen = false): DailyAction => ({ kind: 'content', id: item.id,
    versionId: frozen ? publicationAttemptForDisplay(state.attempts, item.id)?.versionId || undefined : currentContentVersion(item) || undefined, label });
  const workAction = (item: BusinessWorkItem, label: string): DailyAction => ({ kind: 'work', id: `work-${item.id}`, label });
  const actionable: ProjectDailyStatus[] = [];
  const unknown = contents.filter(entry => entry.group === 'unknown');
  if (unknown.length) actionable.push({ kind: 'unknown', title: `${unknown.length} 篇发布结果待核实`, tone: 'attention',
    detail: '先确认是否已经发布。核实前保留原提交版本，不会重复发布。', action: contentAction(unknown[0].item, '核实发布结果', true) });
  const sending = contents.filter(entry => entry.group === 'sending');
  if (sending.length) actionable.push({ kind: 'sending', title: `${sending.length} 篇内容正在提交，等待确认结果`, tone: 'working',
    detail: '请等待平台返回结果；提交中的版本不能修改。', action: contentAction(sending[0].item, '查看发布进度', true) });
  if (project.status === 'archived') return actionable.length
    ? { primary: actionable[0], secondary: actionable.slice(1) }
    : { primary: { kind: 'archived', title: '项目已归档', detail: '历史对话和稿件仍可查看。', tone: 'neutral' }, secondary: [] };
  const running = open.find(item => item.status === 'running');
  if (bootstrap.workspace.paused || project.status === 'paused') actionable.push({ kind: 'paused', tone: 'attention',
    title: bootstrap.workspace.paused ? '工作区已暂停新工作' : '项目已暂停新工作',
    detail: running ? '已有工作仍标记执行中；暂停不代表它们已经结束。'
      : bootstrap.workspace.paused ? '需要继续时，先查看工作区的暂停设置。' : '可以继续项目，再查看待处理的工作。',
    action: bootstrap.workspace.paused ? { kind: 'settings', section: 'runtime', label: '查看暂停设置' }
      : { kind: 'project', label: '继续项目' } });
  const ownerIssue = memberUnavailableReason(bootstrap.members.find(member => member.id === project.ownerId), { requireEdit: true });
  const reviewerIssue = !project.reviewerId || project.reviewerId === project.ownerId ? '还需要一位不同成员独立审稿。'
    : memberUnavailableReason(bootstrap.members.find(member => member.id === project.reviewerId));
  if (ownerIssue || reviewerIssue) actionable.push({ kind: 'team', title: '项目团队需要配置', tone: 'attention',
    detail: ownerIssue ? `负责人不可用：${ownerIssue}` : `独立审稿成员不可用：${reviewerIssue}`,
    action: { kind: 'settings', section: 'team', label: '配置项目团队' } });
  const issues = open.map(item => ({ item, issue: projectWorkIssue(item, time) })).filter(entry => entry.issue !== null);
  const projectReason = [...new Set([project.waitReason, ...(project.blockers || [])].filter(Boolean))].join('；');
  if (issues.length) {
    const { item, issue } = issues[0];
    const issueLabel = issue!.label === '交接受阻' ? '成果核对受阻' : issue!.label;
    actionable.push({ kind: 'blocked', title: `${issues.length} 项工作需要处理`, tone: issues.some(entry => entry.issue!.tone === 'danger') ? 'danger' : 'attention',
      detail: `${issueLabel}${issue!.detail ? `：${issue!.detail}` : '，请查看记录后安排下一步。'}${projectReason ? `；项目提示：${projectReason}` : ''}`,
      action: workAction(item, '查看工作问题') });
  } else if (project.status === 'attention' || projectReason) {
    actionable.push({ kind: 'blocked', tone: 'attention', title: '项目有待处理事项', detail: projectReason || '先查看项目条件，再决定如何继续。',
      action: { kind: 'settings', section: 'runtime', label: '查看项目条件' } });
  }
  const awaiting = contents.filter(entry => entry.group === 'awaiting');
  if (awaiting.length) actionable.push({ kind: 'awaiting', title: `${awaiting.length} 篇整稿可以审阅`, tone: 'ready',
    detail: '查看正文和配图，再确认本版发布条件或提出修改。', action: contentAction(awaiting[0].item) });
  const queued = contents.filter(entry => entry.group === 'queued');
  if (queued.length) actionable.push({ kind: 'queued', title: `${queued.length} 篇内容已批准，等待按排期执行`, tone: 'neutral',
    detail: '执行前还会核对本版条件，可查看或撤销尚未执行的批准。', action: contentAction(queued[0].item, '查看发布安排') });
  if (actionable.length) return { primary: actionable[0], secondary: actionable.slice(1) };
  if (running) return { primary: { kind: 'running', title: `正在进行${workRoleName(running).replace('交接验收', '成果检查')}`, tone: 'working',
    detail: '团队正在处理这项工作，暂时无需你操作。', action: workAction(running, '查看当前工作') }, secondary: [] };
  const waiting = open[0];
  if (waiting) {
    const names: Record<string, string> = { proposed: '工作待负责人采纳', pending: '工作等待安排', ready: '工作等待执行',
      queued: '工作等待执行名额', waiting: '工作等待前序成果', waiting_dependencies: '工作等待前序成果',
      waiting_answer: '工作等待同伴答复', waiting_tool: '工作等待工具结果', checking: '工作成果正在检查',
      reviewing: '工作成果正在审查', completed: '运行已结束，等待验收', succeeded: '运行已结束，等待验收',
      done: '运行已结束，等待验收', superseded: '工作已被替代，等待确认记录' };
    return { primary: { kind: 'waiting', title: waiting.handoffStatus === 'received' ? '成果已收取，等待核对' : names[waiting.status] || '工作状态待确认',
      detail: waiting.waitReason || '团队还需要完成当前步骤，暂时无需你操作。', tone: 'neutral', action: workAction(waiting, '查看等待原因') }, secondary: [] };
  }
  const preparing = contents.find(entry => entry.group === 'preparing');
  if (preparing) {
    const status = contentState(state, preparing.item);
    return { primary: { kind: 'waiting', title: status.label, detail: status.detail || '查看内容即可核对当前版本和处理进展。',
      tone: status.tone === 'working' ? 'neutral' : status.tone, action: contentAction(preparing.item) }, secondary: [] };
  }
  return { primary: { kind: 'idle', title: work.length ? '当前没有未完工作' : '项目已建立，尚未开始执行',
    detail: '可以在下方补充要求，历史对话与成果会保留。', tone: 'neutral' }, secondary: [] };
}

export function projectDailyStatus(project: BusinessProject, state: BusinessSnapshot, bootstrap: Bootstrap,
  unavailable = false, time = Date.now()): ProjectDailyStatus {
  return projectDailySummary(project, state, bootstrap, unavailable, time).primary;
}
