import { supervisorStages } from './task-supervision.mjs';

const readOnlyStages = new Set(['review', 'plan', 'coordinate', 'consult', ...supervisorStages]);

// Scheduling, execution and queue explanations must use the same scope and
// permission decision. A shared channel never grants write access to a task.
export function runPolicy(run, member, room) {
  const taskId = run.taskId || run.contextTaskId || room.taskId || null;
  const readOnly = member.permission !== 'edit' || readOnlyStages.has(run.stage) ||
    Boolean(run.meetingId || run.analysisOnly || (run.stage === 'chat' && taskId));
  return { taskId, resource: taskId || run.roomId, readOnly, writer: !readOnly };
}
