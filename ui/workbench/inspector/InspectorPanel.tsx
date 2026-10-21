import React, { useState } from 'react';
import { Archive, X, Plus, FileText, ChevronRight, ListTodo, FolderOpen, BookOpen, Terminal, Square, AlertCircle } from 'lucide-react';
import type { Artifact, Member, Room, Run, Task, TaskProgress } from '../../types';
import { gateLabels, runStatusLabels, stageLabels, taskStatusLabels } from '../roomState';
import ArtifactDownload from '../../ArtifactDownload';

interface InspectorPanelProps {
  room: Room | undefined;
  roomTasks: Task[];
  roomArtifacts: Artifact[];
  roomRuns: Run[];
  members: Member[];
  focusTask: Task | undefined;
  contextOpen: boolean;
  inspectorOpen: boolean;
  archiveBusy: boolean;
  busyTaskIds: string[];
  tasks: Task[];
  onClose: () => void;
  onArchiveRoom: (id: string) => void;
  onCreateTask: () => void;
  onOpenTask: (id: string, section?: string) => void;
  onOpenRun: (id: string) => void;
  onCancelRun: (id: string) => void;
  onArtifact: (artifact: Artifact) => void;
  progress: TaskProgress | null;
}

const canPreview = (artifact: Artifact) => /\.(txt|md|json|csv|log)$/i.test(artifact.name);
const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? bytes + ' B'
    : bytes < 1048576
    ? (bytes / 1024).toFixed(1) + ' KB'
    : (bytes / 1048576).toFixed(1) + ' MB';

