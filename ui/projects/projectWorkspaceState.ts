import type { BusinessAction, BusinessCollaboration, BusinessSnapshot, BusinessWorkItem, WorkReceipt } from '../types';
import { contentRevision, publicationGroup } from './businessState.ts';

export type ProjectPanel = 'content' | 'resources' | 'recap' | 'team';
export interface ProjectSearchResult {
  id: string; kind: 'work' | 'message' | 'content' | 'fact' | 'material';
  title: string; excerpt: string; createdAt: string; contentId?: string; versionId?: string;
}
export interface ProjectMessageEntry {
  id: string; actorId: string; body: string; createdAt: string; label: string;
  contentId?: string | null; workItemId?: string; versionId?: string; status?: string;
  evidenceType: 'user_instruction' | 'agent_claim';
}

export function workIsClosed(work: BusinessWorkItem): boolean {
  if (['failed', 'blocked', 'interrupted'].includes(work.status)) return false;
  return work.handoffStatus === 'verified' || work.handoffStatus === 'cancelled'
    || (!work.handoffStatus && work.status === 'cancelled');
}

export function workNeedsAttention(work: BusinessWorkItem, time = Date.now()): boolean {
  if (workIsClosed(work)) return false;
  return ['failed', 'blocked', 'interrupted'].includes(work.status)
    || ['returned', 'blocked'].includes(work.handoffStatus || '')
    || Boolean(work.dueAt && Date.parse(work.dueAt) < time);
}

/** A machine receipt belongs to an exact work generation and result, never just its title. */
export function currentWorkReceipt(work: BusinessWorkItem, receipts: WorkReceipt[]): WorkReceipt | null {
  if (!work.resultDigest || work.currentReceiptId === null) return null;
  return [...receipts].filter(receipt => receipt.projectId === work.projectId && receipt.workItemId === work.id
    && (!work.currentReceiptId || receipt.id === work.currentReceiptId)
    && receipt.generation === work.generation && receipt.resultDigest === work.resultDigest && receipt.evidenceType === 'machine')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}

export function workRoleName(work: BusinessWorkItem): string {
  const roles: Record<string, string> = {
    plan: '安排分工', coordinate: '负责人协调', research: '资料调研', analysis: '分析判断',
    copy: '文案制作', visual: '视觉制作', integrate: '整稿集成', review: '独立审稿',
    accept: '交接验收', acceptance: '交接验收', consult: '同伴咨询', recap: '运营复盘',
    owner: '负责人', planner: '负责人', researcher: '资料调研', writer: '文案制作', reviewer: '独立审稿',
  };
  return roles[work.kind || ''] || roles[work.role || ''] || '团队工作';
}

const threadLabel = (thread: BusinessCollaboration) => ({
  message: '交代与答复', revision: '改稿要求', consultation: '同伴咨询', contribution: '成员贡献', proposal: '工作建议',
} as Record<string, string>)[thread.kind || thread.type || ''] || '协作沟通';

export function actionBody(action: BusinessAction): string {
  const input = action.input;
  return action.summary || action.body || action.question || action.reason || input?.message
    || input?.question || input?.reason || input?.content || input?.objective || input?.title || action.title || '';
}

