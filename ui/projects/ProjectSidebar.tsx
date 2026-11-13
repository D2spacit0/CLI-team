import { FolderOpen, Plus, Search, X } from 'lucide-react';
import type { Bootstrap, BusinessProject, BusinessSnapshot } from '../types';
import { searchProject, type ProjectSearchResult } from './projectWorkspaceState';
import { projectDailyStatus } from './projectDailyStatus';

export default function ProjectSidebar({ state, bootstrap, project, query, onQuery, onCreate, onProject,
  onResult, disabled, covered = false, unavailable = false }: {
  state: BusinessSnapshot; bootstrap: Bootstrap; project?: BusinessProject;
  query: string; onQuery: (query: string) => void; onCreate: () => void;
  onProject: (id: string) => void; onResult: (result: ProjectSearchResult) => void;
  disabled: boolean; covered?: boolean; unavailable?: boolean;
}) {
  const results = project ? searchProject(state, project.id, query) : [];
  const labels = { work: '团队过程', message: '消息', content: '内容', fact: '资料', material: '文件' };
  return <aside className="team-sidebar" aria-label="工作列表与搜索" inert={covered}>
    <div className="team-sidebar-heading"><FolderOpen size={16} /><h2>我的工作</h2><button className="btn btn-icon-only btn-secondary" disabled={disabled} aria-label="开始新工作" title="开始新工作" onClick={onCreate}><Plus size={17} /></button></div>
    <label className="team-project-search"><Search size={14} /><input value={query} disabled={!project} onChange={event => onQuery(event.target.value)} aria-label="搜索当前项目" placeholder="搜索当前工作" />{query && <button type="button" aria-label="清空项目搜索" onClick={() => onQuery('')}><X size={13} /></button>}</label>
    <div className="team-sidebar-scroll">
      {query.trim() ? <section className="team-search-results" aria-label="项目搜索结果"><p role="status">找到 {results.length} 项{results.length > 60 ? '，先显示最近 60 项' : ''}</p>{results.slice(0, 60).map(result => <button key={result.id} disabled={disabled} onClick={() => onResult(result)}><small>{labels[result.kind]}</small><strong>{result.title}</strong><span>{result.excerpt}</span></button>)}{!results.length && <div className="team-search-empty">没有匹配内容。可以换个词，或清空搜索返回工作列表。</div>}</section>
        : <div className="team-project-choices" aria-label="项目列表">{state.projects.map(entry => {
          const progress = projectDailyStatus(entry, state, bootstrap, unavailable);
          const active = ['running', 'sending'].includes(progress.kind);
          const selected = project?.id === entry.id;
          return <button key={entry.id} disabled={disabled} className={selected ? 'selected' : ''} aria-current={selected ? 'page' : undefined} onClick={() => onProject(entry.id)}>
            <span className={'team-project-marker ' + (active ? 'active' : '')} aria-hidden="true" /><span className="team-project-index-copy"><strong>{entry.name}</strong>{!selected && <small title={progress.title}>{progress.title}</small>}</span>
          </button>;
        })}{!state.projects.length && <p className="team-sidebar-empty">新工作会保留在这里。</p>}</div>}
    </div>
  </aside>;
}
