import { FileText, FolderOpen, MessageSquare, Plus, Search, Users, X } from 'lucide-react';
import type { Bootstrap, BusinessProject, BusinessSnapshot } from '../types';
import { businessTime, contentRevision, contentState, publicationGroup, safeSourceUrl } from './businessState';
import { projectMessages, searchProject, type ProjectSearchResult } from './projectWorkspaceState';

export default function ProjectSidebar({ state, bootstrap, project, query, onQuery, onCreate, onProject,
  onContent, onFocus, onResult, onTeam, disabled, covered = false }: {
  state: BusinessSnapshot; bootstrap: Bootstrap; project?: BusinessProject;
  query: string; onQuery: (query: string) => void; onCreate: () => void;
  onProject: (id: string) => void; onContent: (id: string) => void; onFocus: (id: string) => void;
  onResult: (result: ProjectSearchResult) => void; onTeam: () => void; disabled: boolean; covered?: boolean;
}) {
  const results = project ? searchProject(state, project.id, query) : [];
  const messages = project ? projectMessages(state, project.id).filter(message => message.actorId === 'user').slice(-5).reverse() : [];
  const contents = project ? state.contentItems.filter(item => item.projectId === project.id).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)) : [];
  const labels = { work: '工作', message: '消息', content: '整稿', fact: '资料', material: '文件' };
  return <aside className="team-sidebar" aria-label="项目、团队与历史" inert={covered}>
    <div className="team-sidebar-heading"><FolderOpen size={16} /><h2>项目索引 <span>{state.projects.length}</span></h2><button className="btn btn-icon-only btn-secondary" disabled={disabled} aria-label="建立业务项目" title="建立业务项目" onClick={onCreate}><Plus size={17} /></button></div>
    <label className="team-project-search"><Search size={14} /><input value={query} disabled={!project} onChange={event => onQuery(event.target.value)} aria-label="搜索当前项目" placeholder="搜索消息、工作、稿件" />{query && <button type="button" aria-label="清空项目搜索" onClick={() => onQuery('')}><X size={13} /></button>}</label>
    <div className="team-sidebar-scroll">
      {query.trim() ? <section className="team-search-results" aria-label="项目搜索结果"><p role="status">找到 {results.length} 项{results.length > 60 ? '，先显示最近 60 项' : ''}</p>{results.slice(0, 60).map(result => <button key={result.id} disabled={disabled} onClick={() => onResult(result)}><small>{labels[result.kind]}</small><strong>{result.title}</strong><span>{result.excerpt}</span></button>)}{!results.length && <div className="team-search-empty">当前项目没有匹配内容。可以换一个词，或清空搜索查看全部记录。</div>}</section>
        : <>
          <div className="team-project-choices" aria-label="项目列表">{state.projects.map(entry => {
            const pending = state.contentItems.filter(item => item.projectId === entry.id && publicationGroup(state, item) === 'awaiting').length;
            const active = entry.status === 'active' && !bootstrap.workspace.paused;
            const status = entry.status === 'archived' ? '已归档' : entry.status === 'paused' || bootstrap.workspace.paused ? '新工作暂停' : active ? '持续推进' : '待处理';
            return <button key={entry.id} disabled={disabled} className={project?.id === entry.id ? 'selected' : ''} aria-current={project?.id === entry.id ? 'page' : undefined} onClick={() => onProject(entry.id)}><span className={`team-project-marker ${active ? 'active' : ''}`} aria-hidden="true" /><span className="team-project-index-copy"><strong>{entry.name}</strong><small>{status}</small></span>{pending > 0 && <b title={`${pending}篇整稿待确认`}>{pending}</b>}</button>;
          })}</div>
          {project && <>
            <section className="team-sidebar-section"><div className="team-sidebar-section-heading"><h3>项目团队</h3><button disabled={disabled} onClick={onTeam} aria-label="查看团队与协作规范"><Users size={13} /></button></div>
              {project.memberIds.map(id => {
                const member = bootstrap.members.find(entry => entry.id === id);
                const running = state.workItems.some(work => work.projectId === project.id && work.memberId === id && work.status === 'running');
                const ready = member?.enabled && member.runtime?.status === 'ready';
                return <div className="team-member-row" key={id}><span className="team-member-avatar">{(member?.name || '成').slice(0, 1)}<i className={running ? 'working' : ready ? 'ready' : 'off'} title={running ? '正在工作' : ready ? '最近运行检查可用' : member?.enabled ? '运行情况将在派工前核对' : '未启用'} /></span><span><strong>{member?.name || '成员记录缺失'}</strong><small>{id === project.ownerId ? '负责人' : id === project.reviewerId ? '独立审稿' : '执行成员'}</small></span>{running && <small className="team-member-running">工作中</small>}</div>;
              })}
            </section>
            <section className="team-sidebar-section"><div className="team-sidebar-section-heading"><h3>稿件历史</h3><span>{contents.length}</span></div>{contents.length ? contents.map(item => <button className="team-history-row" key={item.id} disabled={disabled} onClick={() => onContent(item.id)}><FileText size={13} /><span><strong>{contentRevision(state, item)?.title || item.title}</strong><small>{contentState(state, item).label} · {businessTime(item.updatedAt || item.createdAt, project.timeZone)}</small></span></button>) : <p className="team-sidebar-empty">整稿形成后会保留在这里</p>}</section>
            {messages.length > 0 && <section className="team-sidebar-section"><div className="team-sidebar-section-heading"><h3>最近沟通</h3></div>{messages.map(message => <button className="team-history-row" key={message.id} disabled={disabled} onClick={() => onFocus(message.id)}><MessageSquare size={13} /><span><strong>{message.body}</strong><small>{businessTime(message.createdAt, project.timeZone)}</small></span></button>)}</section>}
            {state.skillCatalog.length > 0 && <details className="team-sidebar-skills"><summary>内置协作规范 <span>{state.skillCatalog.length}</span></summary>{state.skillCatalog.map(skill => <div key={skill.id}><strong>{skill.name}</strong><span>v{skill.version}</span><p>{skill.description}</p>{safeSourceUrl(skill.sourceUrl) && <a href={safeSourceUrl(skill.sourceUrl)!} target="_blank" rel="noreferrer">查看来源</a>}</div>)}</details>}
          </>}
        </>}
    </div>
    <footer className="team-sidebar-footer"><span className="team-presence" /><span>本机工作区<small>关机后暂停推进</small></span></footer>
  </aside>;
}
