import { useState } from 'react';

export default function ModelChoice({ value, onChange, models = [], defaultModel }: {
  value: string; onChange: (value: string) => void; models?: Array<{ id: string; name: string }>;
  defaultModel?: string | null;
}) {
  const [manual, setManual] = useState(Boolean(value && !models.some((model) => model.id === value)));
  const manualInput = manual || Boolean(value && !models.some((model) => model.id === value));
  return <>
    <label className="form-label" htmlFor="member-model-choice">模型选择</label>
    <select id="member-model-choice" className="form-select"
      value={manualInput ? '__manual__' : value}
      onChange={(event) => {
        setManual(event.target.value === '__manual__');
        if (event.target.value !== '__manual__') onChange(event.target.value);
      }}>
      <option value="">跟随 CLI 默认{defaultModel ? `（当前 ${defaultModel}）` : ''}</option>
      {models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}
      <option value="__manual__">手动指定模型</option>
    </select>
    {manualInput && <input aria-label="指定模型标识" className="form-input form-input-mono" value={value}
      style={{ marginTop: 8 }} placeholder="填写官方 CLI 支持的模型标识" onChange={(event) => onChange(event.target.value)} />}
    <p className="text-muted">默认由 CLI 决定；恢复会话时沿用其原生配置。选择具体模型才会覆盖。</p>
    {models.length > 0 && <p className="text-muted">选项来自最近一次接入检查。</p>}
  </>;
}
