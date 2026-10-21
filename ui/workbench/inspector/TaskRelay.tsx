import React from 'react';
import { ListTodo, ChevronRight, CircleCheck } from 'lucide-react';
import type { Member, Task, TaskProgress } from '../../types';

interface TaskRelayProps {
  task: Task;
  progress: TaskProgress | null;
  members: Member[];
  onOpen: () => void;
}

export function TaskRelay({ task, progress, members, onOpen }: TaskRelayProps) {
  const coordination = progress?.taskId === task.id ? progress.coordination : task.coordination;
  const steps = coordination?.steps || [];
  const checked = steps.filter(
    (step) =>
      step.status === 'succeeded' &&
      step.outputCheck?.status === 'passed' &&
      step.checkpointValid !== false
  ).length;
  const previousPlan = coordination?.phase === 'planning' && steps.length > 0;

  return (
    <div className="task-relay" aria-label="成员接力" data-step-count={steps.length} data-complete-count={checked}>
      <div className="relay-heading">
        <span>
          {steps.length && checked === steps.length ? <CircleCheck size={13} /> : <ListTodo size={13} />}
          {previousPlan ? '上一轮计划' : steps.length ? `执行进度 ${checked}/${steps.length}` : '成员接力'}
        </span>
        <button className="file-link" onClick={onOpen}>
          {steps.length ? `${task.managed ? '主控审查' : '交付检查'} · ${checked} 步已通过` : '查看任务计划'}
          <ChevronRight size={13} />
        </button>
      </div>
      {steps.length ? (
        <div
          className="relay-steps"
          role="list"
          aria-label={`执行步骤，已通过 ${checked}/${steps.length}`}
          tabIndex={0}
        >
          {steps.map((step) => {
            const state =
              step.checkpointValid === false
                ? '交付已失效'
                : step.outputCheck?.status === 'failed'
                ? '交付检查失败'
                : step.status === 'succeeded'
                ? step.outputCheck?.status === 'passed'
                  ? '交付检查通过'
                  : '执行完成 · 待检查'
                : ({
                    pending: '等待执行',
                    running: '执行中',
                    waiting: '等待协助',
                    reviewing: '主控审查中',
                    failed: '执行失败',
                  } as Record<string, string>)[step.status];

            const memberName =
              members.find((member) => member.id === step.memberId)?.name || step.memberId;

            return (
              <button
                className={`relay-step relay-${step.status}`}
                key={step.key}
                role="listitem"
                aria-label={`${step.title}，${memberName}，${state}`}
                onClick={onOpen}
              >
                <span className="relay-step-title">{step.title}</span>
                <span>
                  {memberName} · {state}
                </span>
                <small>
                  {step.dependsOn.length ? `依赖：${step.dependsOn.join('、')}` : '无前置依赖'}
                </small>
              </button>
            );
          })}
        </div>
      ) : (
        <p>
          {coordination?.phase === 'planning'
            ? '负责人正在制定执行计划。'
            : task.executionMode === 'delegated'
            ? '尚未形成执行计划。'
            : '此任务由执行人直接处理，可查看执行记录。'}
        </p>
      )}
    </div>
  );
}
