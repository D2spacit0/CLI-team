import { now } from './store.mjs';
import { redact } from './safety.mjs';
import { runPolicy } from './run-policy.mjs';

const terminal = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted']);
const identifier = value => typeof value === 'string' && value.trim().length > 0;

// The only allocator of process slots for both legacy tasks and business work.
// Business outbox delivery admits runs here; it never starts its own CLI pool.
export class ExecutionScheduler {
  constructor(service) { this.service = service; this.pumping = false; }
  runContext(run) {
    const business = run.workflowKind === 'business';
    const required = business ? ['memberId', 'projectId', 'workItemId', 'attemptId', 'jobId', 'stage'] : ['memberId', 'roomId', 'stage'];
    const missing = required.filter(field => !identifier(run[field]));
    if (missing.length) return { issue: `运行记录缺少有效字段：${missing.join('、')}；未派发，请取消后重新创建。` };
    if (business && (!Number.isSafeInteger(run.generation) || run.generation < 1)) {
      return { issue: '业务运行缺少有效的工作代次；未派发，请取消后重新创建。' };
    }
    const member = this.service.store.get('members', run.memberId);
    if (!member) return { issue: '运行关联的成员记录不存在；未派发，请取消后重新创建。' };
    const room = business ? null : this.service.store.get('rooms', run.roomId);
    if (!business && !room) return { issue: '运行关联的频道记录不存在；未派发，请取消后重新创建。' };
    return { member, room };
  }
  blockDispatch(run, reason) {
    if (run.dispatchCheck?.status === 'blocked') return;
    // A malformed queued record still reserves its member configuration until
    // explicitly cancelled. Do not silently migrate its CLI or invent scope.
    this.service.store.transaction(() => {
      this.service.store.update('runs', run.id, { error: reason, summary: reason,
        dispatchCheck: { status: 'blocked', code: 'invalid_run_context', reason, checkedAt: now(), evidenceType: 'machine' } });
      this.service.emitChange('dispatch.blocked', { id: run.id, reason });
    });
  }
  pump() {
    const service = this.service;
    if (this.pumping || service.closing || service.settings().paused) return;
    this.pumping = true;
    try {
      service.business?.admit();
      const busy = new Set([...service.active.values()].map(entry => entry.memberId));
      // A lost owner does not free a physical execution slot. Keep unresolved
      // process trees in the shared capacity count, including for legacy work.
      const quarantinedRuns = new Set(service.store.list('businessQuarantines')
        .filter(record => !record.resolvedAt && !service.active.has(record.runId)).map(record => record.runId));
      for (const candidate of service.store.list('runs').filter(run => run.status === 'queued')) {
        if (service.active.size + quarantinedRuns.size >= service.settings().maxParallel) break;
        if (candidate.dispatchCheck?.status === 'blocked') continue;
        if (busy.has(candidate.memberId) || service.business?.memberQuarantined(candidate.memberId)) continue;
        const business = candidate.workflowKind === 'business';
        const { member, room, issue } = this.runContext(candidate);
        if (issue) { this.blockDispatch(candidate, issue); continue; }
        const policy = business ? service.business.policy(candidate, member) : runPolicy(candidate, member, room);
        if (!policy) continue;
        const { resource, writer } = policy;
        if ([...service.active.values()].some(entry => entry.resource === resource && (writer || entry.writer))) continue;
        if (business && !service.business.claim(candidate)) continue;
        const run = service.require('runs', candidate.id);
        const controller = new AbortController();
        const entry = { memberId: run.memberId, controller, resource, writer, promise: null };
        service.active.set(run.id, entry);
        busy.add(run.memberId);
        entry.promise = Promise.resolve().then(() => business
          ? service.business.execute(run, controller.signal) : service.execute(run, controller.signal))
          .catch(error => {
            if (service.closing) return;
            if (business) { service.business.executionFailed(run, error); return; }
            const current = service.require('runs', run.id);
            if (!terminal.has(current.status)) service.store.update('runs', run.id, {
              status: 'failed', error: redact(error.message), finishedAt: now(),
            });
            if (run.taskId) service.blockTask(run.taskId, error.message);
            else if (run.meetingId) service.advanceMeeting(service.require('runs', run.id));
            else service.notice('blocked', error.message, { runId: run.id, roomId: run.roomId });
            service.emitChange(terminal.has(current.status) ? 'dispatch.failed' : 'run.failed', { id: run.id });
          }).finally(() => {
            if (business) service.business.settled(run.id);
            service.active.delete(run.id);
            if (!service.closing) service.emitChange('run.settled', { id: run.id, taskId: run.taskId,
              projectId: run.projectId, roomId: run.roomId });
            service.kick();
          });
      }
    } finally { this.pumping = false; }
  }
}
