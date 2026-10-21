import { useRef, useState } from 'react';
import { AlertCircle, Check, FileText, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { addTaskInputFiles, defaultMaterialLimits, formatMaterialBytes } from './taskInputFiles';
import type { TaskInputItem } from './taskInputFiles';
import type { MaterialList } from './types';
import './TaskMaterials.css';

export interface TaskInputPickerProps {
  items: TaskInputItem[];
  onChange: (items: TaskInputItem[]) => void;
  disabled?: boolean;
  limits?: MaterialList['limits'];
  onRetry?: (id: string) => void;
  onRemoveImported?: (id: string) => void;
}

const statusText: Record<TaskInputItem['status'], string> = {
  selected: '待导入', uploading: '正在导入', imported: '已导入', failed: '导入失败', missing: '需要重新选择',
};

export default function TaskInputPicker({ items, onChange, disabled = false, limits = defaultMaterialLimits,
  onRetry, onRemoveImported }: TaskInputPickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const replacementInput = useRef<HTMLInputElement>(null);
  const replacementId = useRef<string | undefined>(undefined);
  const [error, setError] = useState('');
  const [removeId, setRemoveId] = useState<string | null>(null);
  const total = items.reduce((sum, item) => sum + (item.size || 0), 0);
  const select = (files: File[], replaceId?: string) => {
    if (disabled || !files.length) return;
    const next = addTaskInputFiles(items, files, limits, replaceId);
    setError(next.error || '');
    if (!next.error) onChange(next.items);
  };
  const remove = (item: TaskInputItem) => {
    if (disabled) return;
    if (item.status === 'imported' || item.materialId) {
      if (removeId !== item.id) { setRemoveId(item.id); return; }
      onRemoveImported?.(item.id);
    } else onChange(items.filter((previous) => previous.id !== item.id));
    setRemoveId(null);
  };
  return <section className="task-materials task-input-picker" aria-label="准备输入材料">
    <div className="material-toolbar">
      <div className="material-heading"><span className="form-label">输入材料</span><small>可选</small>
        <small>{items.length}/{limits.maxFiles} 份{total > 0 ? ` · ${formatMaterialBytes(total)}` : ''}</small></div>
      <button type="button" className="btn btn-sm btn-secondary" disabled={disabled || items.length >= limits.maxFiles}
        onClick={() => input.current?.click()}><Upload size={13} />选择文件</button>
    </div>
    <input type="file" ref={input} multiple hidden disabled={disabled} aria-label="选择任务输入文件" data-testid="task-create-material-input"
      onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ''; select(files); }} />
    <input type="file" ref={replacementInput} hidden disabled={disabled} aria-label="重新选择任务输入文件"
      onChange={(event) => {
        const files = Array.from(event.target.files || []); event.target.value = '';
        select(files, replacementId.current); replacementId.current = undefined;
      }} />
    <p className="material-help">单份不超过 {formatMaterialBytes(limits.maxFileBytes)}，合计不超过 {formatMaterialBytes(limits.maxTaskBytes)}。保存时导入，首次启动后锁定。</p>
    {error && <div className="error-banner material-error" role="alert"><AlertCircle size={14} /><span>{error}</span>
      <button type="button" className="btn btn-sm btn-secondary btn-icon-only" aria-label="关闭材料选择错误" onClick={() => setError('')}><X size={12} /></button></div>}
    {!items.length ? <div className="material-empty">可先添加需求文档、参考资料或待处理文件，也可以直接开始。</div>
      : <div className="material-list">{items.map((item) => {
        const imported = item.status === 'imported' || Boolean(item.materialId);
        return <div className="material-row" key={item.id}>
          <div className="material-input-icon" aria-hidden="true">{item.status === 'imported' ? <Check size={15} /> : <FileText size={15} />}</div>
          <div className="material-info"><div className="material-name">{item.name}</div>
            <div className="material-meta">{item.size !== undefined && <span>{formatMaterialBytes(item.size)}</span>}
              <span className={`material-input-status ${item.status === 'imported' && !item.verified ? 'unverified' : item.status}`}
                role={item.status === 'uploading' ? 'status' : undefined}>{item.status === 'imported' && !item.verified ? '已保存，待核对' : statusText[item.status]}</span></div>
            {item.error && <p className="material-item-error" role="status">{item.error}</p>}
          </div>
          <div className="material-actions">
            {item.status === 'failed' && item.file && onRetry && <button type="button" className="btn btn-sm btn-secondary"
              disabled={disabled} onClick={() => onRetry(item.id)} aria-label={`重试导入 ${item.name}`}><RefreshCw size={12} />重试</button>}
            {item.status !== 'imported' && item.status !== 'uploading' && <button type="button" className="btn btn-sm btn-secondary"
              disabled={disabled} onClick={() => { replacementId.current = item.id; replacementInput.current?.click(); }}
              aria-label={`重新选择 ${item.name}`}>{item.file ? '重选' : '重新选择'}</button>}
            {removeId === item.id ? <><span>移除已导入材料？</span>
              <button type="button" className="btn btn-sm btn-secondary btn-icon-only" disabled={disabled}
                aria-label={`确认移除 ${item.name}`} onClick={() => remove(item)}><Check size={13} /></button>
              <button type="button" className="btn btn-sm btn-secondary btn-icon-only" disabled={disabled}
                aria-label={`取消移除 ${item.name}`} onClick={() => setRemoveId(null)}><X size={13} /></button></>
              : <button type="button" className="btn btn-sm btn-secondary btn-icon-only" disabled={disabled || (imported && !onRemoveImported)}
                title={imported && !onRemoveImported ? '已导入材料可在任务详情移除' : `移除 ${item.name}`}
                aria-label={`移除 ${item.name}`} onClick={() => remove(item)}><Trash2 size={13} /></button>}
          </div>
        </div>;
      })}</div>}
    {items.some((item) => item.status === 'missing') && <p className="material-help material-reselect-note">程序重新打开后，请重新选择未导入的文件。已导入材料会从原待办中核对。</p>}
  </section>;
}
