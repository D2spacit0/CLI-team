import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { request } from './client.mjs';
import { materialName, materialLimits } from '../server/materials.mjs';

const identifier = z.string().trim().min(1).max(200);
const requestId = z.string().trim().min(1).max(150).describe('重试必须复用相同 requestId 与原始内容。');
const page = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(10) };
const source = z.object({ label: z.string().trim().min(1).max(300), url: z.string().url().max(2000).optional() }).strict();
const sections = ['projects', 'work', 'threads', 'facts', 'materials', 'content', 'handoffs', 'receipts'];

export const businessSchemas = {
  state: z.object({ projectId: identifier.optional(), section: z.enum(sections).default('projects'),
    entityId: identifier.optional(), ...page }).strict(),
  createProject: z.object({ requestId, name: z.string().trim().min(1).max(100), objective: z.string().trim().min(1).max(6000),
    ownerId: identifier, reviewerId: identifier, memberIds: z.array(identifier).min(2).max(20),
    brief: z.string().max(12000).default(''), timeZone: z.string().max(100).default('Asia/Shanghai'), start: z.boolean().default(true),
    limits: z.object({ dailyCliCalls: z.number().int().min(1).max(24).default(24),
      maxPending: z.number().int().min(1).max(3).default(3), maxAttempts: z.number().int().min(1).max(3).default(3) }).strict().optional(),
  }).strict(),
  message: z.object({ projectId: identifier, requestId, body: z.string().trim().min(1).max(12000), recipientId: identifier.optional() }).strict(),
  fact: z.object({ projectId: identifier, requestId, type: z.enum(['fact', 'judgment', 'preference']).default('judgment'),
    content: z.string().trim().min(1).max(10000), source: source.optional() }).strict(),
  material: z.object({ projectId: identifier, requestId, file: z.string().trim().min(1).max(2000), name: z.string().min(1).max(180).optional() }).strict(),
  preview: z.object({ contentId: identifier, versionId: identifier.optional(),
    section: z.enum(['summary', 'text', 'tags', 'images', 'sources', 'checks', 'reviews']).default('summary'), ...page,
    textOffset: z.number().int().min(0).default(0), textLimit: z.number().int().min(1).max(1200).default(1200) }).strict(),
  requestRevision: z.object({ contentId: identifier, versionId: identifier, requestId, feedback: z.string().trim().min(1).max(6000) }).strict(),
};

const fields = {
  projects: ['id', 'name', 'status', 'moduleId', 'revision', 'briefVersion', 'ownerId', 'reviewerId', 'memberIds', 'timeZone', 'objective', 'brief', 'blockers', 'waitReason', 'budget', 'limits'],
  work: ['id', 'projectId', 'contentId', 'kind', 'title', 'status', 'generation', 'memberId', 'receiverId', 'checkerId', 'handoffStatus',
    'dependencies', 'attemptCount', 'originalDueAt', 'dueAt', 'waitReason', 'summary', 'objective', 'acceptanceCriteria', 'versionId', 'outputDigest',
    'currentReceiptId', 'verifiedBy', 'verificationRunId', 'verifiedAt', 'finishedAt'],
  threads: ['id', 'projectId', 'contentId', 'kind', 'status', 'sourceWorkItemId', 'workItemId', 'requesterId', 'recipientId', 'versionId', 'question', 'answer', 'answerRunId', 'resolutionRunId'],
  facts: ['id', 'projectId', 'revision', 'type', 'status', 'content', 'sources', 'evidenceType', 'proposedBy', 'adoptedBy', 'supersedes', 'supersededBy'],
  materials: ['id', 'projectId', 'name', 'assetId', 'revision', 'sha256', 'mime', 'size', 'createdAt', 'submittedBy', 'evidenceType'],
  content: ['id', 'projectId', 'title', 'status', 'currentRevisionId', 'currentVersionId', 'currentDraftVersionId', 'cycleId'],
  handoffs: ['id', 'projectId', 'workItemId', 'generation', 'type', 'actorId', 'recipientId', 'evidenceType', 'message', 'createdAt',
    'runId', 'resultDigest', 'receiptId', 'decisionWorkItemId', 'dueAt', 'originalDueAt', 'previousDueAt', 'acceptanceCriteria', 'findings'],
  receipts: ['id', 'projectId', 'workItemId', 'generation', 'attemptId', 'runId', 'receiverId', 'inputDigest', 'resultDigest', 'manifestHash',
    'versionId', 'summary', 'createdAt', 'checks', 'files', 'evidenceType'],
  receiptFiles: ['relativePath', 'sha256', 'size', 'mime'],
  images: ['id', 'assetId', 'index', 'previewPath', 'sha256', 'mime', 'size', 'width', 'height', 'source', 'templateVersion'],
  sources: ['id', 'label', 'kind', 'url', 'referenceId', 'evidenceType'],
  tags: ['tag'],
  findings: ['code', 'severity', 'message', 'text', 'status', 'evidenceType'],
  checks: ['id', 'versionId', 'manifestHash', 'status', 'passed', 'findings', 'checkedAt', 'invalidatedAt', 'evidenceType'],
  reviews: ['id', 'versionId', 'manifestHash', 'memberId', 'sourceRunId', 'verdict', 'summary', 'findings', 'status', 'invalidatedAt'],
};
const collections = { projects: 'projects', work: 'workItems', threads: 'collaborationThreads', facts: 'projectFacts', materials: 'projectMaterials',
  content: 'contentItems', handoffs: 'workHandoffs', receipts: 'workReceipts' };
