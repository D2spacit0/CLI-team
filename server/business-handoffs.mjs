import { createHash } from 'node:crypto';
import { now } from './store.mjs';
import { redact } from './safety.mjs';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = message => { throw Object.assign(new Error(message), { status: 409 }); };
const bounded = value => redact(String(value || '')).slice(0, 6000);

/** An execution terminal is deliberately not a business terminal. */
export function workIsClosed(work) {
  return Boolean(work && ['verified', 'cancelled'].includes(work.handoffStatus));
}

export class BusinessHandoffs {
  constructor(business) { this.business = business; this.store = business.store; }

  contract(input, project) {
    const independent = project.memberIds.filter(memberId => memberId !== input.memberId);
    const receiverId = input.receiverId || (input.kind === 'integrate' ? project.reviewerId :
      independent.includes(project.ownerId) ? project.ownerId : independent.includes(project.reviewerId) ? project.reviewerId : independent[0]) || null;
    if (receiverId && !project.memberIds.includes(receiverId)) failure('收件人必须属于项目团队');
    if (!['accept', 'review'].includes(input.kind) && receiverId === input.memberId) failure('交付成员不能独自验收自己的成果');
    const dueAt = input.dueAt || new Date(Date.now() + 60 * 60 * 1000).toISOString();
    if (!Number.isFinite(Date.parse(dueAt))) failure('交付承诺时间无效');
    const acceptanceCriteria = input.acceptanceCriteria?.length ? input.acceptanceCriteria.map(bounded).slice(0, 8) : [
      bounded(input.objective), input.output?.type === 'files' ? '逐项核对约定文件、实际内容和交付位置。' : '答复覆盖约定目标，有依据的事实与成员判断分开。',
    ];
    return { receiverId, checkerId: project.ownerId, acceptanceCriteria, originalDueAt: dueAt, dueAt, handoffStatus: 'assigned' };
  }

  append(work, type, fields = {}) {
    const eventId = `handoff-${fingerprint([work.id, work.generation, type, fields.key || fields.runId || fields.receiptId || fields.message || ''])}`;
    const existing = this.store.get('workHandoffs', eventId);
    if (existing) return existing;
    const { key: _key, ...details } = fields;
    const event = this.store.put('workHandoffs', { id: eventId, projectId: work.projectId, workItemId: work.id,
      generation: work.generation, type, actorId: 'service', recipientId: work.receiverId, evidenceType: 'machine',
      createdAt: now(), ...details, message: bounded(details.message) });
    this.business.emit('business.handoff', { projectId: work.projectId, workItemId: work.id, eventId, type });
    return event;
  }

  assigned(work) {
    this.append(work, 'assigned', { actorId: work.checkerId, message: `已登记交付责任与完成条件：${work.title}`,
      dueAt: work.dueAt, acceptanceCriteria: work.acceptanceCriteria });
  }

  rebind(work, project) {
    const receiverValid = project.memberIds.includes(work.receiverId) && work.receiverId !== work.memberId &&
      (work.kind !== 'integrate' || work.receiverId === project.reviewerId);
    const receiverId = receiverValid ? work.receiverId : this.contract({ ...work, receiverId: null }, project).receiverId;
    if (receiverId === work.receiverId && work.checkerId === project.ownerId) return work;
    const updated = this.store.update('workItems', work.id, { receiverId, checkerId: project.ownerId });
    this.append(updated, 'responsibility_changed', { previousReceiverId: work.receiverId, previousCheckerId: work.checkerId,
      message: '项目团队已调整，按当前授权重新登记收件和跟进责任；原交付承诺保留。' });
    return updated;
  }

  accepted(work, run) {
    this.store.update('workItems', work.id, { handoffStatus: 'accepted' });
    this.append(work, 'accepted', { runId: run.id, actorId: run.memberId, evidenceType: 'execution_admission',
      message: '本机已接纳本次成员工作；实际运行与成果收取分别记录。' });
  }

