import React from 'react';
import { AlertCircle, CheckSquare, HelpCircle, PauseCircle, Play, ChevronRight } from 'lucide-react';
import type { Task, Member } from '../../types';
import { gateLabels } from '../roomState';

interface AttentionViewProps {
  tasks: Task[];
  members: Member[];
  onOpenTask: (id: string, section?: string) => void;
}

export function AttentionView({ tasks, members, onOpenTask }: AttentionViewProps) {
  const visibleTasks = tasks.filter((t) => !t.archivedAt);

  // 1. 待验收任务
  const reviewTasks = visibleTasks.filter((t) => t.status === 'review');

  // 2. 所有 blocked 状态任务，区分为：主动暂停、真实业务求助、执行受阻
  const blockedTasks = visibleTasks.filter((t) => t.status === 'blocked');

  // Actions come from live task/assistance records. Agent summaries and old
  // help identifiers must never invent a question for the user to answer.
  const pausedTasks = blockedTasks.filter((t) => t.attention?.kind === 'paused' || Boolean(t.pausedAt));
  const assistanceTasks = blockedTasks.filter((t) => !pausedTasks.includes(t) && t.attention?.kind === 'assistance');

  // 2.3 其他受阻/异常任务
  const failedBlockedTasks = blockedTasks.filter(
    (t) => !pausedTasks.includes(t) && !assistanceTasks.includes(t)
  );

  const totalCount = reviewTasks.length + pausedTasks.length + assistanceTasks.length + failedBlockedTasks.length;

  return (
    <div className="attention-view" data-testid="attention-view">
      <div className="attention-header">
        <h2 className="attention-title">需要我处理 ({totalCount})</h2>
        <div className="attention-scope-hint">
          显示当前工作区已加载任务中的阻断与待办事项 · 按照重要程度排列
        </div>
      </div>

      <div className="attention-list">
        {/* 待验收任务 */}
        {reviewTasks.map((task) => {
          const assignee = members.find((m) => m.id === task.assigneeId);
          return (
            <div className="attention-item" key={`review-${task.id}`}>
              <div className="attention-item-left">
                <div>
                  <span className="attention-item-tag attention-tag-review">
                    <CheckSquare size={12} /> 待你验收
                  </span>
                </div>
                <div className="attention-item-title">{task.title}</div>
                <div className="attention-item-desc">
                  负责人：{assignee ? `@${assignee.handle}` : '未分配'} · {gateLabels[task.gate.status]}
                </div>
              </div>
              <div className="attention-actions">
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => onOpenTask(task.id, 'acceptance')}
                >
                  去验收 <ChevronRight size={13} />
                </button>
              </div>
            </div>
          );
        })}

        {/* 等待答复的求助任务 */}
        {assistanceTasks.map((task) => {
          const assignee = members.find((m) => m.id === task.assigneeId);
          return (
            <div className="attention-item" key={`assist-${task.id}`}>
              <div className="attention-item-left">
                <div>
                  <span className="attention-item-tag attention-tag-help">
                    <HelpCircle size={12} /> 等待答复求助
                  </span>
                </div>
                <div className="attention-item-title">{task.title}</div>
                <div className="attention-item-desc">
                  负责人：{assignee ? `@${assignee.handle}` : '未分配'} · {task.summary || '需要提供输入或答复协助'}
                </div>
              </div>
              <div className="attention-actions">
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => onOpenTask(task.id, 'assistance')}
                >
                  去答复 <ChevronRight size={13} />
                </button>
              </div>
            </div>
          );
        })}

        {/* 用户主动暂停任务 */}
        {pausedTasks.map((task) => {
          const assignee = members.find((m) => m.id === task.assigneeId);
          return (
            <div className="attention-item" key={`paused-${task.id}`}>
              <div className="attention-item-left">
                <div>
                  <span className="attention-item-tag attention-tag-paused">
                    <PauseCircle size={12} /> 已主动暂停
                  </span>
                </div>
                <div className="attention-item-title">{task.title}</div>
                <div className="attention-item-desc">
                  负责人：{assignee ? `@${assignee.handle}` : '未分配'} · {task.summary || '任务已暂停，调度保持挂起'}
                </div>
              </div>
              <div className="attention-actions">
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => onOpenTask(task.id, 'plan')}
                >
                  <Play size={12} /> 继续任务
                </button>
              </div>
            </div>
          );
        })}

        {/* 其他受阻任务 */}
        {failedBlockedTasks.map((task) => {
          const assignee = members.find((m) => m.id === task.assigneeId);
          return (
            <div className="attention-item" key={`blocked-${task.id}`}>
              <div className="attention-item-left">
                <div>
                  <span className="attention-item-tag attention-tag-blocked">
                    <AlertCircle size={12} /> 执行受阻
                  </span>
                </div>
                <div className="attention-item-title">{task.title}</div>
                <div className="attention-item-desc">
                  负责人：{assignee ? `@${assignee.handle}` : '未分配'} · {task.summary || '任务执行遇到异常阻断'}
                </div>
              </div>
              <div className="attention-actions">
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => onOpenTask(task.id, 'plan')}
                >
                  查看原因 <ChevronRight size={13} />
                </button>
              </div>
            </div>
          );
        })}

        {totalCount === 0 && (
          <div className="empty-state">
            <CheckSquare size={32} style={{ color: 'var(--wb-success)' }} />
            <p style={{ marginTop: '12px' }}>当前已加载的任务中没有需要处理的阻塞或验收事项</p>
          </div>
        )}
      </div>
    </div>
  );
}
