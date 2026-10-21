import { useEffect, useRef, useState } from 'react';
import { X, Send } from 'lucide-react';
import { api, ApiError } from './api';
import { useTaskDraft } from './taskDrafts';
import { validateTaskTeam } from './memberAvailability';
import type { ManagedTeam, Member, Task } from './types';

interface Props {
  workspace: string; roomId: string; team: ManagedTeam | null; members: Member[];
  onClose: () => void; onSettings: () => void;
  onCreated: (task: Task, warning?: string, cleanup?: () => Promise<boolean>) => void | Promise<void>;
  onBusy: (busy: boolean) => void;
}

export default function ManagedRequestDialog({ workspace, roomId, team, members, onClose, onSettings, onCreated, onBusy }: Props) {
  const draft = useTaskDraft(workspace, { kind: 'managed-request', roomId }, { objective: '', requestId: '' });
  const [phase, setPhase] = useState<'' | 'saving' | 'submitting' | 'recovering'>('');
  const [error, setError] = useState('');
  const lock = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const busy = Boolean(phase), pending = Boolean(draft.values.requestId);
  const setBusy = (next: typeof phase) => { lock.current = Boolean(next); setPhase(next); onBusy(Boolean(next)); };
  useEffect(() => {
    if (!draft.loaded || busy || pending) return;
    // Wait until the draft is editable and the shared dialog focus trap is ready.
    const frame = requestAnimationFrame(() => textarea.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [draft.loaded, busy, pending]);
  const teamIssue = team ? validateTaskTeam({ executionMode: 'delegated', assigneeId: team.ownerId,
    participantIds: team.workerIds, reviewerId: team.reviewerId || '' }, members) : '请先配置主控与协作团队';
  const submissionBlocked = Boolean(teamIssue && !draft.values.requestId);
  const leave = async (next: () => void) => {
    if (lock.current) return;
    setBusy('saving'); setError('');
    try { if (await draft.flush()) next(); }
    finally { setBusy(''); }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && !event.defaultPrevented) {
        event.preventDefault(); void leave(onClose);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  });
  const retryDraft = async () => {
    if (lock.current) return;
    setBusy('recovering');
    try { if (await draft.retry()) setError(''); }
    finally { setBusy(''); }
  };
  const submit = async () => {
    if (lock.current || !draft.loaded || !draft.values.objective.trim() || submissionBlocked) return;
    setBusy('submitting'); setError('');
    const previousRequestId = draft.values.requestId;
    try {
      const requestId = previousRequestId || crypto.randomUUID();
      draft.setField('requestId', requestId);
      if (!await draft.flush()) {
        // Nothing was sent. A new request can safely return to editable text;
        // an earlier uncertain submission must keep its original identity.
        if (!previousRequestId) { draft.setField('requestId', ''); await draft.flush(); }
        setError(previousRequestId ? '原请求尚未完成核对，请先重试保存；目标和请求编号已保留。'
          : '目标尚未提交，请先重试保存；当前内容已保留，可以继续修改。');
        return;
      }
      const task = await api.submitObjective({ requestId, roomId, objective: draft.values.objective });
      const cleared = await draft.clear();
      await onCreated(task, cleared ? undefined : '任务已交给主控，目标草稿尚未清理。可重试清理，任务不会重复提交。',
        cleared ? undefined : draft.retry);
    } catch (reason) {
      if (!previousRequestId && reason instanceof ApiError && [400, 403, 404, 413, 422, 429].includes(reason.status)) {
        draft.setField('requestId', ''); await draft.flush();
      }
      setError(reason instanceof Error && ['TimeoutError', 'AbortError'].includes(reason.name)
        ? '提交结果尚未确认，请重试同一请求核对；目标已保留，不会重复派工。'
        : reason instanceof Error ? reason.message : '提交失败，目标仍然保留');
    } finally { setBusy(''); }
  };
  return <div className="modal-overlay" onClick={() => void leave(onClose)}>
    <form className="modal-content modal-lg" data-testid="managed-request" role="dialog" aria-modal="true" aria-labelledby="managed-request-title"
      onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="modal-header"><span className="modal-title" id="managed-request-title">交给主控</span>
        <button type="button" className="btn btn-icon-only" disabled={busy} aria-label="关闭目标输入" onClick={() => void leave(onClose)}><X size={16} /></button></div>
      <div className="modal-body">
        <p className="text-muted">描述要完成的目标。主控负责拆解、分发、逐项审查、返工和最终交付。</p>
        {teamIssue ? <div className="error-banner">{teamIssue}<button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void leave(onSettings)}>配置团队</button></div>
          : <p className="text-muted">主控：{members.find((member) => member.id === team?.ownerId)?.name} · 协作成员：{team?.workerIds.map((id) => members.find((member) => member.id === id)?.name || id).join('、')}</p>}
        <label className="form-label" htmlFor="managed-objective">任务目标</label>
        <textarea ref={textarea} id="managed-objective" className="form-textarea" rows={6} maxLength={12000} required
          placeholder="例如：实现任务导出功能，支持按房间筛选，并提供使用说明。"
          value={draft.values.objective} disabled={busy || !draft.loaded || pending}
          onChange={(event) => draft.setField('objective', event.target.value)} />
        {draft.values.requestId && !busy && <p className="text-muted">已保存提交请求。重试会核对原任务，避免重复派工。</p>}
        {!team?.verification && !draft.values.requestId && <p className="text-muted">此团队尚未配置自动检查，主控完成审查后会保留待验收状态。</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {draft.error && <div className="error-banner" role="alert">{draft.error}</div>}
      </div>
      <div className="modal-footer">
        <div style={{ flexBasis: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <p className="text-muted" role="status" style={{ margin: 0, fontSize: 12 }}>{!draft.loaded ? draft.error ? '草稿读取失败，请重试' : '正在读取草稿'
            : draft.saving ? '正在保存目标' : draft.error ? '保存失败，文字已保留' : '目标草稿已保存'}</p>
          {draft.error && <button type="button" className="btn btn-sm btn-secondary" data-testid="managed-draft-retry" disabled={busy} onClick={() => void retryDraft()}>
            {draft.loaded ? '重试保存目标' : '重试读取草稿'}</button>}
        </div>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void leave(onClose)}>稍后继续</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !draft.loaded || !draft.values.objective.trim() || submissionBlocked}>
          <Send size={14} />{phase === 'saving' ? '正在保存目标' : phase === 'recovering' ? '正在恢复草稿'
            : phase === 'submitting' ? '正在交给主控' : pending ? '重试同一请求' : '交给主控执行'}</button></div>
    </form>
  </div>;
}