  receive(work, run, collected, resultDigest, versionId = null) {
    const receiptId = `receipt-${run.attemptId}`;
    const receipt = { id: receiptId, projectId: work.projectId, workItemId: work.id, generation: work.generation,
      attemptId: run.attemptId, runId: run.id, receiverId: work.receiverId, createdAt: now(), inputDigest: run.inputDigest,
      resultDigest, manifestHash: collected.manifestHash, versionId, summary: bounded(run.report?.summary),
      files: collected.files.map(file => ({ relativePath: file.relativePath, sha256: file.sha256, size: file.size, mime: file.mime })),
      checks: ['input_integrity', work.output.type === 'files' ? 'declared_files' : 'required_sections'], evidenceType: 'machine' };
    const previous = this.store.get('workReceipts', receiptId);
    if (previous && previous.resultDigest !== resultDigest) failure('同一次交付不能改写已收取的成果');
    if (!previous) this.store.put('workReceipts', receipt);
    const updated = this.store.update('workItems', work.id, { handoffStatus: 'received', currentReceiptId: receiptId });
    this.append(updated, 'received', { runId: run.id, receiptId, resultDigest, message: '成果已在约定位置实际收取，等待接收方核验。' });
    return previous || receipt;
  }

  canReceive(work, dependency) {
    if (!dependency || dependency.status !== 'succeeded') return false;
    if (dependency.handoffStatus === 'verified') return true;
    if (dependency.handoffStatus !== 'received' || !['accept', 'review'].includes(work.kind)) return false;
    return work.acceptanceFor?.workItemId === dependency.id && work.acceptanceFor.generation === dependency.generation &&
      work.acceptanceFor.receiptId === dependency.currentReceiptId && work.memberId === dependency.receiverId;
  }

  acceptanceTarget(work) {
    const binding = work.acceptanceFor;
    if (!binding) failure('验收任务缺少固定交付身份');
    const target = this.store.get('workItems', binding.workItemId);
    const receipt = this.store.get('workReceipts', binding.receiptId);
    if (!target || !receipt || target.projectId !== work.projectId || receipt.projectId !== work.projectId ||
        target.generation !== binding.generation || target.currentReceiptId !== receipt.id || target.resultDigest !== binding.resultDigest ||
        receipt.resultDigest !== binding.resultDigest || target.receiverId !== work.memberId ||
        !['received', 'verified'].includes(target.handoffStatus)) failure('验收所引用的交付已失效，请核对当前版本');
    return { target, receipt };
  }

  ensureAcceptance(work) {
    if (work.handoffStatus !== 'received' || ['accept', 'review'].includes(work.kind) || work.resolutionFor) return;
    const project = this.business.projects.get(work.projectId);
    if (project.status !== 'active') return;
    const receipt = this.store.get('workReceipts', work.currentReceiptId);
    if (!receipt) { this.block(work, '缺少固定收件记录，不能验收'); return; }
    if (!work.receiverId || work.receiverId === work.memberId || !project.memberIds.includes(work.receiverId)) {
      this.block(work, '需要一位独立收件成员核验成果'); return;
    }
    const binding = { workItemId: work.id, generation: work.generation, receiptId: receipt.id, resultDigest: receipt.resultDigest };
    const existing = this.business.works(work.projectId).find(item => item.acceptanceFor?.receiptId === receipt.id &&
      !['cancelled', 'superseded'].includes(item.status));
    if (existing) return existing;
    if (work.kind === 'integrate') {
      const review = this.business.works(work.projectId).find(item => item.kind === 'review' && item.contentId === work.contentId &&
        item.dependencies.includes(work.id) && item.memberId === work.receiverId && !workIsClosed(item));
      if (review) return this.store.update('workItems', review.id, { acceptanceFor: binding });
    }
    const kind = work.kind === 'integrate' ? 'review' : 'accept';
    return this.business.createWork({ projectId: work.projectId, cycleId: work.cycleId, contentId: work.contentId,
      memberId: work.receiverId, kind, title: `核收：${work.title}`,
      objective: `逐条核对这一次已实际收取的交付。来源工作：${work.id}；原目标：${work.objective}。核查约定要求和真实材料，给出 approve 或 changes_requested 及具体依据。`,
      output: { type: 'analysis', sections: ['summary'] }, dependencies: [work.id],
      inputRefs: [{ kind: 'work', id: work.id, revision: work.generation, digest: receipt.resultDigest }],
      acceptanceCriteria: ['核对固定收件及完成条件，逐条说明问题或通过依据。'], acceptanceFor: binding });
  }

