import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, ApiError } from './api';
import { useTaskDraft } from './taskDrafts';
import { memberUnavailableReason } from './memberAvailability';
import { parseRecipientIds } from './workbench/roomState';
import type { Member, Room } from './types';

export default function DiscussionDialog({ kind, workspace, room, members, onClose, onCreated, onBusy }: {
  kind: 'room' | 'meeting'; workspace: string; room?: Room; members: Member[];
  onClose: () => void; onCreated: (roomId: string) => Promise<void>; onBusy: (busy: boolean) => void;
}) {
  const meeting = kind === 'meeting';
  const draft = useTaskDraft(workspace, meeting && room ? { kind: 'meeting-create', roomId: room.id } : { kind: 'room-create' },
    meeting ? { objective: '', memberIds: '[]', requestId: '' } : { name: '', requestId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdRoom, setCreatedRoom] = useState('');
  const [discarding, setDiscarding] = useState(false);
  const lock = useRef(false);
  const pending = Boolean(draft.values.requestId);
  const frozen = busy || !draft.loaded || pending || Boolean(createdRoom);
  const memberIds = parseRecipientIds(draft.values.memberIds);
  const candidates = members.filter(member => member.provider !== 'controller');
  const unavailable = memberIds.map(id => members.find(member => member.id === id)).find(member => memberUnavailableReason(member));
  const missingSelection = memberIds.some(id => !members.some(member => member.id === id));
  const issue = meeting ? !room || room.archivedAt ? '当前聊天室不可用，请先恢复聊天室。'
    : memberIds.length < 2 ? '请选择 2–4 名成员一起讨论。'
    : unavailable || missingSelection ? '所选成员已不可用，请更换或移除。' : '' : '';
  const fieldValue = meeting ? draft.values.objective || '' : draft.values.name || '';
  const setBusyState = (value: boolean) => { lock.current = value; setBusy(value); onBusy(value); };
  const close = async () => {
    if (lock.current) return;
    setBusyState(true);
    try { if (await draft.flush()) onClose(); }
    finally { setBusyState(false); }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); void close(); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (lock.current || !draft.loaded || (!pending && (issue || !fieldValue.trim()))) return;
    setBusyState(true); setError('');
    try {
      if (createdRoom) { await onCreated(createdRoom); return; }
      const requestId = draft.values.requestId || crypto.randomUUID();
      draft.setField('requestId', requestId);
      if (!await draft.flush()) return;
      const result = meeting
        ? await api.createMeeting(room!.id, fieldValue.trim(), memberIds, requestId)
        : await api.createRoom(fieldValue.trim(), requestId);
      const roomId = meeting ? room!.id : result.id;
      setCreatedRoom(roomId);
      if (!await draft.clear()) { setError('操作已成功，草稿清理尚未保存。可以打开已创建的内容。'); return; }
      await onCreated(roomId);
    } catch (reason) {
      // An explicit validation rejection did not commit the transaction and
      // permits correction. A lost response keeps its original request frozen.
      if (reason instanceof ApiError && [400, 403, 404, 409, 413, 422].includes(reason.status)) {
        draft.setField('requestId', ''); await draft.flush();
      }
      setError(reason instanceof Error ? reason.message : '提交失败，填写内容已保留');
    } finally { setBusyState(false); }
  };
  const discard = async () => {
    if (lock.current || pending) return;
    setBusyState(true);
    try { if (await draft.clear()) { setDiscarding(false); setError(''); } }
    finally { setBusyState(false); }
  };
  return <div className="modal-overlay" onClick={() => void close()}>
    <div className="modal-content" data-testid={meeting ? 'meeting-create-dialog' : 'room-create-dialog'} onClick={event => event.stopPropagation()}>
      <div className="modal-header"><span className="modal-title">{meeting ? '发起成员讨论' : '创建新讨论频道'}</span>
        <button className="btn btn-sm btn-secondary btn-icon-only" aria-label="关闭填写" disabled={busy} onClick={() => void close()}><X size={14} /></button></div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {meeting && <p className="text-muted">在“{room?.name}”讨论：成员先独立分析，再相互质疑，最后汇总取舍和待确认事项。</p>}
          <div className="form-group">
            <label className="form-label" htmlFor="discussion-topic">{meeting ? '要讨论什么' : '频道名称'}</label>
            {meeting ? <textarea id="discussion-topic" required rows={4} maxLength={6000} className="form-textarea"
              disabled={frozen} value={fieldValue} placeholder="写明问题、已有信息和希望得到的结论"
              onChange={event => draft.setField('objective', event.target.value)} />
              : <input id="discussion-topic" type="text" required maxLength={60} className="form-input" disabled={frozen}
                placeholder="例如: 架构设计、安全评审" value={fieldValue} onChange={event => draft.setField('name', event.target.value)} />}
          </div>
          {meeting && <fieldset className="form-group" disabled={frozen} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <legend className="form-label">参与成员 · 已选 {memberIds.length}/4</legend>
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>{candidates.map(member => {
              const selected = memberIds.includes(member.id), reason = memberUnavailableReason(member);
              return <label key={member.id} className="checkbox-label" style={{ display: 'flex', marginBottom: 8 }}>
                <input type="checkbox" checked={selected} disabled={!selected && (Boolean(reason) || memberIds.length >= 4)}
                  onChange={() => draft.setField('memberIds', JSON.stringify(selected ? memberIds.filter(id => id !== member.id) : [...memberIds, member.id]))} />
                <span>{member.name}{reason ? ` · ${reason}` : member.status === 'busy' ? ' · 正忙，提交后排队' : ''}</span>
              </label>;
            })}</div>
            {memberIds.filter(id => !candidates.some(member => member.id === id)).map(id => <label key={id} className="checkbox-label" style={{ display: 'flex', marginBottom: 8 }}>
              <input type="checkbox" checked onChange={() => draft.setField('memberIds', JSON.stringify(memberIds.filter(memberId => memberId !== id)))} />
              <span>已失效的成员选择，可取消勾选</span>
            </label>)}
            {memberIds.length > 0 && <p className="text-muted">由 {members.find(member => member.id === memberIds[0])?.name || '首位成员'} 汇总讨论。讨论不会修改文件。</p>}
          </fieldset>}
          {pending && !createdRoom && <p role="status" className="task-prepared-note">上次提交结果尚未确认。重试会核对原请求，避免重复创建{meeting ? '讨论' : '频道'}。</p>}
          {issue && !pending && <p className="text-muted">{issue}</p>}
          {error && <div className="error-banner" role="alert">{error}</div>}
          {draft.error && <div className="error-banner" role="alert">{draft.error}
            <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void draft.retry()}>重试保存</button></div>}
          <p className="text-muted" role="status">{!draft.loaded ? '正在恢复草稿…' : draft.saving ? '正在保存草稿…' : draft.error ? '草稿尚未保存' : '填写草稿已保存，稍后可继续。'}</p>
          {!pending && !createdRoom && Boolean(fieldValue || memberIds.length) && (discarding
            ? <div><span>清空本次填写内容？</span><button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void discard()}>确认放弃草稿</button>
              <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => setDiscarding(false)}>保留草稿</button></div>
            : <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => setDiscarding(true)}>放弃草稿</button>)}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void close()}>稍后继续</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !draft.loaded || (!pending && !createdRoom && (Boolean(issue) || !fieldValue.trim()))}>
            {busy ? '正在提交…' : createdRoom ? '打开已创建的内容' : pending ? '核对并重试' : meeting ? '发起讨论' : '确认创建'}
          </button>
        </div>
      </form>
    </div>
  </div>;
}
