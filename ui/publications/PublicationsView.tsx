import { useState } from 'react';
import { ArrowUpRight, Clock3, FileText, FolderOpen, RadioTower, ScanSearch, ShieldCheck, type LucideIcon } from 'lucide-react';
import { api } from '../api';
import type { BusinessSnapshot } from '../types';
import { BusinessBadge } from '../projects/BusinessComponents';
import { businessTime, contentRevision, contentState, publicationGroup, type PublicationGroup } from '../projects/businessState';
import './publications-view.css';

const groups: Array<{ key: PublicationGroup; title: string; description: string; icon: LucideIcon }> = [
  { key: 'awaiting', title: '待批准整稿', description: '检查与审稿完成后，进入整稿确认具体版本与发布范围。', icon: ShieldCheck },
  { key: 'queued', title: '已批准待执行', description: '由本机按已批准时间窗口安排，执行前再次核对版本与账号。', icon: Clock3 },
  { key: 'sending', title: '发布中', description: '已经开始提交。当前快照保持冻结，停止请求不能证明未发布。', icon: RadioTower },
  { key: 'unknown', title: '结果待核实', description: '可能已经提交，只会回读核实，不会自动重发。', icon: ScanSearch },
];

export default function PublicationsView({ state, onOpenContent, onProjects }: {
  state: BusinessSnapshot; onOpenContent: (contentId: string) => void; onProjects: () => void;
}) {
  const [projectFilter, setProjectFilter] = useState('');
  const contents = state.contentItems.filter((item) => !projectFilter || item.projectId === projectFilter);
  const grouped = groups.map(group => ({ ...group, items: contents.filter(item => publicationGroup(state, item) === group.key) }));
  return <div className="business-publications-view publication-command-queue">
    <header className="business-page-header"><div><span className="publication-page-label"><RadioTower size={13} />发布处理队列</span><h1>待发布</h1><p>整稿批准、执行进度和平台核实各自保留记录。</p></div>
      <label className="publication-filter"><span>项目范围</span><select className="form-select business-project-filter" aria-label="按项目筛选待发布稿件" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="">全部项目</option>{state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></header>
    <div className="business-publications-scroll">
      <dl className="publication-queue-readout" aria-label="当前筛选范围的发布队列数量">{grouped.map(group => <div className={group.key} key={group.key}><dt><group.icon size={14} />{group.title}</dt><dd>{group.items.length}<span>份</span></dd></div>)}</dl>
      {grouped.map((group) => {
      const { items } = group;
      return <section className={`business-publication-group publication-stage ${group.key}`} key={group.key} data-publication-group={group.key}>
        <div className="business-section-heading publication-stage-header"><span className="publication-stage-icon" aria-hidden="true"><group.icon size={17} /></span><div><h2>{group.title} <span className="business-count">{items.length}</span></h2><p>{group.description}</p></div></div>
        {items.length ? <div className="publication-queue-list">{items.map((item) => {
          const revision = contentRevision(state, item), status = contentState(state, item);
          const project = state.projects.find(entry => entry.id === item.projectId);
          return <button className="business-content-card publication-queue-row" key={item.id} onClick={() => onOpenContent(item.id)} data-content-id={item.id}>
            <span className="publication-row-preview">{revision?.images[0] ? <img src={api.contentImageUrl(item.id, revision.id, 0)} alt={`${revision.title}的封面`} loading="lazy" /> : <span><FileText size={19} /><small>配图制作中</small></span>}</span>
            <div className="publication-row-main"><span className="publication-row-project">{project?.name || '所属项目'}<span>{revision ? `版本 ${revision.revision}` : '等待形成整稿'}</span></span>
              <h3>{revision?.title || item.title || '新图文'}</h3><span className="publication-row-description">{status.detail || (revision?.body ? revision.body : '团队正在准备选题、文案与配图。')}</span></div>
            <span className="publication-row-state"><BusinessBadge {...status} /><span>{revision ? `${revision.images.length} 张图片 · ${businessTime(revision.createdAt, project?.timeZone)}` : '等待形成整稿'}</span></span>
            <span className="publication-row-open">查看整稿<ArrowUpRight size={15} /></span>
          </button>;
        })}</div>
          : <p className="business-publication-empty">当前没有{group.title === '发布中' ? '正在发布的稿件' : group.title === '结果待核实' ? '需要核实的发布' : group.title === '待批准整稿' ? '待批准的整稿' : '已批准的排期'}。</p>}
      </section>;
    })}
      <div className="business-publications-help"><FolderOpen size={17} /><p>制作中的内容、已核实发布与复盘记录在项目内查看。</p><button className="btn btn-secondary" onClick={onProjects}>查看项目</button></div>
    </div>
  </div>;
}
