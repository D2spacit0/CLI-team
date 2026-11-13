import { ArrowRight, Check, ChevronDown, GitBranch, Inbox, Layers, PanelRightOpen, Send, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { Bootstrap, BusinessProject, BusinessSnapshot } from '../types';
import { projectDailyStatus, projectWorkIssue, type ProjectSettingsSection } from './projectDailyStatus';

export default function ProjectCommandStrip({ project, state, bootstrap, disabled, unavailable, inspectorOpen, covered = false,
  onFocus, onOpenInspector, onOpenContent, onSettings }: {
  project: BusinessProject; state: BusinessSnapshot; bootstrap: Bootstrap;
  disabled: boolean; unavailable: boolean; inspectorOpen: boolean; covered?: boolean;
  onFocus: (id: string) => void; onOpenInspector: () => void;
  onOpenContent: (id: string, versionId?: string) => void; onSettings: (section?: ProjectSettingsSection) => void;
}) {
  const work = state.workItems.filter(item => item.projectId === project.id)
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  const attention = work.filter(item => projectWorkIssue(item));
  const ordinary = work.filter(item => !projectWorkIssue(item));
  const stages = [
    { key: 'assigned', name: '已派发', detail: '等待接手', Icon: Send },
    { key: 'accepted', name: '本机接纳', detail: '执行与交付中', Icon: Check },
    { key: 'received', name: '已收件', detail: '等待核对', Icon: Inbox },
    { key: 'verified', name: '已验收', detail: '交接已完成', Icon: ShieldCheck },
  ].map(stage => ({ ...stage, items: ordinary.filter(item => item.handoffStatus === stage.key) }));
  const summary = projectDailyStatus(project, state, bootstrap, unavailable);
  const action = summary.action;
  const openAction = () => {
    if (!action || disabled || unavailable) return;
    if (action.kind === 'content') onOpenContent(action.id, action.versionId);
    else if (action.kind === 'work') onFocus(action.id);
    else onSettings(action.section);
  };
  const hasContent = state.contentItems.some(item => item.projectId === project.id);
  return <section className="team-command-strip" aria-label="项目当前进展与下一步" inert={covered}>
    <div className="team-command-intro">
      <div className="team-command-heading"><span className="team-command-mark" aria-hidden="true"><Layers size={19} /></span><div>
        <span className="team-command-eyebrow">当前项目</span><h1 title={project.name}>{project.name}</h1>
      </div>{!inspectorOpen && hasContent && action?.kind !== 'content' && <button className="team-reopen-inspector btn btn-secondary" disabled={disabled || unavailable} onClick={onOpenInspector}><PanelRightOpen size={15} />查看整稿</button>}</div>
    </div>
    <div className={`team-next-step ${summary.tone}`} data-project-state={summary.kind}>
      <div className="team-next-step-copy" role="status"><strong>{summary.title}</strong><p>{summary.detail}</p></div>
      {action && <button className={`btn ${action.kind === 'content' ? 'btn-primary' : 'btn-secondary'} ${action.kind === 'content' && !inspectorOpen ? 'team-reopen-inspector' : ''}`} disabled={disabled || unavailable} onClick={openAction}>{action.label}<ArrowRight size={14} /></button>}
    </div>
    <details className="team-process-details" key={project.id}>
      <summary><GitBranch size={14} />查看团队过程<ChevronDown size={14} /></summary>
      <div className="team-command-handoffs"><p className="team-command-objective">{project.objective}</p>
      <div className="team-command-caption"><span>交接分布</span><small>{unavailable ? '业务数据暂时不可用' : '项目工作所在阶段'}</small></div>
      <ol className="team-stage-track" aria-label="项目工作交接阶段">{stages.map(({ key, name, detail, Icon, items }, index) => <li key={key} className={items.length && !unavailable ? 'has-work' : ''}>
        <button className="team-stage-stop" disabled={disabled || unavailable || !items.length} aria-label={`查看${name}的${items.length}项工作`} onClick={() => onFocus(`work-${items[0].id}`)}>
          <span className="team-stage-symbol"><Icon size={15} /></span><span className="team-stage-label">{name}</span><strong>{unavailable ? '—' : items.length}</strong><small>{detail}</small>
        </button>{index < stages.length - 1 && <ArrowRight className="team-stage-link" size={12} aria-hidden="true" />}
      </li>)}</ol>
      <div className="team-command-exceptions">
        {unavailable ? <span>恢复读取后再核对交接记录</span> : attention.length
          ? <button disabled={disabled} onClick={() => onFocus(`work-${attention[0].id}`)}><TriangleAlert size={12} />{attention.length} 项待接续或核对<ArrowRight size={12} /></button>
          : <span>{work.length ? '点击阶段定位工作，展开工作卡片查看完整交接与证据。' : '实际派工后会显示交接记录。'}</span>}
      </div>
      </div>
    </details>
  </section>;
}