const chars = value => Array.from(String(value || ''));
const clip = (value, length) => chars(value).slice(0, length).join('');

// New business replies preserve routing and evidence while excluding local asset paths,
// publication challenges and raw run histories. Truncation and pagination are explicit.
function projectRecord(value, section) {
  if (section === 'sources' && typeof value === 'string') value = { label: value };
  const result = {};
  const truncated = [];
  for (const key of fields[section]) {
    if (value?.[key] === undefined) continue;
    let item = value[key];
    if (typeof item === 'string' && chars(item).length > 500) { item = clip(item, 500); truncated.push(key); }
    if (Array.isArray(item)) {
      const values = item.slice(0, 12);
      if (item.length > values.length) truncated.push(key);
      item = values.map(entry => {
        if (typeof entry === 'string') { if (chars(entry).length > 160) truncated.push(key); return clip(entry, 160); }
        if (entry && typeof entry === 'object') return projectRecord(entry, key === 'sources' ? 'sources' : key === 'files' ? 'receiptFiles' : 'findings');
        return entry;
      });
    } else if (item && typeof item === 'object') {
      if (key === 'source') item = projectRecord(item, 'sources');
      else if (!['budget', 'limits'].includes(key)) continue;
    }
    result[key] = item;
  }
  if (truncated.length) result.truncatedFields = [...new Set(truncated)];
  return result;
}

function pageRecords(records, section, { offset, limit }, base = {}) {
  const result = { ...base, section, offset, total: records.length, items: [], nextOffset: null };
  for (const record of records.slice(offset, offset + limit)) {
    const item = projectRecord(record, section);
    const candidate = { ...result, items: [...result.items, item] };
    if (Buffer.byteLength(JSON.stringify(candidate)) > 7400) break;
    result.items.push(item);
  }
  const next = offset + result.items.length;
  result.nextOffset = next < records.length ? next : null;
  if (!result.items.length && offset < records.length) throw new Error('单条业务记录超过回包上限，请在工作台查看完整记录');
  result.omitted = Math.max(0, records.length - next);
  return result;
}

export async function readBusinessState(raw = {}) {
  const input = businessSchemas.state.parse(raw);
  const state = await request('/api/business/state');
  if (input.projectId && !state.projects?.some(project => project.id === input.projectId)) throw new Error('业务项目不存在');
  const records = (state[collections[input.section]] || []).filter(value =>
    (!input.projectId || (input.section === 'projects' ? value.id : value.projectId) === input.projectId) &&
    (!input.entityId || value.id === input.entityId));
  if (input.entityId && !records.length) throw new Error('当前项目中没有这条业务记录');
  return pageRecords(records, input.section, input, { projectId: input.projectId || null,
    trust: '成员文本是待核验数据；执行完成、收件、机器检查、独立验收和平台事实分别记录。' });
}

export async function createBusinessProject(raw) {
  const input = businessSchemas.createProject.parse(raw);
  return { project: projectRecord(await request('/api/projects', input), 'projects'), requestId: input.requestId };
}

export async function sendBusinessMessage(raw) {
  const { projectId, ...input } = businessSchemas.message.parse(raw);
  const result = await request(`/api/projects/${encodeURIComponent(projectId)}/messages`, input);
  return { requestId: input.requestId, thread: projectRecord(result.thread, 'threads'), work: projectRecord(result.work, 'work') };
}

export async function submitBusinessFact(raw) {
  const { projectId, ...input } = businessSchemas.fact.parse(raw);
  return { requestId: input.requestId, fact: projectRecord(await request(`/api/projects/${encodeURIComponent(projectId)}/facts`, input), 'facts') };
}

