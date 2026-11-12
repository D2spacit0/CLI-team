import { ArrowRight, Check, Inbox, Layers, PanelRightOpen, Send, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { Bootstrap, BusinessProject, BusinessSnapshot } from '../types';
import { workIsClosed, workNeedsAttention } from './projectWorkspaceState';

export default function ProjectCommandStrip({ project, state, bootstrap, disabled, unavailable, inspectorOpen, covered = false, onFocus, onOpenInspector }: {
  project: BusinessProject; state: BusinessSnapshot; bootstrap: Bootstrap;
  disabled: boolean; unavailable: boolean; inspectorOpen: boolean; covered?: boolean;
  onFocus: (id: string) => void; onOpenInspector: () => void;
}) {
  const work = state.workItems.filter(item => item.projectId === project.id)
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  const attention = work.filter(item => workNeedsAttention(item));
  const ordinary = work.filter(item => !workNeedsAttention(item));
  const unknown = ordinary.filter(item => !['assigned', 'accepted', 'received', 'verified', 'cancelled'].includes(item.handoffStatus || '') && !workIsClosed(item));
  const stages = [
    { key: 'assigned', name: '已派发', detail: '等待接手', Icon: Send },
    { key: 'accepted', name: '本机接纳', detail: '执行与交付中', Icon: Check },
    { key: 'received', name: '已收件', detail: '等待核对', Icon: Inbox },
    { key: 'verified', name: '已验收', detail: '交接已完成', Icon: ShieldCheck },
  ].map(stage => ({ ...stage, items: ordinary.filter(item => item.handoffStatus === stage.key) }));
  const paused = bootstrap.workspace.paused || project.status === 'paused';
  const status = project.status === 'archived' ? '项目已归档' : paused ? '新工作已暂停'
    : project.status === 'attention' ? '有事项待接续' : project.status === 'active' ? '项目持续推进' : '项目状态待确认';
  const objective = state.productionCycles.find(cycle => cycle.projectId === project.id && ['active', 'running', 'planning', 'revising'].includes(cycle.status))?.objective || project.objective;
  return <section className="team-command-strip" aria-label="项目指挥与交接阶段" inert={covered}>
    <div className="team-command-intro">
      <div className="team-command-heading"><span className="team-command-mark" aria-hidden="true"><Layers size={19} /></span><div>
        <span className="team-command-eyebrow">项目指挥</span><h1 title={project.name}>{project.name}</h1>
      </div>{!inspectorOpen && <button className="team-reopen-inspector btn btn-secondary" disabled={disabled} onClick={onOpenInspector}><PanelRightOpen size={15} />查看整稿</button>}</div>
      <p className="team-command-objective" title={objective}>{objective}</p>
      <div className="team-command-status"><span className={`team-presence ${project.status === 'active' && !paused ? 'active' : ''}`} /><span>{unavailable ? '正在等待业务数据恢复' : status}</span><span className="team-command-local">本机工作区</span></div>
    </div>
    <div className="team-command-handoffs">
      <div className="team-command-caption"><span>交接分布</span><small>{unavailable ? '业务数据暂时不可用' : '项目工作所在阶段'}</small></div>
      <ol className="team-stage-track" aria-label="项目工作交接阶段">{stages.map(({ key, name, detail, Icon, items }, index) => <li key={key} className={items.length && !unavailable ? 'has-work' : ''}>
        <button className="team-stage-stop" disabled={disabled || unavailable || !items.length} aria-label={`查看${name}的${items.length}项工作`} onClick={() => onFocus(`work-${items[0].id}`)}>
          <span className="team-stage-symbol"><Icon size={15} /></span><span className="team-stage-label">{name}</span><strong>{unavailable ? '—' : items.length}</strong><small>{detail}</small>
        </button>{index < stages.length - 1 && <ArrowRight className="team-stage-link" size={12} aria-hidden="true" />}
      </li>)}</ol>
      <div className="team-command-exceptions">
        {unavailable ? <span>恢复读取后再核对交接记录</span> : <>
          {attention.length > 0 && <button disabled={disabled} onClick={() => onFocus(`work-${attention[0].id}`)}><TriangleAlert size={12} />{attention.length} 项待接续处理<ArrowRight size={12} /></button>}
          {unknown.length > 0 && <button className="team-command-unknown" disabled={disabled} onClick={() => onFocus(`work-${unknown[0].id}`)}>{unknown.length} 项交接记录待确认<ArrowRight size={12} /></button>}
          {!attention.length && !unknown.length && <span>{work.length ? '各阶段单独核对，点击查看对应工作' : '工作派发后，交接记录会出现在这里'}</span>}
        </>}
      </div>
    </div>
  </section>;
}