  verified(work, run, { machineOnly = false } = {}) {
    const current = this.store.get('workItems', work.id);
    const receipt = this.store.get('workReceipts', current.currentReceiptId);
    if (!receipt || current.generation !== work.generation) failure('核验结果缺少当前收件记录');
    if (current.handoffStatus === 'verified') return current;
    const updated = this.store.update('workItems', work.id, { handoffStatus: 'verified', verifiedAt: now(),
      verifiedBy: run.memberId, verificationRunId: run.id, waitReason: null });
    this.append(updated, 'verified', { runId: run.id, actorId: run.memberId, receiptId: receipt.id, resultDigest: receipt.resultDigest,
      evidenceType: machineOnly ? 'machine_contract' : 'agent_review', message: bounded(run.report?.summary), findings: run.report?.findings || [] });
    const sourceRun = this.store.get('runs', receipt.runId);
    if (sourceRun) this.business.collaboration.complete(sourceRun);
    this.business.kick();
    return updated;
  }

  finish(work, run) {
    if (['accept', 'review'].includes(work.kind)) {
      if (!['approve', 'changes_requested'].includes(run.report?.verdict)) failure('接收方必须给出通过或退回结论');
      if (run.report.verdict === 'approve' && run.report.findings?.some(finding => ['critical', 'major'].includes(finding.severity))) {
        failure('仍有重大问题的验收不能声明通过');
      }
    }
    if (work.kind === 'accept' || work.kind === 'review' && work.acceptanceFor) {
      const { target } = this.acceptanceTarget(work);
      if (work.kind === 'review' && run.report.verdict === 'approve') {
        const eligibility = this.store.get('contentEligibilities', work.contentId);
        if (eligibility?.valid !== true || eligibility.versionId !== target.versionId) failure('整稿的程序检查和独立审稿尚未共同通过');
      }
      this.verified(work, run, { machineOnly: true });
      if (run.report.verdict === 'approve') this.verified(target, run);
      else this.business.rework(target.id, run.report.summary, { sourceRunId: run.id });
      return;
    }
    // A review decision or an applied owner action is itself the contracted output;
    // it must not cause an infinite chain of reviews of reviews.
    if (work.kind === 'review' || work.resolutionFor) {
      this.verified(work, run, { machineOnly: true });
      if (work.kind === 'review' && run.report.verdict === 'changes_requested') {
        const author = this.business.works(work.projectId).find(item => item.kind === 'integrate' && item.contentId === work.contentId);
        if (author) this.business.rework(author.id, run.report.summary, { sourceRunId: run.id });
      }
    }
    else this.ensureAcceptance(this.store.get('workItems', work.id));
  }

  returned(work, reason, sourceRunId = null) {
    this.append(work, 'returned', { runId: sourceRunId, message: reason, receiptId: work.currentReceiptId,
      resultDigest: work.resultDigest, evidenceType: sourceRunId ? 'agent_review' : 'user_instruction' });
  }

  block(work, reason, { escalate = true, sourceRunId = null } = {}) {
    const current = this.store.update('workItems', work.id, { handoffStatus: 'blocked', waitReason: bounded(reason) });
    this.append(current, 'blocked', { runId: sourceRunId, message: reason });
    if (escalate) this.ensureDecision(current, reason);
  }

