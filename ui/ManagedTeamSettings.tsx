import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { memberUnavailableReason, validateTaskTeam } from './memberAvailability';
import type { ManagedTeam, Member } from './types';

interface Props { team: ManagedTeam | null; members: Member[]; onSaved: (team: ManagedTeam | null) => void; onMembers: () => void; onUnsaved?: (unsaved: boolean) => void }
const empty: ManagedTeam = { ownerId: '', workerIds: [], reviewerId: null, verification: null, autoDeliver: true };

export default function ManagedTeamSettings({ team, members, onSaved, onMembers, onUnsaved }: Props) {
  const [value, setValue] = useState<ManagedTeam>(team || empty);
  const [executable, setExecutable] = useState(team?.verification?.executable || '');
  const [args, setArgs] = useState(team?.verification?.args.join('\n') || '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const dirty = useRef(false), lock = useRef(false);
  useEffect(() => {
    if (dirty.current) return;
    setValue(team || empty); setExecutable(team?.verification?.executable || ''); setArgs(team?.verification?.args.join('\n') || '');
  }, [team]);
  const issue = validateTaskTeam({ executionMode: 'delegated', assigneeId: value.ownerId,
    participantIds: value.workerIds, reviewerId: value.reviewerId || '' }, members);
  const save = async () => {
    if (lock.current || issue) return;
    lock.current = true; setBusy(true); setNotice(''); setError(''); onUnsaved?.(true);
    try {
      const saved = await api.updateSettings({ managedTeam: { ...value,
        verification: executable.trim() ? { executable: executable.trim(), args: args.split(/\r?\n/).filter((arg) => arg.length > 0) } : null } });
      dirty.current = false;
      onSaved(saved.managedTeam || null);
      onUnsaved?.(false);
      setNotice('主控团队已保存，后续只需提交目标');
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败'); }
    finally { lock.current = false; setBusy(false); }
  };
  const select = (kind: 'ownerId' | 'reviewerId', label: string, optional = false) => <div className="form-group">
    <label className="form-label" htmlFor={`managed-${kind}`}>{label}</label>
    <select id={`managed-${kind}`} className="form-select" value={value[kind] || ''} disabled={busy}
      onChange={(event) => setValue({ ...value, [kind]: event.target.value || (optional ? null : '') })}>
      <option value="">{optional ? '不指定独立评审者' : '请选择主控 CLI'}</option>
      {members.map((member) => {
        const reason = memberUnavailableReason(member, { requireEdit: !optional });
        return <option key={member.id} value={member.id} disabled={Boolean(reason)}>{member.name} · {reason || member.provider}</option>;
      })}
    </select>
  </div>;
  return <form className="settings-group" data-testid="managed-team-settings" onChange={() => { dirty.current = true; setNotice(''); setError(''); onUnsaved?.(true); }}
    onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="material-toolbar"><h3 className="settings-label">主控与协作团队</h3>
      <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={onMembers}>管理成员</button></div>
    <p className="text-muted">配置一次，之后由主控按成员技能分工、审查和交付。更改仅用于新目标。</p>
    {select('ownerId', '主控 CLI')}
    <fieldset disabled={busy} className="form-group"><legend className="form-label">允许调度的成员（1–4 名）</legend>
      {members.filter((member) => member.provider !== 'controller').map((member) => {
        const selected = value.workerIds.includes(member.id);
        const reason = member.id === value.ownerId ? '已担任主控' : member.id === value.reviewerId ? '已担任独立评审' : memberUnavailableReason(member);
        return <label key={member.id} className="checkbox-label" style={{ display: 'flex', marginBottom: 8 }}>
          <input type="checkbox" checked={selected} disabled={!selected && (Boolean(reason) || value.workerIds.length >= 4)}
            onChange={(event) => setValue({ ...value, workerIds: event.target.checked ? [...value.workerIds, member.id] : value.workerIds.filter((id) => id !== member.id) })} />
          <span>{member.name}{reason ? ` · ${reason}` : member.skills ? ` · ${member.skills.slice(0, 100)}` : ''}</span></label>;
      })}
    </fieldset>
    {select('reviewerId', '独立评审者', true)}
    <div className="form-group"><label className="form-label" htmlFor="managed-check-executable">自动检查程序（可选）</label>
      <input id="managed-check-executable" className="form-input" value={executable} disabled={busy} onChange={(event) => setExecutable(event.target.value)} placeholder="已配置的验收程序路径" /></div>
    <div className="form-group"><label className="form-label" htmlFor="managed-check-args">检查参数，每行一个</label>
      <textarea id="managed-check-args" className="form-textarea" rows={3} value={args} disabled={busy} onChange={(event) => setArgs(event.target.value)} /></div>
    <p className="text-muted">检查在任务目录执行。未配置、失败或证据失效时，不会自动标记为已交付。</p>
    <label className="checkbox-label"><input type="checkbox" checked={value.autoDeliver} disabled={busy}
      onChange={(event) => setValue({ ...value, autoDeliver: event.target.checked })} />机器检查与主控终审通过后自动交付</label>
    {issue && <p className="text-muted">{issue}</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}，团队选择已保留。</p>}
    <button type="submit" className="btn btn-primary" disabled={busy || Boolean(issue)}>{busy ? '正在保存' : '保存主控团队'}</button>
    {dirty.current && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => {
      dirty.current = false; setValue(team || empty); setExecutable(team?.verification?.executable || '');
      setArgs(team?.verification?.args.join('\n') || ''); setError(''); setNotice('已恢复保存的团队配置'); onUnsaved?.(false);
    }}>放弃团队修改</button>}
  </form>;
}