/** Keep the original answer separate from subsequent acceptance work and machine receipts. */
export function projectMessages(state: BusinessSnapshot, projectId: string): ProjectMessageEntry[] {
  const threads = state.collaborationThreads.filter(thread => thread.projectId === projectId);
  const entries: ProjectMessageEntry[] = threads.flatMap(thread => {
    const base = { contentId: thread.contentId, workItemId: thread.workItemId || thread.sourceWorkItemId,
      versionId: thread.versionId, status: thread.status };
    const messages: ProjectMessageEntry[] = [];
    const body = thread.question || thread.body || thread.summary;
    if (body) messages.push({ ...base, id: `message-${thread.id}`, actorId: thread.requesterId || thread.memberId || '',
      body, createdAt: thread.createdAt, label: threadLabel(thread),
      evidenceType: thread.requesterId === 'user' ? 'user_instruction' : 'agent_claim' });
    if (thread.answer) messages.push({ ...base, id: `answer-${thread.id}`, actorId: thread.recipientId || '',
      body: thread.answer, createdAt: thread.answeredAt || thread.createdAt, label: '成员答复', evidenceType: 'agent_claim' });
    return messages;
  });
  for (const action of state.actions.filter(entry => entry.projectId === projectId)) {
    const threadId = action.result?.threadId || action.result?.id;
    if (threadId && threads.some(thread => thread.id === threadId)) continue;
    // Dispatch, material adoption and tool calls live under their work phase instead of duplicating the conversation.
    if (!['contribute', 'message', 'user_message'].includes(action.type)) continue;
    const body = actionBody(action);
    if (!body) continue;
    const sourceWork = state.workItems.find(work => work.id === (action.sourceWorkItemId || action.workItemId));
    const actorId = action.memberId || sourceWork?.memberId || (action.type === 'user_message' ? 'user' : '');
    entries.push({ id: `action-${action.id}`, actorId, body, createdAt: action.createdAt,
      label: action.type === 'user_message' ? '交代与答复' : '成员贡献', contentId: action.contentId,
      workItemId: action.sourceWorkItemId || action.workItemId, status: action.status,
      evidenceType: actorId === 'user' ? 'user_instruction' : 'agent_claim' });
  }
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function preferredProjectContent(state: BusinessSnapshot, projectId: string): string | null {
  const priority = { unknown: 0, awaiting: 1, sending: 2, queued: 3, preparing: 4, published: 5 };
  return state.contentItems.filter(item => item.projectId === projectId)
    .sort((a, b) => priority[publicationGroup(state, a)] - priority[publicationGroup(state, b)]
      || (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))[0]?.id || null;
}

function excerpt(text: string, query: string): string {
  const index = text.toLocaleLowerCase().indexOf(query);
  const start = Math.max(0, index - 28);
  return `${start ? '…' : ''}${text.slice(start, start + 125)}${text.length > start + 125 ? '…' : ''}`;
}

export function searchProject(state: BusinessSnapshot, projectId: string, value: string): ProjectSearchResult[] {
  const query = value.trim().toLocaleLowerCase();
  if (!query) return [];
  const matches = (values: (string | undefined | null)[]) => values.filter(Boolean).join('\n').toLocaleLowerCase().includes(query);
  const results: ProjectSearchResult[] = [];
  for (const work of state.workItems.filter(item => item.projectId === projectId)) {
    const events = state.workHandoffs.filter(event => event.projectId === projectId && event.workItemId === work.id);
    const body = [work.objective, work.summary, work.waitReason, ...(work.acceptanceCriteria || []), ...events.map(event => event.message)].filter(Boolean).join('\n');
    if (matches([work.title, body])) results.push({ id: `work-${work.id}`, kind: 'work', title: work.title || workRoleName(work),
      excerpt: excerpt(body, query), createdAt: work.updatedAt || work.createdAt, contentId: work.contentId || undefined });
  }
  for (const message of projectMessages(state, projectId)) {
    if (matches([message.body])) results.push({ id: message.id, kind: 'message', title: message.actorId === 'user' ? '你的交代' : message.label,
      excerpt: excerpt(message.body, query), createdAt: message.createdAt, contentId: message.contentId || undefined, versionId: message.versionId });
  }
  for (const item of state.contentItems.filter(content => content.projectId === projectId)) {
    const versions = state.contentRevisions.filter(version => version.projectId === projectId && version.contentId === item.id).sort((a, b) => b.revision - a.revision);
    if (!versions.length && matches([item.title])) results.push({ id: `content-${item.id}`, kind: 'content', title: item.title,
      excerpt: '整稿尚在制作', createdAt: item.createdAt, contentId: item.id });
    for (const version of versions) {
      if (!matches([version.title, version.body, version.changeSummary, ...version.tags])) continue;
      results.push({ id: `version-${version.id}`, kind: 'content', title: `${version.title} · 版本 ${version.revision}`,
        excerpt: excerpt(version.body, query), createdAt: version.createdAt, contentId: item.id, versionId: version.id });
    }
  }
  for (const fact of state.projectFacts.filter(item => item.projectId === projectId)) {
    if (matches([fact.content, ...fact.sources.flatMap(source => [source.label, source.url])])) results.push({ id: `fact-${fact.id}`, kind: 'fact',
      title: fact.type === 'preference' ? '内容偏好' : fact.type === 'judgment' ? '团队判断' : '项目资料',
      excerpt: excerpt(fact.content, query), createdAt: fact.createdAt });
  }
  for (const material of state.projectMaterials.filter(item => item.projectId === projectId)) {
    if (matches([material.name])) results.push({ id: `material-${material.id}`, kind: 'material', title: material.name,
      excerpt: '已导入的材料文件', createdAt: material.importedAt || material.createdAt || '' });
  }
  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export const projectContentTitle = (state: BusinessSnapshot, contentId?: string | null): string => {
  const item = state.contentItems.find(content => content.id === contentId);
  return item ? contentRevision(state, item)?.title || item.title : '';
};
