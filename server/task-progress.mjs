import { runPolicy } from './run-policy.mjs';

export function taskAttention(task, service) {
  if (task.archivedAt) return null;
  if (task.status === 'review') return { kind: 'acceptance' };
  if (task.status !== 'blocked') return null;
  if (task.pausedAt) return { kind: 'paused' };
  if (task.pendingFeedback) return { kind: 'blocked' };
  const help = service.assistance.list(task.id).find((item) => service.assistance.current(task, item) &&
    item.status === 'blocked' && !item.interrupted);
  return help ? { kind: 'assistance', helpId: help.id } : { kind: 'blocked' };
}

// Queue diagnostics mirror the scheduler's capacity, member and workspace locks.
export function taskQueueReason(run, service) {
  const active = service.active;
  if (active.has(run.id)) {
    if (run.status === 'cancelled') return '正在停止成员进程，退出后才能调整分工';
    return '';
  }
  if (run.status !== 'queued') return '';
  if (service.settings().paused) return '全局调度已暂停，恢复调度后继续';
  if ([...active.values()].some((entry) => entry.memberId === run.memberId)) return '该成员正在处理其他作业，等待空闲';
  const room = service.require('rooms', run.roomId);
  const member = service.require('members', run.memberId);
  const { resource, writer } = runPolicy(run, member, room);
  if ([...active.values()].some((entry) => entry.resource === resource && (writer || entry.writer))) return '同一任务目录仍有成员工作，等待文件操作结束';
  if (active.size >= service.settings().maxParallel) return '并发名额已满，等待其他作业完成';
  return '已进入队列，等待调度启动';
}
