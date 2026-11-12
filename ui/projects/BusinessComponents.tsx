import { AlertCircle, ArrowUpRight, FileText, MessageSquare } from 'lucide-react';
import { api } from '../api';
import type { BusinessSnapshot, ContentItem, Member, BusinessCollaboration, BusinessAction } from '../types';
import { businessTime, contentRevision, contentState, type BusinessTone, type BusinessStateLabel } from './businessState';
import { actionBody } from './projectWorkspaceState';

export function BusinessBadge({ label, tone = 'neutral' }: BusinessStateLabel) {
  return <span className={`business-badge ${tone}`}><span className="business-status-dot" />{label}</span>;
}

export function BusinessNotice({ children, tone = 'attention', action }: {
  children: React.ReactNode; tone?: BusinessTone; action?: React.ReactNode;
}) {
  return <div className={`business-notice ${tone}`} role={tone === 'danger' ? 'alert' : 'status'}><AlertCircle size={16} /><div>{children}{action && <div className="business-notice-action">{action}</div>}</div></div>;
}

export function ContentCard({ item, state, onOpen, compact = false }: {
  item: ContentItem; state: BusinessSnapshot; onOpen: (id: string) => void; compact?: boolean;
}) {
  const revision = contentRevision(state, item);
  const status = contentState(state, item);
  const image = revision?.images[0];
  return <button className={`business-content-card ${compact ? 'compact' : ''}`} onClick={() => onOpen(item.id)} data-content-id={item.id}>
    <div className="business-content-cover">
      {image && revision ? <img src={api.contentImageUrl(item.id, revision.id, 0)} alt={`${revision.title}的封面`} loading="lazy" />
        : <div className="business-image-pending"><FileText size={20} /><span>配图制作中</span></div>}
    </div>
    <div className="business-content-card-copy"><BusinessBadge {...status} />
      <h3>{revision?.title || item.title || '新图文'}</h3>
      <p>{status.detail || (revision?.body ? revision.body : '团队正在准备选题、文案与配图。')}</p>
      <div className="business-content-card-footer"><span>{revision ? `${revision.images.length} 张图片 · 版本 ${revision.revision}` : '等待形成整稿'}</span><span>查看整稿 <ArrowUpRight size={13} /></span></div>
    </div>
  </button>;
}

const actionLabels: Record<string, string> = {
  ask_peer: '向同伴求助', contribute: '提交贡献', request_revision: '提出修改意见',
  propose_work: '提议后续工作', propose_fact: '提出项目资料', request_tool: '申请使用工具',
  user_message: '告诉团队', message: '告诉团队', revision_request: '退回修改',
  consultation: '向同伴求助', contribution: '提交贡献', revision: '修改要求', proposal: '工作建议',
};
const threadLabels: Record<string, string> = {
  pending: '等待送达', delivered: '已送达，待答复', answered: '已有答复，待核对', resolved: '已有答复',
  rejected: '未采纳', superseded: '已被新工作替代', cancelled: '已取消',
};

export function CollaborationHistory({ threads, actions, members, timeZone }: {
  threads: BusinessCollaboration[]; actions: BusinessAction[]; members: Member[]; timeZone?: string;
}) {
  const memberName = (id?: string) => members.find((member) => member.id === id)?.name || (id === 'user' ? '你' : '团队');
  const entries = [
    ...threads.map((thread) => ({ key: `thread-${thread.id}`, createdAt: thread.createdAt, thread, action: null })),
    ...actions.filter((action) => !threads.some((thread) => thread.id === (action.result?.threadId || action.result?.id)))
      .map((action) => ({ key: `action-${action.id}`, createdAt: action.createdAt, thread: null, action })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!entries.length) return <p className="business-empty-inline">成员交接、材料采用与修改答复会记录在这里。</p>;
  return <ol className="business-collaboration-list">{entries.map(({ key, createdAt, thread, action }) => <li key={key}>
    <MessageSquare size={15} className="business-timeline-icon" />
    <div><div className="business-timeline-heading"><strong>{memberName(thread?.requesterId || action?.memberId)}</strong>
      <span>{actionLabels[thread?.kind || thread?.type || action?.type || ''] || '协作记录'}</span><time>{businessTime(createdAt, timeZone)}</time></div>
      {thread ? <>
        {thread.recipientId && <p className="business-muted">交给 {memberName(thread.recipientId)} · {threadLabels[thread.status] || thread.status}</p>}
        <p className="business-preserve-text">{thread.question || thread.body || thread.summary || '等待成员处理'}</p>
        {thread.answer && <div className="business-peer-answer"><strong>{memberName(thread.recipientId)}的答复 · 成员说明</strong><p>{thread.answer}</p></div>}
        {thread.resolution && <p className="business-resolution">处理说明：{thread.resolution}</p>}
      </> : <>
        <p className="business-preserve-text">{action && actionBody(action) || '已记录结构化行动'}</p>
        {action?.status && <p className="business-muted">{({ accepted: '负责人已采纳', adopted: '负责人已采纳', proposed: '待负责人决定', rejected: '未采纳', completed: '行动已执行，成果另行验收', processed: '行动已登记，成果另行验收' } as Record<string, string>)[action.status] || '行动状态待核对'}</p>}
      </>}
    </div>
  </li>)}</ol>;
}
