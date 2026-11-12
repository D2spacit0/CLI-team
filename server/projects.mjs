import { z } from 'zod';
import { createHash } from 'node:crypto';
import { id, now } from './store.mjs';
import { BusinessStore } from './business-store.mjs';
import { workIsClosed } from './business-handoffs.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const sourceSchema = z.object({ label: z.string().min(1).max(300), url: z.string().url().max(2000).optional(),
  kind: z.enum(['web', 'file', 'user', 'observation', 'agent']).default('user'), referenceId: z.string().max(200).optional() }).strict();
const limitsSchema = z.object({ dailyCliCalls: z.number().int().min(1).max(24).default(24),
  maxPending: z.number().int().min(1).max(3).default(3), maxAttempts: z.number().int().min(1).max(3).default(3) }).strict();
export const projectCreateSchema = z.object({ requestId: z.string().min(1).max(150).optional(),
  name: z.string().trim().min(1).max(100), objective: z.string().trim().min(1).max(6000),
  moduleId: z.literal('xiaohongshu').default('xiaohongshu'), ownerId: z.string().max(200).default(''),
  memberIds: z.array(z.string().max(200)).max(20).default([]), reviewerId: z.string().max(200).default(''),
  brief: z.string().max(12000).default(''), timeZone: z.string().max(100).default('Asia/Shanghai'),
  start: z.boolean().default(true), limits: limitsSchema.default({}) }).strict();
const factSchema = z.object({ type: z.enum(['fact', 'judgment', 'preference']), content: z.string().trim().min(1).max(10000),
  sources: z.array(sourceSchema).max(30).default([]) }).strict();
const accountSchema = z.object({ id: z.string().min(1).max(200), name: z.string().max(200), platform: z.literal('xiaohongshu'),
  status: z.enum(['ready', 'login_required', 'unavailable']).default('unavailable'),
  connectorVersion: z.string().min(1).max(100) }).strict().nullable();
const updateSchema = z.object({ expectedRevision: z.number().int().positive(), name: z.string().trim().min(1).max(100).optional(),
  objective: z.string().trim().min(1).max(6000).optional(), brief: z.string().max(12000).optional(),
  ownerId: z.string().max(200).optional(), reviewerId: z.string().max(200).optional(), memberIds: z.array(z.string().max(200)).max(20).optional(),
  timeZone: z.string().max(100).optional(), status: z.enum(['active', 'paused', 'attention', 'archived']).optional(),
  account: accountSchema.optional(), limits: limitsSchema.optional() }).strict();