  ensureDecision(work, reason) {
    const project = this.business.projects.get(work.projectId);
    if (work.resolutionFor || project.status !== 'active' || !project.ownerId || !project.memberIds.includes(project.ownerId) || work.quarantined) {
      this.business.attention(work.projectId, reason); return null;
    }
    const existing = this.business.works(work.projectId).find(item => item.resolutionFor?.workItemId === work.id &&
      item.resolutionFor.generation === work.generation && item.resolutionFor.dueAt === work.dueAt);
    if (existing) return existing;
    const decision = this.business.createWork({ projectId: work.projectId, cycleId: work.cycleId, contentId: work.contentId,
      memberId: project.ownerId, kind: 'coordinate', title: `处理阻碍：${work.title}`,
      objective: `处理未完工作 ${work.id} 的阻碍：${bounded(reason)}。必须用 resolve_work 明确重试、改期或取消，不得只汇报问题。保留原承诺与已用次数，不扩大项目范围。`,
      output: { type: 'analysis', sections: ['summary'] }, inputRefs: [{ kind: 'project', id: project.id, revision: project.briefVersion }],
      resolutionFor: { workItemId: work.id, generation: work.generation, dueAt: work.dueAt, reason: bounded(reason) }, priority: 1 });
    this.append(work, 'escalated', { actorId: 'service', recipientId: project.ownerId, key: decision.id,
      message: '已把未完工作交给负责人处理。', decisionWorkItemId: decision.id });
    return decision;
  }

  checkPending(at = Date.now()) {
    for (const work of this.business.works()) {
      if (workIsClosed(work) || this.business.projects.get(work.projectId).status !== 'active') continue;
      if (work.resolutionFor) {
        const target = this.store.get('workItems', work.resolutionFor.workItemId);
        if (target && (workIsClosed(target) || target.generation !== work.resolutionFor.generation || target.dueAt !== work.resolutionFor.dueAt)) {
          this.business.stopWorkRuns(work, '所处理的工作已经改变，旧协调任务结束');
          const closed = this.store.update('workItems', work.id, { status: 'cancelled', handoffStatus: 'cancelled', generation: work.generation + 1 });
          this.append(closed, 'cancelled', { message: '所处理的工作已经改变，旧协调任务结束。' });
          continue;
        }
      }
      if (work.handoffStatus === 'received') this.ensureAcceptance(work);
      if (Date.parse(work.dueAt) > at || !Number.isFinite(Date.parse(work.dueAt))) continue;
      this.append(work, 'overdue', { key: work.dueAt, message: '原定交付时间已到，工作仍未验收。', dueAt: work.dueAt });
      this.ensureDecision(work, '工作超过约定交付时间，核查进度并作出处理');
    }
  }

  defer(work, dueAt, reason, run) {
    const next = Date.parse(dueAt);
    if (!Number.isFinite(next) || next <= Date.now() || next > Date.now() + 7 * 86400000) failure('新交付时间应在未来七天以内');
    this.store.update('workItems', work.id, { dueAt: new Date(next).toISOString(), waitReason: bounded(reason) });
    this.append(work, 'rescheduled', { key: run.id, runId: run.id, actorId: run.memberId, previousDueAt: work.dueAt,
      originalDueAt: work.originalDueAt, dueAt: new Date(next).toISOString(), message: reason, evidenceType: 'owner_decision' });
  }

  recover() {
    for (const work of this.business.works().filter(item => !item.handoffStatus)) {
      const project = this.store.get('projects', work.projectId);
      if (!project) continue;
      const terminal = ['cancelled', 'superseded'].includes(work.status);
      const handoffStatus = terminal ? 'cancelled' : work.status === 'succeeded' ? 'blocked' : 'assigned';
      const updated = this.store.update('workItems', work.id, { ...this.contract(work, project), handoffStatus });
      this.append(updated, terminal ? 'cancelled' : 'assigned', { message: '已保留原工作和成果，补登记交接责任。' });
      if (work.status === 'succeeded') this.block(updated, '旧业务记录没有独立收件验收凭据，需要负责人安排核收');
    }
  }
}
