import { useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { Artifact } from './types';
import { api } from './api';

export default function ArtifactDownload({ artifact, compact = false, className = 'btn btn-sm btn-secondary' }: {
  artifact: Artifact; compact?: boolean; className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const download = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const bytes = await api.getArtifactDownload(artifact.id);
      const url = URL.createObjectURL(bytes);
      const link = document.createElement('a');
      link.href = url; link.download = artifact.name;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '下载失败，请重试'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
    <button type="button" className={className} disabled={busy} onClick={() => void download()}
      aria-label={`下载 ${artifact.name}`} title={`下载 ${artifact.name}`}>
      <Download size={13} />{!compact && <span>{busy ? '正在下载…' : error ? '重试下载' : '下载'}</span>}
    </button>
    {error && <span role="alert" style={{ color: 'var(--danger)', fontSize: 12, overflowWrap: 'anywhere' }}>{error}</span>}
  </span>;
}
