import { useEffect, useState } from 'react';
import { FolderArchive, FolderOpen, Monitor } from 'lucide-react';
import type { DesktopInfo } from './desktop';

export default function DesktopSettings() {
  const desktop = window.cliTeamDesktop;
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [pending, setPending] = useState<'loading' | 'opening' | 'switching' | null>(desktop ? 'loading' : null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    desktop.getInfo().then((result) => { if (active) setInfo(result); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '读取桌面信息失败'); })
      .finally(() => { if (active) setPending(null); });
    return () => { active = false; };
  }, [desktop]);

  if (!desktop) return null;

  const openWorkspace = async () => {
    if (pending) return;
    setPending('opening');
    setError('');
    setNotice('');
    try { await desktop.openWorkspace(); }
    catch (reason: unknown) { setError(reason instanceof Error ? reason.message : '打开工作目录失败'); }
    finally { setPending(null); }
  };

  const selectWorkspace = async () => {
    if (pending) return;
    setPending('switching');
    setError('');
    setNotice('');
    try {
      const result = await desktop.selectWorkspace();
      if (result.changed) {
        setInfo((current) => current ? { ...current, workspace: result.workspace } : current);
        setNotice('工作目录已切换，正在加载对应工作区。');
      }
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : '切换工作目录失败'); }
    finally { setPending(null); }
  };

  return <section className="settings-group" style={{ marginBottom: 16 }}>
    <div className="settings-label"><Monitor size={14} aria-hidden="true" /> 桌面应用</div>
    <div className="settings-row"><span>桌面版本</span><span>{info ? info.version : pending === 'loading' ? '读取中…' : '暂不可用'}</span></div>
    <div className="settings-row"><span>当前工作目录</span><span className="mono-path" style={{ overflowWrap: 'anywhere' }}>{info?.workspace || (pending === 'loading' ? '读取中…' : '暂不可用')}</span></div>
    <p className="text-muted">在系统目录选择窗口中切换工作目录，桌面应用会重新加载该目录下的团队服务。</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" className="btn btn-secondary" disabled={Boolean(pending)} onClick={openWorkspace}>
        <FolderOpen size={14} /><span>{pending === 'opening' ? '正在打开…' : '打开工作目录'}</span>
      </button>
      <button type="button" className="btn btn-secondary" disabled={Boolean(pending)} onClick={selectWorkspace}>
        <FolderArchive size={14} /><span>{pending === 'switching' ? '正在切换工作目录…' : '切换工作目录'}</span>
      </button>
    </div>
    {pending === 'switching' && <p role="status" className="text-muted">请在系统窗口选择目录，随后等待工作区加载。</p>}
    {notice && <p role="status" className="text-muted">{notice}</p>}
    {error && <div role="alert" className="error-banner" style={{ marginTop: 8 }}>{error}</div>}
  </section>;
}
