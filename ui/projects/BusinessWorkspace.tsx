import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, FolderOpen, Plus, RefreshCw, X } from 'lucide-react';
import type { Bootstrap, BusinessSnapshot } from '../types';
import { BusinessBadge, BusinessNotice } from './BusinessComponents';
import { businessTime, currentContentVersion, safeSourceUrl } from './businessState';
import ProjectHome, { ProjectRecap, ProjectResources } from './ProjectHome';
import ProjectSidebar from './ProjectSidebar';
import ProjectCommandStrip from './ProjectCommandStrip';
import { preferredProjectContent, type ProjectPanel, type ProjectSearchResult } from './projectWorkspaceState';
import { useBusinessBusy } from './useBusinessBusy';
import { useInspectorOverlay } from './useInspectorOverlay';
import ProjectCreateDialog from './ProjectCreateDialog';
import ContentWorkbench from '../content/ContentWorkbench';
import PublicationsView from '../publications/PublicationsView';
import './business.css';
import './team-workspace.css';

export interface BusinessNavigation { projectId?: string | null; contentId?: string | null; versionId?: string | null; focusId?: string | null; panel?: string | null }
export interface BusinessSettingsContext extends BusinessNavigation { section?: 'account' | 'team' | 'runtime' }

export default function BusinessWorkspace({ view, bootstrap, state, loading, error, revision, projectId, contentId, versionId, focusId, panel,
  onNavigate, onRefresh, onSettings, onMembers, onBusy, onStartWork }: {
  view: 'projects' | 'publications'; bootstrap: Bootstrap; state: BusinessSnapshot;
  loading: boolean; error: string; revision: number; projectId?: string | null; contentId?: string | null;
  versionId?: string | null; focusId?: string | null; panel?: string | null;
  onNavigate: (view: 'projects' | 'publications', selection?: BusinessNavigation) => void;
  onRefresh: () => Promise<void>; onSettings: (context: BusinessSettingsContext) => void;
  onMembers: (context: BusinessNavigation) => void; onBusy: (busy: boolean) => void; onStartWork: () => void;
}) {
  const creating = panel === 'create';
  const [query, setQuery] = useState('');
  const [focusNonce, setFocusNonce] = useState(0);
  const [rememberedContent, setRememberedContent] = useState<Record<string, string>>({});
  const contextPanel = useRef<HTMLDivElement>(null);
  const workspacePanel = useRef<HTMLDivElement>(null);
  const inspectorPanel = useRef<HTMLElement>(null);
  const { busy, report } = useBusinessBusy(onBusy);
  const reportConversation = useCallback((value: boolean) => report('conversation', value), [report]);
  const reportContent = useCallback((value: boolean) => report('content', value), [report]);
  const reportContext = useCallback((value: boolean) => report('context', value), [report]);
  const reportCreate = useCallback((value: boolean) => report('create', value), [report]);
  const reportCommand = useCallback((value: boolean) => report('command', value), [report]);
  const explicitContent = contentId ? state.contentItems.find((item) => item.id === contentId) : null;
  const selectedId = explicitContent?.projectId || projectId;
  const project = state.projects.find((entry) => entry.id === selectedId)
    || (!selectedId ? state.projects.find((entry) => entry.status !== 'archived') : null);
  const preferredId = project ? preferredProjectContent(state, project.id) : null;
  const rememberedId = project && rememberedContent[project.id];
  const defaultContent = state.contentItems.find(item => item.id === rememberedId && item.projectId === project?.id)
    || state.contentItems.find(item => item.id === preferredId);
  const content = explicitContent || (!contentId ? defaultContent : null);
  const currentPanel: ProjectPanel = ['resources', 'recap', 'team'].includes(panel || '') ? panel as ProjectPanel : 'content';
  const inspectorOpen = !creating && panel !== 'conversation' && Boolean(contentId || ['content', 'resources', 'recap', 'team'].includes(panel || ''));
  const inspectorOverlay = useInspectorOverlay({ workspace: workspacePanel, inspector: inspectorPanel, projectId: project?.id,
    shown: Boolean(project && inspectorOpen && !loading && (view !== 'publications' || contentId)), empty: currentPanel === 'content' && !content });
  useEffect(() => { setQuery(''); }, [project?.id]);
  useEffect(() => {
    if (project && content && rememberedContent[project.id] !== content.id) {
      setRememberedContent(previous => ({ ...previous, [project.id]: content.id }));
    }
  }, [project?.id, content?.id]);
  useEffect(() => {
    if (!focusId || !contextPanel.current) return;
    const target = [...contextPanel.current.querySelectorAll<HTMLElement>('[data-project-focus]')].find(node => node.dataset.projectFocus === focusId);
    target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [focusId, focusNonce, currentPanel]);
  const openContent = (id: string, selectedVersion?: string) => {
    if (busy) return;
    const target = state.contentItems.find((entry) => entry.id === id);
    if (target) onNavigate('projects', { projectId: target.projectId, contentId: id, versionId: selectedVersion || currentContentVersion(target), focusId });
  };
  const currentContext = (): BusinessNavigation => ({ projectId: project?.id || projectId, contentId: content?.id || contentId,
    versionId: versionId || (content ? currentContentVersion(content) : null), focusId, panel: inspectorOpen ? currentPanel : 'conversation' });
  const openSettings = (section?: 'account' | 'team' | 'runtime') => { if (!busy) onSettings({ ...currentContext(), section }); };
  const openMembers = () => { if (!busy) onMembers(currentContext()); };
  const closeCreate = () => onNavigate('projects', { projectId, contentId, versionId, focusId, panel: contentId ? 'content' : 'conversation' });
  const showPanel = (next: ProjectPanel | 'conversation') => {
    if (!project || busy) return;
    onNavigate('projects', { projectId: project.id, contentId: content?.id, versionId, focusId, panel: next });
  };
  const focusEntry = (id: string) => {
    if (!project || busy) return;
    setFocusNonce(value => value + 1);
    onNavigate('projects', { projectId: project.id, contentId: content?.id, versionId,
      panel: window.matchMedia('(max-width: 900px)').matches || !inspectorOpen ? 'conversation' : currentPanel, focusId: id });
  };
  const selectResult = (result: ProjectSearchResult) => {
    if (!project || busy) return;
    setQuery('');
    setFocusNonce(value => value + 1);
    const conversationResult = ['work', 'message'].includes(result.kind);
    const searchPanel = ['fact', 'material'].includes(result.kind) ? 'resources'
      : conversationResult ? (window.matchMedia('(max-width: 900px)').matches || !inspectorOpen ? 'conversation' : currentPanel) : 'content';
    onNavigate('projects', { projectId: project.id, contentId: result.contentId || content?.id,
      versionId: result.versionId, focusId: result.id, panel: searchPanel });
  };
  const contextProps = project ? { project, bootstrap, state, onRefresh, onOpenContent: openContent, onSettings: openSettings, onBusy: reportContext } : null;
  return <div className="business-workspace">
    {error && <BusinessNotice tone="danger" action={<button className="btn btn-sm btn-secondary" onClick={() => void onRefresh()}><RefreshCw size={13} />重新读取</button>}>业务数据暂时无法读取：{error}</BusinessNotice>}
    {loading ? <div className="business-page-empty" role="status"><RefreshCw size={22} /><p>正在读取项目与内容进度</p></div>
      : view === 'publications' && !contentId ? <PublicationsView state={state} onOpenContent={openContent} onProjects={() => onNavigate('projects')} />
        : <div ref={workspacePanel} inert={creating} onFocusCapture={inspectorOverlay.rememberFocus} className={`team-workbench ${project ? '' : 'without-project'} ${inspectorOpen ? 'with-inspector' : 'without-inspector'}`}>
          {project && <ProjectCommandStrip key={`command-${project.id}`} project={project} state={state} bootstrap={bootstrap} disabled={busy} unavailable={Boolean(error)}
            covered={inspectorOverlay.coversIndex} overlayOpen={inspectorOverlay.coversConversation} onFocus={focusEntry} onOpenContent={openContent} onSettings={openSettings}
            onRefresh={onRefresh} onBusy={reportCommand} />}
          <ProjectSidebar state={state} bootstrap={bootstrap} project={project || undefined} query={query} onQuery={setQuery}
            onCreate={onStartWork} onProject={id => onNavigate('projects', { projectId: id })}
            onResult={selectResult} disabled={busy || Boolean(error)} unavailable={Boolean(error)} covered={inspectorOverlay.coversIndex} />
          {project ? <ProjectHome key={`conversation-${project.id}`} project={project} bootstrap={bootstrap} state={state} onRefresh={onRefresh} onOpenContent={openContent}
            onSettings={openSettings} onBusy={reportConversation} onShowPanel={showPanel} onFocus={focusEntry} focusId={focusId} focusNonce={focusNonce} selectedContentId={content?.id} covered={inspectorOverlay.coversConversation} inspectorOpen={inspectorOpen} />
            : projectId ? <div className="business-page-empty"><h2>当前工作区没有这个项目</h2><button className="btn btn-secondary" onClick={() => onNavigate('projects')}>返回项目列表</button></div>
              : <div className="business-project-onboarding"><div className="business-onboarding-icon"><FolderOpen size={26} /></div><h1>把目标交给团队</h1><p>完成一次任务，或让团队持续运营内容。先交代你想要的结果，团队负责安排工作、检查与修改。</p>
                <div className="business-onboarding-workflow"><span>交代目标</span><ArrowRight size={14} /><span>团队推进</span><ArrowRight size={14} /><strong>看成果，提修改</strong></div>
                <button className="btn btn-primary business-start-project" disabled={Boolean(error)} onClick={onStartWork}><Plus size={16} />开始第一项工作</button><p className="business-onboarding-note">一次性任务和持续运营都从这里开始。内容运营可以先准备稿件，随后接入发布账号。</p>
              </div>}
          {project && inspectorOpen && <aside ref={inspectorPanel} className="team-inspector" aria-label="项目成果与上下文" tabIndex={-1} inert={!inspectorOverlay.visible}>
            <div className="team-inspector-nav" aria-label="成果面板内容"><span className="team-inspector-label"><FileText size={14} />成果台</span>{([['content', '整稿'], ['resources', '资料'], ['recap', '复盘'], ['team', '团队']] as const).map(([key, label]) => <button key={key} disabled={busy} aria-pressed={currentPanel === key} className={currentPanel === key ? 'active' : ''} onClick={() => showPanel(key)}>{label}</button>)}{currentPanel !== 'content' && <button className="team-close-context" disabled={busy} aria-label="收起上下文面板" onClick={() => showPanel('conversation')}><X size={16} /></button>}</div>
            {currentPanel === 'content' ? content ? <ContentWorkbench key={`${project.id}:${content.id}`} item={content} project={project} state={state} bootstrap={bootstrap} dataRevision={revision}
              embedded requestedVersionId={versionId} onVersionChange={next => onNavigate('projects', { projectId: project.id, contentId: content.id, versionId: next, focusId })}
              onRefresh={onRefresh} onBack={() => showPanel('conversation')} onSettings={openSettings} onBusy={reportContent} />
              : <div className="team-inspector-empty"><FileText size={30} /><h2>{contentId ? '未找到这篇稿件' : '整稿准备好后，在这里审阅'}</h2><p>{contentId ? '该稿件不在当前工作区。项目中的其他工作仍可正常查看。' : '标题、正文、真实配图和审稿意见会放在一起。确认后，团队继续处理发布。'}</p><button className="btn btn-secondary" onClick={() => showPanel('resources')}>查看项目资料</button></div>
              : <div className="team-context-panel" ref={contextPanel}>
                {currentPanel === 'resources' && contextProps && <ProjectResources key={project.id} {...contextProps} />}
                {currentPanel === 'recap' && contextProps && <ProjectRecap {...contextProps} />}
                {currentPanel === 'team' && <><section className="business-section"><h2>项目团队与运行条件</h2><p className="business-muted">负责人负责安排、收取和接续工作。最终发布由你确认。</p><div className="team-team-detail">{project.memberIds.map(id => { const member = bootstrap.members.find(entry => entry.id === id); return <article key={id}><strong>{member?.name || '成员记录缺失'}</strong><BusinessBadge label={id === project.ownerId ? '负责人' : id === project.reviewerId ? '独立审稿' : '执行成员'} tone="neutral" /><p>{member?.enabled ? member.status === 'busy' ? '成员正在运行' : member.runtime?.status === 'ready' ? '最近运行检查可用' : '运行情况将在派工前核对' : '成员未启用'}</p></article>; })}</div><button className="btn btn-secondary" disabled={busy} onClick={openMembers}>管理成员</button></section>
                  <section className="business-section"><h2>发布条件</h2><p className="business-muted">{project.account?.name || project.account?.label || '项目尚未绑定发布账号'}</p><p className="business-muted">{state.connection?.reason || (state.connection?.status === 'ready' ? '连接已可用，每篇整稿仍需检查、审稿和最终批准。' : state.connection?.status === 'login_required' ? '发布账号需要登录。' : '发布连接尚未配置或尚不可用。')}</p><button className="btn btn-secondary" disabled={busy} onClick={() => openSettings('account')}>账号与运行设置</button></section>
                  <section className="business-section"><h2>内置协作规范</h2>{state.skillCatalog.length ? state.skillCatalog.map(skill => <article key={skill.id} className="team-skill-detail"><strong>{skill.name} <small>v{skill.version}</small></strong><p>{skill.description}</p>{safeSourceUrl(skill.sourceUrl) && <a href={safeSourceUrl(skill.sourceUrl)!} target="_blank" rel="noreferrer">查看来源</a>}</article>) : <p className="business-muted">尚未读取到协作规范目录。</p>}</section>
                  <section className="business-section"><h2>周期记录</h2>{state.productionCycles.filter(cycle => cycle.projectId === project.id).map(cycle => <p key={cycle.id} className="business-muted">{cycle.dateKey || businessTime(cycle.createdAt, project.timeZone)} · {({ active: '推进中', planning: '规划中', running: '推进中', complete: '已完成', completed: '已完成', revising: '返工中', blocked: '待处理', cancelled: '已取消' } as Record<string, string>)[cycle.status] || '状态待确认'}</p>)}</section></>}
              </div>}
          </aside>}
        </div>}
    {creating && <ProjectCreateDialog bootstrap={bootstrap} onBusy={reportCreate} onClose={closeCreate}
      onMembers={() => onMembers({ projectId, contentId, versionId, focusId, panel: 'create' })}
      onCreated={async (created) => { await onRefresh(); onNavigate('projects', { projectId: created.id }); }} />}
  </div>;
}
