import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ChevronDown, FileText, GitBranch, Send, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useTaskDraft } from '../taskDrafts';
import type { BusinessSnapshot, BusinessWorkItem, Member } from '../types';
import type { ProjectHomeProps } from './ProjectHome';
import { BusinessBadge, BusinessNotice } from './BusinessComponents';
import { businessTime, workState } from './businessState';
import { actionBody, currentWorkReceipt, projectContentTitle, projectMessages, workRoleName } from './projectWorkspaceState';
import { projectWorkIssue } from './projectDailyStatus';
import { currentProjectOutput, projectOutputDisplay } from './projectOutputDisplay';
import { useBusinessBusy } from './useBusinessBusy';

export default function ProjectConversation(props: ProjectHomeProps) {
  const { project, bootstrap, state, onOpenContent, onBusy, onShowPanel, focusId, focusNonce = 0, covered = false, inspectorOpen = false } = props;
  const { busy, report } = useBusinessBusy(onBusy);
  const reportMessage = useCallback((value: boolean) => report('message', value), [report]);
  const [hasNewActivity, setHasNewActivity] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const followsLatest = useRef(true);
  const latestActivityTarget = useRef<'message' | 'output'>('output');
  const owner = bootstrap.members.find(member => member.id === project.ownerId);
  const memberName = (id?: string | null) => bootstrap.members.find(member => member.id === id)?.name || (id === 'user' ? '你' : '团队');
  const messages = useMemo(() => projectMessages(state, project.id), [state, project.id]);
  const work = state.workItems.filter(item => item.projectId === project.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const featured = currentProjectOutput(state, project.id, props.selectedContentId);
  const history = state.contentItems.filter(item => item.projectId === project.id && item.id !== featured?.item.id)
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
    .map(item => projectOutputDisplay(state, item));
  const focusedWorkExists = work.some(item => focusId === `work-${item.id}`);
  const focusedHistoryExists = history.some(output => focusId === `content-${output.item.id}`);
  const focusedTargetVisible = (!focusedWorkExists || processOpen) && (!focusedHistoryExists || historyOpen);
  const messageKey = [messages.length, messages.at(-1)?.id, messages.at(-1)?.body].join('|');
  const outputKey = [featured?.item.id, featured?.versionId].join('|');
  const previousActivity = useRef({ messageKey, outputKey });
  const latestScrollTop = () => {
    const node = scroller.current;
    if (!node) return 0;
    const output = node.querySelector<HTMLElement>('.team-featured-output');
    const message = node.querySelector<HTMLElement>('.team-conversation-timeline > li:last-child .team-message');
    const target = (latestActivityTarget.current === 'message' ? message || output : output || message)
      || node.querySelector<HTMLElement>('.team-conversation-empty');
    if (!target) return 0;
    const padding = Number.parseFloat(getComputedStyle(node).paddingTop) || 0;
    const top = node.scrollTop + target.getBoundingClientRect().top - node.getBoundingClientRect().top - padding;
    return Math.max(0, Math.min(top, node.scrollHeight - node.clientHeight));
  };
  const jumpToLatest = (target: 'message' | 'output' = latestActivityTarget.current) => {
    latestActivityTarget.current = target;
    if (!scroller.current) return;
    scroller.current.scrollTop = latestScrollTop();
    followsLatest.current = true;
    setHasNewActivity(false);
  };
  useLayoutEffect(() => {
    if (previousActivity.current.outputKey !== outputKey) latestActivityTarget.current = 'output';
    else if (previousActivity.current.messageKey !== messageKey) latestActivityTarget.current = 'message';
    previousActivity.current = { messageKey, outputKey };
    if (!followsLatest.current) setHasNewActivity(true);
    else if (!covered) jumpToLatest();
  }, [messageKey, outputKey]);
  useLayoutEffect(() => {
    if (!covered && followsLatest.current) jumpToLatest();
  }, [inspectorOpen, covered]);
  useEffect(() => {
    if (covered) return;
    if (focusedWorkExists) setProcessOpen(true);
    if (focusedHistoryExists) setHistoryOpen(true);
  }, [focusId, focusNonce, covered, focusedWorkExists, focusedHistoryExists]);
  useEffect(() => {
    if (!focusId || covered || !focusedTargetVisible) return;
    const frame = requestAnimationFrame(() => {
      const node = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-project-focus]') || [])]
        .find(element => element.dataset.projectFocus === focusId);
      if (!node?.getClientRects().length) return;
      followsLatest.current = false;
      node.focus({ preventScroll: true });
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusId, focusNonce, covered, focusedWorkExists, focusedHistoryExists, focusedTargetVisible]);
  return <section className="team-conversation" aria-label={`${project.name}的负责人会话`} data-project-id={project.id} inert={covered}>
    <header className="team-conversation-header">
      <div className="team-project-heading"><h2>对话</h2><span>{owner?.name || '负责人'}</span></div>
      <div className="team-header-tools"><button type="button" disabled={busy} onClick={() => onShowPanel?.('resources')}>资料</button>
        <button type="button" disabled={busy} onClick={() => onShowPanel?.('team')}>团队</button>
        <button type="button" disabled={busy} onClick={() => onShowPanel?.('recap')}>复盘</button></div>
    </header>
    <div className="team-conversation-scroll" ref={scroller} onScroll={() => {
      const node = scroller.current;
      if (!node || covered) return;
      // Reading older messages or expanded records stops following until the user chooses the latest content again.
      if (followsLatest.current && Math.abs(node.scrollTop - latestScrollTop()) >= 72) followsLatest.current = false;
      if (followsLatest.current) setHasNewActivity(false);
    }}>
      {!messages.length ? <div className="team-conversation-empty"><h2>还没有对话</h2><p>可以在下方补充要求，负责人的答复会保留在这里。</p></div>
        : <ol className="team-conversation-timeline" aria-label="团队对话">{messages.map(message => <li key={message.id}>
          <article className={`team-message ${message.actorId === 'user' ? 'from-user' : ''} ${focusId === message.id ? 'is-focused' : ''}`} data-project-focus={message.id} tabIndex={-1}>
            <div className="team-message-byline"><span className="team-message-avatar">{memberName(message.actorId).slice(0, 1)}</span><strong>{memberName(message.actorId)}</strong><span>{message.actorId === project.ownerId ? '负责人' : message.actorId === 'user' ? '' : message.label}</span><time>{businessTime(message.createdAt, project.timeZone)}</time></div>
            <div className="team-message-body">{message.body}</div>
            <div className="team-message-context">{message.contentId && <button disabled={busy} onClick={() => onOpenContent(message.contentId!, message.versionId)}><FileText size={12} />查看关联内容</button>}
              {message.actorId === 'user' && <span>{({ pending: '已登记，等待接手', delivered: '已送达成员', answered: '已有答复，待核对', resolved: '已有答复', superseded: '对应工作已更新' } as Record<string, string>)[message.status || ''] || '已登记'}</span>}
              {message.evidenceType === 'agent_claim' && <span>成员说明</span>}</div>
          </article>
        </li>)}</ol>}
      {!inspectorOpen && (featured ? <article className="team-featured-output" aria-label="当前成果" data-content-id={featured.item.id} data-version-id={featured.versionId || undefined} data-project-focus={`content-${featured.item.id}`} tabIndex={-1}>
        <div className="team-output-heading"><span>当前成果</span><small>{featured.revision ? `版本 ${featured.revision.revision} · ${featured.revision.images.length} 张配图${featured.frozen ? ' · 提交时版本' : ''}` : featured.frozen ? '提交时版本尚未读取' : '等待形成内容'}</small></div>
        <div className="team-featured-preview">{featured.revision?.images[0] ? <img src={api.contentImageUrl(featured.item.id, featured.revision.id, 0)} alt="当前成果首图" loading="lazy" /> : <span className="team-featured-image-empty" aria-label="尚无可查看的配图"><FileText size={22} /></span>}
          <div className="team-featured-copy"><h3>{featured.title}</h3><p className="team-featured-body">{featured.body}</p><button className="btn btn-secondary team-reopen-inspector" disabled={busy} onClick={() => onOpenContent(featured.item.id, featured.versionId || undefined)}>查看内容<ArrowRight size={13} /></button></div>
        </div>
      </article> : <div className="team-output-empty"><strong>内容准备好后会出现在这里</strong><p>{work.length ? '已有工作记录，可展开团队过程查看进度。' : '可以先补充资料或内容要求，形成完整内容后再查看。'}</p></div>)}
      {history.length > 0 && <details className="team-output-history" open={historyOpen} onToggle={event => {
        if (event.currentTarget.open) followsLatest.current = false;
        setHistoryOpen(event.currentTarget.open);
      }}>
        <summary>历史成果 <span>{history.length}</span><ChevronDown size={14} /></summary>
        <div>{history.map(output => <button key={output.item.id} className="team-history-row" data-project-focus={`content-${output.item.id}`} disabled={busy} onClick={() => onOpenContent(output.item.id, output.versionId || undefined)}>
          <span><strong>{output.title}</strong><small>{output.revision ? `版本 ${output.revision.revision}${output.frozen ? ' · 提交时版本' : ''}` : output.frozen ? '提交时版本尚未读取' : '等待形成内容'}</small></span><ArrowRight size={13} />
        </button>)}</div>
      </details>}
      <details className="team-process-details" open={processOpen} onToggle={event => {
        if (event.currentTarget.open) followsLatest.current = false;
        setProcessOpen(event.currentTarget.open);
      }}>
        <summary><GitBranch size={14} />查看团队过程 <span>{work.length}</span><ChevronDown size={14} /></summary>
        {work.length ? <ol className="team-process-timeline" aria-label="团队工作记录">{work.map(item => <li key={item.id}><WorkPhase work={item} state={state} members={bootstrap.members} timeZone={project.timeZone} focused={focusId === `work-${item.id}`} focusNonce={focusNonce} onOpenContent={onOpenContent} disabled={busy} /></li>)}</ol>
          : <p className="team-process-empty">尚未产生工作记录，实际安排与检查会保留在这里。</p>}
      </details>
    </div>
    {hasNewActivity && <button className="team-new-activity" onClick={() => jumpToLatest()}><ArrowDown size={13} />有新进展，回到最新</button>}
    <ProjectComposer {...props} onBusy={reportMessage} onSent={() => jumpToLatest('message')} />
    <div className="team-conversation-footnote">草稿按项目自动保存</div>
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
