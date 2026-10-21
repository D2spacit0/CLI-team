import { useEffect, useRef, useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { api } from './api';
import { isMemberRunnable, memberUnavailableReason } from './memberAvailability';
import { useTaskDraft } from './taskDrafts';
import type { Member, Task } from './types';

export default function TaskAssignment({ task, members, workspaceRoot, contextId, canReassign, reviewerExcludedIds = [], disabled = false, onChanged, onBusyChange, onDraftStateChange }: {
  task: Task; members: Member[]; canReassign?: boolean; reviewerExcludedIds?: string[]; onChanged: (updated: Task) => Promise<void>;
  workspaceRoot: string; contextId?: string;
  onBusyChange?: (busy: boolean) => void;
  onDraftStateChange?: (ready: boolean, dirty: boolean) => void;
  disabled?: boolean;
}) {
  const draft = useTaskDraft(workspaceRoot, { kind: 'assignment', taskId: task.id, planId: task.coordination?.planId, contextId }, {
    assigneeId: task.assigneeId, reviewerId: task.reviewerId || '', participantIds: JSON.stringify(task.participantIds || []), note: '',
  });
  const assignee = draft.values.assigneeId || '', reviewer = draft.values.reviewerId || '', note = draft.values.note || '';
  const participants: string[] = (() => { try { return JSON.parse(draft.values.participantIds || '[]'); } catch { return []; } })();
  const changed = assignee !== task.assigneeId || reviewer !== (task.reviewerId || '')
    || JSON.stringify([...participants].sort()) !== JSON.stringify([...(task.participantIds || [])].sort());
  const dirty = changed || Boolean(note);
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const actionLock = useRef(false);
  useEffect(() => {
    onDraftStateChange?.(draft.loaded, dirty);
  }, [draft.loaded, dirty, onDraftStateChange]);
  const change = (values: Record<string, string>) => { draft.setValues(values); setSaved(false); setRecovered(false); setError(''); };
  const frozen = busy || disabled || !draft.loaded;
  const delegated = task.executionMode === 'delegated';
  const candidates = members.filter(isMemberRunnable);
  const assigneeCandidates = candidates.filter((member) => !memberUnavailableReason(member, { requireEdit: delegated }));
  const reviewerCandidates = candidates.filter((member) => member.id !== assignee && !reviewerExcludedIds.includes(member.id) && (!delegated || !participants.includes(member.id)));
  const participantCandidates = candidates.filter((member) => member.id !== assignee && member.id !== reviewer);
  const unavailableParticipants = participants.filter((id) => !participantCandidates.some((member) => member.id === id));
  const assigneeValid = assigneeCandidates.some((member) => member.id === assignee);
  const reviewerValid = !reviewer || reviewerCandidates.some((member) => member.id === reviewer);
  const participantsValid = !delegated || (participants.length >= 1 && participants.length <= 4 &&
    new Set(participants).size === participants.length && unavailableParticipants.length === 0);
  const editable = canReassign === true;
  const memberName = (id: string) => members.find((member) => member.id === id)?.name || id;
  if (task.archivedAt || !['backlog', 'blocked'].includes(task.status)) return null;
  if (!editable) return <p className="text-muted">{canReassign === undefined
    ? '请先加载或刷新任务进度，确认全部停止后再调整分工。'
    : '任务仍有执行、排队或停止清理活动；全部停止后才能调整分工。'}</p>;
  return <details className="task-assignment" open={expanded ?? dirty} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="form-label">调整分工</summary>
    <p className="text-muted">已有成果和作业记录会保留。保存后不会自动执行，请检查分工，再点击“继续任务”或“启动任务”。</p>
    <div className="task-member-fields">
      <div>
        <label className="form-label" htmlFor="reassign-builder">{delegated ? '负责人' : '执行者'}</label>
        <select className="form-select" id="reassign-builder" value={assignee} disabled={frozen} onChange={(event) => change({
          assigneeId: event.target.value, reviewerId: reviewer === event.target.value ? '' : reviewer,
          participantIds: JSON.stringify(participants.filter(id => id !== event.target.value)),
        })}>
          {!assigneeValid && <option value={assignee} disabled>{memberName(assignee) || '未指定'}（{memberUnavailableReason(members.find((member) => member.id === assignee), { requireEdit: delegated }) || '请重新选择'}）</option>}
          {assigneeCandidates.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select>
        {members.find((member) => member.id === assignee)?.skills && <div className="text-muted" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          擅长：{members.find((member) => member.id === assignee)?.skills}
        </div>}
      </div>
      <div>
        <label className="form-label" htmlFor="reassign-reviewer">独立评审者</label>
        <select className="form-select" id="reassign-reviewer" value={reviewer} disabled={frozen} onChange={(event) => change({ reviewerId: event.target.value })}>
          <option value="">不指定</option>
          {!reviewerValid && <option value={reviewer} disabled>{memberName(reviewer)}（不可用，请重新选择）</option>}
          {reviewerCandidates.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select>
        {reviewerExcludedIds.length > 0 && <p className="text-muted">曾参与本任务写入的成员不能担任独立评审：{reviewerExcludedIds.map(memberName).join('、')}。</p>}
        {members.find((member) => member.id === reviewer)?.skills && <div className="text-muted" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          擅长：{members.find((member) => member.id === reviewer)?.skills}
        </div>}
      </div>
    </div>
    {delegated && <fieldset className="coordination-members" disabled={frozen}>
      <legend className="form-label">可调度成员（已选 {participants.length}/4）</legend>
      <p className="text-muted">选择 1–4 名协作者，负责人和独立评审者不参与此名单。再次继续时，负责人会按新分工重新规划。</p>
      {participantCandidates.map((member) => <label className="coordination-member" key={member.id}>
        <input type="checkbox" checked={participants.includes(member.id)}
          disabled={!participants.includes(member.id) && participants.length >= 4}
          onChange={(event) => {
            change({ participantIds: JSON.stringify(event.target.checked ? [...participants, member.id] : participants.filter(id => id !== member.id)) });
          }} />
        <span><strong>{member.name}</strong> · {member.permission === 'edit' ? '可编辑' : '只读分析'}
          <span className="coordination-skills">{member.skills || '未填写技能描述'}</span></span>
      </label>)}
      {unavailableParticipants.map((id) => <label className="coordination-member" key={id}>
        <input type="checkbox" checked onChange={() => change({ participantIds: JSON.stringify(participants.filter(item => item !== id)) })} />
        <span>{memberName(id)}（{memberUnavailableReason(members.find((member) => member.id === id)) || '与负责人或评审者冲突'}，请取消选择并替换）</span>
      </label>)}
    </fieldset>}
    <label className="form-label" htmlFor="reassign-note">改派原因（会交给新的负责人）</label>
    <input id="reassign-note" data-testid="reassign-note" className="form-input" value={note} disabled={frozen} maxLength={1200} onChange={(event) => change({ note: event.target.value })} />
    {error && <div className="error-banner" role="alert">{error}</div>}
    {draft.error ? <div className="error-banner" role="alert"><span>{draft.error}</span>
      <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => { void draft.retry(); }}>重试保存草稿</button></div>
      : <p className="draft-status" role="status">{!draft.loaded ? '正在恢复分工草稿…' : draft.saving ? '正在保存分工草稿…'
        : dirty ? '分工草稿已保存。请先保存分工或恢复当前分工，再启动任务。' : '草稿保留在当前任务，保存分工后才会应用。'}</p>}
    {saved && <p className="text-muted" role="status">分工已保存，成果已保留。确认后可继续任务。</p>}
    {recovered && <p className="text-muted" role="status">本次保存回执未收到，已核对成员分工和改派说明，无需重复保存。</p>}
    {(!assigneeValid || !reviewerValid) && <div className="text-muted">当前分工包含不可用成员，请重新选择；独立评审者也可改为“不指定”。</div>}
    {!participantsValid && <div className="text-muted">请选择 1–4 名可用协作者，移除无效成员后才能保存。</div>}
    {!changed && note.trim() && <p className="text-muted">当前分工未变化。若只需补充执行要求，请填写“继续任务前的纠正要求”。</p>}
    <button className="btn btn-secondary" disabled={frozen || !changed || !note.trim() || !assigneeValid || !reviewerValid || !participantsValid} onClick={async () => {
      if (actionLock.current || frozen || !changed || !note.trim() || !assigneeValid || !reviewerValid || !participantsValid || !editable) return;
      actionLock.current = true;
      onBusyChange?.(true);
      setBusy(true);
      setError('');
      setSaved(false);
      setRecovered(false);
      let persisted = false;
      try {
        let updated: Task;
        let receiptRecovered = false;
        try { updated = await api.reassignTask(task.id, assignee, reviewer || null, note.trim(), delegated ? participants : undefined); }
        catch (reason) {
          const snapshot = await api.getBootstrap(true).catch(() => null);
          const observed = snapshot?.tasks.find(item => item.id === task.id);
          if (!observed || observed.assigneeId !== assignee || (observed.reviewerId || '') !== reviewer
              || JSON.stringify([...(observed.participantIds || [])].sort()) !== JSON.stringify([...participants].sort())
              || !observed.pendingFeedback?.includes(`成员调整说明：${note.trim()}`)) throw reason;
          updated = observed; receiptRecovered = true;
        }
        persisted = true;
        await onChanged(updated);
        const cleared = await draft.clear();
        setSaved(true);
        setRecovered(receiptRecovered);
        if (!cleared) setError('分工已保存，但草稿清理失败。请重试保存草稿，或恢复当前分工后再继续。');
      } catch (err) { setError(`${persisted ? '分工已保存，但状态刷新失败：' : '保存结果未确认，草稿已保留：'}${err instanceof Error ? err.message : '改派失败'}`); }
      finally { actionLock.current = false; setBusy(false); onBusyChange?.(false); }
    }}><ArrowRightLeft size={14} /><span>{busy ? '正在保存分工' : '保存分工'}</span></button>
    {dirty && <button type="button" className="btn btn-secondary" disabled={frozen} onClick={async () => {
      if (actionLock.current || frozen) return;
      actionLock.current = true; setBusy(true); onBusyChange?.(true);
      try { if (await draft.clear()) { setError(''); setSaved(false); setRecovered(false); } }
      finally { actionLock.current = false; setBusy(false); onBusyChange?.(false); }
    }}>恢复当前分工</button>}
  </details>;
}
