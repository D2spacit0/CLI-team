import { useEffect, useId, useRef, useState } from 'react';
import { Save, Terminal } from 'lucide-react';
import { api } from './api';
import { useTaskDraft } from './taskDrafts';
import type { Member, Run, Task, TaskAssistanceRecord, TaskProgress } from './types';

const assistanceStatuses: Record<TaskAssistanceRecord['status'], string> = {
  pending: '等待负责人处理', consulting: '同伴协助中', answered: '已答复', blocked: '等待补充答复', cancelled: '已取消',
};
const runStatuses: Record<Run['status'], string> = {
  queued: '排队中', running: '执行中', succeeded: '执行结束', failed: '执行失败', blocked: '执行受阻', cancelled: '已取消', interrupted: '已中断',
};
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '时间未记录';

export interface TaskAssistanceProps {
  workspaceRoot: string;
  task: Task;
  progress: TaskProgress;
  assistance?: TaskAssistanceRecord[];
  members: Member[];
  loading?: boolean;
  disabled?: boolean;
  onChanged: () => Promise<void>;
  onOpenRun: (id: string) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}

function AssistanceAnswerDraft({ workspaceRoot, help, fieldId, editable, current, answered, saved, disabled, pending, notice, onSave }: {
  workspaceRoot: string; help: TaskAssistanceRecord; fieldId: string; editable: boolean; current: boolean;
  answered: boolean; saved: boolean; disabled: boolean; pending: boolean; notice: string;
  onSave: (answer: string, clearDraft: () => Promise<boolean>) => Promise<void>;
}) {
  const draft = useTaskDraft(workspaceRoot, { kind: 'assistance', taskId: help.taskId, planId: help.planId, questionId: help.id }, { answer: '' });
  const answer = draft.values.answer || '';
  if (!editable && !answer && !draft.error) return null;
  const status = <>
    {draft.error && <div className="error-banner" role="alert">{draft.error}
      <button type="button" className="btn btn-sm btn-secondary" disabled={draft.saving || disabled} onClick={() => void draft.retry()}>重试</button>
    </div>}
    {draft.saving && <p className="text-muted" role="status">正在保存文字草稿…</p>}
  </>;
  if (!editable) return <details>
    <summary>{answered ? '问题已有答复，仍保留的文字草稿' : current ? '保留的答复草稿（当前不可提交）' : '历史计划的答复草稿（仅供复制）'}</summary>
    <textarea className="form-textarea" rows={3} value={answer} readOnly aria-label="保留的答复草稿" />
    <p className="text-muted">这段文字只属于原计划和原问题，不会自动提交到当前工作。</p>
    {status}
    <button type="button" className="btn btn-sm btn-secondary" disabled={disabled || draft.saving || !answer} onClick={() => void draft.clear()}>清除此草稿</button>
  </details>;
  return <form onSubmit={(event) => { event.preventDefault(); void onSave(answer, draft.clear); }}>
    {!saved && <p className="text-muted">{notice}</p>}
    <label className="form-label" htmlFor={fieldId}>{help.interrupted ? '补充答复（可选）' : '补充答复'}</label>
    <textarea id={fieldId} data-draft-question={help.id} className="form-textarea" rows={3} maxLength={6000} value={answer}
      disabled={disabled || saved || !draft.ready} onChange={(event) => draft.setField('answer', event.target.value)} />
    {!draft.ready && <p className="text-muted" role="status">正在恢复文字草稿…</p>}
    {draft.restored && !draft.error && !draft.saving && <p className="text-muted">已恢复此问题的文字草稿。</p>}
    {status}
    <p className="text-muted">文字草稿自动保存在本工作区。提交答复后不会自动执行；答复将交回提出问题的成员。</p>
    <button type="submit" className="btn btn-sm btn-secondary" disabled={disabled || saved || !draft.ready || !answer.trim()}>
      <Save size={13} /><span>{pending ? '正在保存' : '保存答复'}</span>
    </button>
    <button type="button" className="btn btn-sm btn-secondary" disabled={disabled || saved || draft.saving || !answer} onClick={() => void draft.clear()}>放弃草稿</button>
  </form>;
}

