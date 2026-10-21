import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Download, GitBranch, LockKeyhole, Monitor, RefreshCw } from 'lucide-react';
import { api } from './api';
import type { ExternalSession } from './types';

const statusNames = {
  running: '执行未结束', idle: '本轮已结束', stopped: '本轮已停止', unknown: '状态未知',
};

export default function ExternalSessions({ imports, onChange, onRelay }: {
  imports: ExternalSession[]; onChange: () => Promise<void>; onRelay: (session: ExternalSession) => void;
}) {
  const [sessions, setSessions] = useState<ExternalSession[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const selected = sessions.find((item) => item.sessionId === selectedId) || sessions[0];

  async function refresh(background = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!background) setBusy(true);
    try {
      const result = await api.getDshSessions();
      const synced = await api.refreshDshSessions();
      if (!alive.current) return;
      const merged = new Map([...result.sessions, ...synced.sessions].map((item) => [item.sessionId, item]));
      setSessions([...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setWarnings([...result.warnings.map((item) => item.error), ...synced.errors.map((item) => item.error)]);
      setError('');
      await onChange();
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '同步失败');
    } finally {
      inFlight.current = false;
      if (!background && alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => { void refresh(true); }, 15000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);

  async function attach(session: ExternalSession) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await api.importDshSession(session.sessionId);
      await onChange();
      if (alive.current) setError('');
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '挂载失败');
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }

  return <div className="external-view">
    <div className="view-header">
      <h2 className="view-title">外部会话</h2>
      <button className="btn btn-icon-only btn-secondary" onClick={() => void refresh()} disabled={busy}
        title="同步 DSH 会话" aria-label="同步 DSH 会话"><RefreshCw size={16} /></button>
    </div>
    {error && <div className="external-error" role="alert"><AlertCircle size={16} />
      <span>{error}</span><button className="btn btn-sm btn-secondary" disabled={busy}
        onClick={() => void refresh()}>重试同步</button></div>}
    {warnings.map((warning, index) => <div key={index} className="external-error">{warning}</div>)}
    <div className="external-layout">
      <div className="external-list" aria-label="DSH 会话列表">
        {sessions.length === 0 && <p className="external-empty">{busy ? '读取中' : '未发现可读取的 DSH 会话'}</p>}
        {sessions.map((session) => {
          const imported = imports.some((item) => item.sessionId === session.sessionId);
          return <button key={session.sessionId} className={`external-row ${selected?.sessionId === session.sessionId ? 'selected' : ''}`}
            onClick={() => setSelectedId(session.sessionId)}>
            <Monitor size={17} />
            <span><strong>{session.title}</strong><small>{statusNames[session.activity]} · {imported ? '已挂载' : '未挂载'}</small></span>
          </button>;
        })}
      </div>
      {selected && <section className="external-detail">
        <div className="external-title">
          <h3>{selected.title}</h3>
          <button className="btn btn-secondary" disabled={busy} onClick={() => onRelay(selected)}>
            <GitBranch size={15} /><span>独立接力</span>
          </button>
          {!imports.some((item) => item.sessionId === selected.sessionId) &&
            <button className="btn btn-secondary" disabled={busy} onClick={() => void attach(selected)}>
              <Download size={15} /><span>只读挂载</span>
            </button>}
        </div>
        <div className="external-ownership"><LockKeyhole size={16} />写入权：DSH 桌面端<span>只读接入</span></div>
        <dl className="external-facts">
          <dt>工作目录</dt><dd className="mono-path">{selected.workspace}</dd>
          <dt>会话 ID</dt><dd className="mono-path">{selected.sessionId}</dd>
          <dt>日志状态</dt><dd>{statusNames[selected.activity]}{selected.partial ? ' · 日志追加中' : ''}</dd>
          <dt>最近工具</dt><dd>{selected.lastTool || '无'}</dd>
          <dt>日志记录</dt><dd>{selected.eventCount.toLocaleString()}</dd>
          <dt>最近更新</dt><dd>{new Date(selected.lastEventAt || selected.updatedAt).toLocaleString('zh-CN')}</dd>
        </dl>
        <h4>最近答复摘录</h4>
        <pre className="external-summary">{selected.summary || '尚无答复'}</pre>
        {selected.lastRequest && <><h4>最近请求摘录</h4><pre className="external-summary">{selected.lastRequest}</pre></>}
      </section>}
    </div>
  </div>;
}
