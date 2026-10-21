import React from 'react';
import {
  MessagesSquare,
  CheckSquare,
  Users,
  FolderArchive,
  Settings as SettingsIcon,
  Monitor,
  Archive,
  AlertCircle,
  FlaskConical,
} from 'lucide-react';
import type { Bootstrap } from '../../types';

declare global {
  interface ImportMeta {
    env: { DEV: boolean };
  }
}

export type WorkbenchTab =
  | 'rooms'
  | 'tasks'
  | 'members'
  | 'attention'
  | 'artifacts'
  | 'settings'
  | 'external'
  | 'archive'
  | 'fixtures';

interface WorkbenchNavProps {
  activeTab: WorkbenchTab;
  mobileNavOpen: boolean;
  bootstrap: Bootstrap | null;
  onTabChange: (tab: WorkbenchTab) => void;
}

export function WorkbenchNav({
  activeTab,
  mobileNavOpen,
  bootstrap,
  onTabChange,
}: WorkbenchNavProps) {
  const visibleTasks = (bootstrap?.tasks || []).filter((task) => !task.archivedAt);
  const attentionCount = visibleTasks.filter((task) =>
    ['blocked', 'review'].includes(task.status)
  ).length;
  const visibleArtifacts = (bootstrap?.artifacts || []).filter((artifact) =>
    visibleTasks.some((task) => task.id === artifact.taskId)
  );

  return (
    <nav className={`app-sidebar ${mobileNavOpen ? 'open' : ''}`} aria-label="主功能导航">
      <div className="nav-group">
        <button
          className={`nav-item ${activeTab === 'rooms' ? 'active' : ''}`}
          onClick={() => onTabChange('rooms')}
        >
          <MessagesSquare size={16} />
          <span>团队讨论</span>
        </button>

        <button
          className={`nav-item ${activeTab === 'tasks' ? 'active' : ''}`}
          onClick={() => onTabChange('tasks')}
        >
          <CheckSquare size={16} />
          <span>任务看板</span>
          {visibleTasks.length > 0 && (
            <span className="nav-badge">{visibleTasks.length}</span>
          )}
        </button>

        <button
          className={`nav-item ${activeTab === 'attention' ? 'active' : ''}`}
          onClick={() => onTabChange('attention')}
        >
          <AlertCircle size={16} />
          <span>待我处理</span>
          {attentionCount > 0 && (
            <span className="nav-badge" style={{ background: 'var(--wb-warning)' }}>
              {attentionCount}
            </span>
          )}
        </button>

        <button
          className={`nav-item ${activeTab === 'members' ? 'active' : ''}`}
          onClick={() => onTabChange('members')}
        >
          <Users size={16} />
          <span>成员管理</span>
          {bootstrap && (
            <span className="nav-badge">{bootstrap.members.length}</span>
          )}
        </button>

        <button
          className={`nav-item ${activeTab === 'artifacts' ? 'active' : ''}`}
          onClick={() => onTabChange('artifacts')}
        >
          <FolderArchive size={16} />
          <span>产物文件</span>
          {visibleArtifacts.length > 0 && (
            <span className="nav-badge">{visibleArtifacts.length}</span>
          )}
        </button>

        <button
          className={`nav-item ${activeTab === 'external' ? 'active' : ''}`}
          onClick={() => onTabChange('external')}
        >
          <Monitor size={16} />
          <span>外部会话</span>
          {Boolean(bootstrap?.externalSessions?.length) && (
            <span className="nav-badge">{bootstrap?.externalSessions.length}</span>
          )}
        </button>

        <button
          className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => onTabChange('settings')}
        >
          <SettingsIcon size={16} />
          <span>工作区设置</span>
        </button>

        {import.meta.env.DEV && (
          <button
            className={`nav-item ${activeTab === 'fixtures' ? 'active' : ''}`}
            onClick={() => onTabChange('fixtures')}
            title="开发预览 / 异常场景演示"
          >
            <FlaskConical size={16} />
            <span>开发预览</span>
          </button>
        )}
      </div>

      <div className="sidebar-footer-info">
        <button
          className={`nav-item ${activeTab === 'archive' ? 'active' : ''}`}
          title="归档记录"
          onClick={() => onTabChange('archive')}
        >
          <Archive size={15} />
          <span>归档记录</span>
          {Boolean(bootstrap?.archived?.tasks) && (
            <span className="nav-badge">{bootstrap?.archived.tasks}</span>
          )}
        </button>
        <div title="隔离模式: 目录隔离">目录隔离</div>
        <div title="协议: Loopback 本地服务">仅本机服务</div>
      </div>
    </nav>
  );
}
