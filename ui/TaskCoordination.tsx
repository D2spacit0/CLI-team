import { useCallback, useRef, useState } from 'react';
import { Pause, RefreshCw, Terminal } from 'lucide-react';
import { api } from './api';
import RunDiagnostics from './RunDiagnostics';
import TaskAssistance from './TaskAssistance';
import type { Member, Run, Task, TaskProgress, TaskStep } from './types';
import { stageLabels } from './workbench/roomState';

const phases: Record<NonNullable<Task['coordination']>['phase'], string> = { planning: '负责人制定计划', working: '协作成员执行', checking: '主控审查子任务', assisting: '处理成员求助', synthesizing: '负责人汇总成果', delivering: '主控终审与交付', blocked: '已阻塞', cancelled: '已取消', review: '待整体验收', done: '已验收' };
const statuses: Record<Run['status'], string> = { queued: '排队中', running: '执行中', succeeded: '执行结束', failed: '执行失败', blocked: '执行受阻', cancelled: '已取消', interrupted: '已中断' };
const taskStatuses: Record<Task['status'], string> = { backlog: '待启动', running: '执行中', review: '待整体验收', done: '已验收', blocked: '已阻塞', cancelled: '已取消' };
const stageName = (stage: string) => stageLabels[stage] || stage;
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '时间未记录';
const outputFormats = { any: '任意格式', text: '文本', json: 'JSON' };

function StepOutputCheck({ step }: { step: TaskStep }) {
  const output = step.output;
  const check = step.outputCheck;
  const type = check?.type || output?.type;
  const label = type === 'files' ? '文件交付检查' : type === 'analysis' ? '分析结构检查' : '交付检查';
  const status = step.checkpointValid === false ? '上次通过，当前已失效'
    : check ? { passed: '通过', failed: '未通过', not_configured: '未配置' }[check.status]
    : output ? '尚无检查记录' : '未配置';
  const files = check?.files || [];
  const sections = check?.sections || [];
  const issues = check?.issues || [];
  return <>
    {output?.type === 'files' && <p className="text-muted">约定文件：{(output.files || []).map((file) => `${file.path}（${outputFormats[file.format] || '格式未记录'}）`).join('、') || '未记录文件清单'}</p>}
    {output?.type === 'analysis' && <p className="text-muted">约定分析部分：{(output.sections || []).join('、') || '未记录结构要求'}</p>}
    <p className="text-muted"><strong>{label}：{status}</strong>{check?.summary && step.checkpointValid !== false && ` · ${check.summary}`}
      {!output && !check && '；此步骤未记录交付约定，不能作为已检查的交付保留。'}</p>
    {check && <p className="text-muted">上次检查：{time(check.checkedAt)}。
      {step.checkpointValid === false ? step.checkpointReason || '原检查点已失效，继续时需要重新执行。'
        : step.checkpointValid === true ? '本次已复核交付与依赖一致；是否保留以继续执行说明为准。'
          : check.status === 'passed' ? '这是该次执行的检查记录，继续前会重新核对当前文件与依赖。' : ''}</p>}
    {issues.length > 0 && <ul className="text-muted" style={{ margin: '6px 0', paddingLeft: 18 }}>
      {issues.map((issue, index) => <li key={`${index}-${issue}`}>{issue}</li>)}
    </ul>}
    {check && (check.contractHash || files.length > 0 || sections.length > 0) && <details>
      <summary>检查记录 · {time(check.checkedAt)}</summary>
      {check.contractHash && <p className="text-muted">交付约定 SHA-256：<code>{check.contractHash}</code></p>}
      {files.length > 0 && <ul className="text-muted" style={{ margin: '6px 0', paddingLeft: 18 }}>
        {files.map((file, index) => <li key={`${index}-${file.path}`}>
          <code>{file.path}</code> · {outputFormats[file.format] || '格式未记录'} · {file.size} B
          <br />SHA-256：<code>{file.sha256 || '未记录'}</code>
        </li>)}
      </ul>}
      {sections.length > 0 && <ul className="text-muted" style={{ margin: '6px 0', paddingLeft: 18 }}>
        {sections.map((section, index) => <li key={`${index}-${section.key}`}>
          {section.key} · SHA-256：<code>{section.sha256 || '未记录'}</code>
        </li>)}
      </ul>}
    </details>}
  </>;
}

