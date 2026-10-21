import { useRef, useState } from 'react';
import { api } from './api';
import type { Settings } from './types';

type Field = 'proxy' | 'maxParallel' | 'maxHops' | 'repairLimit' | 'runTimeoutMinutes';
const numberFields = [
  { key: 'maxParallel', label: '同时执行的作业数', min: 1, max: 4, hint: '同一成员和同一任务目录仍按顺序执行。' },
  { key: 'maxHops', label: '成员之间最多转交几次', min: 0, max: 4, hint: '填 0 可关闭聊天中的成员转交。' },
  { key: 'repairLimit', label: '自动返工次数', min: 0, max: 3, hint: '达到上限后暂停，等待你处理；填 0 不自动返工。' },
  { key: 'runTimeoutMinutes', label: '单次作业最长等待时间（分钟）', min: 1, max: 30, hint: '超过此时间会停止该次作业。' },
] as const;

export default function RuntimeSettingsForm({ settings, onSaved, onUnsaved }: {
  settings: Settings; onSaved: (settings: Partial<Settings>) => void; onUnsaved: (unsaved: boolean) => void;
}) {
  const [edits, setEdits] = useState<Partial<Record<Field, string>>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const lock = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const fieldValue = (field: Field) => edits[field] ?? String(settings[field]);
  const change = (field: Field, value: string) => {
    const next = { ...edits, [field]: value };
    if (value === String(settings[field])) delete next[field];
    setEdits(next); setNotice(''); setError(''); onUnsaved(Object.keys(next).length > 0);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (lock.current || !Object.keys(edits).length || !form.current?.reportValidity()) return;
    lock.current = true; setSaving(true); setError(''); setNotice(''); onUnsaved(true);
    try {
      // Unedited fields, including the separate live pause control, stay current.
      const patch = Object.fromEntries(Object.entries(edits).map(([key, value]) => [key, key === 'proxy' ? value.trim() : Number(value)]));
      const updated = await api.updateSettings(patch);
      onSaved(Object.fromEntries(Object.keys(patch).map(key => [key, updated[key as Field]])));
      setEdits({}); onUnsaved(false); setNotice('设置已保存并生效');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试'); }
    finally { lock.current = false; setSaving(false); }
  };
  return <form ref={form} onSubmit={save} data-testid="runtime-settings" style={{ marginTop: 16 }}>
    <fieldset className="settings-group" disabled={saving} style={{ border: 0, margin: 0, minWidth: 0 }}>
      <legend className="settings-label">运行参数配置</legend>
      <div className="form-group">
        <label className="form-label" htmlFor="runtime-proxy">CLI 网络代理</label>
        <input id="runtime-proxy" name="proxy" type="text" maxLength={500} className="form-input form-input-mono"
          placeholder="例如 http://127.0.0.1:7890；留空使用直连" value={fieldValue('proxy')} onChange={event => change('proxy', event.target.value)} />
        <p className="text-muted">用于此工作区后续启动的 CLI；本机工作台连接始终直连。</p>
      </div>
      {numberFields.map(({ key, label, min, max, hint }) => <div className="form-group" key={key}>
        <label className="form-label" htmlFor={`runtime-${key}`}>{label}</label>
        <input id={`runtime-${key}`} name={key} type="number" required min={min} max={max} step={1} className="form-input"
          value={fieldValue(key)} onChange={event => change(key, event.target.value)} aria-describedby={`runtime-${key}-hint`} />
        <p id={`runtime-${key}-hint`} className="text-muted">{hint}</p>
      </div>)}
    </fieldset>
    {error && <div className="error-banner" role="alert">{error}，填写内容已保留。</div>}
    {notice && <p role="status">{notice}</p>}
    {Boolean(Object.keys(edits).length) && !notice && <p className="text-muted" role="status">有尚未应用的修改。</p>}
    <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button type="button" className="btn btn-secondary" disabled={saving || !Object.keys(edits).length}
        onClick={() => { setEdits({}); setError(''); setNotice('已恢复当前生效的设置'); onUnsaved(false); }}>放弃修改</button>
      <button type="submit" className="btn btn-primary" disabled={saving || !Object.keys(edits).length}>
        {saving ? '正在保存…' : '保存并应用设置'}
      </button>
    </div>
  </form>;
}
