import { useEffect, useRef, useState } from 'react';
import { FileUp, Pencil, X, Link2 } from 'lucide-react';
import { api } from '../api';
import type { Bootstrap, BusinessProject, BusinessSnapshot, ProjectFact } from '../types';
import { useTaskDraft } from '../taskDrafts';
import { BusinessNotice, ContentCard } from './BusinessComponents';
import { businessTime, metricDisplay, metricValues, publicationGroup, safeSourceUrl } from './businessState';
import type { ProjectPanel } from './projectWorkspaceState';
import type { ProjectSettingsSection } from './projectDailyStatus';
export { default } from './ProjectConversation';

export interface ProjectHomeProps {
  project: BusinessProject; bootstrap: Bootstrap; state: BusinessSnapshot;
  onRefresh: () => Promise<void>; onOpenContent: (id: string, versionId?: string) => void;
  onSettings: (section?: ProjectSettingsSection) => void; onBusy: (busy: boolean) => void;
  onShowPanel?: (panel: ProjectPanel) => void; onFocus?: (id: string) => void;
  focusId?: string | null; focusNonce?: number; selectedContentId?: string | null; covered?: boolean; inspectorOpen?: boolean;
}

export function ProjectResources({ project, bootstrap, state, onRefresh, onBusy }: ProjectHomeProps) {
  const factDraft = useTaskDraft(bootstrap.workspace.root, { kind: 'project-fact', projectId: project.id }, { content: '', type: 'fact', source: '', requestId: '' });
  const briefDraft = useTaskDraft(bootstrap.workspace.root, { kind: 'project-brief', projectId: project.id }, { objective: '', brief: '', expectedRevision: '' });
  const factType = (factDraft.values.type || 'fact') as ProjectFact['type'];
  const factContent = factDraft.values.content || '';
  const source = factDraft.values.source || '';
  const [editingBrief, setEditingBrief] = useState(false);
  const objective = briefDraft.values.objective || '';
  const brief = briefDraft.values.brief || '';
  const hydrated = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const facts = state.projectFacts.filter((fact) => fact.projectId === project.id);
  const materials = state.projectMaterials.filter((material) => material.projectId === project.id);
  const projectMaterials = materials.length ? materials : project.materials || [];
  useEffect(() => {
    if (!briefDraft.loaded || hydrated.current) return;
    hydrated.current = true;
    if (briefDraft.values.expectedRevision) setEditingBrief(true);
  }, [briefDraft.loaded, briefDraft.values.expectedRevision]);
  const run = async (action: () => Promise<unknown>, message: string) => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); onBusy(true); setError(''); setNotice('');
    try { await action(); await onRefresh(); setNotice(message); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '资料保存失败'); return false; }
    finally { lock.current = false; setBusy(false); onBusy(false); }
  };
  const importFile = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) { setError('单个材料文件不能超过 8 MiB。'); return; }
    await run(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const sha256 = [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await api.importProjectMaterial(project.id, file.name, btoa(binary), sha256);
    }, `已导入材料「${file.name}」。`);
  };
  return <div className="business-resources">
    {(error || notice) && <BusinessNotice tone={error ? 'danger' : 'ready'}>{error || notice}</BusinessNotice>}
    <section className="business-section"><div className="business-section-heading"><h2>目标与账号简报</h2>
      <button className="btn btn-sm btn-secondary" disabled={busy || !briefDraft.loaded} onClick={() => {
        if (!briefDraft.values.expectedRevision) briefDraft.setValues({ objective: project.objective, brief: project.brief || '', expectedRevision: String(project.revision) });
        setEditingBrief((value) => !value);
      }}>{editingBrief ? <X size={13} /> : <Pencil size={13} />}{editingBrief ? '收起编辑' : '修正简报'}</button></div>
      {editingBrief ? <form className="business-form" onSubmit={(event) => {
        event.preventDefault(); void run(async () => {
          if (!await briefDraft.flush()) throw new Error('简报草稿尚未保存，请重试。');
          await api.updateProject(project.id, { expectedRevision: Number(briefDraft.values.expectedRevision), objective: objective.trim(), brief: brief.trim() });
          await briefDraft.clear();
        }, '简报已更新。相关工作与整稿将按新资料重新检查。').then((saved) => { if (saved) setEditingBrief(false); });
      }}><label className="form-group"><span className="form-label">长期目标</span><textarea className="form-textarea" aria-label="长期目标" rows={3} value={objective} maxLength={6000} required disabled={busy} onChange={(event) => briefDraft.setField('objective', event.target.value)} /></label>
        <label className="form-group"><span className="form-label">账号简报</span><textarea className="form-textarea" aria-label="账号简报" rows={5} value={brief} maxLength={12000} disabled={busy} onChange={(event) => briefDraft.setField('brief', event.target.value)} /></label>
        {briefDraft.error && <BusinessNotice tone="danger" action={<button type="button" className="btn btn-sm btn-secondary" onClick={() => void briefDraft.retry()}>重试保存草稿</button>}>{briefDraft.error}</BusinessNotice>}
        <div className="business-form-actions"><span className="business-muted">填写内容自动保存。修改会使受影响的旧稿批准失效。</span><button type="submit" className="btn btn-primary" disabled={busy || !briefDraft.loaded || !objective.trim()}>保存简报</button></div>
      </form> : <div className="business-brief-copy"><strong>{project.objective}</strong><p>{project.brief || '尚未补充账号背景与内容要求。'}</p><small>简报版本 {project.briefVersion} · {project.timeZone}</small></div>}
    </section>
    <section className="business-section"><div className="business-section-heading"><h2>素材文件</h2><button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => fileInput.current?.click()}><FileUp size={14} />导入材料</button></div>
      <input ref={fileInput} type="file" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} />
      {projectMaterials.length ? <ul className="business-material-list">{projectMaterials.map((material) => <li key={material.id} data-project-focus={`material-${material.id}`} tabIndex={-1}><FileUp size={16} /><div><strong>{material.name}</strong><span>{(material.size / 1024).toFixed(1)} KB · {businessTime(material.importedAt || material.createdAt, project.timeZone)}</span></div><code title={material.sha256}>{material.sha256.slice(0, 12)}</code></li>)}</ul>
        : <p className="business-empty-inline">可以导入品牌资料、已有图片或可靠信息来源。需要真实照片的内容会等待相应素材。</p>}
      <p className="business-muted">默认封面与信息卡由本地模板制作。模板制作不会标成 AI 生图或实拍。</p>
    </section>
    <section className="business-section"><div className="business-section-heading"><h2>共享资料与判断</h2><span>来源、提出者与采纳状态分别记录</span></div>
      {facts.length ? <ul className="business-fact-list">{facts.map((fact) => <li key={fact.id} data-project-focus={`fact-${fact.id}`} tabIndex={-1} className={fact.status === 'superseded' ? 'superseded' : ''}>
        <div className="business-fact-heading"><span className={`business-fact-kind ${fact.type}`}>{({ fact: '事实资料', judgment: '成员判断', preference: '内容偏好' })[fact.type]}</span><span className="business-muted">{({ proposed: '待负责人采纳', adopted: '已采纳', superseded: '已被修订替代' })[fact.status]} · 版本 {fact.revision}</span></div>
        <p>{fact.content}</p><div className="business-source-links">{fact.sources?.length ? fact.sources.map((entry, index) => {
          const url = safeSourceUrl(entry.url);
          return url ? <a href={url} target="_blank" rel="noreferrer" key={index}><Link2 size={12} />{entry.label || url}</a> : <span key={index}>{entry.label || '资料来源'}</span>;
        }) : <span>尚未提供可核对来源</span>}</div>
      </li>)}</ul> : <p className="business-empty-inline">团队采纳的材料与复盘判断会保留来源，供后续周期使用。</p>}
      <form className="business-fact-form" onSubmit={(event) => {
        event.preventDefault(); void run(async () => {
          const requestId = factDraft.values.requestId || crypto.randomUUID();
          factDraft.setField('requestId', requestId);
          if (!await factDraft.flush()) throw new Error('资料草稿尚未保存，请重试。');
          await api.addProjectFact(project.id, { requestId, type: factType, content: factContent.trim(), ...(source.trim() ? { sources: [{ label: source.trim().slice(0, 300), ...(safeSourceUrl(source.trim()) ? { url: source.trim() } : {}), kind: 'user' }] } : {}) });
          await factDraft.clear();
        }, '补充资料已保存。');
      }}><label className="form-group"><span className="form-label">补充资料</span><textarea className="form-textarea" aria-label="补充资料" rows={3} value={factContent} maxLength={6000} disabled={busy || !factDraft.loaded || Boolean(factDraft.values.requestId)} required placeholder="写下可引用的事实、需要团队判断的问题，或你的表达偏好。" onChange={(event) => factDraft.setField('content', event.target.value)} /></label>
        <div className="business-fact-form-row"><select className="form-select" aria-label="资料类型" disabled={busy || !factDraft.loaded || Boolean(factDraft.values.requestId)} value={factType} onChange={(event) => factDraft.setField('type', event.target.value)}><option value="fact">事实资料</option><option value="judgment">判断</option><option value="preference">偏好</option></select>
          <input className="form-input" aria-label="资料来源" placeholder={factType === 'fact' ? '来源链接或说明（必填）' : '来源链接或说明（选填）'} value={source} maxLength={2000} required={factType === 'fact'} disabled={busy || !factDraft.loaded || Boolean(factDraft.values.requestId)} onChange={(event) => factDraft.setField('source', event.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={busy || !factDraft.loaded || !factContent.trim() || (factType === 'fact' && !source.trim())}>{factDraft.values.requestId ? '核对并重试' : '保存资料'}</button></div>
        {factDraft.error && <BusinessNotice tone="danger" action={<button type="button" className="btn btn-sm btn-secondary" onClick={() => void factDraft.retry()}>重试保存草稿</button>}>{factDraft.error}</BusinessNotice>}
      </form>
    </section>
  </div>;
}

export function ProjectRecap({ project, state, onOpenContent }: ProjectHomeProps) {
  const items = state.contentItems.filter((item) => item.projectId === project.id && publicationGroup(state, item) === 'published');
  const ids = new Set(items.map((item) => item.id));
  const metrics = state.metrics.filter((snapshot) => snapshot.projectId === project.id || (snapshot.contentId && ids.has(snapshot.contentId)));
  const cycles = state.productionCycles.filter((cycle) => cycle.projectId === project.id && cycle.summary);
  return <div className="business-recap">
    <section className="business-section"><div className="business-section-heading"><h2>已核实发布</h2><span>{items.length} 篇</span></div>
      {items.length ? <div className="business-content-grid">{items.map((item) => <ContentCard key={item.id} item={item} state={state} onOpen={onOpenContent} compact />)}</div> : <p className="business-empty-inline">平台身份与整稿回读一致后，发布记录会出现在这里。</p>}
    </section>
    <section className="business-section"><div className="business-section-heading"><h2>实测数据</h2><span>公开互动与后台数据分别记录</span></div>
      {metrics.length ? <div className="business-metrics-list">{metrics.map((snapshot) => <article key={snapshot.id}><div className="business-metrics-header"><strong>笔记 {snapshot.noteId}</strong><span>{businessTime(snapshot.collectedAt || snapshot.createdAt, project.timeZone)} · {snapshot.source || '平台回读'}</span></div>
        <div className="business-metric-values">{metricValues(snapshot).map((value) => { const display = metricDisplay(value); return <div key={value.name} className={display.missing ? 'missing' : ''}><span>{display.label}</span><strong>{display.value}</strong>{display.reason && <small>{display.reason}</small>}</div>; })}</div>
      </article>)}</div> : <div className="business-metrics-empty"><strong>尚无实测数据</strong><p>已核实发布后采集实际可见的点赞、收藏、评论等指标。曝光与点击未取得时会显示“未取得”。</p></div>}
    </section>
    <section className="business-section"><div className="business-section-heading"><h2>周期复盘与后续行动</h2></div>{cycles.length ? cycles.map((cycle) => <article className="business-cycle-recap" key={cycle.id}><strong>{cycle.dateKey || cycle.localDate || businessTime(cycle.createdAt, project.timeZone)}</strong><p>{cycle.summary}</p></article>) : <p className="business-empty-inline">负责人会结合已取得的数据提出后续行动。未取得的数据不会按零处理。</p>}</section>
  </div>;
}