export function InspectorPanel({
  room,
  roomTasks,
  roomArtifacts,
  roomRuns,
  members,
  focusTask,
  contextOpen,
  inspectorOpen,
  archiveBusy,
  busyTaskIds,
  tasks,
  onClose,
  onArchiveRoom,
  onCreateTask,
  onOpenTask,
  onOpenRun,
  onCancelRun,
  onArtifact,
  progress,
}: InspectorPanelProps) {
  const [contextTab, setContextTab] = useState<'tasks' | 'artifacts' | 'runs'>('tasks');
  const currentRuns = progress?.currentRuns || [];
  const runReason = (run: Run) => currentRuns.find((item) => item.id === run.id)?.waitReason;
  const runIssue = (run: Run) =>
    run.error || (run.status === 'failed' || run.status === 'blocked' || run.status === 'interrupted'
      ? run.summary || '作业未正常结束，请查看完整日志。'
      : '');

  return (
    <aside
      className={`room-context-panel workbench-context${contextOpen ? ' context-open' : ''}`}
      hidden={inspectorOpen}
      aria-label="房间信息"
    >
      <header className="context-header">
        <strong>房间信息</strong>
        <div>
          {room && room.id !== 'team' && (
            <button
              className="btn btn-sm btn-secondary btn-icon-only"
              aria-label="归档频道"
              title={roomTasks.length ? '请先归档房间内的任务' : '归档聊天室'}
              disabled={archiveBusy || roomTasks.length > 0}
              onClick={() => onArchiveRoom(room.id)}
            >
              <Archive size={14} />
            </button>
          )}
          <button
            className="btn btn-sm btn-secondary btn-icon-only context-close"
            aria-label="关闭房间信息"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="context-tabs" role="tablist" aria-label="房间信息分类">
        {(['tasks', 'artifacts', 'runs'] as const).map((tab) => (
          <button
            type="button"
            role="tab"
            key={tab}
            id={`room-tab-${tab}`}
            aria-controls="room-context-content"
            aria-selected={contextTab === tab}
            onClick={() => setContextTab(tab)}
          >
            {{ tasks: '任务', artifacts: '成果', runs: '日志' }[tab]}{' '}
            <small>
              {tab === 'tasks' ? roomTasks.length : tab === 'artifacts' ? roomArtifacts.length : roomRuns.length}
            </small>
          </button>
        ))}
      </div>

      <div className="context-content" role="tabpanel" id="room-context-content" aria-labelledby={`room-tab-${contextTab}`}>
        {contextTab === 'tasks' && (
          <>
            <button className="btn btn-secondary context-new-task" disabled={!room} onClick={onCreateTask}>
              <Plus size={14} />
              新建协作任务
            </button>
            {roomTasks.map((task) => (
              <section className={`context-task${task.id === focusTask?.id ? ' selected' : ''}`} key={task.id}>
                <button className="context-task-title" onClick={() => onOpenTask(task.id)}>
                  <FileText size={15} />
                  <strong>{task.title}</strong>
                  <ChevronRight size={14} />
                </button>
                <div className="context-task-meta">
                  <span className={`task-state-label state-${task.status}`}>{taskStatusLabels[task.status]}</span>
                  <span>{members.find((member) => member.id === task.assigneeId)?.name || '负责人待确认'}</span>
                </div>
                <p>{task.objective}</p>
                <span className={`context-gate gate-${task.gate.status}`}>{gateLabels[task.gate.status]}</span>
                <div className="context-task-actions">
                  <button className="file-link" onClick={() => onOpenTask(task.id, 'plan')}>
                    <ListTodo size={13} />
                    计划与求助
                  </button>
                  <button className="file-link" onClick={() => onOpenTask(task.id, 'materials')}>
                    <FolderOpen size={13} />
                    材料
                  </button>
                  {task.status === 'review' && (
                    <button className="file-link" onClick={() => onOpenTask(task.id, 'acceptance')}>
                      处理验收
                    </button>
                  )}
                </div>
              </section>
            ))}
            {!roomTasks.length && <p className="context-empty">暂无关联任务。创建任务后，在这里查看计划、答复求助和处理验收。</p>}
          </>
        )}

        {contextTab === 'artifacts' && (
          <>
            <p className="context-caption">当前已加载的房间成果；是否验收以所属任务为准。</p>
            {roomArtifacts.map((artifact) => (
              <article className="context-artifact" key={artifact.id}>
                {canPreview(artifact) ? (
                  <button className="file-link" onClick={() => onArtifact(artifact)}>
                    <BookOpen size={15} />
                    <strong>{artifact.name}</strong>
                  </button>
                ) : (
                  <strong>{artifact.name}</strong>
                )}
                <small>
                  {sizeLabel(artifact.size)} ·{' '}
                  {tasks.find((task) => task.id === artifact.taskId)?.status === 'done' ? '所属任务已验收' : '候选成果'}
                </small>
                <ArtifactDownload artifact={artifact} className="file-link" />
              </article>
            ))}
            {!roomArtifacts.length && <p className="context-empty">已加载的记录中暂无成果文件。</p>}
          </>
        )}

        {contextTab === 'runs' && (
          <>
            <p className="context-caption">从工作区最近 50 次执行中筛选；任务详情提供该任务的完整进度。</p>
            {roomRuns.map((run) => (
              <article className="context-run" key={run.id}>
                <div>
                  <strong>{members.find((member) => member.id === run.memberId)?.name || run.memberId}</strong>
                  <span className={`run-state-${run.status}`}>{runStatusLabels[run.status]}</span>
                </div>
                <small>
                  {stageLabels[run.stage] || run.stage} ·{' '}
                  {new Date(run.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </small>
                {run.status === 'queued' && (
                  <p className="context-run-reason" data-run-reason={run.id}>
                    <AlertCircle size={12} aria-hidden="true" />
                    <span>{runReason(run) || '正在等待可用执行名额；无需重复提交。'}</span>
                  </p>
                )}
                {runIssue(run) && <p className="context-run-issue">{runIssue(run)}</p>}
                {run.summary && run.status !== 'queued' && !runIssue(run) && <p>{run.summary}</p>}
                <div className="context-task-actions">
                  <button className="file-link" onClick={() => onOpenRun(run.id)}>
                    <Terminal size={13} />
                    查看日志
                  </button>
                  {['running', 'queued'].includes(run.status) && (
                    <button
                      className="file-link danger-link"
                      disabled={busyTaskIds.includes(run.taskId || run.contextTaskId || '')}
                      onClick={() => onCancelRun(run.id)}
                    >
                      <Square size={12} />
                      停止执行
                    </button>
                  )}
                </div>
              </article>
            ))}
            {!roomRuns.length && <p className="context-empty">最近记录中暂无本房间的执行。</p>}
          </>
        )}
      </div>
    </aside>
  );
}
