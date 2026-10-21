import { useState, useEffect, useRef, useCallback } from 'react';
import { Upload, Trash2, X, RefreshCw, AlertCircle, Check } from 'lucide-react';
import { api } from './api';
import type { Task, MaterialList, Material } from './types';
import { encodeMaterialFile as encodeFile, formatMaterialBytes as formatBytes, validateMaterialFiles } from './taskInputFiles';
import './TaskMaterials.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : '请求失败';
const integrityText = (value: Material['integrity']) => value ? ({
  verified: '已校验', changed: '内容变更', missing: '文件缺失', unsafe: '存在风险',
}[value]) : '未校验';

export default function TaskMaterials({ task, onChanged, onBusyChange }: {
  task: Task; onChanged: () => Promise<void>; onBusyChange: (busy: boolean) => void;
}) {
  const [list, setList] = useState<MaterialList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [remaining, setRemaining] = useState<File[]>([]);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const life = useRef({ active: false, generation: 0 });
  const sequence = useRef(0);
  const actionLock = useRef(false);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  // The parent keys this component by task ID; generation also guards StrictMode cleanup.
  useEffect(() => {
    life.current.active = true;
    return () => { life.current.active = false; life.current.generation++; };
  }, []);
  const currentGuard = () => {
    const generation = life.current.generation;
    return () => life.current.active && generation === life.current.generation;
  };
  const refresh = useCallback(async () => {
    const generation = life.current.generation;
    const request = ++sequence.current;
    const valid = () => life.current.active && generation === life.current.generation && sequence.current === request;
    setLoading(true);
    try {
      const data = await api.getMaterials(task.id);
      if (valid()) { setList(data); setLoadError(''); }
    } catch (error) {
      if (valid()) setLoadError(errorText(error));
    } finally {
      if (valid()) setLoading(false);
    }
  }, [task.id]);
  useEffect(() => { void refresh(); }, [refresh, task.status, task.materials?.length]);

  const locked = task.status !== 'backlog' || Boolean(list?.locked);
  const disabled = busy || loading || locked || !list || Boolean(loadError);
  const validate = (files: File[]) => {
    if (!list) return '材料列表尚未加载';
    return validateMaterialFiles(files, list.materials, list.limits);
  };
  const notify = async (valid: () => boolean) => {
    await refresh();
    if (valid()) {
      try { await onChanged(); }
      catch (error) { if (valid()) setActionError((previous) => [previous, `同步失败: ${errorText(error)}`].filter(Boolean).join('；')); }
    }
  };
  const upload = async (files: File[]) => {
    if (!files.length || actionLock.current || disabled || !list) return;
    const invalid = validate(files);
    if (invalid) { setActionError(invalid); return; }
    actionLock.current = true;
    setBusy(true);
    setActionError('');
    const valid = currentGuard();
    const completed = new Map(list.materials.filter((item) => item.integrity === 'verified')
      .map((item) => [item.name.toLowerCase(), item.sha256]));
    try {
      setRemaining([]);
      for (let index = 0; index < files.length; index++) {
        if (!valid()) return;
        const file = files[index];
        setProgress(file.name);
        try {
          const { sha256, contentBase64 } = await encodeFile(file);
          if (!valid()) return;
          // Identical content under a different name is a separate, selected input.
          if (completed.get(file.name.toLowerCase()) !== sha256) {
            await api.importMaterial(task.id, file.name, contentBase64, sha256);
          }
          completed.set(file.name.toLowerCase(), sha256);
        } catch (error) {
          if (!valid()) return;
          setRemaining(files.slice(index));
          setActionError(`导入 ${file.name} 失败: ${errorText(error)}`);
          break;
        }
      }
      if (valid()) await notify(valid);
    } finally {
      if (valid()) { actionLock.current = false; setBusy(false); setProgress(''); }
    }
  };
  const remove = async (materialId: string) => {
    if (actionLock.current || disabled || confirmation !== materialId) return;
    actionLock.current = true;
    setBusy(true);
    setActionError('');
    const valid = currentGuard();
    try {
      await api.removeMaterial(task.id, materialId);
      if (!valid()) return;
      setConfirmation(null);
      await notify(valid);
    } catch (error) {
      if (valid()) setActionError(errorText(error));
    } finally {
      if (valid()) { actionLock.current = false; setBusy(false); }
    }
  };
  const errors = [actionError, loadError].filter(Boolean).join('；');

  return <section className="task-materials" aria-label="输入材料">
    <div className="material-toolbar">
      <div className="material-heading">
        <span className="form-label">输入材料</span>
        {list && <small>{list.materials.length}/{list.limits.maxFiles}</small>}
        {locked && <small>已锁定</small>}
      </div>
      <div className="material-actions">
        <input ref={input} type="file" multiple hidden aria-label="选择输入材料" disabled={disabled}
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            void upload(files);
          }} />
        <button type="button" className="btn btn-sm btn-secondary" disabled={disabled} onClick={() => input.current?.click()}>
          <Upload size={13} /><span>导入材料</span>
        </button>
        <button type="button" className="btn btn-sm btn-secondary btn-icon-only" title="刷新材料列表"
          aria-label="刷新材料列表" disabled={busy || loading} onClick={() => void refresh()}><RefreshCw size={13} /></button>
      </div>
    </div>
    {errors && <div className="error-banner material-error" role="alert">
      <AlertCircle size={14} /><span>{errors}</span>
      <button type="button" className="btn btn-sm btn-secondary btn-icon-only" title="关闭操作错误"
        aria-label="关闭操作错误" onClick={() => setActionError('')}><X size={12} /></button>
    </div>}
    {progress && <div className="material-progress" role="status">正在导入 {progress}</div>}
    {remaining.length > 0 && <div className="material-actions">
      <button type="button" className="btn btn-sm btn-secondary" disabled={disabled} onClick={() => void upload(remaining)}>
        <RefreshCw size={12} />重试剩余文件 ({remaining.length})
      </button>
      <button type="button" className="btn btn-sm btn-secondary btn-icon-only" title="放弃重试" aria-label="放弃重试"
        disabled={busy} onClick={() => setRemaining([])}><X size={12} /></button>
    </div>}
    {!list ? <div className="material-empty">{loading ? '正在加载材料' : '材料列表加载失败'}</div>
      : !list.materials.length ? <div className="material-empty">暂无输入材料</div>
        : <div className="material-list">{list.materials.map((item) => <div className="material-row" key={item.id}>
          <div className="material-info">
            <div className="material-name">{item.name}</div>
            <div className="material-meta">
              <span>{formatBytes(item.size)}</span><code title={item.sha256}>{item.sha256.slice(0, 12)}</code>
              <span className={`material-integrity ${item.integrity || 'unknown'}`}>{integrityText(item.integrity)}</span>
            </div>
          </div>
          <div className="material-actions">
            {confirmation === item.id ? <>
              <span>移除？</span>
              <button type="button" className="btn btn-sm btn-secondary btn-icon-only" disabled={disabled}
                title={`确认移除 ${item.name}`} aria-label={`确认移除 ${item.name}`} onClick={() => void remove(item.id)}><Check size={13} /></button>
              <button type="button" className="btn btn-sm btn-secondary btn-icon-only" disabled={busy}
                title={`取消移除 ${item.name}`} aria-label={`取消移除 ${item.name}`} onClick={() => setConfirmation(null)}><X size={13} /></button>
            </> : <button type="button" className="btn btn-sm btn-secondary btn-icon-only" disabled={disabled}
              title={`移除材料 ${item.name}`} aria-label={`移除材料 ${item.name}`} onClick={() => setConfirmation(item.id)}><Trash2 size={13} /></button>}
          </div>
        </div>)}</div>}
  </section>;
}
