import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, now } from './store.mjs';
import { BusinessStore } from './business-store.mjs';
import { ProjectService, projectDay } from './projects.mjs';
import { ContentRevisionService } from './content-revisions.mjs';
import { BusinessScheduler } from './business-scheduler.mjs';
import { BusinessCollaboration } from './business-collaboration.mjs';
import { stepOutputSchema } from './adapters.mjs';
import { redact } from './safety.mjs';
import { materialName } from './materials.mjs';
import { readResearchSource } from './business-research.mjs';
import { BusinessHandoffs, workIsClosed } from './business-handoffs.mjs';
import { skillCatalog } from './business-skills.mjs';

export const workTerminal = new Set(['succeeded', 'failed', 'cancelled', 'superseded']);
export const failBusiness = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const refKind = kind => ({ projects: 'project', projectFacts: 'fact', workItems: 'work', contentRevisions: 'content',
  contentRevision: 'content', projectMaterials: 'material' })[kind] || kind;
const bounded = value => redact(String(value || '')).slice(0, 12000);

export class BusinessWork {
  constructor(service, { contentRenderer } = {}) {
    this.service = service; this.store = service.store; this.renderer = contentRenderer;
    this.durable = new BusinessStore(this.store);
    this.contents = new ContentRevisionService({ store: this.store, dataDir: service.dataDir, emit: (...args) => service.emitChange(...args) });
    this.projects = new ProjectService({ store: this.store, dataDir: service.dataDir, emit: (...args) => service.emitChange(...args),
      onInvalidate: input => this.invalidate(input) });
    this.handoffs = new BusinessHandoffs(this);
    this.collaboration = new BusinessCollaboration(this);
    this.scheduler = new BusinessScheduler(this);
    this.timer = null;
  }
  require(kind, entityId) { return this.service.require(kind, entityId); }
  emit(type, payload) { this.service.emitChange(type, payload); }
  works(projectId) { return this.store.list('workItems').filter(work => !projectId || work.projectId === projectId); }
  kick() { this.service.kick(); }
  start() {
    this.timer = setInterval(() => this.tick(), 15000);
    this.timer.unref();
    this.tick();
  }
  tick() {
    if (this.service.closing) return;
    if (!this.service.settings().paused) {
      for (const project of this.projects.list().filter(item => item.status === 'active')) {
        try { this.ensureCycle(project.id); }
        catch (error) { this.attention(project.id, error.message); }
      }
      this.handoffs.checkPending();
      this.kick();
      void this.service.publications?.tick().catch(error => this.emit('publication.error', { message: bounded(error.message) }));
    }
  }
  async close() { clearInterval(this.timer); await this.scheduler.close(); }
  createProject(input) {
    return this.store.transaction(() => {
      const project = this.projects.create(input);
      if (project.status === 'active') this.ensureCycle(project.id);
      this.kick();
      return this.projects.get(project.id);
    });
  }
  updateProject(projectId, input) {
    return this.store.transaction(() => {
      const result = this.projects.update(projectId, input);
      if (['paused', 'archived'].includes(result.status)) this.stopProjectRuns(projectId, '项目已经暂停', false);
      this.kick(); return result;
    });
  }
  ensureCycle(projectId) {
    const project = this.projects.get(projectId);
    if (project.status !== 'active') return null;
    const cycle = this.projects.startCycle(projectId);
    if (!cycle || cycle.status !== 'active' || this.works(projectId).some(work => work.cycleId === cycle.id)) return cycle;
    const capacity = this.durable.budgetUsage(projectId, projectDay(project.timeZone));
    if (capacity.contentSlots >= project.limits.maxPending) {
      if (project.waitReason !== '待批准及未决稿件已达到上限') this.store.update('projects', projectId, { waitReason: '待批准及未决稿件已达到上限' });
      return cycle;
    }
    return this.store.transaction(() => {
      const content = this.contents.createItem(projectId, { cycleId: cycle.id, title: '团队正在规划图文', requestId: `cycle:${cycle.id}` });
      this.createWork({ projectId, cycleId: cycle.id, contentId: content.id, memberId: project.ownerId, kind: 'plan',
        title: '安排本轮图文生产', objective: `根据长期目标和当前资料安排本轮一篇图文。明确读者、选题、来源缺口及成员分工。给出可执行的有向无环工作计划，包含文案、视觉、整合和独立审稿。${project.objective}`,
        output: { type: 'analysis', sections: ['summary'] } });
      this.store.update('projects', projectId, { waitReason: null, currentCycleId: cycle.id });
      return cycle;
    });
  }
  createWork(input) {
    const project = this.projects.get(input.projectId);
    if (!project.memberIds.includes(input.memberId)) failBusiness('工作责任人不在项目授权成员中', 403);
    const member = this.require('members', input.memberId);
    if (member.provider === 'controller') failBusiness('不能把内部工作派给主控会话', 403);
    const output = stepOutputSchema.parse(input.output || { type: 'analysis', sections: ['summary'] });
    if (output.type === 'files' && member.permission !== 'edit') failBusiness('文件工作需要具备编辑权限的成员');
    if (input.kind === 'review' && input.memberId !== project.reviewerId) failBusiness('审稿工作必须由项目独立审稿成员承担');
    if (input.kind !== 'review' && ['copy', 'visual', 'integrate'].includes(input.kind) && input.memberId === project.reviewerId) {
      failBusiness('独立审稿成员不能同时制作这篇稿件');
    }
    if (input.contentId && this.require('contentItems', input.contentId).projectId !== project.id) failBusiness('稿件不属于当前项目');
    const dependencies = [...new Set(input.dependencies || [])];
    for (const dependency of dependencies) if (this.require('workItems', dependency).projectId !== project.id) failBusiness('不能依赖其他项目的工作');
    const facts = this.store.list('projectFacts').filter(fact => fact.projectId === project.id && fact.status === 'adopted').slice(-8);
    const inputRefs = input.inputRefs || [{ kind: 'project', id: project.id, revision: project.briefVersion },
      ...facts.map(fact => ({ kind: 'fact', id: fact.id, revision: fact.revision }))];
    this.validateRefs(project.id, inputRefs);
    const workId = input.id || id('work');
    const contract = this.handoffs.contract({ ...input, output }, project);
    const work = { id: workId, projectId: project.id, cycleId: input.cycleId || null, contentId: input.contentId || null,
      memberId: member.id, role: input.kind === 'review' ? 'reviewer' : input.kind === 'plan' || input.kind === 'coordinate' ? 'owner' : member.role,
      kind: input.kind || 'analysis', title: String(input.title).slice(0, 120), objective: bounded(input.objective),
      output, dependencies, inputRefs, priority: input.priority ?? 5, generation: 1,
      attemptCount: input.carriedAttemptCount || 0, currentAttemptId: null,
      status: dependencies.length ? 'waiting_dependencies' : 'ready', waitReason: null,
      ...contract, acceptanceFor: input.acceptanceFor || null, resolutionFor: input.resolutionFor || null,
      originalDueAt: input.originalDueAt || contract.originalDueAt, replacesWorkItemId: input.replacesWorkItemId || null,
      rootChainId: input.rootChainId || workId, consultation: input.consultation || null, threadId: input.threadId || null,
      dispatchedBy: input.dispatchedBy || null,
      feedback: input.feedback || null, createdAt: now(), updatedAt: now() };
    this.store.put('workItems', work);
    this.collaboration.assertAcyclic(project.id);
    this.handoffs.assigned(work);
    this.emit('business.work_created', { projectId: project.id, workItemId: work.id });
    this.kick();
    return work;
  }
  validateRefs(projectId, refs) {
    if (!Array.isArray(refs) || refs.length > 30) failBusiness('工作输入引用超出上限');
    for (const ref of refs) {
      const kind = refKind(ref.kind);
      const collection = { project: 'projects', fact: 'projectFacts', work: 'workItems', content: 'contentRevisions', material: 'projectMaterials' }[kind];
      if (!collection) failBusiness('不支持的业务输入引用');
      const record = this.require(collection, ref.id);
      if ((kind === 'project' ? record.id : record.projectId) !== projectId) failBusiness('输入引用不属于当前项目');
      const revision = kind === 'project' ? record.briefVersion : kind === 'work' ? record.generation : record.revision;
      const hash = kind === 'work' ? record.resultDigest : record.manifestHash || record.sha256;
      if (ref.revision !== undefined && revision !== undefined && String(revision) !== String(ref.revision) ||
          ref.generation !== undefined && ref.generation !== record.generation || ref.digest && hash !== ref.digest ||
          ['superseded', 'invalid', 'revoked', 'deleted'].includes(record.status)) {
        failBusiness('工作引用的输入版本已经失效');
      }
      if (kind === 'fact' && record.status !== 'adopted') failBusiness('未采纳的成员判断不能作为项目事实输入');
    }
  }
  readyDependencies(work) {
    return work.dependencies.every(key => this.handoffs.canReceive(work, this.store.get('workItems', key)));
  }
  refreshReady() {
    this.handoffs.checkPending();
    for (const work of this.works()) {
      if (work.status !== 'waiting_dependencies' && !(work.status === 'blocked' && work.waitKind === 'dependency')) continue;
      const failed = work.dependencies.map(key => this.store.get('workItems', key)).find(dep => !dep || ['failed', 'cancelled', 'superseded'].includes(dep.status));
      if (failed || work.dependencies.some(key => !this.store.get('workItems', key))) {
        if (work.status !== 'blocked') {
          this.store.update('workItems', work.id, { status: 'blocked', waitKind: 'dependency', waitReason: `等待负责人处理上游工作：${failed?.title || '依赖记录缺失'}` });
          this.handoffs.block(work, `等待上游工作处理：${failed?.title || '依赖记录缺失'}`, { escalate: false });
          this.emit('business.dependency_ended', { projectId: work.projectId, workItemId: work.id });
        }
      } else if (this.readyDependencies(work)) this.store.update('workItems', work.id, { status: 'ready', waitKind: null, waitReason: null });
    }
  }
  attention(projectId, reason) {
    const previous = this.projects.get(projectId);
    if (previous.waitReason !== reason) {
      this.store.update('projects', projectId, { waitReason: bounded(reason) });
      this.emit('business.attention', { projectId, reason: bounded(reason) });
    }
  }
  pauseProject(projectId) {
    return this.store.transaction(() => {
      const project = this.projects.get(projectId);
      const next = this.projects.update(projectId, { expectedRevision: project.revision, status: 'paused' });
      this.stopProjectRuns(projectId, '项目已暂停，确认成员停止后可继续', false);
      return next;
    });
  }
  resumeProject(projectId) {
    return this.store.transaction(() => {
      const project = this.projects.get(projectId);
      const next = this.projects.update(projectId, { expectedRevision: project.revision, status: 'active' });
      for (const work of this.works(projectId).filter(item => item.status === 'interrupted')) {
        if (this.service.active.has(work.runId) || this.memberQuarantined(work.memberId)) {
          this.store.update('workItems', work.id, { resumeRequested: true, waitReason: '已请求继续，等待旧进程树确认退出' });
        } else this.resumeInterrupted(work);
      }
      this.ensureCycle(projectId); this.kick(); return next;
    });
  }
  resumeInterrupted(work) {
    const project = this.projects.get(work.projectId);
    if (project.status !== 'active' || work.status !== 'interrupted' || work.quarantined || this.memberQuarantined(work.memberId)) return work;
    const exhausted = work.attemptCount >= project.limits.maxAttempts;
    const updated = this.store.update('workItems', work.id, { status: exhausted ? 'failed' : 'waiting_dependencies',
      handoffStatus: exhausted ? 'blocked' : 'assigned', resumeRequested: false, currentAttemptId: null,
      waitReason: exhausted ? '工作已达到尝试上限' : null });
    if (exhausted) this.handoffs.block(updated, '工作已达到尝试上限，负责人需要处理');
    else this.handoffs.append(updated, 'recovered', { message: '项目已继续且旧进程已退出，等待重新核对依赖后接手。' });
    return updated;
  }
  stopProjectRuns(projectId, reason, cancel = false) {
    for (const work of this.works(projectId).filter(item => !workTerminal.has(item.status))) {
      const current = this.store.update('workItems', work.id, { generation: work.generation + 1,
        status: cancel ? 'cancelled' : 'interrupted', handoffStatus: cancel ? 'cancelled' : 'blocked', resumeRequested: false, waitReason: reason });
      this.handoffs.append(current, cancel ? 'cancelled' : 'interrupted', { message: reason });
      this.stopWorkRuns(current, reason);
    }
  }
  stopWorkRuns(work, reason) {
    this.durable.cancelJobs({ workItemId: work.id, reason });
    for (const run of this.store.list('runs').filter(item => item.workflowKind === 'business' && item.workItemId === work.id && ['queued', 'running'].includes(item.status))) {
      this.store.update('runs', run.id, { status: 'cancelled', error: reason, finishedAt: now() });
      this.store.afterCommit(() => this.service.active.get(run.id)?.controller.abort());
    }
    this.collaboration.terminateWaiters(work, reason);
  }
  invalidate({ projectId, refs = [], replacementRefs = [], allContent = false, reason = '上游输入已经变化' }) {
    return this.store.transaction(() => {
      const related = new Set(this.works(projectId).filter(work => work.handoffStatus !== 'cancelled' && (allContent ||
        refs.some(ref => refKind(ref.kind) === 'work' && ref.id === work.id && (ref.revision === undefined || String(ref.revision) === String(work.generation))) || work.inputRefs.some(input =>
        refs.some(ref => refKind(ref.kind) === refKind(input.kind) && ref.id === input.id &&
          (ref.revision === undefined || String(ref.revision) === String(input.revision)))))).map(work => work.id));
      let changed = true;
      while (changed) {
        changed = false;
        for (const work of this.works(projectId)) if (work.handoffStatus !== 'cancelled' && !related.has(work.id) &&
          (work.dependencies.some(key => related.has(key)) || related.has(work.consultation?.sourceWorkItemId))) {
          related.add(work.id); changed = true;
        }
      }
      const contentIds = new Set();
      const project = this.projects.get(projectId);
      // Replanning replaces its previously dispatched graph. Retaining both
      // generations would release duplicate writers after the new plan passes.
      const replanned = new Set(this.works(projectId).filter(work => related.has(work.id) && (work.kind === 'plan' ||
        work.report?.business?.actions?.some(action => action.type === 'propose_work'))).map(work => work.id));
      const retired = new Set();
      let retireMore = true;
      while (retireMore) {
        retireMore = false;
        for (const work of this.works(projectId)) if (related.has(work.id) && !retired.has(work.id) &&
          (replanned.has(work.dispatchedBy?.workItemId) || work.dependencies.some(key => replanned.has(key) || retired.has(key)))) {
          retired.add(work.id); retireMore = true;
        }
      }
      for (const work of this.works(projectId).filter(item => related.has(item.id))) {
        if (work.contentId) contentIds.add(work.contentId);
        this.handoffs.returned(work, reason);
        const inputRefs = work.inputRefs.map(input => {
          const replacement = replacementRefs.find(item => refKind(item.from.kind) === refKind(input.kind) && item.from.id === input.id);
          return replacement ? replacement.to : input;
        }).filter(input => !(refKind(input.kind) === 'work' && related.has(input.id)) && refKind(input.kind) !== 'content');
        const acceptance = work.kind === 'accept', staleConsultation = related.has(work.consultation?.sourceWorkItemId);
        const cancelled = acceptance || retired.has(work.id) || staleConsultation;
        const next = this.store.update('workItems', work.id, { generation: work.generation + 1,
          status: cancelled ? 'cancelled' : project.status === 'active' ? 'waiting_dependencies' : 'interrupted',
          handoffStatus: cancelled ? 'cancelled' : 'returned', currentReceiptId: null, acceptanceFor: null, resumeRequested: false,
          cancellationKind: retired.has(work.id) ? 'replanned' : acceptance ? 'obsolete_acceptance' : staleConsultation ? 'obsolete_consultation' : null,
          waitKind: null, waitReason: reason, resultDigest: null, outputDigest: null, outputFiles: [], currentAttemptId: null,
          waitingOn: [], blockedByWorkItemId: null, answers: [], toolResults: [], inputRefs });
        if (!cancelled) this.handoffs.rebind(next, project);
        this.stopWorkRuns(next, reason);
        if (cancelled) this.handoffs.append(next, 'cancelled', { message: acceptance ? '原交付已改变，旧验收任务结束。' :
          staleConsultation ? '原提问工作已改变，旧咨询结束。' : '派工计划已改变，旧分工结束；新计划通过后重新派发。' });
        if (work.cycleId) {
          const cycle = this.store.get('productionCycles', work.cycleId);
          if (cycle?.status === 'complete') this.store.update('productionCycles', cycle.id, { status: 'revising', finishedAt: null });
        }
      }
      if (allContent) for (const content of this.store.list('contentItems').filter(item => item.projectId === projectId)) contentIds.add(content.id);
      for (const contentId of contentIds) this.contents.invalidateContent(contentId, reason);
      if (!contentIds.size && refs.length) this.contents.invalidateDependencies({ projectId, refs, reason });
      this.emit('business.inputs_invalidated', { projectId, workItemIds: [...related], contentIds: [...contentIds], reason });
      this.kick();
      return [...related];
    });
  }
  rework(workItemId, reason, { sourceRunId = null, threadId = null } = {}) {
    return this.store.transaction(() => {
      const target = this.require('workItems', workItemId), project = this.projects.get(target.projectId);
      if (target.attemptCount >= project.limits.maxAttempts) {
        this.invalidate({ projectId: target.projectId, refs: [{ kind: 'work', id: target.id, revision: target.generation }], reason });
        const current = this.store.update('workItems', target.id, { status: 'failed', waitReason: '该工作已达到尝试上限' });
        this.handoffs.block(current, '该工作已达到尝试上限，负责人需要调整计划', { sourceRunId });
        return this.require('workItems', target.id);
      }
      this.handoffs.returned(target, reason, sourceRunId);
      const ids = this.invalidate({ projectId: target.projectId, refs: [{ kind: 'work', id: target.id, revision: target.generation }], reason });
      if (!ids.includes(target.id)) {
        this.store.update('workItems', target.id, { generation: target.generation + 1 });
        this.stopWorkRuns(target, reason);
        if (target.contentId) this.contents.invalidateContent(target.contentId, reason);
      }
      const current = this.require('workItems', target.id);
      if (current.cancellationKind === 'obsolete_consultation') return current;
      this.store.update('workItems', target.id, { status: 'waiting_dependencies', currentAttemptId: null,
        handoffStatus: 'returned', currentReceiptId: null,
        feedback: bounded(reason), feedbackSourceRunId: sourceRunId, threadId: threadId || target.threadId, waitReason: null,
        inputRefs: current.inputRefs.filter(ref => refKind(ref.kind) !== 'work') });
      if (target.kind === 'consult') this.collaboration.resumeConsultation(this.require('workItems', target.id));
      for (const dependentId of ids.filter(item => item !== target.id)) {
        const dependent = this.require('workItems', dependentId);
        if (dependent.kind === 'accept' || dependent.handoffStatus === 'cancelled') continue;
        this.store.update('workItems', dependentId, { status: 'waiting_dependencies', currentAttemptId: null,
          inputRefs: dependent.inputRefs.filter(ref => refKind(ref.kind) !== 'work'), waitReason: null });
      }
      this.kick(); return this.require('workItems', target.id);
    });
  }
  resolveWork(run, action) {
    const project = this.projects.get(run.projectId), work = this.require('workItems', action.workItemId);
    if (run.memberId !== project.ownerId || work.projectId !== project.id) failBusiness('只有项目负责人可以处理这项未完工作', 403);
    const source = this.require('workItems', run.workItemId);
    if (source.resolutionFor && (source.resolutionFor.workItemId !== work.id || source.resolutionFor.generation !== work.generation ||
      source.resolutionFor.dueAt !== work.dueAt)) failBusiness('协调任务所绑定的工作或交付承诺已经变化，旧处理意见无效');
    if (work.generation !== action.generation || workIsClosed(work)) failBusiness('处理意见引用了已改变或已关闭的工作');
    if (work.quarantined || this.memberQuarantined(work.memberId)) failBusiness('旧进程尚未确认退出，不能重新派发或取消其运行事实');
    if (action.decision === 'retry') {
      if (work.attemptCount >= project.limits.maxAttempts) failBusiness('尝试次数已经用完，请改期说明阻碍或明确取消');
      return this.rework(work.id, action.reason, { sourceRunId: run.id });
    }
    if (action.decision === 'defer') {
      this.handoffs.defer(work, action.dueAt, action.reason, run);
      return this.require('workItems', work.id);
    }
    return this.cancelWork(work.id, action.reason, run);
  }
  cancelWork(workItemId, reason, run) {
    const target = this.require('workItems', workItemId);
    const related = new Set([target.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const work of this.works(target.projectId)) if (!related.has(work.id) &&
        (work.dependencies.some(key => related.has(key)) || related.has(work.consultation?.sourceWorkItemId))) {
        related.add(work.id); changed = true;
      }
    }
    for (const work of this.works(target.projectId).filter(item => related.has(item.id) && !workIsClosed(item))) {
      this.stopWorkRuns(work, reason);
      const updated = this.store.update('workItems', work.id, { generation: work.generation + 1, status: 'cancelled', handoffStatus: 'cancelled', waitReason: bounded(reason) });
      this.handoffs.append(updated, 'cancelled', { runId: run?.id, actorId: run?.memberId || 'user',
        message: reason, evidenceType: run ? 'owner_decision' : 'user_instruction' });
    }
    for (const work of this.works(target.projectId).filter(item => item.waitKind === 'consultation' && related.has(item.blockedByWorkItemId) && !workIsClosed(item))) {
      this.handoffs.ensureDecision(work, '咨询工作已取消，需要负责人决定原工作如何继续');
    }
    if (target.contentId) this.contents.invalidateContent(target.contentId, reason);
    this.kick();
    return this.require('workItems', target.id);
  }
  revisionRequest(contentId, input, actor = 'user') {
    const parsed = z.object({ versionId: z.string().min(1), feedback: z.string().trim().min(1).max(6000), requestId: z.string().min(1).max(150) }).strict().parse(input);
    return this.durable.requestOnce(`content.revision:${actor}:${parsed.requestId}`, digest({ contentId, ...parsed }), () => {
      const content = this.require('contentItems', contentId);
      if (content.currentRevisionId !== parsed.versionId && content.currentVersionId !== parsed.versionId && content.currentDraftVersionId !== parsed.versionId) {
        failBusiness('当前稿件版本已改变，请重新查看整稿');
      }
      const author = this.works(content.projectId).filter(work => work.contentId === contentId && work.kind === 'integrate').at(-1);
      if (!author) failBusiness('这份稿件没有可返工的责任工作项');
      const thread = this.collaboration.thread({ projectId: content.projectId, contentId, sourceWorkItemId: author.id,
        question: parsed.feedback, requesterId: actor, recipientId: author.memberId, status: 'delivered', versionId: parsed.versionId, kind: 'revision' });
      this.rework(author.id, parsed.feedback, { threadId: thread.id });
      return { thread, workItemId: author.id };
    });
  }
  tell(projectId, input, actor = 'user') {
    const parsed = z.object({ requestId: z.string().min(1).max(150), body: z.string().trim().min(1).max(12000), recipientId: z.string().max(200).optional() }).strict().parse(input);
    return this.durable.requestOnce(`project.message:${actor}:${parsed.requestId}`, digest({ projectId, ...parsed }), () => {
      const project = this.projects.get(projectId);
      const recipient = parsed.recipientId || project.ownerId;
      if (!project.memberIds.includes(recipient)) failBusiness('消息收件人不在项目成员中');
      const thread = this.collaboration.thread({ projectId, requesterId: actor, recipientId: recipient,
        question: parsed.body, kind: 'message', status: 'pending' });
      const work = this.createWork({ projectId, memberId: recipient, kind: recipient === project.ownerId ? 'coordinate' : 'analysis',
        title: '处理用户交代', objective: parsed.body, threadId: thread.id, output: { type: 'analysis', sections: ['summary'] } });
      this.store.update('collaborationThreads', thread.id, { workItemId: work.id });
      return { thread, work };
    });
  }
  addFact(projectId, input, actor = 'user') {
    const parsed = z.object({ type: z.enum(['fact', 'judgment', 'preference']), content: z.string().trim().min(1).max(10000),
      requestId: z.string().min(1).max(150).optional(),
      source: z.union([z.string().max(2000), z.object({ label: z.string().min(1).max(300), url: z.string().url().max(2000).optional() }).strict()]).optional() }).strict().parse(input);
    const origin = actor === 'user' ? 'user' : 'agent';
    const source = typeof parsed.source === 'object' ? { ...parsed.source, kind: origin } : { label: parsed.source || (actor === 'user' ? '用户提供' : '主控提交，待负责人核对'), kind: origin,
      ...(parsed.source?.startsWith('https://') ? { url: parsed.source } : {}) };
    const create = () => {
      const fact = this.projects.addFact(projectId, { type: parsed.type, content: parsed.content, sources: [source] },
        { proposedBy: actor, adopt: actor === 'user', adoptedBy: actor });
      const project = this.projects.get(projectId);
      if (actor !== 'user' && project.memberIds.includes(project.ownerId)) this.createWork({ projectId, memberId: project.ownerId,
        kind: 'coordinate', title: '核对主控提交的资料', objective: `核对这条待采纳资料：${JSON.stringify(fact)}。它是未验证的主控提交。只有核对后才用propose_fact引用factId并adopt:true，或说明不采纳原因。`,
        output: { type: 'analysis', sections: ['summary'] } });
      return fact;
    };
    return parsed.requestId ? this.durable.requestOnce(`project.fact:${actor}:${parsed.requestId}`, digest({ projectId, ...parsed }), create) : this.store.transaction(create);
  }
  reviseFact(projectId, factId, input) {
    const parsed = z.object({ type: z.enum(['fact', 'judgment', 'preference']), content: z.string().trim().min(1).max(10000),
      source: z.string().min(1).max(2000) }).strict().parse(input);
    return this.projects.reviseFact(projectId, factId, { type: parsed.type, content: parsed.content,
      sources: [{ kind: 'user', label: parsed.source, ...(parsed.source.startsWith('https://') ? { url: parsed.source } : {}) }] });
  }
  importMaterial(projectId, input, actor = 'user') {
    const parsed = z.object({ name: z.string().min(1).max(180), contentBase64: z.string().min(1).max(12 * 1024 * 1024),
      requestId: z.string().min(1).max(150).optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(input);
    this.projects.get(projectId); materialName(parsed.name);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed.contentBase64)) failBusiness('素材base64编码无效', 400);
    const bytes = Buffer.from(parsed.contentBase64, 'base64');
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || parsed.sha256 && digest(bytes) !== parsed.sha256) failBusiness('素材大小或哈希不正确', 400);
    const image = /\.(png|jpe?g)$/i.test(parsed.name);
    if (!image && !/\.(txt|md|json|csv)$/i.test(parsed.name)) failBusiness('首期支持 PNG、JPEG 或文本资料', 400);
    const create = () => {
      if (this.store.list('projectMaterials').filter(item => item.projectId === projectId).length >= 30) failBusiness('项目素材达到30项上限');
      const asset = this.contents.storeAsset(bytes, { projectId, source: { kind: actor === 'user' ? 'user_import' : 'controller_import', label: parsed.name }, image,
        mime: image ? undefined : 'text/plain', originalName: parsed.name });
      const material = this.store.put('projectMaterials', { id: id('material'), projectId, name: parsed.name,
        assetId: asset.id, sha256: asset.sha256, size: asset.size, mime: asset.mime, revision: 1, createdAt: now(),
        submittedBy: actor, evidenceType: actor === 'user' ? 'user_material' : 'controller_submission' });
      this.emit('project.material', { projectId, materialId: material.id });
      return material;
    };
    return parsed.requestId ? this.durable.requestOnce(`project.material:${actor}:${parsed.requestId}`, digest({ projectId, name: parsed.name, sha256: digest(bytes) }), create) : this.store.transaction(create);
  }
  imageFile(contentId, versionId, index) {
    const bundle = this.contents.getBundle(contentId, versionId);
    const asset = bundle.revision?.images[index];
    if (!asset) failBusiness('图片不存在', 404);
    this.contents.inspectAsset(asset);
    return { asset, bytes: fs.readFileSync(asset.path) };
  }
  bindAccount(projectId, input = {}) {
    const parsed = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(input);
    const connection = this.service.publications.connection();
    if (connection.status !== 'ready' || !connection.account?.id) failBusiness('先在桌面设置登录并核对账号');
    const account = { id: connection.account.id, name: connection.account.name || connection.account.id,
      platform: 'xiaohongshu', status: 'ready', connectorVersion: connection.version };
    return this.updateProject(projectId, { ...parsed, account });
  }
  schedule(contentId, input) {
    const parsed = z.object({ versionId: z.string().min(1), mode: z.enum(['immediate', 'scheduled']),
      startsAt: z.string().datetime().optional(), visibility: z.enum(['public', 'private']).default('public') }).strict().parse(input);
    if (parsed.mode === 'scheduled' && (!parsed.startsAt || Date.parse(parsed.startsAt) <= Date.now())) failBusiness('定时发布需要将来的开始时间', 400);
    const { item, revision, project } = this.contents.getBundle(contentId, parsed.versionId);
    if (!revision || item.currentRevisionId !== parsed.versionId) failBusiness('排期引用了旧稿，请重新查看整稿');
    const schedule = { kind: parsed.mode, ...(parsed.mode === 'scheduled' ? { startsAt: parsed.startsAt } : {}) };
    if (digest(revision.schedule) === digest(schedule) && revision.visibility === parsed.visibility) return revision;
    const next = this.contents.createRevision(contentId, { title: revision.title, body: revision.body, tags: revision.tags,
      images: revision.images.map(image => ({ assetId: image.id })), sources: revision.sources, inputRefs: revision.inputRefs,
      authorMemberIds: revision.authorMemberIds, visibility: parsed.visibility, schedule, changeSummary: '更新本机发布时间范围或可见性，重新核对发布批准' });
    if (this.contents.getBundle(contentId, next.id).eligibility?.valid !== true) this.createWork({ projectId: item.projectId, cycleId: item.cycleId, contentId, memberId: project.reviewerId, kind: 'review',
      title: '核对更新后的发布安排', objective: '对这一固定版本重新审稿，核对图文与新的发布范围。',
      inputRefs: [{ kind: 'content', id: next.id, digest: next.manifestHash }], output: { type: 'analysis', sections: ['summary'] } });
    return next;
  }
  abandon(contentId) {
    return this.store.transaction(() => {
      const result = this.contents.abandon(contentId);
      for (const work of this.works(result.projectId).filter(item => item.contentId === contentId && !workIsClosed(item))) {
        const next = this.store.update('workItems', work.id, { status: 'cancelled', handoffStatus: 'cancelled', generation: work.generation + 1, waitReason: '用户放弃了此稿件' });
        this.handoffs.append(next, 'cancelled', { actorId: 'user', message: '用户放弃了此稿件', evidenceType: 'user_instruction' });
        this.stopWorkRuns(work, '用户放弃了此稿件');
      }
      return result;
    });
  }
  async readTool(action, sourceRunId) {
    const run = this.require('runs', sourceRunId);
    const input = action.arguments;
    if (action.tool === 'template.render') {
      const result = await this.service.businessTools.execute({ name: 'render_card', input },
        { projectId: run.projectId, workItemId: run.workItemId, sourceRunId, allowedTools: ['render_card'] });
      const asset = this.contents.storeAsset(result.buffer, { projectId: run.projectId, image: true,
        source: { kind: 'template', label: '本地可信模板', spec: input }, templateVersion: result.templateVersion, renderCheck: result.renderCheck });
      return { type: 'image', assetId: asset.id, sha256: asset.sha256, evidenceType: 'machine_render' };
    }
    if (action.tool === 'research.read') {
      const { factId, sourceIndex } = z.object({ factId: z.string().min(1), sourceIndex: z.number().int().min(0).max(29).default(0) }).strict().parse(input);
      const fact = this.require('projectFacts', factId);
      if (fact.projectId !== run.projectId || fact.status !== 'adopted' || !fact.sources[sourceIndex]?.url) failBusiness('调研来源必须先登记到当前项目资料');
      return readResearchSource(fact.sources[sourceIndex].url);
    }
    if (action.tool === 'material.read') {
      const { materialId } = z.object({ materialId: z.string().min(1) }).strict().parse(input);
      const material = this.require('projectMaterials', materialId);
      if (material.projectId !== run.projectId) failBusiness('素材不属于当前项目');
      if (['invalid', 'revoked', 'superseded', 'deleted'].includes(material.status)) failBusiness('素材已失效，不能作为当前工作依据');
      const asset = this.require('contentAssets', material.assetId);
      this.contents.inspectAsset(asset);
      return { type: 'material', materialId, assetId: asset.id, sha256: asset.sha256,
        ...(asset.mime === 'text/plain' ? { text: fs.readFileSync(asset.path, 'utf8').slice(0, 16000) } : { width: asset.width, height: asset.height }),
        evidenceType: material.evidenceType || (asset.source?.kind === 'user_import' ? 'user_material' : 'material_reference') };
    }
    if (action.tool === 'metrics.read') {
      const { contentId } = z.object({ contentId: z.string().min(1) }).strict().parse(input);
      if (this.require('contentItems', contentId).projectId !== run.projectId) failBusiness('指标不属于当前项目');
      const values = this.store.list('metricsSnapshots').filter(metric => metric.contentId === contentId);
      return { type: 'metrics', values, status: values.length ? 'available' : 'unavailable', evidenceType: 'platform_observation' };
    }
    if (action.tool === 'publication.candidates') {
      const { attemptId } = z.object({ attemptId: z.string().min(1) }).strict().parse(input);
      return this.service.businessTools.execute({ name: 'publication_verify', input: { attemptId } },
        { projectId: run.projectId, workItemId: run.workItemId, sourceRunId, allowedTools: ['publication_verify'] });
    }
    failBusiness('业务工具未配置', 400);
  }
  state() {
    const kinds = ['projectFacts', 'projectMaterials', 'productionCycles', 'workItems', 'workReceipts', 'workHandoffs', 'contentItems', 'contentRevisions', 'contentEligibilities', 'contentChecks', 'reviews', 'collaborationThreads'];
    const data = Object.fromEntries(kinds.map(kind => [kind, this.store.list(kind)]));
    return { ...data, skillCatalog, projects: this.projects.list().map(project => ({ ...project,
      budget: this.durable.budgetUsage(project.id, projectDay(project.timeZone)) })),
      actions: this.store.list('businessActions'), approvals: this.store.list('publicationApprovals'),
      publications: this.store.list('publications'), attempts: this.store.list('publicationAttempts'),
      metrics: this.store.list('metricsSnapshots'), connection: this.service.publications?.connection() || { status: 'unavailable' },
      tools: { rendering: this.renderer ? 'available' : 'unavailable', imageGeneration: 'not_configured' } };
  }
  applyOwnerPlan(run, actions) { return this.collaboration.applyOwnerPlan(run, actions); }
  admit() { return this.scheduler.admit(); }
  policy(run, member) { return this.scheduler.policy(run, member); }
  claim(run) { return this.scheduler.claim(run); }
  execute(run, signal) { return this.scheduler.execute(run, signal); }
  executionFailed(run, error) { return this.scheduler.executionFailed(run, error); }
  settled(runId) { return this.scheduler.settled(runId); }
  memberQuarantined(memberId) { return this.scheduler.memberQuarantined(memberId); }
  recover() { this.handoffs.recover(); return this.scheduler.recover(); }
}