export default function TaskAssistance({ workspaceRoot, task, progress, assistance = [], members, loading = false, disabled = false, onChanged, onOpenRun, onBusyChange }: TaskAssistanceProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedAnswers, setSavedAnswers] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [logError, setLogError] = useState('');
  const fieldPrefix = useId();
  const actionLock = useRef(false);
  const life = useRef({ active: false, generation: 0 });
  const busy = pendingId !== null;

  // TaskCoordination keys this component by task ID; the generation also guards StrictMode cleanup.
  useEffect(() => {
    life.current.active = true;
    return () => { life.current.active = false; life.current.generation++; };
  }, []);

  const coordination = progress.coordination || task.coordination;
  const planId = coordination?.planId;
  const records = [...new Map(assistance.filter((help) => help.taskId === task.id).map((help) => [help.id, help])).values()]
    .sort((left, right) => (right.createdAt || '').localeCompare(left.createdAt || ''));
  const runs = new Map([...(progress.runs || []), ...(progress.currentRuns || [])].map((run) => [run.id, run]));
  const memberName = (id?: string) => members.find((member) => member.id === id)?.name || id || '未指定';
  const isCurrent = (help: TaskAssistanceRecord) => Boolean(planId && help.planId === planId);
  const canAnswer = (help: TaskAssistanceRecord) => progress.taskId === task.id && isCurrent(help)
    && task.status === 'blocked' && !task.archivedAt && !task.pendingFeedback && progress.active === false && help.status === 'blocked'
    && help.ownerId === task.assigneeId && Boolean(coordination?.steps?.some((step) => step.key === help.stepKey
      && step.helpId === help.id && step.memberId === help.requesterId));

  const saveAnswer = async (help: TaskAssistanceRecord, text: string, clearDraft: () => Promise<boolean>) => {
    const answer = text.trim();
    if (actionLock.current || disabled || loading || !canAnswer(help) || savedAnswers[help.id] || !answer) return;
    actionLock.current = true;
    onBusyChange?.(true);
    setPendingId(help.id);
    setErrors((current) => ({ ...current, [help.id]: '' }));
    const generation = life.current.generation;
    const valid = () => life.current.active && generation === life.current.generation;
    let persisted = false;
    try {
      await api.answerTaskAssistance(task.id, help.id, answer);
      persisted = true;
      if (valid()) setSavedAnswers((current) => ({ ...current, [help.id]: answer }));
      // Clear only after the answer was accepted, including when the dialog closed meanwhile.
      await clearDraft();
      if (!valid()) return;
      await onChanged();
    } catch (reason) {
      if (valid()) setErrors((current) => ({ ...current, [help.id]: `${persisted ? '答复已保存，但进度刷新失败：' : ''}${reason instanceof Error ? reason.message : '保存答复失败'}` }));
    } finally {
      actionLock.current = false;
      onBusyChange?.(false);
      if (valid()) setPendingId(null);
    }
  };

  const openLog = async (id: string) => {
    if (actionLock.current) return;
    setLogError('');
    try { await onOpenRun(id); }
    catch (reason) { if (life.current.active) setLogError(reason instanceof Error ? reason.message : '打开协助日志失败'); }
  };

  if (records.length === 0) return null;

  return <details data-task-section="assistance" open={records.some((help) => isCurrent(help) && help.status !== 'cancelled' && (help.status !== 'answered' || task.status === 'blocked'))}>
    <summary className="form-label">任务内协助（{records.length} 条）</summary>
    {logError && <div className="error-banner" role="alert">{logError}</div>}
    {records.map((help) => {
      const current = isCurrent(help);
      const step = current ? coordination?.steps?.find((item) => item.key === help.stepKey) : undefined;
      const answer = help.answer || savedAnswers[help.id];
      const coordinatorRun = help.coordinatorRunId ? runs.get(help.coordinatorRunId) : undefined;
      const consultRun = help.consultRunId ? runs.get(help.consultRunId) : undefined;
      const answerRun = help.answerRunId ? runs.get(help.answerRunId) : undefined;
      const saved = Boolean(savedAnswers[help.id]);
      const interrupted = help.status === 'blocked' && help.interrupted === true;
      const fieldId = `${fieldPrefix}-${help.id}`;
      const logLinks = new Map<string, string[]>();
      for (const [id, label] of [[help.coordinatorRunId, '负责人处理'], [help.consultRunId, '同伴咨询'], [help.answerRunId, '答复来源']]) {
        if (id && label) logLinks.set(id, [...(logLinks.get(id) || []), label]);
      }

      return <article className="coordination-step" key={help.id}>
        <div><strong>{help.stepKey}{step?.title ? ` · ${step.title}` : ''}</strong>
          <span className="coordination-status">{saved && help.status === 'blocked' ? '答复已保存，等待刷新' : interrupted ? '协助处理中断' : assistanceStatuses[help.status] || '状态待更新'}</span></div>
        <p className="text-muted">{memberName(help.requesterId)} → 负责人 {memberName(help.ownerId)}
          {help.consultantId && ` → 同伴 ${memberName(help.consultantId)}`} · {current ? '当前计划' : planId ? '历史计划' : '计划关联待更新'}</p>
        {(help.coordinatorRunId || help.consultRunId) && <p className="text-muted">
          {help.coordinatorRunId && `负责人处理：${coordinatorRun ? runStatuses[coordinatorRun.status] : '状态待更新'}`}
          {help.coordinatorRunId && help.consultRunId && ' · '}
          {help.consultRunId && `同伴咨询：${consultRun ? runStatuses[consultRun.status] : '状态待更新'}`}
        </p>}
        <p className="task-summary"><strong>问题：</strong>{help.question || '未记录具体问题，请查看关联作业日志。'}</p>
        {help.consultQuestion && <p className="task-summary"><strong>负责人向同伴咨询：</strong>{help.consultQuestion}</p>}
        {help.peerReply && <details><summary>同伴答复（成员自述）</summary><p className="task-summary">{help.peerReply}</p></details>}
        {help.blocker && <p className="text-muted"><strong>{interrupted ? '中断原因' : '阻塞原因'}：</strong>{help.blocker}</p>}
        {answer && <p className="task-summary"><strong>答复{answerRun ? `（${memberName(answerRun.memberId)}）` : ''}：</strong>{answer}</p>}
        {help.status === 'answered' && !answer && <p className="text-muted">答复内容尚未加载，请刷新进度或查看答复来源日志。</p>}
        <p className="text-muted">提出于 {time(help.createdAt)}{help.answeredAt && ` · 答复于 ${time(help.answeredAt)}`}</p>
        {errors[help.id] && <div className="error-banner" role="alert">{errors[help.id]}</div>}
        {current && task.status === 'blocked' && !task.archivedAt && step?.status === 'waiting' && (saved || help.status === 'answered') && <p className="text-muted" role="status">
          {progress.active ? '答复已保存，等待当前作业全部停止后再继续。' : '答复已保存，尚未恢复执行。点击“继续任务”后，成员会收到答复并继续处理。'}
        </p>}
        <AssistanceAnswerDraft workspaceRoot={workspaceRoot} help={help} fieldId={fieldId} editable={canAnswer(help)}
          current={current} answered={Boolean(answer)} saved={saved} disabled={busy || loading || disabled} pending={pendingId === help.id}
          notice={interrupted
            ? progress.resume?.available ? '协助处理中断，可直接点击“继续任务”恢复当前咨询，也可手动补充答复。' : '协助处理中断。可补充答复，或按上方“继续执行”说明处理后继续。'
            : '负责人仍缺少必要信息；请先保存答复，或在下方填写纠正要求后继续。'}
          onSave={(text, clearDraft) => saveAnswer(help, text, clearDraft)} />
        {current && help.status === 'blocked' && progress.active && <p className="text-muted">{interrupted
          ? '等待当前作业全部停止后，可继续咨询或补充答复。' : '等待当前作业全部停止后，才能补充答复。'}</p>}
        {logLinks.size > 0 && <div style={{ justifyContent: 'flex-start', marginTop: 8 }}>
          {[...logLinks].map(([id, labels]) => <button type="button" className="btn btn-sm btn-secondary" key={id} disabled={busy} onClick={() => void openLog(id)}>
            <Terminal size={12} /><span>查看{labels.join(' / ')}日志</span>
          </button>)}
        </div>}
      </article>;
    })}
  </details>;
}
