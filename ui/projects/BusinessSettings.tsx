import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw, Settings2 } from 'lucide-react';
import { api } from '../api';
import type { Bootstrap, BusinessConnection, BusinessProject, BusinessSnapshot } from '../types';
import { BusinessBadge, BusinessNotice } from './BusinessComponents';
import { businessTime } from './businessState';
import { isMemberRunnable } from '../memberAvailability';
import './business.css';

export default function BusinessSettings({ state, bootstrap, onRefresh, onMembers, onBusy, onUnsaved }: {
  state: BusinessSnapshot; bootstrap: Bootstrap; onRefresh: () => Promise<void>; onMembers: () => void;
  onBusy: (busy: boolean) => void; onUnsaved: (unsaved: boolean) => void;
}) {
  const [projectId, setProjectId] = useState('');
  const project = state.projects.find((entry) => entry.id === projectId) || state.projects.find((entry) => entry.status !== 'archived');
  const [connection, setConnection] = useState<BusinessConnection | null>(state.connection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  useEffect(() => { setConnection(state.connection); }, [state.connection]);
  const run = async (operation: () => Promise<BusinessConnection>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); onBusy(true); setError(''); setNotice('');
    try { const next = await operation(); setConnection(next); await onRefresh(); return next; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '连接操作失败'); }
    finally { lock.current = false; setBusy(false); onBusy(false); }
  };
  const login = async () => {
    if (!window.cliTeamDesktop?.openPublicationLogin) { setError('请在桌面工作台打开发布账号登录窗口。'); return; }
    const result = await run(() => window.cliTeamDesktop!.openPublicationLogin(project?.id));
    if (result) setNotice('登录窗口已打开。在浏览器完成平台登录后，回到这里检测连接。');
  };
  const bind = async () => {
    if (!project) return;
    const result = await run(async () => {
      await api.bindProjectAccount(project.id, project.revision);
      return api.getBusinessConnection();
    });
    if (result) setNotice('已将当前核实的账号绑定到项目。受影响的稿件需要重新送审。');
  };
  const status = connection?.status || 'unavailable';
  const accountBound = Boolean(project?.account?.id && project.account.id === connection?.account?.id && project.account.connectorVersion === connection?.version);
  return <>
    <section className="settings-group business-settings"><div className="business-section-heading"><h2>图文运营与发布账号</h2><BusinessBadge label={status === 'ready' ? '账号连接可用' : status === 'login_required' ? '需要登录账号' : '连接尚不可用'} tone={status === 'ready' ? 'ready' : 'attention'} /></div>
      <p className="business-muted">账号由标准浏览器的独立登录会话管理。每篇内容的最终发布确认在整稿页面完成。</p>
      <div className="business-connection-details"><div><span>当前账号</span><strong>{connection?.account?.name || connection?.account?.label || '尚未核对账号'}</strong></div><div><span>最近检测</span><strong>{businessTime(connection?.checkedAt)}</strong></div></div>
      {(connection?.reason || connection?.message) && <p className="business-connection-reason">{connection.reason || connection.message}</p>}
      {state.projects.length > 0 && <label className="form-group"><span className="form-label">接入与配置的项目</span><select className="form-select" aria-label="接入账号的项目" value={project?.id || ''} disabled={busy} onChange={(event) => setProjectId(event.target.value)}>{state.projects.filter((entry) => entry.status !== 'archived').map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>}
      <div className="business-connection-actions"><button className="btn btn-secondary" disabled={busy || !window.cliTeamDesktop?.openPublicationLogin} onClick={() => void login()}><ExternalLink size={14} />登录发布账号</button><button className="btn btn-secondary" disabled={busy} onClick={() => void run(api.probeBusinessConnection)}><RefreshCw size={14} />{busy ? '正在处理连接' : '检测连接'}</button>{project && <button className="btn btn-primary" disabled={busy || status !== 'ready' || accountBound} onClick={() => void bind()}>{accountBound ? '当前账号已绑定' : '绑定当前账号到项目'}</button>}</div>
      {!window.cliTeamDesktop?.openPublicationLogin && <p className="business-muted">账号登录和最终发布批准需要桌面工作台。</p>}
      {connection?.gates?.length ? <ul className="business-connection-gates">{connection.gates.map((gate) => <li key={gate.name}><span>{gate.name}</span><strong>{({ passed: '已验证', failed: '未通过', not_checked: '尚未验证', unavailable: '尚不可用' } as Record<string, string>)[gate.status] || gate.status}</strong>{gate.reason && <small>{gate.reason}</small>}</li>)}</ul> : <p className="business-muted">发布能力需通过上传关联、创建身份与整稿回读核实。连接可用不代表真实发布已验收。</p>}
      {(error || notice) && <BusinessNotice tone={error ? 'danger' : 'ready'}>{error || notice}</BusinessNotice>}
    </section>
    {project && <ProjectOperationSettings key={project.id} project={project} bootstrap={bootstrap} onRefresh={onRefresh} onMembers={onMembers} onBusy={onBusy} onUnsaved={onUnsaved} />}
  </>;
}

