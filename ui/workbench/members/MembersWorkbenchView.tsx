import React from 'react';
import { Search, Plus, ShieldCheck, Cpu, AlertTriangle } from 'lucide-react';
import type { Member } from '../../types';
import { memberUnavailableReason } from '../../memberAvailability';

interface MembersWorkbenchViewProps {
  members: Member[];
  onDiscover: () => void;
  onCreateMember: () => void;
  onEditMember: (member: Member) => void;
}

export function MembersWorkbenchView({
  members,
  onDiscover,
  onCreateMember,
  onEditMember,
}: MembersWorkbenchViewProps) {
  const enabledCount = members.filter((m) => m.enabled).length;

  return (
    <div className="members-view" style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
      <div className="view-header">
        <div>
          <h2 className="view-title">团队与 CLI 代理</h2>
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>
            {enabledCount} 名已启用成员 · 官方 CLI 凭据由原生客户端管理，此工作台不存储或打印凭据
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-secondary" onClick={onDiscover}>
            <Search size={14} />
            <span>自动发现已安装 CLI</span>
          </button>
          <button className="btn btn-primary" onClick={onCreateMember}>
            <Plus size={14} />
            <span>添加代理成员</span>
          </button>
        </div>
      </div>

      <div className="members-grid" style={{ marginTop: '20px' }}>
        {members.map((m) => {
          const isController = m.provider === 'controller';
          const reason = memberUnavailableReason(m);

          return (
            <div key={m.id} className="member-card">
              <div className="member-card-header">
                <div className="member-info-left">
                  <div className={`provider-avatar provider-${m.provider}`} title={m.provider}>
                    {m.name.slice(0, 1)}
                  </div>
                  <div>
                    <div className="member-name-row">
                      <strong className="member-name">{m.name}</strong>
                      <span className="member-handle">@{m.handle}</span>
                    </div>
                    <div className="member-provider-tag">
                      {m.provider} · {m.role}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <span
                    className={`member-status-pill ${
                      !m.enabled ? 'disabled' : m.status === 'busy' ? 'busy' : 'ready'
                    }`}
                  >
                    {!m.enabled ? '已停用' : m.status === 'busy' ? '排队忙碌' : '可用'}
                  </span>
                </div>
              </div>

              {reason && (
                <div className="member-warning" style={{ fontSize: '11px', marginTop: '8px', color: 'var(--wb-warning)' }}>
                  <AlertTriangle size={12} /> {reason}
                </div>
              )}

              {m.skills && (
                <div className="member-skills-text" style={{ fontSize: '12px', marginTop: '10px', color: 'var(--text-secondary)' }}>
                  {m.skills}
                </div>
              )}

              <div className="member-card-footer" style={{ marginTop: '14px', paddingTop: '10px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  权限: {m.permission === 'edit' ? '工作目录内编辑' : '方案规划'}
                </span>
                {!isController && (
                  <button className="file-link" onClick={() => onEditMember(m)}>
                    配置
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
