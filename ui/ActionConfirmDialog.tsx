import { useEffect, useId, useRef } from 'react';
import { AlertCircle, X } from 'lucide-react';
import './TaskOperations.css';

export default function ActionConfirmDialog({ title, message, confirmText, returnText, busy, disabled, error, onConfirm, onClose }: {
  title: string; message: string; confirmText: string; returnText: string;
  busy: boolean; disabled: boolean; error: string; onConfirm: () => void; onClose: () => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const current = useRef({ busy, onClose });
  current.current = { busy, onClose };
  const titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const element = overlay.current!;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = [...(element.parentElement?.children || [])].filter((item): item is HTMLElement => item instanceof HTMLElement && item !== element);
    const previousInert = siblings.map(item => item.inert);
    siblings.forEach(item => { item.inert = true; });
    back.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopImmediatePropagation();
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (!current.current.busy) current.current.onClose();
      }
      if (event.key === 'Tab') {
        const controls = [...element.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const target = event.shiftKey ? controls.at(-1) : controls[0];
        if (!controls.length || !element.contains(document.activeElement)
            || (event.shiftKey ? document.activeElement === controls[0] : document.activeElement === controls.at(-1))) {
          event.preventDefault(); target?.focus();
        }
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      siblings.forEach((item, index) => { item.inert = previousInert[index]; });
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  const close = () => { if (!busy) onClose(); };
  return <div ref={overlay} className="modal-overlay action-confirm-overlay" onClick={close}>
    <div className="modal-content" data-action-confirm role="alertdialog" aria-modal="true" aria-labelledby={titleId}
      aria-describedby={descriptionId} aria-busy={busy} onClick={event => event.stopPropagation()}>
      <div className="modal-header">
        <span className="modal-title" id={titleId}>{title}</span>
        <button type="button" className="btn btn-sm btn-secondary btn-icon-only" aria-label={returnText} disabled={busy} onClick={close}><X size={14} /></button>
      </div>
      <div className="modal-body">
        <div className="action-confirm-message" id={descriptionId}><AlertCircle size={20} /><span>{message}</span></div>
        {error && <div className="error-banner" role="alert"><span>{error}</span></div>}
      </div>
      <div className="modal-footer">
        <button ref={back} type="button" className="btn btn-secondary" disabled={busy} onClick={close}>{returnText}</button>
        <button type="button" className="btn btn-danger" disabled={busy || disabled} onClick={onConfirm}>{busy ? '正在处理…' : confirmText}</button>
      </div>
    </div>
  </div>;
}
