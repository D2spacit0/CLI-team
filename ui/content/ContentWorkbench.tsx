import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Clock3, ExternalLink, FileText, Image as ImageIcon, Link2, LockKeyhole, RefreshCw, ScanLine, ShieldCheck, UserRound, X } from 'lucide-react';
import { api } from '../api';
import type { Bootstrap, BusinessProject, BusinessSnapshot, ContentItem, ContentRevision, PublicationPreview } from '../types';
import { useTaskDraft } from '../taskDrafts';
import { BusinessBadge, BusinessNotice, CollaborationHistory } from '../projects/BusinessComponents';
import { businessTime, contentGateSummary, contentState, currentContentVersion, itemEligibility, latestAttempt, revisionChanges, safeSourceUrl, unresolvedSubmission } from '../projects/businessState';
import './content-workbench.css';

export default function ContentWorkbench({ item, project, state, bootstrap, dataRevision, onRefresh, onBack, onSettings, onBusy,
  embedded = false, requestedVersionId, onVersionChange }: {
  item: ContentItem; project: BusinessProject; state: BusinessSnapshot; bootstrap: Bootstrap; dataRevision: number;
  onRefresh: () => Promise<void>; onBack: () => void; onSettings: () => void; onBusy: (busy: boolean) => void;
  embedded?: boolean; requestedVersionId?: string | null; onVersionChange?: (versionId: string) => void;
}) {
  const [versionId, setVersionId] = useState(() => requestedVersionId || currentContentVersion(item) || '');
  const [preview, setPreview] = useState<PublicationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewError, setPreviewError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState('');
  const [sideTab, setSideTab] = useState<'reviews' | 'collaboration' | 'versions'>('reviews');
  const [showRevisionForm, setShowRevisionForm] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [imageIndex, setImageIndex] = useState<number | null>(null);
  const [imageStates, setImageStates] = useState<Record<string, boolean>>({});
  const [imageReloadKey, setImageReloadKey] = useState(0);
  const [noteUrl, setNoteUrl] = useState('');
  const sequence = useRef(0);
  const lock = useRef(false);
  const versions = state.contentRevisions.filter((entry) => entry.contentId === item.id).sort((a, b) => b.revision - a.revision);
  const selected = versions.find((entry) => entry.id === versionId) || null;
  const revision = preview?.versionId === versionId && preview.revision?.id === versionId ? preview.revision : selected;
  const previous = revision?.parentId ? versions.find((entry) => entry.id === revision.parentId) || null : null;
  const stale = versionId !== currentContentVersion(item);
  const attempt = preview?.attempt || latestAttempt(state, item.id);
  const submitting = attempt?.status === 'sending';
  const uncertain = unresolvedSubmission(attempt);
  const submissionFrozen = submitting || uncertain;
  const verificationId = attempt?.id || preview?.approval?.id;
  const payload = preview?.versionId === versionId ? preview.payload : revision ? { title: revision.title, body: revision.body, tags: revision.tags, images: revision.images, visibility: revision.visibility } : null;
  const eligibility = preview?.eligibility || itemEligibility(state, item);
  const checks = preview?.checks || state.contentChecks.filter((entry) => entry.contentId === item.id);
  const reviews = preview?.reviews || state.reviews.filter((entry) => entry.contentId === item.id);
  const gates = revision ? contentGateSummary(revision, eligibility, checks, reviews) : null;
  const draft = useTaskDraft(bootstrap.workspace.root, versionId ? { kind: 'content-revision-request', contentId: item.id, versionId } : null, { feedback: '', requestId: '' });
  const refreshPreview = useCallback(async (quiet = false) => {
    if (!versionId) { setLoading(false); return; }
    const current = ++sequence.current;
    if (!quiet) setLoading(true);
    try {
      const result = await api.getPublicationPreview(item.id, versionId);
      if (current !== sequence.current) return;
      if (result.contentId !== item.id || result.versionId !== versionId) throw new Error('整稿响应与当前选择的版本不一致，请重新读取。');
      setPreview(result); setPreviewError('');
    } catch (reason) { if (current === sequence.current) setPreviewError(reason instanceof Error ? reason.message : '整稿读取失败'); }
    finally { if (current === sequence.current) setLoading(false); }
  }, [item.id, versionId]);
  useEffect(() => { setPreview(null); setPreviewError(''); void refreshPreview(); return () => { sequence.current++; }; }, [refreshPreview]);
  useEffect(() => { void refreshPreview(true); }, [dataRevision]);
  useEffect(() => {
    if (!versionId && currentContentVersion(item)) setVersionId(currentContentVersion(item)!);
  }, [item, versionId]);
  useEffect(() => {
    if (requestedVersionId && requestedVersionId !== versionId && !lock.current) {
      setVersionId(requestedVersionId); setImageIndex(null); setShowRevisionForm(false);
    }
  }, [requestedVersionId]);
  const selectVersion = (next: string) => {
    setVersionId(next); setImageIndex(null); setShowRevisionForm(false); onVersionChange?.(next);
  };
  useEffect(() => () => onBusy(false), []);
  const run = async (name: string, operation: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setAction(name); onBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败，请重试'); }
    finally { lock.current = false; setBusy(false); setAction(''); onBusy(false); }
  };
  const hasDesktopApproval = typeof window.cliTeamDesktop?.requestPublicationApproval === 'function';
  const imagesReady = Boolean(payload?.images.length && payload.images.every((_image, index) => imageStates[`${versionId}:${index}`] === true));
  const blockers = [
    ...(preview?.blockers || []),
    ...(!hasDesktopApproval ? ['请在桌面工作台完成最终发布确认。'] : []),
    ...(stale ? ['当前正在查看旧版本，请先查看最新整稿。'] : []),
    ...(project.status !== 'active' || bootstrap.workspace.paused ? ['项目或工作区已暂停，请恢复后再批准发布。'] : []),
    ...(previewError ? ['当前整稿状态未能刷新，批准已暂停。'] : []),
    ...(payload?.images.length && !imagesReady ? ['配图尚未完整显示，请等待加载或刷新后确认。'] : []),
  ];
  const canApprove = Boolean(preview?.canApprove && preview.approvalDigest && gates?.machinePassed && gates?.reviewPassed && !blockers.length && !loading && !submissionFrozen);
  const approve = () => run('approval', async () => {
    if (!preview || !canApprove || !window.cliTeamDesktop) return;
    const receipt = await window.cliTeamDesktop.requestPublicationApproval(item.id, versionId, preview.approvalDigest);
    if (receipt.cancelled) { setNotice('已取消本次确认，稿件仍保留。'); return; }
    await onRefresh(); await refreshPreview();
    setNotice('最终确认已完成。发布执行与平台核实结果会继续显示在这里。');
  });
  const revise = () => run('revision', async () => {
    const requestId = draft.values.requestId || crypto.randomUUID();
    draft.setField('requestId', requestId);
    if (!await draft.flush()) throw new Error('修改要求尚未保存，请重试。');
    await api.requestContentRevision(item.id, { versionId, feedback: draft.values.feedback.trim(), requestId });
    const cleared = await draft.clear();
    await onRefresh(); await refreshPreview();
    setShowRevisionForm(!cleared);
    setNotice(cleared ? '修改要求已交给团队。新版本会重新检查与审稿，再送你确认。' : '修改要求已提交，草稿尚未清理；重复提交会核对同一请求。');
  });
  const reconcile = () => run('reconcile', async () => {
    if (!verificationId) throw new Error('尚未找到可核实的发布记录。');
    await api.reconcilePublication(verificationId, noteUrl.trim() || undefined);
    await onRefresh(); await refreshPreview(); setNotice('已请求回读核实，不会再次提交稿件。');
  });
  const revoke = () => run('revoke', async () => {
    if (!preview?.approval?.id) throw new Error('尚未找到批准记录。');
    await api.revokePublication(preview.approval.id); await onRefresh(); await refreshPreview(); setNotice('已核对撤销结果，请以当前发布状态为准。');
  });
  const members = bootstrap.members;
  const workIds = new Set(state.workItems.filter((work) => work.contentId === item.id).map((work) => work.id));
  const relatedThreads = state.collaborationThreads.filter((thread) => thread.contentId === item.id || workIds.has(thread.workItemId || '') || workIds.has(thread.sourceWorkItemId || ''));
  const relatedActions = state.actions.filter((entry) => entry.contentId === item.id || workIds.has(entry.sourceWorkItemId || entry.workItemId || ''))
    .map(entry => ({ ...entry, memberId: entry.memberId || state.workItems.find(work => work.id === (entry.sourceWorkItemId || entry.workItemId))?.memberId }));
  const closeImage = useCallback(() => setImageIndex(null), []);
  return <div className={`business-content-workbench content-review-dock ${embedded ? 'team-embedded-manuscript' : ''}`} data-content-workbench={item.id} data-version-id={versionId}>
    <header className="business-content-header"><div className="business-content-breadcrumb"><button className="btn btn-icon-only btn-secondary" aria-label={embedded ? '收起稿件面板' : '返回项目内容'} disabled={busy} onClick={onBack}>{embedded ? <X size={16} /> : <ArrowLeft size={16} />}</button>
      <div><span>{project.name}</span><h1>整稿与发布确认</h1></div><BusinessBadge {...contentState(state, item)} /></div>
      <div className="business-header-actions"><select className="form-select business-version-select" aria-label="查看稿件版本" disabled={busy} value={versionId} onChange={(event) => selectVersion(event.target.value)}>
        {!versions.length && <option value="">尚未形成版本</option>}{versions.map((entry) => <option key={entry.id} value={entry.id}>版本 {entry.revision}{entry.id === currentContentVersion(item) ? ' · 当前' : ' · 历史'}</option>)}</select>
        <button className="btn btn-secondary btn-icon-only" disabled={busy || loading} aria-label="刷新整稿状态" title="刷新整稿状态" onClick={() => { setImageStates({}); setImageReloadKey((value) => value + 1); void refreshPreview(); }}><RefreshCw size={14} /></button></div>
    </header>
    <div className="business-content-scroll">
      {stale && <BusinessNotice action={<button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => selectVersion(currentContentVersion(item) || '')}>查看最新整稿</button>}>团队已经更新稿件。当前展示的历史版本不能继续批准。</BusinessNotice>}
      {previewError && <BusinessNotice tone="danger" action={<button className="btn btn-sm btn-secondary" disabled={loading} onClick={() => void refreshPreview()}>重试读取</button>}>{previewError}</BusinessNotice>}
      {(error || notice) && <BusinessNotice tone={error ? 'danger' : 'ready'}>{error || notice}</BusinessNotice>}
      {submissionFrozen && <BusinessNotice><strong>{submitting ? '这篇稿件已经开始提交。' : '这篇稿件可能已经提交，结果待核实。'}</strong> 原批准版本保持冻结，恢复连接只会继续回读，不会重新发文。{attempt?.verificationBlocked && <p>{attempt.verificationBlocked}</p>}</BusinessNotice>}
      {!payload || !revision ? <div className="business-content-not-ready"><ImageIcon size={28} /><h2>{loading ? '正在读取整稿' : '整稿还在制作中'}</h2><p>团队收取文案与实际配图后，会在这里显示完整版本。</p><button className="btn btn-secondary" onClick={onBack}>返回查看协作进展</button></div> : <>
        <div className="business-content-columns">
          <section className="business-proof-sheet" aria-label="用于发布的固定整稿">
            <div className="business-proof-label"><span><FileText size={13} />用于发布的整稿</span><span className="content-version-stamp"><b>版本 {revision.revision}</b><time>{businessTime(revision.createdAt, project.timeZone)}</time></span></div>
            <h2>{payload.title}</h2>
            <div className="business-image-strip" aria-label="按发布顺序排列的图片">{payload.images.map((image, index) => <figure key={`${image.sha256}-${index}`}>
              <button className="business-image-button" onClick={() => setImageIndex(index)} aria-label={`放大第 ${index + 1} 张图片`}><img src={`${api.contentImageUrl(item.id, versionId, index)}?load=${imageReloadKey}`} alt={`第 ${index + 1} 张：${revision.images[index]?.name || payload.title}`} onLoad={() => setImageStates((value) => ({ ...value, [`${versionId}:${index}`]: true }))} onError={() => setImageStates((value) => ({ ...value, [`${versionId}:${index}`]: false }))} />{imageStates[`${versionId}:${index}`] === false && <span className="business-image-load-error">图片未能加载，请刷新</span>}</button>
              <figcaption><span>{index + 1} / {payload.images.length}</span><span>{revision.images[index]?.templateVersion ? '模板制作' : '导入素材'}</span></figcaption>
            </figure>)}</div>
            {!payload.images.length && <BusinessNotice>尚未收取实际配图，不能批准发布。</BusinessNotice>}
            <div className="content-body-heading"><span>发布正文</span><span>{Array.from(payload.body).length} 字</span></div>
            <div className="business-payload-body">{payload.body}</div>
            <div className="business-content-tags">{payload.tags.map((tag, index) => <span key={`${tag}-${index}`}>#{tag.replace(/^#+/, '')}</span>)}</div>
            <footer className="business-proof-footer"><span>{Array.from(payload.title).length} 字标题 · {Array.from(payload.body).length} 字正文 · {payload.images.length} 张图片</span><span>上方展示的是规范化后的发布内容</span></footer>
          </section>
          <aside className="business-content-inspection" aria-label="本版检查、审稿与发布授权">
            <section className="business-publish-scope"><h2>发布范围</h2><dl><div><dt>账号</dt><dd>{preview?.account?.name || preview?.account?.label || project.account?.name || '尚未接入账号'}</dd></div>
              <div><dt>可见范围</dt><dd>{visibilityLabel(payload.visibility)}</dd></div><div><dt>执行时间</dt><dd>{preview?.timeWindow?.display || '批准后 10 分钟内'}</dd></div></dl>
              {!submissionFrozen && <button className="business-text-button" disabled={busy || stale} onClick={() => setShowSchedule((value) => !value)}><Clock3 size={13} />{showSchedule ? '收起排期' : '调整发布时间与范围'}</button>}
              {showSchedule && <ScheduleForm revision={revision} disabled={busy || stale} onSave={(values) => run('schedule', async () => {
                await api.setContentSchedule(item.id, { versionId, ...values }); await onRefresh(); await refreshPreview(); setShowSchedule(false); setNotice('发布范围已更新。请查看新版本后重新确认。');
              })} />}
            </section>
            <div className="business-inspection-tabs" role="tablist" aria-label="整稿检查与协作"><button role="tab" aria-selected={sideTab === 'reviews'} onClick={() => setSideTab('reviews')}>检查与审稿</button><button role="tab" aria-selected={sideTab === 'collaboration'} onClick={() => setSideTab('collaboration')}>协作与材料</button><button role="tab" aria-selected={sideTab === 'versions'} onClick={() => setSideTab('versions')}>版本改动</button></div>
            <div className="business-inspection-content">
              {sideTab === 'reviews' && <>
                <section className="business-evidence-section" data-evidence="machine"><div className="content-evidence-heading"><h3><ScanLine size={15} />程序检查</h3><span>机器核验</span></div>{gates && <BusinessBadge {...gates.machine} />}
                  <p className="business-muted">核对字段、实际图片、尺寸、来源与版本摘要。</p>{eligibility?.status === 'invalid' && <p className="business-check-issue">{eligibility.reason || '上游资料变化，旧检查不再适用于当前稿件。'}</p>}
                  {checks.filter((check) => check.versionId === versionId).flatMap((check) => check.findings || []).map((finding, index) => <p key={index} className="business-check-issue">{finding.message}</p>)}</section>
                <section className="business-evidence-section" data-evidence="agent"><div className="content-evidence-heading"><h3><UserRound size={15} />团队独立审稿</h3><span>成员意见</span></div>{gates && <BusinessBadge {...gates.review} />}
                  <p className="business-muted">以下是成员对内容质量的判断，单独保留审稿意见。</p>
                  {reviews.filter((review) => review.versionId === versionId).length ? reviews.filter((review) => review.versionId === versionId).map((review) => <article className="business-review-entry" key={review.id}>
                    <div><strong>{members.find((member) => member.id === review.memberId)?.name || '审稿成员'}</strong><span>{businessTime(review.createdAt, project.timeZone)}</span></div>
                    <p>{review.summary}</p><span className={review.verdict === 'approve' && review.status === 'current' ? 'business-review-approved' : 'business-check-issue'}>{revision.authorMemberIds.includes(review.memberId) ? '作者自述，不能替代独立审稿' : review.status !== 'current' ? '审稿来源尚未核验，不能用于发布批准' : review.verdict === 'approve' ? '建议批准' : '请求修改'}{eligibility?.reviewId && eligibility.reviewId !== review.id ? ' · 先前意见' : ''}</span>
                    {review.evidenceReuse === 'schedule_only' && review.reusedFromReviewId && <p className="business-muted">沿用内容审查，发布范围已更新，需重新批准。</p>}
                    {review.findings?.map((finding, index) => <p key={index} className="business-check-issue">{typeof finding === 'string' ? finding : finding.message}</p>)}
                  </article>) : <p className="business-empty-inline">尚无绑定此版本的独立审稿记录。</p>}
                </section>
                <section className="business-evidence-section" data-evidence="approval"><div className="content-evidence-heading"><h3><LockKeyhole size={15} />你的发布批准</h3><span>本人授权</span></div>{preview?.approval?.versionId === versionId ? <><BusinessBadge label={approvalLabel(preview.approval.status)} tone={['approved', 'queued'].includes(preview.approval.status) ? 'ready' : 'attention'} /><p className="business-muted">{businessTime(preview.approval.approvedAt || preview.approval.createdAt, project.timeZone)}</p>{preview.approval.reason && <p>{preview.approval.reason}</p>}</> : <p className="business-empty-inline">尚未批准这一版本。</p>}</section>
              </>}
              {sideTab === 'collaboration' && <>
                <section className="business-evidence-section"><h3>采用的材料</h3>{revision.inputRefs?.length ? <ul className="business-adopted-materials">{revision.inputRefs.map((ref, index) => {
                  const fact = state.projectFacts.find((entry) => entry.id === ref.id);
                  return <li key={`${ref.id}-${index}`}><strong>{ref.label || fact?.content || (ref.kind === 'brief' ? '项目简报' : '已登记成果')}</strong><span>版本 {ref.version || ref.revision || ref.versionId || '已绑定'}</span>
                    {fact?.sources?.map((source, position) => { const url = safeSourceUrl(source.url); return url ? <a key={position} href={url} target="_blank" rel="noreferrer"><Link2 size={12} />{source.label}</a> : <small key={position}>{source.label}</small>; })}</li>;
                })}</ul> : <p className="business-empty-inline">尚未登记采用的资料版本。</p>}</section>
                <section className="business-evidence-section"><h3>成员交接与修改答复</h3><CollaborationHistory threads={relatedThreads} actions={relatedActions} members={members} timeZone={project.timeZone} /></section>
              </>}
              {sideTab === 'versions' && <>
                <section className="business-evidence-section"><h3>本版改动</h3><ul className="business-version-changes">{revisionChanges(previous, revision).map((change) => <li key={change}><Check size={13} />{change}</li>)}</ul>{revision.changeSummary && <p>{revision.changeSummary}</p>}</section>
                {previous && <section className="business-evidence-section"><h3>与版本 {previous.revision} 对照</h3>{previous.title !== revision.title && <div className="business-text-diff"><del>{previous.title}</del><ins>{revision.title}</ins></div>}
                  {previous.body !== revision.body && <details className="business-body-diff"><summary>展开正文对照</summary><div><strong>上一版</strong><p>{previous.body}</p></div><div><strong>当前所选版本</strong><p>{revision.body}</p></div></details>}</section>}
                <section className="business-evidence-section"><h3>版本记录</h3>{versions.map((entry) => <button className={`business-version-row ${entry.id === versionId ? 'active' : ''}`} key={entry.id} disabled={busy} onClick={() => selectVersion(entry.id)}><strong>版本 {entry.revision}</strong><span>{businessTime(entry.createdAt, project.timeZone)}</span>{entry.id === versionId && <Check size={13} />}</button>)}</section>
              </>}
            </div>
          </aside>
        </div>
        {uncertain && <section className="business-reconcile-panel"><h2>核实本次发布</h2><p>可补充这篇笔记的链接，再由程序核对账号、正文与图片关联。链接本身不会被当成成功证据。</p>
          <div className="business-reconcile-form"><input className="form-input" aria-label="需要核实的笔记链接" placeholder="笔记链接（选填）" value={noteUrl} disabled={busy} onChange={(event) => setNoteUrl(event.target.value)} /><button className="btn btn-secondary" disabled={busy || !verificationId} onClick={() => void reconcile()}><RefreshCw size={14} />{action === 'reconcile' ? '正在核实' : '回读核实'}</button></div>
        </section>}
        {attempt?.status === 'published' && <BusinessNotice tone="ready">平台身份与本版内容已核实。{attempt.evidence?.verifiedAt && <span> 核实时间：{businessTime(attempt.evidence.verifiedAt, project.timeZone)}。</span>}{safeSourceUrl(attempt.noteUrl || attempt.evidence?.noteUrl) && <a href={safeSourceUrl(attempt.noteUrl || attempt.evidence?.noteUrl)!} target="_blank" rel="noreferrer" className="business-published-link">查看已发布笔记 <ExternalLink size={13} /></a>}</BusinessNotice>}
        {showRevisionForm && !submissionFrozen && <form className="business-revision-form" onSubmit={(event) => { event.preventDefault(); void revise(); }}><label className="form-group"><span className="form-label">希望团队怎样修改</span><textarea className="form-textarea" aria-label="希望团队怎样修改" rows={3} required maxLength={6000} disabled={busy || !draft.loaded || Boolean(draft.values.requestId)} value={draft.values.feedback || ''} placeholder="直接写一句修改要求，团队会将意见交给相关成员处理。" onChange={(event) => draft.setField('feedback', event.target.value)} /></label>
          {draft.error && <BusinessNotice tone="danger">{draft.error}</BusinessNotice>}<div className="business-form-actions"><span className="business-muted">修改要求绑定当前查看的版本 {revision.revision}</span><button className="btn btn-primary" disabled={busy || !draft.loaded || !draft.values.feedback?.trim() || stale} type="submit">{action === 'revision' ? '正在交给团队' : draft.values.requestId ? '核对并重试' : '退回团队修改'}</button></div></form>}
      </>}
    </div>
    {payload && revision && <footer className="business-publication-actions" data-approval-ready={canApprove}>
      <div className="content-authorization-summary"><span className="content-authorization-label"><LockKeyhole size={12} />最终发布授权</span>{!submissionFrozen && blockers.length > 0 ? <><strong>发布条件尚未满足</strong><p>{[...new Set(blockers)].slice(0, 3).join(' ')}</p>{!project.account && <button className="business-text-button" onClick={onSettings}>去接入发布账号</button>}</> : <><strong>{submissionFrozen ? '本次提交只进行核实' : preview?.canApprove ? '整稿已具备送审条件' : '等待完成检查与审稿'}</strong><p>{submissionFrozen ? '没有重新发文入口。' : '批准将打开桌面最终确认，核对账号、版本与发布时间。'}</p></>}</div>
      <div className="business-action-buttons">{preview?.approval && ['approved', 'queued'].includes(preview.approval.status) && !submissionFrozen ? <button className="btn btn-secondary" disabled={busy} onClick={() => void revoke()}>撤销未执行批准</button> : null}
        {!submissionFrozen && <button className="btn btn-secondary" disabled={busy || stale || attempt?.status === 'published'} onClick={() => setShowRevisionForm((value) => !value)}>{showRevisionForm ? '收起修改要求' : '退回修改'}</button>}
        <button className="btn btn-primary business-approve-button" disabled={busy || !canApprove} onClick={() => void approve()}><ShieldCheck size={16} />{action === 'approval' ? '等待最终确认' : '批准本版发布'}</button></div>
    </footer>}
    {imageIndex !== null && payload && revision && <ImageLightbox contentId={item.id} versionId={versionId} title={payload.title} index={imageIndex} count={payload.images.length} onIndex={setImageIndex} onClose={closeImage} />}
  </div>;
}

function visibilityLabel(value: string) {
  return ({ public: '公开可见', private: '仅自己可见', friends: '好友可见' } as Record<string, string>)[value] || value || '待确认';
}
function approvalLabel(value: string) {
  return ({ approved: '已批准', queued: '已批准待执行', expired: '批准已过期', revoked: '批准已撤销', invalid: '批准已失效', invalidated: '批准已失效', consumed: '批准已用于本次提交' } as Record<string, string>)[value] || value;
}

function ScheduleForm({ revision, disabled, onSave }: {
  revision: ContentRevision; disabled: boolean;
  onSave: (data: { mode: 'immediate' | 'scheduled'; startsAt?: string; visibility: string }) => Promise<void>;
}) {
  const initialKind = revision.schedule?.mode || revision.schedule?.kind;
  const [mode, setMode] = useState<'immediate' | 'scheduled'>(initialKind === 'scheduled' ? 'scheduled' : 'immediate');
  const [startsAt, setStartsAt] = useState(() => {
    if (!revision.schedule?.startsAt) return '';
    const date = new Date(revision.schedule.startsAt);
    if (Number.isNaN(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [visibility, setVisibility] = useState(revision.visibility || 'public');
  const [error, setError] = useState('');
  return <form className="business-schedule-form" onSubmit={(event) => {
    event.preventDefault(); setError('');
    if (mode === 'scheduled' && (!startsAt || new Date(startsAt).getTime() <= Date.now())) { setError('请选择未来的开始时间。'); return; }
    void onSave({ mode, visibility, ...(mode === 'scheduled' ? { startsAt: new Date(startsAt).toISOString() } : {}) });
  }}><label className="form-group"><span className="form-label">发布时间</span><select className="form-select" value={mode} disabled={disabled} onChange={(event) => setMode(event.target.value as 'immediate' | 'scheduled')}><option value="immediate">批准后 10 分钟内</option><option value="scheduled">指定执行时间</option></select></label>
    {mode === 'scheduled' && <label className="form-group"><span className="form-label">开始时间（本机时区）</span><input className="form-input" type="datetime-local" required disabled={disabled} value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /><span className="business-muted">开始后的 10 分钟内执行，过期需要重新批准。</span></label>}
    <label className="form-group"><span className="form-label">可见范围</span><select className="form-select" value={visibility} disabled={disabled} onChange={(event) => setVisibility(event.target.value)}><option value="public">公开可见</option><option value="private">仅自己可见</option></select></label>
    {error && <p className="business-check-issue" role="alert">{error}</p>}<button className="btn btn-secondary" type="submit" disabled={disabled}>保存为新的发布版本</button>
  </form>;
}

function ImageLightbox({ contentId, versionId, title, index, count, onIndex, onClose }: {
  contentId: string; versionId: string; title: string; index: number; count: number;
  onIndex: (index: number) => void; onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const controls = useRef({ index, count, onClose, onIndex });
  controls.current = { index, count, onClose, onIndex };
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const application = document.getElementById('root');
    const wasInert = application?.inert || false;
    if (application) application.inert = true;
    closeButton.current?.focus();
    const listener = (event: KeyboardEvent) => {
      const active = controls.current;
      if (event.key === 'Escape') { event.preventDefault(); active.onClose(); }
      if (event.key === 'ArrowRight' && active.index < active.count - 1) { event.preventDefault(); active.onIndex(active.index + 1); }
      if (event.key === 'ArrowLeft' && active.index > 0) { event.preventDefault(); active.onIndex(active.index - 1); }
      if (event.key === 'Tab') {
        const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || [])];
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', listener);
    return () => {
      window.removeEventListener('keydown', listener);
      if (application) application.inert = wasInert;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<div ref={dialog} className="business-lightbox content-image-lightbox" role="dialog" aria-modal="true" aria-label={`查看第 ${index + 1} 张配图`}>
    <header><strong>{title} · {index + 1} / {count}</strong><button ref={closeButton} className="btn btn-icon-only btn-secondary" aria-label="关闭图片预览" onClick={onClose}><X size={18} /></button></header>
    <img src={api.contentImageUrl(contentId, versionId, index)} alt={`第 ${index + 1} 张完整配图`} />
    <footer><button className="btn btn-secondary" disabled={index === 0} onClick={() => onIndex(index - 1)}>上一张</button><span>按发布顺序查看</span><button className="btn btn-secondary" disabled={index === count - 1} onClick={() => onIndex(index + 1)}>下一张</button></footer>
  </div>, document.body);
}
