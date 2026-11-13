import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ChevronDown, FileText, FolderOpen, GitBranch, Pause, Play, Radio, Send, Settings2, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useTaskDraft } from '../taskDrafts';
import type { BusinessSnapshot, BusinessWorkItem, Member } from '../types';
import type { ProjectHomeProps } from './ProjectHome';
import { BusinessBadge, BusinessNotice } from './BusinessComponents';
import { businessTime, contentRevision, contentState, publicationGroup, workState } from './businessState';
import { actionBody, currentWorkReceipt, projectContentTitle, projectMessages, workIsClosed, workRoleName } from './projectWorkspaceState';
import { projectWorkIssue } from './projectDailyStatus';
import { useBusinessBusy } from './useBusinessBusy';

export default function ProjectConversation(props: ProjectHomeProps) {
  const { project, bootstrap, state, onOpenContent, onRefresh, onSettings, onBusy, onShowPanel, focusId, focusNonce = 0, covered = false } = props;
  const { busy, report } = useBusinessBusy(onBusy);
  const reportMessage = useCallback((value: boolean) => report('message', value), [report]);
  const [error, setError] = useState('');
  const [hasNewActivity, setHasNewActivity] = useState(false);
  const [showAllAttention, setShowAllAttention] = useState(false);
  const pauseLock = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const followsLatest = useRef(true);
  const owner = bootstrap.members.find(member => member.id === project.ownerId);
  const memberName = (id?: string | null) => bootstrap.members.find(member => member.id === id)?.name || (id === 'user' ? '你' : '团队');
  const messages = useMemo(() => projectMessages(state, project.id), [state, project.id]);
  const work = state.workItems.filter(item => item.projectId === project.id);
  const content = state.contentItems.filter(item => item.projectId === project.id);
  const openWork = work.filter(item => !workIsClosed(item));
  const blocked = openWork.filter(item => projectWorkIssue(item));
  const awaiting = content.filter(item => publicationGroup(state, item) === 'awaiting');
  const verifying = content.filter(item => ['unknown', 'sending'].includes(publicationGroup(state, item)));
  const entries = [
    ...messages.map(message => ({ id: message.id, at: message.createdAt, message, work: null })),
    ...work.map(item => ({ id: `work-${item.id}`, at: item.createdAt, message: null, work: item })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const activityKey = [entries.length, messages.at(-1)?.id, messages.at(-1)?.body, ...work.map(item => `${item.id}:${item.status}:${item.handoffStatus}:${item.updatedAt}`)].join('|');
  const jumpToLatest = () => {
    if (!scroller.current) return;
    followsLatest.current = true;
    scroller.current.scrollTop = scroller.current.scrollHeight;
    setHasNewActivity(false);
  };
  useEffect(() => {
    if (followsLatest.current) jumpToLatest();
    else setHasNewActivity(true);
  }, [activityKey]);
  useEffect(() => {
    if (!focusId || !scroller.current || covered) return;
    const node = [...scroller.current.querySelectorAll<HTMLElement>('[data-project-focus]')].find(element => element.dataset.projectFocus === focusId);
    if (!node) return;
    followsLatest.current = false;
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [focusId, focusNonce, covered]);
  const pause = async () => {
    if (pauseLock.current) return;
    pauseLock.current = true; report('pause', true); setError('');
    try { await api.setProjectPaused(project.id, project.status !== 'paused'); await onRefresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '项目状态更新失败'); }
    finally { pauseLock.current = false; report('pause', false); }
  };
  return <section className="team-conversation" aria-label={`${project.name}的负责人会话`} data-project-id={project.id} inert={covered}>
    <header className="team-conversation-header">
      <span className="team-channel-mark" aria-hidden="true"><Radio size={18} /></span><div className="team-project-heading"><h2>负责人通讯</h2><p>{owner?.name || '负责人'}<span className="team-heading-divider">·</span>协调团队与接续工作</p></div>
      <div className="team-header-tools"><button className={`btn btn-secondary ${project.status === 'paused' ? 'team-resume-project' : 'btn-icon-only'}`} disabled={busy || project.status === 'archived'} aria-label={project.status === 'paused' ? '继续项目' : '暂停项目'} title={project.status === 'paused' ? '继续项目' : '暂停项目'} onClick={() => void pause()}>{project.status === 'paused' ? <><Play size={15} /><span>继续项目</span></> : <Pause size={15} />}</button>
        <button className="btn btn-secondary btn-icon-only" aria-label="项目运行与账号设置" title="项目运行与账号设置" onClick={() => onSettings('runtime')}><Settings2 size={15} /></button></div>
    </header>
    <div className="team-context-row"><p>对话与交接记录</p>
      <button type="button" onClick={() => onShowPanel?.('resources')}><FolderOpen size={13} />资料</button><button type="button" onClick={() => onShowPanel?.('recap')}>复盘</button></div>
    {error && <BusinessNotice tone="danger">{error}</BusinessNotice>}
    {(project.waitReason || project.blockers?.length || bootstrap.workspace.paused) && <div className="team-project-condition" role="status">{bootstrap.workspace.paused ? '工作区调度已暂停，恢复后继续推进。' : project.waitReason || project.blockers?.join('；')}</div>}
    {(awaiting.length > 0 || verifying.length > 0 || blocked.length > 0) && <section className="team-attention" aria-label="待批准与交接受阻" aria-live="polite">
      {awaiting.length > 0 && <button className="team-approval-prompt" disabled={busy} onClick={() => onOpenContent(awaiting[0].id)}><span className="team-attention-icon"><ShieldCheck size={16} /></span><span><strong>{awaiting.length} 篇整稿可以审阅</strong><small>{projectContentTitle(state, awaiting[0].id)}</small></span><ArrowRight size={15} /></button>}
      {verifying.map(item => <button key={item.id} className="team-pending-row" disabled={busy} onClick={() => onOpenContent(item.id)}><BusinessBadge {...contentState(state, item)} /><span>{projectContentTitle(state, item.id)}</span><ArrowRight size={12} /></button>)}
      {(showAllAttention ? blocked : blocked.slice(0, 2)).map(item => <button key={item.id} className="team-pending-row" disabled={busy} onClick={() => props.onFocus?.(`work-${item.id}`)}><BusinessBadge {...projectWorkIssue(item)!} /><span>{item.title || item.objective}</span><small>查看原因</small></button>)}
      {blocked.length > 2 && <button className="team-attention-more" onClick={() => setShowAllAttention(value => !value)}>{showAllAttention ? '收起列表' : `还有 ${blocked.length - 2} 项待接续处理`}</button>}
    </section>}
    <div className="team-conversation-scroll" ref={scroller} onScroll={() => {
      const node = scroller.current;
      if (node) followsLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
      if (followsLatest.current) setHasNewActivity(false);
    }}>
      {!entries.length ? <div className="team-conversation-empty"><div className="team-owner-avatar">{(owner?.name || '团').slice(0, 1)}</div><h2>把目标交给团队</h2><p>{project.objective}</p><span>工作分配、成果与修改进展会留在这里。整稿准备好后，再由你确认发布。</span></div>
        : <ol className="team-conversation-timeline" aria-label="团队对话与协作进度">{entries.map(entry => <li key={entry.id}>
          {entry.message ? <article className={`team-message ${entry.message.actorId === 'user' ? 'from-user' : ''} ${focusId === entry.id ? 'is-focused' : ''}`} data-project-focus={entry.id} tabIndex={-1}>
            <div className="team-message-byline"><span className="team-message-avatar">{memberName(entry.message.actorId).slice(0, 1)}</span><strong>{memberName(entry.message.actorId)}</strong><span>{entry.message.actorId === project.ownerId ? '负责人' : entry.message.actorId === 'user' ? '' : entry.message.label}</span><time>{businessTime(entry.message.createdAt, project.timeZone)}</time></div>
            <div className="team-message-body">{entry.message.body}</div>
            <div className="team-message-context">{entry.message.contentId && <button disabled={busy} onClick={() => onOpenContent(entry.message!.contentId!, entry.message!.versionId)}><FileText size={12} />{projectContentTitle(state, entry.message.contentId) || '关联整稿'}</button>}
              {entry.message.actorId === 'user' && <span>{({ pending: '已登记，等待接手', delivered: '已送达成员', answered: '已有答复，待核对', resolved: '已有答复', superseded: '对应工作已更新' } as Record<string, string>)[entry.message.status || ''] || '已登记'}</span>}
              {entry.message.evidenceType === 'agent_claim' && <span>成员说明</span>}</div>
          </article> : entry.work && <WorkPhase work={entry.work} state={state} members={bootstrap.members} timeZone={project.timeZone} focused={focusId === entry.id} focusNonce={focusNonce} onOpenContent={onOpenContent} disabled={busy} />}
        </li>)}</ol>}
      {content.length > 0 && <section className="team-output-list" aria-label="本项目成果"><h2>稿件与成果 <span>{content.length}</span></h2>{content.map(item => {
        const revision = contentRevision(state, item);
        return <button key={item.id} data-project-focus={`content-${item.id}`} className={props.selectedContentId === item.id ? 'selected' : ''} disabled={busy} onClick={() => onOpenContent(item.id)}>
          {revision?.images[0] ? <img src={api.contentImageUrl(item.id, revision.id, 0)} alt="" loading="lazy" /> : <span className="team-output-icon"><FileText size={19} /></span>}
          <span><strong>{revision?.title || item.title}</strong><small>{revision ? `${revision.images.length} 张配图 · 版本 ${revision.revision}` : '尚未形成完整稿件'}</small></span><BusinessBadge {...contentState(state, item)} /></button>;
      })}</section>}
    </div>
    {hasNewActivity && <button className="team-new-activity" onClick={jumpToLatest}><ArrowDown size={13} />有新进展，回到最新</button>}
    <ProjectComposer {...props} onBusy={reportMessage} onSent={jumpToLatest} />
    <div className="team-conversation-footnote"><span>{openWork.length} 项未完工作</span><span>草稿按项目自动保存</span></div>
  </section>;
}

function WorkPhase({ work, state, members, timeZone, focused, focusNonce, onOpenContent, disabled }: {
  work: BusinessWorkItem; state: BusinessSnapshot; members: Member[]; timeZone: string; focused: boolean; focusNonce: number;
  onOpenContent: (id: string, versionId?: string) => void; disabled: boolean;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? focused;
  useEffect(() => { if (focused) setOverride(true); }, [focused, focusNonce]);
  const issue = projectWorkIssue(work);
  const status = issue || workState(work);
  const memberName = (id?: string | null) => members.find(member => member.id === id)?.name || (id === 'user' ? '你' : id === 'service' ? '本机服务' : '待登记');
  const events = state.workHandoffs.filter(event => event.projectId === work.projectId && event.workItemId === work.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const receipt = currentWorkReceipt(work, state.workReceipts);
  const actions = state.actions.filter(action => (action.sourceWorkItemId || action.workItemId) === work.id);
  const eventNames: Record<string, string> = { assigned: '已派发', accepted: '本机已接纳', received: '成果已收取', verified: '验收通过', returned: '退回修改', blocked: '交接受阻', cancelled: '已取消', due_changed: '交付时间已调整', rescheduled: '交付时间已调整', overdue: '已超过预计时间', escalated: '已交负责人接续', responsibility_changed: '交接责任已调整', recovered: '已恢复接续', interrupted: '运行已中断', quarantined: '成果已隔离待核对' };
  const evidenceNames: Record<string, string> = { machine: '程序记录', execution_admission: '程序记录 · 本机接纳', machine_contract: '程序记录 · 交付核验', user_instruction: '用户决定', owner_decision: '负责人决定', agent_review: '成员审查', agent_claim: '成员说明' };
  const checkNames: Record<string, string> = { input_integrity: '工作输入与约定版本一致', declared_files: '约定文件已逐项收取', required_sections: '交付说明包含约定内容' };
  return <article className={`team-work-phase ${status.tone} ${focused ? 'is-focused' : ''}`} data-project-focus={`work-${work.id}`} tabIndex={-1}>
    <button className="team-phase-toggle" aria-expanded={expanded} onClick={() => setOverride(!expanded)}><span className="team-phase-glyph"><GitBranch size={16} /></span><span className="team-phase-copy"><small>{workRoleName(work)} · {memberName(work.memberId)}</small><strong>{work.title || work.objective}</strong></span><BusinessBadge {...status} /><ChevronDown size={16} className={expanded ? 'is-open' : ''} /></button>
    {issue && <p className="team-phase-warning">{work.waitReason || work.error || issue.detail || `${issue.label}，展开查看当前记录。`}</p>}
    {expanded && <div className="team-phase-body">
      <p className="team-phase-objective">{work.objective}</p>
      <dl className="team-handoff-people"><div><dt>负责</dt><dd>{memberName(work.memberId)}</dd></div><ArrowRight size={12} aria-hidden="true" /><div><dt>收取</dt><dd>{memberName(work.receiverId)}</dd></div><ArrowRight size={12} aria-hidden="true" /><div><dt>核对</dt><dd>{memberName(work.checkerId)}</dd></div></dl>
      {work.dueAt && <p className="team-phase-due">预计交付 {businessTime(work.dueAt, timeZone)}{work.originalDueAt && work.originalDueAt !== work.dueAt && <span> · 原预计 {businessTime(work.originalDueAt, timeZone)}</span>}</p>}
      {work.acceptanceCriteria?.length ? <div className="team-phase-contract"><strong>交付标准</strong><ul>{work.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></div> : <p className="team-evidence-empty">尚无单独登记的交付标准</p>}
      {work.summary && <div className="team-member-claim"><span>成员交付说明</span><p>{work.summary}</p></div>}
      {events.length > 0 && <ol className="team-handoff-history" aria-label="交接记录">{events.map(event => <li key={event.id} className={event.generation !== work.generation ? 'older' : ''}><span className="team-handoff-dot" /><div><strong>{eventNames[event.type] || '交接记录'}{event.generation !== work.generation && <small> · 先前第 {event.generation} 轮</small>}</strong><time>{businessTime(event.createdAt, timeZone)}</time>{event.message && <p>{event.message}</p>}<small>{evidenceNames[event.evidenceType] || '来源待核对'}{event.actorId && ` · ${memberName(event.actorId)}`}</small></div></li>)}</ol>}
      {receipt ? <details className="team-receipt"><summary><ShieldCheck size={13} />查看本轮程序收件记录 · {receipt.files.length} 份文件</summary><p>收取时间 {businessTime(receipt.createdAt, timeZone)}</p>
        <ul>{receipt.files.map(file => <li key={`${file.relativePath}:${file.sha256}`}><span>{file.relativePath}</span><code title={file.sha256}>{file.sha256.slice(0, 12)}</code></li>)}</ul>{receipt.checks.map((check, index) => <p key={index}>{checkNames[check] || check}</p>)}<p className="team-evidence-empty">该记录确认收件与对应版本；内容质量判断单独保留。</p></details>
        : <p className="team-evidence-empty">尚无与本轮成果匹配的程序收件记录</p>}
      {actions.length > 0 && <details className="team-phase-actions"><summary>查看 {actions.length} 条成员行动</summary>{actions.map(action => <div key={action.id}><strong>{({ propose_work: '安排后续工作', propose_fact: '提出项目资料', request_tool: '使用业务工具', ask_peer: '向同伴求助', contribute: '提交贡献', request_revision: '提出修改意见' } as Record<string, string>)[action.type] || '协作行动'}</strong><p>{actionBody(action) || '行动已登记'}</p></div>)}</details>}
    </div>}
    {work.contentId && <button className="team-phase-output" disabled={disabled} onClick={() => onOpenContent(work.contentId!, receipt?.versionId || undefined)}><FileText size={12} /><span>{projectContentTitle(state, work.contentId) || '查看关联整稿'}</span><ArrowRight size={12} /></button>}
  </article>;
}

function ProjectComposer({ project, bootstrap, onRefresh, onBusy, onSent }: ProjectHomeProps & { onSent: () => void }) {
  const draft = useTaskDraft(bootstrap.workspace.root, { kind: 'project-message', projectId: project.id }, { body: '', recipientId: '', requestId: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const lock = useRef(false);
  const send = async () => {
    if (lock.current || !draft.loaded || !draft.values.body?.trim()) return;
    lock.current = true; setBusy(true); onBusy(true); setError(''); setNotice('');
    try {
      const requestId = draft.values.requestId || crypto.randomUUID();
      draft.setField('requestId', requestId);
      if (!await draft.flush()) throw new Error('消息请求还未保存，请重试。');
      await api.sendProjectMessage(project.id, { requestId, body: draft.values.body.trim(), ...(draft.values.recipientId ? { recipientId: draft.values.recipientId } : {}) });
      const cleared = await draft.clear();
      setNotice(cleared ? '已交给成员，答复与处理进展会留在上方。' : '消息已送达，草稿尚未清理；重试会核对同一请求。');
      await onRefresh(); onSent();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '消息发送失败'); }
    finally { lock.current = false; setBusy(false); onBusy(false); }
  };
  const frozen = busy || !draft.loaded || Boolean(draft.values.requestId);
  const owner = bootstrap.members.find(member => member.id === project.ownerId);
  const recipient = draft.values.recipientId ? bootstrap.members.find(member => member.id === draft.values.recipientId) : owner;
  return <form className="team-project-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
    <textarea className="form-textarea" rows={2} aria-label="告诉负责人新的要求" placeholder="告诉负责人新的要求，团队会继续推进……" maxLength={12000} disabled={frozen} value={draft.values.body || ''} onChange={event => draft.setField('body', event.target.value)} />
    <div className="team-composer-footer"><div className="team-recipient-control"><span className="team-current-recipient">发给 <strong>{recipient?.name || (draft.values.recipientId ? '原指定成员' : '负责人')}</strong>{draft.values.recipientId ? ' · 指定成员' : ' · 负责人'}</span>
      <details className="team-recipient-options"><summary>调整收件人</summary><label><span>消息收件人</span><select className="form-select" aria-label="消息收件人" disabled={frozen} value={draft.values.recipientId || ''} onChange={event => draft.setField('recipientId', event.target.value)}><option value="">{owner?.name || '负责人'} · 协调团队</option>{bootstrap.members.filter(member => project.memberIds.includes(member.id) && member.id !== project.ownerId).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label></details></div>
      <button className="btn btn-primary" type="submit" disabled={busy || !draft.loaded || !draft.values.body?.trim()}><Send size={13} />{busy ? '正在发送' : draft.values.requestId ? '核对并重试' : '发送'}</button></div>
    {(error || draft.error) && <BusinessNotice tone="danger">{error || draft.error}</BusinessNotice>}{notice && <p className="team-composer-notice" role="status">{notice}</p>}
  </form>;
}