export function projectDay(timeZone = 'Asia/Shanghai', at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
    const get = type => parts.find(part => part.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch { fail('项目时区无效'); }
}

export class ProjectService {
  constructor({ store, dataDir, emit = () => {}, onInvalidate = () => {} }) {
    this.store = store; this.dataDir = dataDir; this.emit = emit; this.onInvalidate = onInvalidate;
    this.durable = new BusinessStore(store);
  }

  get(projectId) {
    const project = this.store.get('projects', projectId);
    if (!project) fail('业务项目不存在', 404);
    return project;
  }
  list() { return this.store.list('projects'); }

  teamIssues(project) {
    const roster = new Set(project.memberIds);
    const issues = [];
    if (!project.ownerId) issues.push('尚未指定负责人');
    if (!project.reviewerId) issues.push('尚未指定独立审稿成员');
    for (const memberId of [...new Set([...project.memberIds, project.ownerId, project.reviewerId].filter(Boolean))]) {
      const member = this.store.get('members', memberId);
      if (!member || member.provider === 'controller') fail('项目只能使用现有的 CLI 成员');
      if (!member.enabled) issues.push(`${member.name}尚未启用`);
      if (!roster.has(memberId)) issues.push(`${member.name}未加入项目团队`);
    }
    if (project.ownerId && project.ownerId === project.reviewerId) issues.push('负责人和独立审稿成员应分开');
    return issues;
  }

  create(input) {
    const parsed = projectCreateSchema.parse(input);
    projectDay(parsed.timeZone);
    const fingerprint = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
    const create = () => {
      const { requestId: _requestId, start, ...fields } = parsed;
      const project = { ...fields, id: id('project'), revision: 1, briefVersion: 1, moduleVersion: '1',
        timezone: fields.timeZone, memberIds: [...new Set(fields.memberIds)], account: null,
        toolBindings: { render: 'local-template-v1', imageGeneration: null }, status: start ? 'active' : 'paused',
        createdAt: now(), updatedAt: now() };
      project.blockers = this.teamIssues(project);
      if (start && project.blockers.length) project.status = 'attention';
      this.store.put('projects', project);
      this.emit('project.created', { projectId: project.id });
      return project;
    };
    return parsed.requestId ? this.durable.requestOnce(`project.create:${parsed.requestId}`, fingerprint, create) : this.store.transaction(create);
  }

  update(projectId, input) {
    const parsed = updateSchema.parse(input);
    if (parsed.timeZone) projectDay(parsed.timeZone);
    return this.store.transaction(() => {
      const previous = this.get(projectId);
      if (previous.revision !== parsed.expectedRevision) fail('项目已被其他操作更新，请重新加载', 409);
      const { expectedRevision: _expectedRevision, ...patch } = parsed;
      const briefChanged = ['objective', 'brief'].some(key => patch[key] !== undefined && patch[key] !== previous[key]);
      const bindingChanged = ['account', 'timeZone'].some(key => patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(previous[key]));
      const teamChanged = ['ownerId', 'reviewerId', 'memberIds'].some(key => patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(previous[key]));
      const next = { ...previous, ...patch, revision: previous.revision + 1, updatedAt: now(),
        timezone: patch.timeZone || previous.timezone, briefVersion: previous.briefVersion + (briefChanged ? 1 : 0) };
      next.memberIds = [...new Set(next.memberIds)];
      next.blockers = this.teamIssues(next);
      if (next.status === 'active' && next.blockers.length) next.status = 'attention';
      this.store.put('projects', next);
      if (briefChanged || bindingChanged || teamChanged) this.onInvalidate({ projectId,
        refs: briefChanged ? [{ kind: 'project', id: projectId, revision: previous.briefVersion }] : [],
        replacementRefs: briefChanged ? [{ from: { kind: 'project', id: projectId, revision: previous.briefVersion },
          to: { kind: 'project', id: projectId, revision: next.briefVersion } }] : [],
        allContent: bindingChanged || teamChanged,
        reason: teamChanged ? '项目团队授权已调整' : briefChanged ? '项目目标或简报已经修正' : '账号绑定或排期时区已经变化' });
      this.emit('project.updated', { projectId, revision: next.revision });
      return next;
    });
  }

  addFact(projectId, input, { proposedBy = 'user', adopt = false, adoptedBy = 'user' } = {}) {
    const parsed = factSchema.parse(input);
    return this.store.transaction(() => {
      const project = this.get(projectId);
      if (adopt && !['user', project.ownerId].includes(adoptedBy)) fail('只有用户或项目负责人可以采纳项目资料', 403);
      if (parsed.type === 'fact' && !parsed.sources.length) fail('事实资料需要可追溯来源；没有来源的内容应标为判断');
      const fact = { ...parsed, id: id('fact'), projectId, revision: 1, status: adopt ? 'adopted' : 'proposed',
        proposedBy, adoptedBy: adopt ? adoptedBy : null, evidenceType: proposedBy === 'user' ? 'user_provided' : 'agent_claim',
        createdAt: now(), adoptedAt: adopt ? now() : null, supersedes: null };
      this.store.put('projectFacts', fact);
      this.emit('project.fact', { projectId, factId: fact.id, status: fact.status });
      return fact;
    });
  }

  adoptFact(projectId, factId, { memberId } = {}) {
    return this.store.transaction(() => {
      const project = this.get(projectId), fact = this.store.get('projectFacts', factId);
      if (memberId !== project.ownerId && memberId !== 'user') fail('只有负责人可以采纳成员提出的资料', 403);
      if (!fact || fact.projectId !== projectId || fact.status === 'superseded') fail('待采纳资料不存在或已被替代', 409);
      if (fact.status === 'adopted') return fact;
      const updated = this.store.update('projectFacts', factId, { status: 'adopted', adoptedBy: memberId, adoptedAt: now() });
      this.emit('project.fact', { projectId, factId, status: 'adopted' });
      return updated;
    });
  }

  reviseFact(projectId, factId, input, { memberId = 'user' } = {}) {
    const parsed = factSchema.parse(input);
    return this.store.transaction(() => {
      const project = this.get(projectId), previous = this.store.get('projectFacts', factId);
      if (!previous || previous.projectId !== projectId || previous.status === 'superseded') fail('资料不存在或已经有更新版本', 409);
      if (![project.ownerId, 'user'].includes(memberId)) fail('只有用户或负责人可以修正已采纳资料', 403);
      const updated = this.addFact(projectId, parsed, { proposedBy: memberId, adopt: previous.status === 'adopted', adoptedBy: memberId });
      const revision = this.store.update('projectFacts', updated.id, { revision: previous.revision + 1, supersedes: previous.id });
      this.store.update('projectFacts', previous.id, { status: 'superseded', supersededBy: revision.id });
      this.onInvalidate({ projectId, refs: [{ kind: 'fact', id: previous.id, revision: previous.revision }],
        replacementRefs: [{ from: { kind: 'fact', id: previous.id, revision: previous.revision },
          to: { kind: 'fact', id: revision.id, revision: revision.revision } }], reason: '依赖的项目资料已经修正' });
      this.emit('project.fact_revised', { projectId, factId: previous.id, replacementId: revision.id });
      return revision;
    });
  }

  startCycle(projectId, { at = new Date(), objective } = {}) {
    return this.store.transaction(() => {
      const project = this.get(projectId);
      const active = this.store.list('productionCycles').find(cycle => cycle.projectId === projectId && cycle.status === 'active');
      if (active) return active;
      if (project.status !== 'active') return null;
      const day = projectDay(project.timeZone, at);
      const existing = this.store.list('productionCycles').find(cycle => cycle.projectId === projectId && cycle.day === day);
      if (existing) return existing;
      const cycle = { id: id('cycle'), projectId, day, key: `${projectId}:${day}`, status: 'active',
        objective: objective || project.objective, briefVersion: project.briefVersion, createdAt: now(), reviewRefs: [] };
      this.store.put('productionCycles', cycle);
      this.emit('project.cycle', { projectId, cycleId: cycle.id });
      return cycle;
    });
  }

  finishCycle(cycleId, { status = 'complete', reviewRefs = [] } = {}) {
    if (!['complete', 'cancelled'].includes(status)) fail('周期结束状态无效');
    return this.store.transaction(() => {
      const cycle = this.store.get('productionCycles', cycleId);
      if (!cycle) fail('生产周期不存在', 404);
      const active = this.store.list('workItems').some(work => work.cycleId === cycleId && !workIsClosed(work));
      if (active) fail('生产周期仍有未完成工作', 409);
      return this.store.update('productionCycles', cycleId, { status, reviewRefs, finishedAt: now() });
    });
  }
}