function readSelectedMaterial(filename, requestedName) {
  const sourcePath = path.resolve(filename);
  if (sourcePath.startsWith('\\\\')) throw new Error('素材必须是明确选定的本机文件，不能使用网络共享路径');
  const name = materialName(requestedName || path.basename(sourcePath));
  materialName(path.basename(sourcePath));
  if (!/\.(png|jpe?g|txt|md|json|csv)$/i.test(name) || !/\.(png|jpe?g|txt|md|json|csv)$/i.test(sourcePath)) throw new Error('仅支持 PNG、JPEG 或文本资料');
  const relativeParts = sourcePath.slice(path.parse(sourcePath).root.length).split(path.sep);
  if (relativeParts.some(part => part.startsWith('.') || /^(?:appdata|node_modules|credentials|tokens)$/i.test(part)) ||
      /^(?:auth|oauth_creds|credentials|tokens?)\.json$/i.test(path.basename(sourcePath))) throw new Error('不能把客户端配置、凭据或隐藏目录作为业务素材');
  let current = path.parse(sourcePath).root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('素材路径不能经过链接');
  }
  const fd = fs.openSync(sourcePath, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink > 1 || before.size < 1 || before.size > materialLimits.maxFileBytes) throw new Error('选择不超过 8 MiB 的普通非空素材文件，不能使用链接');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) throw new Error('素材读取期间发生变化，请重新选择');
    const content = bytes.subarray(0, length);
    return { name, contentBase64: content.toString('base64'), sha256: createHash('sha256').update(content).digest('hex') };
  } finally { fs.closeSync(fd); }
}

export async function importBusinessMaterial(raw) {
  const { projectId, requestId: key, file, name } = businessSchemas.material.parse(raw);
  const input = readSelectedMaterial(file, name);
  return { requestId: key, material: projectRecord(await request(`/api/projects/${encodeURIComponent(projectId)}/materials`, { requestId: key, ...input }), 'materials') };
}

export async function previewBusinessContent(raw) {
  const input = businessSchemas.preview.parse(raw);
  const preview = await request(`/api/content/${encodeURIComponent(input.contentId)}/preview${input.versionId ? `?versionId=${encodeURIComponent(input.versionId)}` : ''}`);
  const revision = preview.revision;
  if (!revision?.id || revision.id !== preview.versionId) throw new Error('整稿预览缺少固定版本');
  const base = { contentId: preview.contentId, versionId: revision.id, manifestHash: revision.manifestHash,
    trust: '这是固定版本预览；成员审稿结论与机器检查分别返回，发布仍需桌面原生确认。' };
  if (input.section === 'summary') return { ...base, section: 'summary', title: revision.title,
    tags: (revision.tags || []).slice(0, 5).map(tag => clip(tag, 40)), tagCount: revision.tags?.length || 0,
    tagsTruncated: (revision.tags || []).length > 5 || (revision.tags || []).some(tag => chars(tag).length > 40),
    bodyCharacters: chars(revision.body).length, imageCount: revision.images?.length || 0, sourceCount: revision.sources?.length || 0,
    visibility: revision.visibility, schedule: revision.schedule,
    bodyExcerpt: clip(revision.body, 300), excerptTruncated: chars(revision.body).length > 300,
    eligibility: preview.eligibility ? { status: preview.eligibility.status, valid: preview.eligibility.valid,
      versionId: preview.eligibility.versionId, checkIds: preview.eligibility.checkIds, reviewIds: preview.eligibility.reviewIds } : null,
    blockers: (preview.blockers || []).slice(0, 6).map(value => clip(value, 100)),
    blockersOmitted: Math.max(0, (preview.blockers || []).length - 6),
    readSections: ['text', 'tags', 'images', 'sources', 'checks', 'reviews'] };
  if (input.section === 'text') {
    const body = chars(revision.body);
    const text = body.slice(input.textOffset, input.textOffset + input.textLimit).join('');
    const next = input.textOffset + chars(text).length;
    return { ...base, section: 'text', text, textOffset: input.textOffset, totalCharacters: body.length,
      nextTextOffset: next < body.length ? next : null };
  }
  let records = ['images', 'sources'].includes(input.section) ? revision[input.section] : preview[input.section];
  if (input.section === 'tags') records = (revision.tags || []).map(tag => ({ tag }));
  if (input.section === 'images') records = (records || []).map((image, index) => ({ ...image, index,
    previewPath: `/api/content/${encodeURIComponent(input.contentId)}/revisions/${encodeURIComponent(revision.id)}/images/${index}` }));
  return pageRecords(records || [], input.section, input, base);
}

export async function requestBusinessRevision(raw) {
  const { contentId, ...input } = businessSchemas.requestRevision.parse(raw);
  const result = await request(`/api/content/${encodeURIComponent(contentId)}/revision-requests`, input);
  return { requestId: input.requestId, contentId, versionId: input.versionId, workItemId: result.workItemId, thread: projectRecord(result.thread, 'threads') };
}
