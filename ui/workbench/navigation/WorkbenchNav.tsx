import { useEffect, useState } from 'react';
import { MessagesSquare, Users, FolderArchive, Settings as SettingsIcon, Monitor, Archive, AlertCircle, FlaskConical, FolderOpen, Send, History, MoreHorizontal, Radio } from 'lucide-react';
import type { Bootstrap, BusinessSnapshot } from '../../types';
import { publicationGroup } from '../../projects/businessState';

declare global {
  interface ImportMeta { env: { DEV: boolean } }
}

export type WorkbenchTab = 'projects' | 'publications' | 'rooms' | 'tasks' | 'members' | 'attention' | 'artifacts' | 'settings' | 'external' | 'archive' | 'fixtures';

export function WorkbenchNav({ activeTab, mobileNavOpen, bootstrap, business, onTabChange, covered = false }: {
  activeTab: WorkbenchTab; mobileNavOpen: boolean; bootstrap: Bootstrap | null; business?: BusinessSnapshot;
  onTabChange: (tab: WorkbenchTab) => void;
  covered?: boolean;
}) {
  const legacyTab = !['projects', 'publications', 'tasks', 'settings'].includes(activeTab);
  const [moreOpen, setMoreOpen] = useState(legacyTab);
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => { if (legacyTab) setMoreOpen(true); }, [legacyTab]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 768px)');
    const update = () => setMobileLayout(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const visibleTasks = (bootstrap?.tasks || []).filter((task) => !task.archivedAt);
  const attentionCount = visibleTasks.filter((task) => ['blocked', 'review'].includes(task.status)).length;
  const pendingPublications = business?.contentItems.filter((item) => ['awaiting', 'unknown'].includes(publicationGroup(business, item))).length || 0;
  const mainItems = [
    { tab: 'projects' as const, label: '项目', icon: FolderOpen, count: 0 },
    { tab: 'publications' as const, label: '待发布', icon: Send, count: pendingPublications },
    { tab: 'tasks' as const, label: '任务记录', icon: History, count: attentionCount },
    { tab: 'settings' as const, label: '设置', icon: SettingsIcon, count: 0 },
  ];
  const tools = [
    { tab: 'rooms' as const, label: '团队讨论', icon: MessagesSquare },
    { tab: 'attention' as const, label: '待我处理', icon: AlertCircle },
    { tab: 'members' as const, label: '成员管理', icon: Users },
    { tab: 'artifacts' as const, label: '产物文件', icon: FolderArchive },
    { tab: 'external' as const, label: '外部会话', icon: Monitor },
    { tab: 'archive' as const, label: '归档记录', icon: Archive },
  ];
  return <nav id="workbench-navigation" className={`app-sidebar business-main-nav ${mobileNavOpen ? 'open' : ''}`} aria-label="主功能导航" inert={covered || mobileLayout && !mobileNavOpen} aria-hidden={covered || mobileLayout && !mobileNavOpen || undefined}>
    <div className="nav-group">{mainItems.map(({ tab, label, icon: Icon, count }) => <button key={tab} className={`nav-item ${activeTab === tab ? 'active' : ''}`} aria-current={activeTab === tab ? 'page' : undefined} onClick={() => onTabChange(tab)}>
      <Icon size={18} /><span>{label}</span>{count > 0 && <span className="nav-badge">{count}</span>}
    </button>)}
      <details className="business-nav-tools" open={moreOpen} onToggle={(event) => setMoreOpen(event.currentTarget.open)}><summary title="团队讨论、成员、成果与旧任务工具"><MoreHorizontal size={18} /><span>更多工具</span></summary>
        <div className="business-nav-tools-list">{tools.map(({ tab, label, icon: Icon }) => <button key={tab} className={`nav-item business-tool-nav ${activeTab === tab ? 'active' : ''}`} onClick={() => onTabChange(tab)}><Icon size={15} /><span>{label}</span></button>)}
          {import.meta.env.DEV && <button className={`nav-item business-tool-nav ${activeTab === 'fixtures' ? 'active' : ''}`} onClick={() => onTabChange('fixtures')}><FlaskConical size={15} /><span>开发预览</span></button>}
        </div>
      </details>
    </div>
    <div className="sidebar-footer-info" title="工作台服务仅在本机运行"><Radio size={15} aria-hidden="true" /><span>本机工作台</span></div>
  </nav>;
}
