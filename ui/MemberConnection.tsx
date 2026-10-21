import { useState } from 'react';
import { api } from './api';
import type { Member } from './types';

const statusNames = { unchecked: '尚未检查接入', missing: '入口不完整', failed: '接入检查失败',
  available: '客户端启动已验证', ready: '协议与模型配置已验证' };
const checkNames = { entry: '程序入口', launch: '客户端启动', protocol: '协议连接', model: '模型选择', authentication: '模型服务认证' };
const checkStates = { passed: '通过', failed: '失败', not_checked: '未检查' };

export default function MemberConnection({ member, onChanged }: { member: Member; onChanged: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const runtime = member.runtime;
  const busy = checking || runtime?.checking;
  const probe = async () => {
    if (busy) return;
    setChecking(true); setError('');
    try { await api.probeMember(member.id); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '接入检查失败'); }
    finally { setChecking(false); }
  };
  return <section aria-label={`${member.name} 接入状态`} style={{ overflowWrap: 'anywhere', borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <strong style={{ fontSize: 12 }}>{busy ? '正在检查接入…' : statusNames[runtime?.status || 'unchecked']}</strong>
      <button className="btn btn-sm btn-secondary" disabled={Boolean(busy || member.status === 'busy')}
        onClick={() => void probe()}>{busy ? '检查中…' : '检查接入'}</button>
    </div>
    {(error || runtime?.error) && <p role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>{error || runtime?.error}</p>}
    {runtime?.hint && <p className="text-muted" style={{ fontSize: 12 }}>{runtime.hint}</p>}
    {runtime && <details style={{ fontSize: 12, marginTop: 8 }}>
      <summary>接入详情{runtime.version ? ` · v${runtime.version}` : ''}</summary>
      <p>接入方式：{runtime.transport} · {runtime.checkedAt ? new Date(runtime.checkedAt).toLocaleString() : '尚未检查'}</p>
      {runtime.entry.entryPoint && <p>CLI 入口：<code>{runtime.entry.entryPoint}</code></p>}
      <ul>{Object.entries(checkNames).map(([key, name]) => <li key={key}>{name}：{checkStates[runtime.checks[key as keyof typeof checkNames]]}</li>)}</ul>
      {runtime.selectedModel && <p>实际选择：<code>{runtime.selectedModel}</code></p>}
      {runtime.diagnostics?.configurationSources?.map((source) => <p key={source}>模型配置来源：<code>{source}</code></p>)}
      {Boolean(runtime.models?.length) && <p>可用模型：{runtime.models?.map((model) => model.id).join('、')}</p>}
    </details>}
  </section>;
}
