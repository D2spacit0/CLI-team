import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw, Settings2 } from 'lucide-react';
import { api } from '../api';
import type { Bootstrap, BusinessConnection, BusinessProject, BusinessSnapshot } from '../types';
import { BusinessBadge, BusinessNotice } from './BusinessComponents';
import { businessTime } from './businessState';
import { accountConnectionStep, projectAccountBound, resolveSettingsProject } from './businessSettingsState';
import { isMemberRunnable } from '../memberAvailability';
import './business.css';
import './business-settings.css';

export default function BusinessSettings({ state, bootstrap, onRefresh, onMembers, onBusy, onUnsaved, initialProjectId, focusSection }: {
  state: BusinessSnapshot; bootstrap: Bootstrap; onRefresh: () => Promise<void>; onMembers: (projectId?: string) => void;
  onBusy: (busy: boolean) => void; onUnsaved: (unsaved: boolean) => void;
  initialProjectId?: string | null; focusSection?: string | null;
}) {
  const incomingProjectId = initialProjectId || '';
  const [selection, setSelection] = useState(() => ({ sourceId: incomingProjectId, selectedId: incomingProjectId || state.projects.find(entry => entry.status !== 'archived')?.id || '' }));
  const [connection, setConnection] = useState<BusinessConnection | null>(state.connection);
  const [busy, setBusy] = useState(false);
  const [connectionAction, setConnectionAction] = useState('');
  const [teamDirty, setTeamDirty] = useState(false);
  const [teamBusy, setTeamBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const sections = useRef<HTMLDivElement>(null);
  const projectSelect = useRef<HTMLSelectElement>(null);
  const previousProject = useRef<BusinessProject | null>(null);
  const selectionLocked = busy || teamBusy || teamDirty;
  const incomingChanged = incomingProjectId !== selection.sourceId;
  const targetId = incomingChanged && !selectionLocked ? incomingProjectId : selection.selectedId;
  const { project, error: projectError } = resolveSettingsProject(state.projects, targetId);
  const retainedProject = !project && (teamDirty || teamBusy) && previousProject.current?.id === targetId ? previousProject.current : null;
  const editorProject = project || retainedProject;

  useEffect(() => { setConnection(state.connection); }, [state.connection]);
  useEffect(() => { if (project) previousProject.current = project; }, [project]);
  useEffect(() => {
    if (!selectionLocked && (incomingChanged || !selection.selectedId && project)) {
      setSelection({ sourceId: incomingProjectId, selectedId: targetId || project?.id || '' });
      setError(''); setNotice('');
    }
  }, [incomingChanged, incomingProjectId, project?.id, selection.selectedId, selectionLocked, targetId]);
  useEffect(() => { onBusy(busy || teamBusy); return () => onBusy(false); }, [busy, teamBusy, onBusy]);
  useEffect(() => { onUnsaved(teamDirty || teamBusy); return () => onUnsaved(false); }, [teamDirty, teamBusy, onUnsaved]);
  useEffect(() => {
    if (focusSection !== 'account' && focusSection !== 'team') return;
    const target = sections.current?.querySelector<HTMLElement>(`[data-business-settings-section="${focusSection}"]`);
    target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [focusSection, project?.id]);

  const run = async (name: string, operation: () => Promise<BusinessConnection>) => {
    if (lock.current || teamBusy) return;
    lock.current = true; setBusy(true); setConnectionAction(name); setError(''); setNotice('');
    try { const next = await operation(); setConnection(next); await onRefresh(); return next; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '连接操作失败'); }
    finally { lock.current = false; setBusy(false); setConnectionAction(''); }
  };
  const login = async () => {
    if (!window.cliTeamDesktop?.openPublicationLogin) { setError('请在桌面工作台打开发布账号登录窗口。'); return; }
    const result = await run('login', () => window.cliTeamDesktop!.openPublicationLogin(project?.id));
    if (result) setNotice('登录窗口已打开。完成平台登录后，回到这里检测连接。');
  };
  const probe = async () => {
    const result = await run('probe', api.probeBusinessConnection);
    if (result?.status === 'ready' && result.account?.id && result.version) setNotice('当前账号已检测。请核对账号与项目，再决定是否绑定。');
  };
  const bind = async () => {
    if (!project || teamDirty || connection?.status !== 'ready' || !connection.account?.id || !connection.version) return;
    const result = await run('bind', async () => {
      await api.bindProjectAccount(project.id, project.revision);
      return api.getBusinessConnection();
    });
    if (result) setNotice(`已将当前核实的账号绑定到“${project.name}”。旧检查与批准已失效，请回到整稿查看重新审查的结果。`);
  };
  const step = accountConnectionStep(project, connection);
  const accountBound = projectAccountBound(project, connection);
  const connectionVerified = connection?.status === 'ready' && Boolean(connection.account?.id && connection.version);
  const hasDesktopLogin = typeof window.cliTeamDesktop?.openPublicationLogin === 'function';
  const operationBusy = busy || teamBusy;
  const loginButton = (primary: boolean) => <button className={`btn ${primary ? 'btn-primary' : 'btn-secondary'}`} disabled={operationBusy || !hasDesktopLogin} onClick={() => void login()}><ExternalLink size={14} />{connectionAction === 'login' ? '正在打开登录窗口' : '登录发布账号'}</button>;
  const probeButton = (primary: boolean) => <button className={`btn ${primary ? 'btn-primary' : 'btn-secondary'}`} disabled={operationBusy} onClick={() => void probe()}><RefreshCw size={14} />{connectionAction === 'probe' ? '正在检测连接' : '检测连接'}</button>;

  return <div ref={sections} className="business-settings-stack">
    <section className="settings-group business-settings" data-business-settings-section="account" tabIndex={-1}>
      <div className="business-section-heading"><h2>图文运营与发布账号</h2><BusinessBadge label={connectionVerified ? '当前账号已检测' : connection?.status === 'login_required' ? '需要登录账号' : '账号连接待核对'} tone={connectionVerified ? 'ready' : 'attention'} /></div>
      <p className="business-muted">每个项目明确绑定发布账号。每篇内容的最终发布确认在整稿页面完成。</p>
      {(state.projects.length > 0 || targetId) && <label className="form-group"><span className="form-label">接入与配置的项目</span><select ref={projectSelect} className="form-select" aria-label="接入账号的项目" value={project?.id || targetId || ''} disabled={selectionLocked} onChange={event => { setSelection({ sourceId: incomingProjectId, selectedId: event.target.value }); setError(''); setNotice(''); }}>
        {!project && <option value={targetId || ''} disabled>请选择可配置的项目</option>}
        {state.projects.filter(entry => entry.status !== 'archived').map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></label>}
      {project && <p className="business-settings-project-context">正在配置 <strong>{project.name}</strong><span>{accountBound ? `项目绑定：${project.account?.name || project.account?.label || '已核实账号'}` : project.account ? `项目原绑定：${project.account.name || project.account.label || '已登记账号'}` : '项目尚未绑定发布账号'}</span></p>}
      {projectError && <BusinessNotice tone="danger">{projectError}</BusinessNotice>}
      {incomingChanged && selectionLocked && <BusinessNotice>当前项目有未保存或正在提交的设置。请先保存或撤销本地修改，再切换到请求的项目。</BusinessNotice>}
      <div className="business-connection-details"><div><span>浏览器当前账号</span><strong>{connection?.account?.name || connection?.account?.label || '尚未核对账号'}</strong></div><div><span>最近检测</span><strong>{businessTime(connection?.checkedAt)}</strong></div></div>
      <div className="business-connection-next" data-connection-step={step.action}><span>下一步</span><h3>{step.title}</h3><p>{step.detail}</p>
        <div className="business-connection-actions">
          {step.action === 'login' && loginButton(true)}
          {step.action === 'probe' && probeButton(true)}
          {step.action === 'bind' && <button className="btn btn-primary" disabled={operationBusy || teamDirty || Boolean(projectError)} onClick={() => void bind()}>{connectionAction === 'bind' ? '正在绑定账号' : '绑定当前账号到项目'}</button>}
          {step.action === 'select' && state.projects.some(entry => entry.status !== 'archived') && <button className="btn btn-primary" disabled={operationBusy} onClick={() => projectSelect.current?.focus()}>选择要绑定的项目</button>}
          {step.action === 'done' && <BusinessBadge label="当前账号已绑定" tone="ready" />}
        </div>
      </div>
      {!hasDesktopLogin && <p className="business-muted">账号登录和最终发布批准需要桌面工作台。</p>}
      {(error || notice) && <BusinessNotice tone={error ? 'danger' : 'ready'}>{error || notice}</BusinessNotice>}
      <details className="business-settings-details"><summary>其他连接操作与检测详情</summary>
        <div className="business-connection-actions">{step.action !== 'login' && loginButton(false)}{step.action !== 'probe' && probeButton(false)}</div>
        {(connection?.reason || connection?.message) && <p className="business-connection-reason">{connection.reason || connection.message}</p>}
        {connection?.gates?.length ? <ul className="business-connection-gates">{connection.gates.map(gate => <li key={gate.name}><span>{gate.name}</span><strong>{({ passed: '已验证', failed: '未通过', not_checked: '尚未验证', unavailable: '尚不可用' } as Record<string, string>)[gate.status] || gate.status}</strong>{gate.reason && <small>{gate.reason}</small>}</li>)}</ul> : <p className="business-muted">发布能力还需核对上传关联、创建身份与整稿回读。账号检测通过不代表真实发布已验收。</p>}
      </details>
    </section>
    {editorProject && <ProjectOperationSettings key={editorProject.id} project={editorProject} bootstrap={bootstrap} onRefresh={onRefresh} onMembers={() => onMembers(editorProject.id)} onBusy={setTeamBusy} onUnsaved={setTeamDirty} externalBusy={busy} unavailable={!project} />}
  </div>;
}

const operationValues = (project: BusinessProject) => ({ ownerId: project.ownerId, reviewerId: project.reviewerId || '', memberIds: project.memberIds,
  dailyCliCalls: project.limits?.dailyCliCalls ?? 24, maxPending: project.limits?.maxPending ?? 3 });

function ProjectOperationSettings({ project, bootstrap, onRefresh, onMembers, onBusy, onUnsaved, externalBusy, unavailable }: {
  project: BusinessProject; bootstrap: Bootstrap; onRefresh: () => Promise<void>; onMembers: () => void;
  onBusy: (busy: boolean) => void; onUnsaved: (unsaved: boolean) => void; externalBusy: boolean; unavailable: boolean;
}) {
  const [baseline, setBaseline] = useState(project);
  const [values, setValues] = useState(() => operationValues(project));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const expectedRevision = useRef(project.revision);
  const dirty = JSON.stringify(values) !== JSON.stringify(operationValues(baseline));
  const serverChanged = project.revision > expectedRevision.current;
  const lock = useRef(false);
  const members = bootstrap.members.filter(isMemberRunnable);
  const owners = members.filter(member => member.permission === 'edit');
  const reviewers = members.filter(member => member.id !== values.ownerId);
  const disabled = busy || externalBusy || unavailable;
  const reset = (next: BusinessProject) => { expectedRevision.current = next.revision; setBaseline(next); setValues(operationValues(next)); };
  useEffect(() => { if (!dirty && !busy && serverChanged) reset(project); }, [project, dirty, busy, serverChanged]);
  useEffect(() => { onUnsaved(dirty); return () => onUnsaved(false); }, [dirty, onUnsaved]);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const save = async () => {
    if (lock.current || externalBusy || unavailable) return;
    if (!owners.some(member => member.id === values.ownerId) || !reviewers.some(member => member.id === values.reviewerId)) { setError('请选择可用的负责人和另一位独立审稿成员。'); return; }
    if (serverChanged) { setError('项目设置已更新，当前修改仍保留。请先核对最新设置。'); return; }
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const updated = await api.updateProject(project.id, { expectedRevision: expectedRevision.current, ownerId: values.ownerId, reviewerId: values.reviewerId,
        memberIds: [...new Set([...values.memberIds, values.ownerId, values.reviewerId])], limits: { dailyCliCalls: values.dailyCliCalls, maxPending: values.maxPending, maxAttempts: project.limits?.maxAttempts ?? 3 } });
      reset(updated); await onRefresh(); setNotice('项目团队与运行限额已保存。团队变化会使原稿件审查失效，请回到整稿查看当前检查与审稿。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '项目设置保存失败'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <form className="settings-group business-settings" data-business-settings-section="team" tabIndex={-1} onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="business-section-heading"><h2>{project.name} · 项目团队</h2><button type="button" className="btn btn-sm btn-secondary" disabled={disabled || dirty} onClick={onMembers}><Settings2 size={13} />配置成员能力</button></div>
    {dirty && <p className="business-muted">先保存或撤销本地修改，再前往配置成员能力。</p>}
    {unavailable && <BusinessNotice>这个项目已不能继续配置。你的未保存编辑仍保留供核对，可以明确撤销；当前不能提交。</BusinessNotice>}
    {serverChanged && dirty && <BusinessNotice>服务端项目设置已经更新。当前编辑内容仍保留；撤销本地修改后可读取最新设置。</BusinessNotice>}
    <div className="business-settings-fields"><label className="form-group"><span className="form-label">负责人</span><select className="form-select" value={values.ownerId} disabled={disabled} onChange={event => setValues(current => ({ ...current, ownerId: event.target.value }))}>
      {!owners.some(member => member.id === values.ownerId) && <option value={values.ownerId} disabled>当前负责人不可用，请重新选择</option>}{owners.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      <label className="form-group"><span className="form-label">独立审稿</span><select className="form-select" value={values.reviewerId} disabled={disabled} onChange={event => setValues(current => ({ ...current, reviewerId: event.target.value }))}><option value="">请选择审稿成员</option>
        {values.reviewerId && !reviewers.some(member => member.id === values.reviewerId) && <option value={values.reviewerId} disabled>当前审稿成员不可用，请重新选择</option>}{reviewers.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label></div>
    <fieldset className="business-member-choices" disabled={disabled}><legend>参与项目的成员</legend>{members.map(member => <label key={member.id}><input type="checkbox" checked={values.memberIds.includes(member.id) || [values.ownerId, values.reviewerId].includes(member.id)} disabled={[values.ownerId, values.reviewerId].includes(member.id)} onChange={event => setValues(current => ({ ...current, memberIds: event.target.checked ? [...current.memberIds, member.id] : current.memberIds.filter(id => id !== member.id) }))} />{member.name}</label>)}</fieldset>
    <details className="business-settings-details"><summary>项目运行限额</summary><div className="business-settings-fields">
      <label className="form-group"><span className="form-label">每日成员调用上限</span><input className="form-input" type="number" min={1} max={24} required value={values.dailyCliCalls} disabled={disabled} onChange={event => setValues(current => ({ ...current, dailyCliCalls: Number(event.target.value) }))} /></label>
      <label className="form-group"><span className="form-label">未完成稿件上限</span><input className="form-input" type="number" min={1} max={3} required value={values.maxPending} disabled={disabled} onChange={event => setValues(current => ({ ...current, maxPending: Number(event.target.value) }))} /></label></div>
      <p className="business-muted">负责人、咨询、修改与评审共同使用每日额度。结果待核实的稿件仍占用名额。</p>
    </details>
    {(error || notice) && <BusinessNotice tone={error ? 'danger' : 'ready'}>{error || notice}</BusinessNotice>}
    <div className="business-form-actions"><span className="business-muted">{dirty ? '有尚未保存的设置' : '项目设置已同步'}</span><div className="business-connection-actions">
      {dirty && <button className="btn btn-secondary" type="button" disabled={busy || externalBusy} onClick={() => { reset(project); setError(''); setNotice('已撤销本地修改，并读取当前项目设置。'); }}>撤销未保存修改</button>}
      <button className="btn btn-primary" type="submit" disabled={disabled || !dirty || serverChanged}>{busy ? '正在保存' : '保存项目设置'}</button></div></div>
  </form>;
}
