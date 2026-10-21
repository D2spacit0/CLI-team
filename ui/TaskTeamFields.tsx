import { Settings2 } from 'lucide-react';
import { isMemberRunnable, memberUnavailableReason } from './memberAvailability';
import type { TaskTeamSelection } from './memberAvailability';
import type { Member } from './types';

export { validateTaskTeam } from './memberAvailability';
export type { TaskTeamSelection } from './memberAvailability';

export interface TaskTeamFieldsProps {
  members: Member[];
  value: TaskTeamSelection;
  onChange: (patch: Partial<TaskTeamSelection>) => void;
  disabled?: boolean;
  onOpenMembers: () => void;
}

const memberLabel = (member: Member) => `${member.name} (@${member.handle})`;
const availableNote = (member: Member) => member.status === 'busy' ? '执行中，将排队' : member.permission === 'edit' ? '可编辑' : '只读分析';
function Skills({ member }: { member: Member | undefined }) {
  if (!member) return null;
  return <p className="text-muted" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>擅长：{member.skills || '尚未填写，可在成员管理补充'}</p>;
}

export default function TaskTeamFields({ members, value, onChange, disabled = false, onOpenMembers }: TaskTeamFieldsProps) {
  const delegated = value.executionMode === 'delegated';
  const owner = members.find((member) => member.id === value.assigneeId);
  const reviewer = members.find((member) => member.id === value.reviewerId);
  const ownerReason = (member: Member | undefined) => memberUnavailableReason(member, { requireEdit: delegated });
  const reviewerReason = (member: Member | undefined) => memberUnavailableReason(member) ||
    (member?.id === value.assigneeId ? '已担任负责人或执行者' :
      delegated && member && value.participantIds.includes(member.id) ? '已在协作名单中' : '');
  const participantReason = (id: string) => {
    if (id === value.assigneeId) return '已担任负责人，请从协作名单移除';
    if (id === value.reviewerId) return '已担任独立评审者，请从协作名单移除';
    return memberUnavailableReason(members.find((member) => member.id === id));
  };
  const participantMembers = members.filter((member) => member.id !== value.assigneeId && member.id !== value.reviewerId);
  const absentParticipants = [...new Set(value.participantIds)].filter((id) => !participantMembers.some((member) => member.id === id));
  const selectParticipant = (id: string, checked: boolean) => {
    if (disabled) return;
    if (checked && (participantReason(id) || value.participantIds.length >= 4)) return;
    onChange({ participantIds: checked ? [...new Set([...value.participantIds, id])] : value.participantIds.filter((item) => item !== id) });
  };
  return <div className="task-team-fields">
    <div className="material-toolbar">
      <span className="form-label">执行团队</span>
      <button type="button" className="btn btn-sm btn-secondary" disabled={disabled} onClick={onOpenMembers}>
        <Settings2 size={13} />管理成员</button>
    </div>
    <div className="form-group">
      <label className="form-label" htmlFor="task-execution-mode">执行方式</label>
      <select className="form-select" id="task-execution-mode" data-testid="task-execution-mode" value={value.executionMode}
        disabled={disabled} onChange={(event) => onChange({ executionMode: event.target.value as TaskTeamSelection['executionMode'] })}>
        <option value="direct">单成员执行</option>
        <option value="delegated">负责人调度协作</option>
      </select>
      <p className="text-muted">{delegated ? '负责人按成员技能拆分任务、安排协作并汇总结果。' : '由一个成员完成任务，可另选独立评审者检查结果。'}</p>
    </div>
    <div className="task-member-fields">
      <div className="form-group" style={{ flex: 1 }}>
        <label className="form-label" htmlFor="task-create-assignee">{delegated ? '负责人' : '执行者'}</label>
        <select className="form-select" id="task-create-assignee" data-testid="task-create-assignee" value={value.assigneeId}
          required disabled={disabled} aria-invalid={Boolean(value.assigneeId && ownerReason(owner))}
          onChange={(event) => onChange({ assigneeId: event.target.value })}>
          <option value="">{delegated ? '请选择负责人' : '请选择执行者'}</option>
          {value.assigneeId && !owner && <option value={value.assigneeId} disabled>原成员已不存在，请重新选择</option>}
          {members.map((member) => {
            const reason = ownerReason(member);
            return <option key={member.id} value={member.id} disabled={Boolean(reason)}>{memberLabel(member)} · {reason || availableNote(member)}</option>;
          })}
        </select>
        {value.assigneeId && ownerReason(owner) && <p className="text-muted" role="status">{ownerReason(owner)}。请重新选择，或到成员管理处理。</p>}
        <Skills member={owner} />
      </div>
      <div className="form-group" style={{ flex: 1 }}>
        <label className="form-label" htmlFor="task-create-reviewer">独立评审者（可选）</label>
        <select className="form-select" id="task-create-reviewer" data-testid="task-create-reviewer" value={value.reviewerId}
          disabled={disabled} aria-invalid={Boolean(value.reviewerId && reviewerReason(reviewer))}
          onChange={(event) => onChange({ reviewerId: event.target.value })}>
          <option value="">不指定</option>
          {value.reviewerId && !reviewer && <option value={value.reviewerId} disabled>原评审者已不存在，请重新选择</option>}
          {members.map((member) => {
            const reason = reviewerReason(member);
            return <option key={member.id} value={member.id} disabled={Boolean(reason)}>{memberLabel(member)} · {reason || availableNote(member)}</option>;
          })}
        </select>
        {value.reviewerId && reviewerReason(reviewer) && <p className="text-muted" role="status">{reviewerReason(reviewer)}。请另选评审者，或改为“不指定”。</p>}
        <Skills member={reviewer} />
      </div>
    </div>
    {!members.some((member) => isMemberRunnable(member) && !ownerReason(member)) && <p className="text-muted" role="status">
      {delegated ? '暂无可用负责人，请在成员管理启用具备文件编辑权限的成员。' : '暂无可用执行者，请先到成员管理配置并启用一个成员。'}</p>}
    {delegated && <fieldset className="coordination-members" data-testid="task-create-participants" disabled={disabled}>
      <legend className="form-label">协作者（已选 {value.participantIds.length}/4）</legend>
      <p className="text-muted">选择 1–4 名协作者。负责人和独立评审者分别承担调度与检查，不列入协作名单。</p>
      {participantMembers.map((member) => {
        const selected = value.participantIds.includes(member.id);
        const reason = participantReason(member.id);
        return <label className="coordination-member" key={member.id}>
          <input type="checkbox" checked={selected} data-member-id={member.id}
            disabled={disabled || (!selected && (Boolean(reason) || value.participantIds.length >= 4))}
            onChange={(event) => selectParticipant(member.id, event.target.checked)} />
          <span><strong>{member.name}</strong> · {reason || availableNote(member)}{reason && selected ? '，请取消或更换' : ''}
            <span className="coordination-skills">{member.skills || '未填写技能描述'}</span></span>
        </label>;
      })}
      {absentParticipants.map((id) => <label className="coordination-member" key={id}>
        <input type="checkbox" checked data-member-id={id} disabled={disabled} onChange={() => selectParticipant(id, false)} />
        <span><strong>{members.find((member) => member.id === id)?.name || '原协作者'}</strong> · {participantReason(id)}；取消选择后可替换</span>
      </label>)}
      {new Set(value.participantIds).size !== value.participantIds.length && <p className="text-muted" role="status">名单包含重复成员，请取消重复人选后重新选择。</p>}
    </fieldset>}
  </div>;
}
