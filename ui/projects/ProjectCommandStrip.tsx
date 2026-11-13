import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, MoreHorizontal, Pause, Play, Settings2 } from 'lucide-react';
import { api } from '../api';
import type { Bootstrap, BusinessProject, BusinessSnapshot } from '../types';
import { BusinessNotice } from './BusinessComponents';
import { projectDailySummary, type DailyAction, type ProjectSettingsSection } from './projectDailyStatus';
import { useBusinessBusy } from './useBusinessBusy';

export default function ProjectCommandStrip({ project, state, bootstrap, disabled, unavailable, covered = false, overlayOpen = false,
  onFocus, onOpenContent, onSettings, onRefresh, onBusy }: {
  project: BusinessProject; state: BusinessSnapshot; bootstrap: Bootstrap;
  disabled: boolean; unavailable: boolean; covered?: boolean; overlayOpen?: boolean;
  onFocus: (id: string) => void; onOpenContent: (id: string, versionId?: string) => void;
  onSettings: (section?: ProjectSettingsSection) => void; onRefresh: () => Promise<void>; onBusy: (value: boolean) => void;
}) {
  const { primary, secondary } = projectDailySummary(project, state, bootstrap, unavailable);
  const { busy, report } = useBusinessBusy(onBusy);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const options = useRef<HTMLDetailsElement>(null);
  const blocked = disabled || busy || unavailable;
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (options.current?.open && event.target instanceof Node && !options.current.contains(event.target)) options.current.open = false;
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);
  useEffect(() => { if ((covered || overlayOpen) && options.current) options.current.open = false; }, [covered, overlayOpen]);
  const closeOptions = () => {
    const node = options.current;
    if (!node?.open) return;
    if (node.contains(document.activeElement)) node.querySelector('summary')?.focus({ preventScroll: true });
    node.open = false;
  };
  const setPaused = async (paused: boolean) => {
    if (lock.current || blocked || project.status === 'archived') return;
    lock.current = true; report('pause', true); setError(''); closeOptions();
    try { await api.setProjectPaused(project.id, paused); await onRefresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '项目状态更新失败，请重试。'); }
    finally { lock.current = false; report('pause', false); }
  };
  const openAction = (action: DailyAction) => {
    if (blocked) return;
    if (action.kind === 'content') onOpenContent(action.id, action.versionId);
    else if (action.kind === 'work') onFocus(action.id);
    else if (action.kind === 'project') void setPaused(false);
    else onSettings(action.section);
  };
  const openSettings = (section: ProjectSettingsSection) => { closeOptions(); onSettings(section); };
  return <section className="team-command-strip" aria-label="项目当前进展与下一步" inert={covered}>
    <div className="team-command-heading"><h1 title={project.name}>{project.name}</h1>
      <details className="team-project-options" ref={options} key={project.id} onKeyDown={event => {
        if (event.key === 'Escape' && options.current?.open) { event.preventDefault(); closeOptions(); }
      }}>
        <summary><span>项目选项</span><MoreHorizontal size={18} /></summary>
        <div className="team-project-options-menu" role="group" aria-label="项目选项">
          <button disabled={blocked} onClick={() => openSettings('team')}><Settings2 size={14} />团队设置</button>
          <button disabled={blocked} onClick={() => openSettings('account')}>发布账号</button>
          <button disabled={blocked} onClick={() => openSettings('runtime')}>运行设置</button>
          <button disabled={blocked || project.status === 'archived'} onClick={() => void setPaused(project.status !== 'paused')}>
            {project.status === 'paused' ? <Play size={14} /> : <Pause size={14} />}{project.status === 'paused' ? '继续项目' : '暂停项目'}
          </button>
        </div>
      </details>
    </div>
    <div className={'team-next-step ' + primary.tone} data-project-state={primary.kind}>
      <div className="team-next-step-copy" role="status"><strong>{primary.title}</strong><p>{primary.detail}</p></div>
      {primary.action && <button className={'btn ' + (['running', 'waiting', 'queued', 'sending'].includes(primary.kind) ? 'btn-secondary' : 'btn-primary')}
        disabled={blocked} onClick={() => openAction(primary.action!)}>{busy ? '正在更新…' : primary.action.label}<ArrowRight size={15} /></button>}
    </div>
    {secondary.length > 0 && <details className="team-other-statuses" key={'status-' + project.id}>
      <summary>其他待处理 <span>{secondary.length}</span><ChevronDown size={14} /></summary>
      <ul>{secondary.map(status => <li key={status.kind} data-project-state={status.kind}>
        <div><strong>{status.title}</strong><p>{status.detail}</p></div>{status.action && <button className="btn btn-secondary"
          disabled={blocked} onClick={() => openAction(status.action!)}>{status.action.label}<ArrowRight size={13} /></button>}
      </li>)}</ul>
    </details>}
    {error && <BusinessNotice tone="danger">{error}</BusinessNotice>}
  </section>;
}