export interface TaskCoordinationProps {
  workspaceRoot: string;
  task: Task;
  members: Member[];
  data: TaskProgress | null;
  loading?: boolean;
  disabled?: boolean;
  error?: string;
  refresh: () => Promise<void>;
  onChanged: () => Promise<void>;
  onOpenRun: (id: string) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}

export default function TaskCoordination({ workspaceRoot, task, members, data, loading = false, disabled = false, error = '', refresh, onChanged, onOpenRun, onBusyChange }: TaskCoordinationProps) {
  const [pending, setPending] = useState<'refresh' | 'pause' | null>(null);
  const [assistanceBusy, setAssistanceBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const actionLock = useRef(false);
  const assistanceBusyRef = useRef(false);
  const busy = Boolean(pending) || assistanceBusy;
  const reportAssistanceBusy = useCallback((value: boolean) => {
    assistanceBusyRef.current = value;
    setAssistanceBusy(value);
    onBusyChange?.(actionLock.current || value);
  }, [onBusyChange]);
  const progress = data?.taskId === task.id ? data : null;
  const coordination = progress?.coordination;
  const steps = coordination?.steps || [];
  const currentRuns = [...new Map((progress?.currentRuns || []).map((run) => [run.id, run])).values()];
  const pausedAt = task.status === 'blocked' ? task.pausedAt : null;
  const memberName = (id: string) => members.find((member) => member.id === id)?.name || id;
  const runs = [...new Map((progress?.runs || []).map((run) => [run.id, run])).values()].sort((left, right) => (right.createdAt || '').localeCompare(left.createdAt || ''));
  const exceptions = runs.filter((run) => ['failed', 'blocked', 'cancelled', 'interrupted'].includes(run.status) || (run.riskFlags || []).length > 0 || run.error);
  const resume = progress?.resume;
  const resumeCountsAvailable = resume && Number.isInteger(resume.reusableSteps) && Number.isInteger(resume.totalSteps)
    && resume.reusableSteps >= 0 && resume.totalSteps > 0 && resume.reusableSteps <= resume.totalSteps;
  const stepStatus = (step: NonNullable<Task['coordination']>['steps'][number]) => {
    const currentRun = currentRuns.find((run) => run.id === step.runId);
    const run = currentRun || runs.find((item) => item.id === step.runId);
    const help = (progress?.assistance || []).find((item) => item.id === step.helpId && item.planId === coordination?.planId && item.stepKey === step.key);
    if (run?.status === 'cancelled' && progress?.active && (currentRun || step.status === 'running')) return '正在停止';
    if (help?.status === 'blocked' && help.interrupted && ['waiting', 'failed'].includes(step.status)) return '协助已中断，等待继续';
    if (step.status === 'running') return run ? statuses[run.status] : '执行状态待更新';
    if (step.status === 'reviewing') return '成员已提交，主控审查中';
    if (step.status === 'waiting') {
      return help?.status === 'answered' ? '答复已就绪，等待恢复执行' : '等待协助答复';
    }
    if (step.checkpointValid === false) return '原交付已变化，等待重做';
    if (step.outputCheck?.status === 'failed') return '交付检查未通过';
    return ({ pending: '等待执行', failed: '执行失败', succeeded: task.status === 'done' ? '执行完成，整体验收已通过' : task.managed ? '主控审查通过，待整体验收' : '执行完成，待整体验收' } as Record<string, string>)[step.status] || step.status;
  };
  const openLog = async (id: string) => {
    setActionError('');
    try { await onOpenRun(id); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : '打开作业日志失败'); }
  };
  const update = async () => {
    if (actionLock.current || busy || loading || disabled) return;
    actionLock.current = true;
    onBusyChange?.(true);
    setPending('refresh');
    setActionError('');
    try { await refresh(); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : '刷新任务进度失败'); }
    finally { actionLock.current = false; setPending(null); onBusyChange?.(assistanceBusyRef.current); }
  };
  const pause = async () => {
    if (actionLock.current || busy || loading || disabled || error || task.archivedAt || !progress?.canPause) return;
    actionLock.current = true;
    onBusyChange?.(true);
    setPending('pause');
    setActionError('');
    let paused = false;
    try {
      await api.pauseTask(task.id);
      paused = true;
      await onChanged();
    } catch (reason) { setActionError(`${paused ? '暂停请求已提交，但状态刷新失败：' : ''}${reason instanceof Error ? reason.message : '暂停任务失败'}`); }
    finally { actionLock.current = false; setPending(null); onBusyChange?.(assistanceBusyRef.current); }
  };

  return <section className="coordination-panel">
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
      <div className="form-label">{task.executionMode === 'delegated' ? '负责人调度进度' : '任务执行进度'}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm btn-secondary" disabled={busy || loading || disabled} onClick={update}>
          <RefreshCw size={13} /><span>{pending === 'refresh' || loading ? '正在刷新' : '刷新进度'}</span>
        </button>
        {progress?.canPause && !task.archivedAt && <button type="button" className="btn btn-sm btn-secondary" disabled={busy || loading || disabled || Boolean(error)} onClick={pause}>
          <Pause size={13} /><span>{pending === 'pause' ? '正在暂停' : '暂停任务'}</span>
        </button>}
      </div>
    </div>
    {(error || actionError) && <div className="error-banner" role="alert">{actionError || error}{error && progress && '（下方保留上次成功加载的进度）'}</div>}
    {!progress ? <p className="text-muted">{loading ? '正在读取此任务的进度与作业记录…' : '进度尚未加载，请刷新后查看真实执行状态。'}</p> : <>
      <p><strong>当前阶段：</strong>{pausedAt ? (progress.active ? '正在暂停，等待作业停止' : '已暂停') : coordination ? phases[coordination.phase] || '阶段待更新' : taskStatuses[task.status]}
        {coordination && ` · 第 ${coordination.round} 轮`} · 剩余自动返工 {progress.remainingRepairs} 轮</p>
      {task.executionMode === 'delegated' && <p className="text-muted">负责人：{memberName(task.assigneeId)} · 可调度：{(task.participantIds || []).map(memberName).join('、') || '未指定'}</p>}
      {task.managed && <p className="text-muted">主控托管：逐项审查交付，退回不合格步骤；整体验收后由主控终审。</p>}
      {task.delivery && <section data-testid="task-delivery">
        <h4>{task.delivery.status === 'delivered' ? '主控已交付' : '主控交付报告 · 待确认'}</h4>
        <p className="task-summary">{task.delivery.summary}</p>
        {task.delivery.limitation && <p className="run-warning">{task.delivery.limitation}</p>}
        <p className="text-muted">机器检查：{({ passed: '通过', not_configured: '未配置', pending: '待检查', failed: '失败', stale: '已失效' })[task.delivery.gateStatus]} · 独立评审：{task.delivery.independentReview === 'approve' ? '通过' : '未配置'}</p>
        <ul>{task.delivery.artifacts.map((artifact) => <li key={artifact.id}><code>{artifact.relativePath}</code></li>)}</ul>
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => openLog(task.delivery!.runId)}>查看主控终审日志</button>
      </section>}
      {pausedAt && <p className="text-muted">暂停于 {time(pausedAt)}。已有成果保留；全部停止后可调整分工，再点击“继续任务”。</p>}
      {progress.canPause && <p className="text-muted">暂停会停止当前作业和后续派工，保留成果，之后可继续。</p>}
      {task.status === 'blocked' && !task.archivedAt && resume && <div>
        <div className="form-label">继续执行</div>
        {resume.available && resumeCountsAvailable ? <p className="text-muted">
          可保留已检查的 {resume.reusableSteps}/{resume.totalSteps} 步，继续仅重做未保留的步骤；后续仍需汇总与整体验收。
        </p> : <p className="text-muted">当前尚不能直接复用已执行步骤。</p>}
        {resume.reason && <p className="text-muted">{resume.reason}</p>}
      </div>}

      <div className="form-label">当前执行与排队</div>
      {currentRuns.length > 0 ? currentRuns.map((run) => <article className="coordination-step" key={run.id}>
        <div><strong>{memberName(run.memberId)} · {stageName(run.stage)}</strong><span>{run.status === 'cancelled' ? '正在停止' : statuses[run.status]}</span></div>
        {run.waitReason && <p className="text-muted">等待原因：{run.waitReason}</p>}
        {run.status === 'queued' && !run.waitReason && <p className="text-muted">已进入队列，服务尚未提供具体等待原因。</p>}
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => openLog(run.id)}><Terminal size={12} /><span>查看当前作业日志</span></button>
      </article>) : <p className="text-muted">{progress.active ? '本任务仍有执行或停止清理活动，等待状态更新。' : '当前没有执行或排队的作业。'}</p>}

      <TaskAssistance key={`assistance-${workspaceRoot}-${task.id}`} workspaceRoot={workspaceRoot} task={task} progress={progress} assistance={progress.assistance || []} members={members}
        loading={loading} disabled={disabled || Boolean(pending) || Boolean(error)} onChanged={onChanged} onOpenRun={onOpenRun} onBusyChange={reportAssistanceBusy} />

      {coordination && <details open>
        <summary className="form-label">{coordination.phase === 'planning' && steps.length > 0 ? '上一轮结果（本轮正在重新规划）' : `本轮计划与依赖（${steps.length} 步）`}</summary>
        {steps.length === 0 && <p className="text-muted">本轮尚未记录可执行步骤。</p>}
        {steps.length > 0 && <p className="text-muted">交付检查核对文件、格式或分析结构；检查通过不代表业务验收通过。</p>}
        {steps.map((step, index) => <article className="coordination-step" key={`${coordination.planId || coordination.round}-${step.key}-${index}`}>
          <div><strong>{step.key} · {step.title}</strong><span className="coordination-status">{stepStatus(step)}</span></div>
          <p className="text-muted">执行成员：{memberName(step.memberId)} · 前置步骤：{(step.dependsOn || []).length ? step.dependsOn.map((key) => `${key}（${steps.find((item) => item.key === key)?.title || '未找到步骤'}）`).join('、') : '无'}
            {typeof step.attempts === 'number' && ` · 已尝试 ${step.attempts} 次`}</p>
          <p>{step.objective}</p>
          <StepOutputCheck step={step} />
          {(step.ownerReview || step.previousOwnerReview) && <details open={step.ownerReview?.verdict === 'changes_requested'}>
            <summary>{step.ownerReview ? '本次主控审查' : '上次主控审查'} · {(step.ownerReview || step.previousOwnerReview)?.verdict === 'approve' ? '通过' : '要求返工'}</summary>
            <p className="task-summary">{(step.ownerReview || step.previousOwnerReview)?.summary}</p>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => openLog((step.ownerReview || step.previousOwnerReview)!.runId)}>查看主控审查日志</button>
          </details>}
          {step.status === 'reviewing' && step.reviewRunId && <button type="button" className="btn btn-sm btn-secondary" onClick={() => openLog(step.reviewRunId!)}>查看进行中的主控审查</button>}
          {step.summary && <details><summary>成员执行回执（成员自述）</summary><p className="task-summary">{step.summary}</p></details>}
          {step.runId && <button type="button" className="btn btn-sm btn-secondary" onClick={() => openLog(step.runId!)}><Terminal size={12} /><span>查看步骤日志</span></button>}
        </article>)}
      </details>}

      <details open={exceptions.length > 0 && task.status === 'blocked'}>
        <summary className="form-label">本任务近期执行异常（{exceptions.length} 条）</summary>
        <p className="text-muted">已加载本任务 {runs.length} 条作业记录，共 {progress.totalRuns} 条{progress.omittedRuns > 0 ? `，另有 ${progress.omittedRuns} 条较早记录未展示` : ''}。历史异常不代表当前任务仍失败，机器检查与成员自述分开记录。</p>
        {exceptions.length === 0 && <p className="text-muted">已加载的作业中没有异常记录；这不代表任务已经通过验收。</p>}
        {exceptions.map((run, index) => <details className="coordination-step" key={run.id} open={index === 0}>
          <summary>{memberName(run.memberId)} · {stageName(run.stage)} · {statuses[run.status]} · {time(run.createdAt)}</summary>
          <RunDiagnostics run={run} />
          {run.warnings?.map((warning, warningIndex) => <p className="run-warning" key={warningIndex}>{warning}</p>)}
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => openLog(run.id)}><Terminal size={12} /><span>查看异常日志</span></button>
        </details>)}
      </details>
      <details>
        <summary className="form-label">本任务作业记录（已加载 {runs.length}/{progress.totalRuns}）</summary>
        {runs.length === 0 && <p className="text-muted">尚无作业记录。</p>}
        {runs.map((run) => <article className="coordination-step" key={run.id}>
          <div><span>{memberName(run.memberId)} · {stageName(run.stage)} · {statuses[run.status]}</span>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => openLog(run.id)}><Terminal size={12} /><span>查看日志</span></button></div>
          <p className="text-muted">{time(run.createdAt)}</p>
        </article>)}
        {progress.omittedRuns > 0 && <p className="text-muted">较早的 {progress.omittedRuns} 条记录未在此处加载。</p>}
      </details>
    </>}
  </section>;
}
