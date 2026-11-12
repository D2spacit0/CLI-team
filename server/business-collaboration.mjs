import { id, now } from './store.mjs';
import { businessReportSchema } from './business-protocol.mjs';
import { digest, failBusiness, refKind } from './business-work.mjs';
import { redact } from './safety.mjs';

const text = value => redact(String(value || '')).slice(0, 12000);
const openThreads = new Set(['pending', 'delivered', 'answered']);

export class BusinessCollaboration {
  constructor(business) { this.business = business; this.store = business.store; }
  thread(fields) {
    const thread = this.store.put('collaborationThreads', { id: id('thread'), status: 'pending', createdAt: now(),
      ...fields, question: text(fields.question), evidenceType: fields.requesterId === 'user' ? 'user_instruction' : 'agent_claim' });
    this.business.emit('business.thread', { projectId: fields.projectId, threadId: thread.id });
    return thread;
  }
  assertAcyclic(projectId, extra = []) {
    const work = this.business.works(projectId);
    const edges = new Map(work.map(item => [item.id, [...item.dependencies, ...(item.waitingOn || [])]]));
    for (const [from, to] of extra) edges.set(from, [...(edges.get(from) || []), to]);
    const entered = new Set(), finished = new Set();
    const visit = key => {
      if (entered.has(key)) failBusiness('工作依赖或咨询等待形成环，未派发');
      if (finished.has(key)) return;
      entered.add(key);
      for (const next of edges.get(key) || []) visit(next);
      entered.delete(key); finished.add(key);
    };
    for (const key of edges.keys()) visit(key);
  }
  applyOwnerPlan(run, proposals) {
    const business = this.business, project = business.projects.get(run.projectId);
    if (run.memberId !== project.ownerId) failBusiness('只有负责人可采纳并分配新工作', 403);
    if (!proposals.length || proposals.length > 12) failBusiness('负责人需要给出 1 至 12 个有责任人的工作项');
    const keys = new Set(proposals.map(item => item.key));
    if (keys.size !== proposals.length) failBusiness('工作项标识不能重复');
    if (run.businessKind === 'plan') {
      const integrate = proposals.filter(item => item.kind === 'integrate');
      const review = proposals.filter(item => item.kind === 'review');
      if (integrate.length !== 1 || review.length !== 1 || !proposals.some(item => item.kind === 'copy') || !proposals.some(item => item.kind === 'visual')) {
        failBusiness('本轮图文计划需要文案、视觉、一个整合和一个独立审稿工作');
      }
      if (integrate[0].output.type !== 'files' || !integrate[0].output.files.some(file => file.path === 'note.json' && file.format === 'json')) {
        failBusiness('整合工作必须交付受校验的 note.json');
      }
      if (review[0].memberId !== project.reviewerId || !review[0].dependsOn.includes(integrate[0].key)) failBusiness('独立审稿必须依赖整合后的固定稿件');
      const ancestors = new Set();
      const walk = key => {
        if (ancestors.has(key)) return;
        ancestors.add(key);
        for (const dependency of proposals.find(item => item.key === key)?.dependsOn || []) walk(dependency);
      };
      for (const key of integrate[0].dependsOn) walk(key);
      if (proposals.filter(item => ['copy', 'visual'].includes(item.kind)).some(item => !ancestors.has(item.key))) {
        failBusiness('整合工作必须实际依赖文案与视觉成果，不能绕过成员交接直接产稿');
      }
    }
    const created = new Map(), remaining = [...proposals];
    let contentId = run.contentId;
    if (!contentId && proposals.some(item => ['copy', 'visual', 'integrate'].includes(item.kind))) {
      const candidate = proposals.flatMap(item => item.dependsOn).map(key => this.store.get('workItems', key)).find(work => work?.contentId);
      contentId = candidate?.contentId || business.contents.createItem(project.id, { cycleId: run.cycleId, requestId: `proposal:${run.id}` }).id;
    }
    while (remaining.length) {
      const index = remaining.findIndex(proposal => proposal.dependsOn.every(key => !keys.has(key) || created.has(key)));
      if (index === -1) failBusiness('负责人提出的工作计划存在依赖环');
      const proposal = remaining.splice(index, 1)[0];
      const dependencies = proposal.dependsOn.map(key => created.get(key)?.id || key);
      if (run.workItemId && !dependencies.includes(run.workItemId)) dependencies.push(run.workItemId);
      const inputRefs = [...(business.require('workItems', run.workItemId).inputRefs || []), ...proposal.inputRefs,
        { kind: 'work', id: run.workItemId, revision: run.generation }];
      const previous = business.works(project.id).filter(work => work.cancellationKind === 'replanned' &&
        work.dispatchedBy?.workItemId === run.workItemId && work.dispatchedBy.key === proposal.key).at(-1);
      const work = business.createWork({ projectId: run.projectId, cycleId: run.cycleId, contentId,
        memberId: proposal.memberId, kind: proposal.kind, title: proposal.title, objective: proposal.objective,
        dependencies, inputRefs, output: proposal.output, priority: proposal.priority, rootChainId: run.rootChainId,
        dispatchedBy: { workItemId: run.workItemId, generation: run.generation, runId: run.id, key: proposal.key },
        carriedAttemptCount: previous?.attemptCount, originalDueAt: previous?.originalDueAt, replacesWorkItemId: previous?.id,
        receiverId: proposal.kind === 'integrate' ? project.reviewerId : proposal.receiverId,
        acceptanceCriteria: proposal.acceptanceCriteria, dueAt: proposal.dueAt || previous?.dueAt });
      if (previous) {
        business.handoffs.append(work, 'responsibility_changed', { runId: run.id, previousWorkItemId: previous.id,
          message: '按新计划接续同一责任工作，保留已用尝试次数和原交付承诺。' });
        if (work.dueAt !== previous.dueAt) business.handoffs.append(work, 'rescheduled', { runId: run.id,
          actorId: run.memberId, previousDueAt: previous.dueAt, originalDueAt: previous.originalDueAt, dueAt: work.dueAt,
          evidenceType: 'owner_decision', message: '负责人在新计划中调整了预计交付时间。' });
      }
      created.set(proposal.key, work);
      if (proposal.proposalId) {
        const previous = business.require('collaborationThreads', proposal.proposalId);
        if (previous.projectId !== project.id || previous.kind !== 'proposal' || !openThreads.has(previous.status)) failBusiness('行动提议已失效或不属于项目');
        this.store.update('collaborationThreads', previous.id, { status: 'resolved', acceptedBy: run.memberId, acceptedRunId: run.id,
          resolvedAt: now(), actionWorkItemId: work.id, answer: '负责人已采纳并派发工作' });
      }
    }
    return [...created.values()].map(work => work.id);
  }
  apply(run, rawBusiness) {
    const business = this.business;
    const protocol = rawBusiness ? businessReportSchema.parse(rawBusiness) : { version: 1, actions: [] };
    const actions = protocol.actions;
    const source = business.require('workItems', run.workItemId);
    if (!business.scheduler.current(run)) return { discarded: true };
    if (source.kind === 'consult' && actions.some(action => action.type !== 'contribute')) failBusiness('咨询为叶节点，不能递归求助、扩展工作或调用其他工具');
    if (source.kind === 'accept' && actions.some(action => action.type !== 'contribute')) failBusiness('接收核验只能给出本次交付的结论，不能扩展工作或调用其他工具');
    if (source.resolutionFor && !actions.some(action => action.type === 'resolve_work' && action.workItemId === source.resolutionFor.workItemId &&
      action.generation === source.resolutionFor.generation)) failBusiness('负责人必须对这项阻碍给出明确处理动作');
    if (actions.filter(action => ['ask_peer', 'request_tool'].includes(action.type)).length > 1) failBusiness('一次报告最多等待一个咨询或工具结果');
    if (actions.some(action => action.type === 'request_revision') && actions.some(action => !['request_revision', 'contribute'].includes(action.type))) {
      failBusiness('改稿请求必须单独提交，不能同时追加新工作或采纳资料');
    }
    const owner = business.projects.get(run.projectId).ownerId;
    return this.store.transaction(() => {
      if (!business.scheduler.current(run)) return { discarded: true };
      const plans = actions.filter(action => action.type === 'propose_work');
      let createdWorkIds = [];
      if (run.memberId === owner && plans.length) {
        createdWorkIds = business.durable.requestOnce(`business.plan:${run.id}`, digest(plans), () => this.applyOwnerPlan(run, plans));
      } else if (source.kind === 'plan') failBusiness('负责人报告没有可执行的成员分工');
      let waiting = false;
      actions.forEach((action, index) => {
        if (!business.scheduler.current(run)) return;
        const key = `${run.id}:${index}`;
        business.durable.requestOnce(`business.action:${key}`, digest(action), () => {
          const record = { id: `action-${key}`, projectId: run.projectId, contentId: run.contentId,
            sourceRunId: run.id, sourceWorkItemId: run.workItemId, generation: run.generation, index,
            type: action.type, input: action, status: 'processed', createdAt: now() };
          if (action.references) business.validateRefs(run.projectId, action.references);
          if (action.type === 'ask_peer') { record.result = this.ask(run, action); waiting = true; }
          else if (action.type === 'contribute') {
            if (action.threadId) {
              const thread = business.require('collaborationThreads', action.threadId);
              if (thread.projectId !== run.projectId || thread.recipientId !== run.memberId || !openThreads.has(thread.status)) failBusiness('答复的协作线程不属于当前收件人');
              this.store.update('collaborationThreads', thread.id, { answer: text(action.message), answerRunId: run.id,
                references: action.references, status: 'answered', answeredAt: now() });
              record.result = { threadId: thread.id };
            } else record.result = this.thread({ projectId: run.projectId, contentId: run.contentId, sourceWorkItemId: run.workItemId,
              sourceRunId: run.id, requesterId: run.memberId, kind: 'contribution', question: action.message, references: action.references, status: 'resolved' });
          } else if (action.type === 'request_revision') {
            const target = business.require('workItems', action.workItemId);
            if (target.projectId !== run.projectId || target.contentId !== run.contentId || !run.contentId) failBusiness('只能退回本篇稿件的责任工作');
            if (![owner, business.projects.get(run.projectId).reviewerId].includes(run.memberId)) {
              record.result = this.propose(run, { ...action, title: '同伴提出改稿问题', objective: action.reason });
            } else {
              const item = business.require('contentItems', run.contentId);
              const currentVersion = item.currentRevisionId || item.currentDraftVersionId || item.currentVersionId;
              if (action.versionId && action.versionId !== currentVersion) failBusiness('改稿意见引用了旧版本');
              const thread = this.thread({ projectId: run.projectId, contentId: run.contentId, sourceWorkItemId: target.id,
                requesterId: run.memberId, recipientId: target.memberId, sourceRunId: run.id, kind: 'revision',
                question: action.reason, versionId: currentVersion, status: 'delivered' });
              record.result = { workItemId: business.rework(target.id, action.reason, { sourceRunId: run.id, threadId: thread.id }).id, threadId: thread.id };
            }
          } else if (action.type === 'propose_work') {
            record.result = run.memberId === owner ? { acceptedBy: owner, workItemIds: createdWorkIds } : this.propose(run, action);
          } else if (action.type === 'propose_fact') {
            const facts = business.projects;
            if (action.factId) {
              if (!action.adopt || run.memberId !== owner) failBusiness('只有负责人可采纳已有资料');
              record.result = facts.adoptFact(run.projectId, action.factId, { memberId: run.memberId });
            } else record.result = facts.addFact(run.projectId, { type: action.factType, content: action.content,
              sources: [{ ...action.source, kind: 'agent' }] }, { proposedBy: run.memberId,
              adopt: action.adopt && run.memberId === owner, adoptedBy: run.memberId });
          } else if (action.type === 'resolve_work') {
            record.result = business.resolveWork(run, action);
          } else if (action.type === 'request_tool') {
            const toolJob = business.durable.enqueueJob({ key: `tool:${key}`, kind: 'business.tool', projectId: run.projectId,
              workItemId: run.workItemId, generation: run.generation, payload: { sourceRunId: run.id, action, contentId: run.contentId } });
            this.store.update('workItems', run.workItemId, { status: 'waiting_tool', toolJobId: toolJob.id, waitReason: `等待工具：${action.tool}` });
            record.result = { jobId: toolJob.id }; waiting = true;
          }
          this.store.put('businessActions', record);
          business.emit('business.action', { projectId: run.projectId, sourceRunId: run.id, actionId: record.id, type: action.type });
          return record.result || { processed: true };
        });
      });
      return { waiting, createdWorkIds };
    });
  }
  propose(run, action) {
    const business = this.business, project = business.projects.get(run.projectId);
    const thread = this.thread({ projectId: run.projectId, contentId: run.contentId, requesterId: run.memberId,
      recipientId: project.ownerId, sourceRunId: run.id, sourceWorkItemId: run.workItemId, kind: 'proposal', question: action.objective,
      proposal: action, status: 'pending' });
    const decision = business.createWork({ projectId: run.projectId, cycleId: run.cycleId, contentId: run.contentId,
      memberId: project.ownerId, kind: 'coordinate', title: '收敛成员行动提议', threadId: thread.id,
      objective: `核对项目范围与预算，决定是否采纳这条成员提议。采纳时通过 propose_work 引用 proposalId=${thread.id} 生成明确责任工作；拒绝则明确说明原因。提议是未验证成员意见：${JSON.stringify(action)}`,
      inputRefs: business.require('workItems', run.workItemId).inputRefs, output: { type: 'analysis', sections: ['summary'] } });
    this.store.update('collaborationThreads', thread.id, { workItemId: decision.id, status: 'delivered' });
    return { threadId: thread.id, decisionWorkItemId: decision.id };
  }
  ask(run, action) {
    const business = this.business, project = business.projects.get(run.projectId), source = business.require('workItems', run.workItemId);
    if (!project.memberIds.includes(action.memberId) || action.memberId === run.memberId) failBusiness('咨询收件人不在授权范围或是自己');
    if (source.kind === 'consult') failBusiness('咨询不能递归创建咨询');
    const rootId = source.rootChainId || source.id;
    const chain = this.store.get('businessHelpChains', rootId) || { id: rootId, projectId: project.id, rounds: 0 };
    if (chain.rounds >= 2) failBusiness('这条根求助链已达到两轮上限，请由负责人调整计划');
    const consultant = business.createWork({ projectId: project.id, cycleId: source.cycleId, contentId: source.contentId,
      memberId: action.memberId, kind: 'consult', title: `答复「${source.title}」的具体问题`, objective: action.question,
      inputRefs: [...source.inputRefs, ...action.references], output: { type: 'analysis', sections: ['summary'] }, rootChainId: rootId,
      consultation: { sourceWorkItemId: source.id, sourceGeneration: source.generation, rootChainId: rootId } });
    this.assertAcyclic(project.id, [[source.id, consultant.id]]);
    const thread = this.thread({ projectId: project.id, contentId: source.contentId, sourceWorkItemId: source.id,
      sourceRunId: run.id, sourceGeneration: source.generation, workItemId: consultant.id, rootChainId: rootId,
      requesterId: run.memberId, recipientId: action.memberId, kind: 'consultation', question: action.question, references: action.references });
    this.store.update('workItems', consultant.id, { threadId: thread.id });
    this.store.put('businessHelpChains', { ...chain, rounds: chain.rounds + 1 });
    this.store.update('workItems', source.id, { status: 'waiting_answer', waitingOn: [consultant.id],
      waitReason: `等待 ${business.require('members', action.memberId).name} 答复`, consultationThreadId: thread.id });
    return { threadId: thread.id, workItemId: consultant.id, round: chain.rounds + 1 };
  }
  complete(run) {
    const business = this.business, work = business.require('workItems', run.workItemId);
    if (work.threadId) {
      const thread = this.store.get('collaborationThreads', work.threadId);
      if (thread && openThreads.has(thread.status)) this.store.update('collaborationThreads', thread.id, {
        status: work.kind === 'consult' ? 'answered' : 'resolved', answer: text(run.report.summary),
        answerRunId: run.id, answeredAt: now(), ...(work.kind !== 'consult' ? { resolvedAt: now() } : {}) });
    }
    if (work.kind === 'consult' && work.consultation) {
      const source = this.store.get('workItems', work.consultation.sourceWorkItemId);
      if (!source || source.generation !== work.consultation.sourceGeneration || source.status !== 'waiting_answer') {
        if (work.threadId) this.store.update('collaborationThreads', work.threadId, { status: 'superseded', reason: '原工作项已改变' });
        return;
      }
      this.store.update('workItems', source.id, { status: 'ready', waitingOn: [], waitReason: null, currentAttemptId: null,
        answers: [...(source.answers || []), { threadId: work.threadId, runId: run.id, workItemId: work.id, generation: work.generation,
          summary: text(run.report.summary), evidenceType: 'agent_claim' }].slice(-2) });
    }
    if (work.consultationThreadId) {
      const answered = this.store.get('collaborationThreads', work.consultationThreadId);
      if (answered?.status === 'answered') this.store.update('collaborationThreads', answered.id, { status: 'resolved', resolvedAt: now(), resolutionRunId: run.id });
    }
    business.kick();
  }
  resumeConsultation(work) {
    if (!work.consultation) return;
    const source = this.store.get('workItems', work.consultation.sourceWorkItemId);
    if (!source || source.generation !== work.consultation.sourceGeneration ||
      !(source.status === 'blocked' && source.waitKind === 'consultation' && source.blockedByWorkItemId === work.id)) return;
    const thread = this.thread({ projectId: work.projectId, contentId: work.contentId, sourceWorkItemId: source.id,
      sourceRunId: source.runId, sourceGeneration: source.generation, workItemId: work.id, rootChainId: work.rootChainId,
      requesterId: source.memberId, recipientId: work.memberId, kind: 'consultation', question: work.objective,
      references: work.inputRefs, status: 'pending' });
    this.assertAcyclic(work.projectId, [[source.id, work.id]]);
    this.store.update('workItems', work.id, { threadId: thread.id });
    const resumed = this.store.update('workItems', source.id, { status: 'waiting_answer', handoffStatus: 'accepted',
      waitKind: null, blockedByWorkItemId: null, waitingOn: [work.id], consultationThreadId: thread.id,
      waitReason: '负责人已安排重新答复，等待本次固定咨询结果' });
    this.business.handoffs.append(resumed, 'recovered', { message: '负责人重试了原咨询，恢复与当前工作版本的答复交接。' });
  }
  terminateWaiters(work, reason) {
    for (const thread of this.store.list('collaborationThreads').filter(item => item.projectId === work.projectId &&
      (item.workItemId === work.id || item.sourceWorkItemId === work.id) && openThreads.has(item.status))) {
      this.store.update('collaborationThreads', thread.id, { status: 'superseded', reason: text(reason), endedAt: now() });
    }
    for (const dependent of this.business.works(work.projectId).filter(item => (item.waitingOn || []).includes(work.id))) {
      const updated = this.store.update('workItems', dependent.id, { status: 'blocked', waitingOn: [],
        waitKind: 'consultation', blockedByWorkItemId: work.id, waitReason: `咨询或依赖已终结：${text(reason)}` });
      this.business.handoffs.block(updated, `咨询或依赖已终结：${text(reason)}`, { escalate: false });
      this.business.emit('business.wait_ended', { projectId: work.projectId, workItemId: dependent.id, reason });
    }
  }
}