function ProjectOperationSettings({ project, bootstrap, onRefresh, onMembers, onBusy, onUnsaved }: {
  project: BusinessProject; bootstrap: Bootstrap; onRefresh: () => Promise<void>; onMembers: () => void;
  onBusy: (busy: boolean) => void; onUnsaved: (unsaved: boolean) => void;
}) {
  const [ownerId, setOwnerId] = useState(project.ownerId);
  const [reviewerId, setReviewerId] = useState(project.reviewerId || '');
  const [memberIds, setMemberIds] = useState(project.memberIds);
  const [dailyCliCalls, setDailyCliCalls] = useState(project.limits?.dailyCliCalls ?? 24);
  const [maxPending, setMaxPending] = useState(project.limits?.maxPending ?? 3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const expectedRevision = useRef(project.revision);
  const dirty = ownerId !== project.ownerId || reviewerId !== (project.reviewerId || '') || JSON.stringify(memberIds) !== JSON.stringify(project.memberIds)
    || dailyCliCalls !== (project.limits?.dailyCliCalls ?? 24) || maxPending !== (project.limits?.maxPending ?? 3);
  const lock = useRef(false);
  const members = bootstrap.members.filter(isMemberRunnable);
  useEffect(() => { onUnsaved(dirty || busy); return () => onUnsaved(false); }, [dirty, busy, onUnsaved]);
  const save = async () => {
    if (lock.current) return;
    if (!ownerId || !reviewerId || ownerId === reviewerId) { setError('负责人和独立审稿成员必须不同。'); return; }
    lock.current = true; setBusy(true); onBusy(true); setError(''); setNotice('');
    try {
      const updated = await api.updateProject(project.id, { expectedRevision: expectedRevision.current, ownerId, reviewerId, memberIds: [...new Set([...memberIds, ownerId, reviewerId])], limits: { dailyCliCalls, maxPending, maxAttempts: project.limits?.maxAttempts ?? 3 } });
      expectedRevision.current = updated.revision; setMemberIds(updated.memberIds); await onRefresh(); setNotice('项目团队与运行限额已保存。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '项目设置保存失败'); }
    finally { lock.current = false; setBusy(false); onBusy(false); }
  };
  return <form className="settings-group business-settings" onSubmit={(event) => { event.preventDefault(); void save(); }}><div className="business-section-heading"><h2>{project.name} · 团队与限额</h2><button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={onMembers}><Settings2 size={13} />配置成员能力</button></div>
    <div className="business-settings-fields"><label className="form-group"><span className="form-label">负责人</span><select className="form-select" value={ownerId} disabled={busy} onChange={(event) => setOwnerId(event.target.value)}>{members.filter((member) => member.permission === 'edit').map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      <label className="form-group"><span className="form-label">独立审稿</span><select className="form-select" value={reviewerId} disabled={busy} onChange={(event) => setReviewerId(event.target.value)}><option value="">请选择审稿成员</option>{members.filter((member) => member.id !== ownerId).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      <label className="form-group"><span className="form-label">每日成员调用上限</span><input className="form-input" type="number" min={1} max={24} value={dailyCliCalls} disabled={busy} onChange={(event) => setDailyCliCalls(Number(event.target.value))} /></label>
      <label className="form-group"><span className="form-label">未完成稿件上限</span><input className="form-input" type="number" min={1} max={3} value={maxPending} disabled={busy} onChange={(event) => setMaxPending(Number(event.target.value))} /></label></div>
    <fieldset className="business-member-choices" disabled={busy}><legend>参与项目的成员</legend>{members.map((member) => <label key={member.id}><input type="checkbox" checked={memberIds.includes(member.id) || [ownerId, reviewerId].includes(member.id)} disabled={[ownerId, reviewerId].includes(member.id)} onChange={(event) => setMemberIds(event.target.checked ? [...memberIds, member.id] : memberIds.filter((id) => id !== member.id))} />{member.name}</label>)}</fieldset>
    <p className="business-muted">负责人、咨询、修改与评审共同使用每日额度。结果待核实的稿件仍占用名额。</p>
    {(error || notice) && <BusinessNotice tone={error ? 'danger' : 'ready'}>{error || notice}</BusinessNotice>}
    <div className="business-form-actions"><span className="business-muted">{dirty ? '有尚未保存的设置' : '项目设置已同步'}</span><button className="btn btn-primary" type="submit" disabled={busy || !dirty}>{busy ? '正在保存' : '保存项目设置'}</button></div>
  </form>;
}
