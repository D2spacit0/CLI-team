import { createHash } from 'node:crypto';
import { z } from 'zod';
import { now } from './store.mjs';

export const managedTeamSchema = z.object({
  ownerId: z.string().min(1).max(200),
  workerIds: z.array(z.string().min(1).max(200)).min(1).max(4),
  reviewerId: z.string().min(1).max(200).nullable().default(null),
  verification: z.object({ executable: z.string().min(1).max(1000),
    args: z.array(z.string().max(2000)).max(40) }).strict().nullable().default(null),
  autoDeliver: z.boolean().default(true),
}).strict();

const requestSchema = z.object({
  requestId: z.string().uuid(), objective: z.string().trim().min(1).max(12000),
  title: z.string().trim().min(1).max(120).optional(), roomId: z.string().min(1).max(200).default('team'),
}).strict();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export class ManagedTasks {
  constructor(service) { this.service = service; }

  validateTeam(team) {
    const s = this.service;
    s.validateDelegationMembers({ executionMode: 'delegated', assigneeId: team.ownerId,
      participantIds: team.workerIds, reviewerId: team.reviewerId });
    if (team.reviewerId) {
      s.runnable(team.reviewerId);
      if (team.reviewerId === team.ownerId) fail('主控和独立评审者必须是不同成员');
    }
  }

  submit(input) {
    const parsed = requestSchema.parse(input);
    const requestId = parsed.requestId.toLowerCase();
    const inputHash = createHash('sha256').update(JSON.stringify({ ...parsed, requestId })).digest('hex');
    const s = this.service;
    return s.store.transaction(() => {
      const previous = s.store.get('managedRequests', requestId);
      if (previous) {
        if (previous.inputHash !== inputHash) fail('这个请求已用于不同目标，请恢复原请求或重新提交', 409);
        return s.require('tasks', previous.taskId);
      }
      const team = s.settings().managedTeam;
      if (!team) fail('请先在工作区设置中配置主控与协作团队', 409);
      this.validateTeam(team);
      s.ensureQueueCapacity();
      const task = s.createTask({ title: parsed.title || parsed.objective.split(/\r?\n/)[0].slice(0, 80),
        objective: parsed.objective, roomId: parsed.roomId, assigneeId: team.ownerId,
        participantIds: team.workerIds, reviewerId: team.reviewerId, verification: team.verification,
        executionMode: 'delegated', managed: true, autoDeliver: team.autoDeliver, start: false });
      s.store.put('managedRequests', { id: requestId, inputHash, taskId: task.id, createdAt: now() });
      s.message(task.roomId, 'user', '你', parsed.objective, { kind: 'user', taskId: task.id });
      const started = s.startPreparedTask(task.id);
      s.emitChange('task.submitted', { id: task.id, ownerId: team.ownerId });
      return started;
    });
  }
}
