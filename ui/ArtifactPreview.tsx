import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from './api';
import ArtifactDownload from './ArtifactDownload';
import type { Artifact, Task } from './types';

export default function ArtifactPreview({ artifact, status, onClose }: {
  artifact: Artifact; status?: Task['status']; onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    setText(null);
    setError('');
    api.getArtifactPreview(artifact.id).then((result) => {
      if (live) setText(result.text);
    }).catch((err) => { if (live) setError(err instanceof Error ? err.message : '预览失败'); });
    closeRef.current?.focus();
    return () => { live = false; };
  }, [artifact.id, attempt]);
  return <div className="modal-overlay" onClick={onClose} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
    <section className="modal-content artifact-reader" role="dialog" aria-modal="true" aria-label={`预览 ${artifact.name}`}
      onClick={(event) => event.stopPropagation()}>
      <header className="modal-header">
        <div className="reader-heading">
          <span className="modal-title">{artifact.name}</span>
          <small>{status === 'done' ? '已验收' : '候选稿 · 未验收'}
            {text !== null && ` · ${(text.match(/\p{Script=Han}/gu) || []).length.toLocaleString()} 汉字`}</small>
        </div>
        <ArtifactDownload artifact={artifact} compact className="btn btn-secondary btn-icon-only" />
        <button ref={closeRef} className="btn btn-secondary btn-icon-only" onClick={onClose} title="关闭预览" aria-label="关闭预览"><X size={15} /></button>
      </header>
      <div className="reader-body">
        {error ? <div className="error-banner" role="alert">{error}<button className="btn btn-sm btn-secondary" onClick={() => setAttempt(value => value + 1)}>重试预览</button></div>
          : text === null ? <div role="status">正在加载正文...</div>
          : <pre className={artifact.name.endsWith('.json') ? 'reader-json' : 'reader-prose'}>{text}</pre>}
      </div>
    </section>
  </div>;
}
