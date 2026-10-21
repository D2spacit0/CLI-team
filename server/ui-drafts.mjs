import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { materialLimits, materialName } from './materials.mjs';
import { now } from './store.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const identifier = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]*$/);
const optionalIdentifier = z.union([identifier, z.literal('')]);
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new-task'), contextId: identifier.default('default') }).strict(),
  z.object({ kind: z.literal('room-create') }).strict(),
  z.object({ kind: z.literal('meeting-create'), roomId: identifier }).strict(),
  z.object({ kind: z.literal('room-message'), roomId: identifier }).strict(),
  z.object({ kind: z.literal('managed-request'), roomId: identifier }).strict(),
  ...['revision', 'acceptance', 'assignment'].map((kind) => z.object({ kind: z.literal(kind), taskId: identifier,
    planId: optionalIdentifier.default(''), contextId: optionalIdentifier.default('') }).strict()),
  z.object({ kind: z.literal('assistance'), taskId: identifier, planId: identifier, questionId: identifier }).strict(),
]);
const requestSchema = z.object({ workspace: z.string().min(1).max(4096).refine((value) => !/[\u0000-\u001f]/.test(value)), scope: scopeSchema }).strict();
const revisionSchema = z.number().int().nonnegative().safe();
const text = (limit) => z.string().max(limit);
const jsonText = (schema, limit) => text(limit).superRefine((value, context) => {
  try {
    const result = schema.safeParse(JSON.parse(value));
    if (!result.success) context.addIssue({ code: z.ZodIssueCode.custom, message: '草稿 JSON 的结构或内容无效' });
  } catch { context.addIssue({ code: z.ZodIssueCode.custom, message: '草稿需要有效的 JSON 数组' }); }
});
const materialIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/);
const materialSchema = z.object({
  id: materialIdentifier,
  name: text(180).min(1).refine((name) => { try { materialName(name); return true; } catch { return false; } }, '材料名称无效'),
  size: z.number().int().nonnegative().max(materialLimits.maxFileBytes).optional(),
  status: z.enum(['selected', 'uploading', 'imported', 'failed', 'missing']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), materialId: materialIdentifier.optional(),
}).strict();
const materialListSchema = z.array(materialSchema).max(materialLimits.maxFiles)
  .refine((items) => items.reduce((sum, item) => sum + (item.size || 0), 0) <= materialLimits.maxTaskBytes, '材料总量超限')
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length &&
    new Set(items.map((item) => item.name.toLowerCase())).size === items.length, '材料记录重复');
const fieldSchemas = {
  'new-task': z.object({ title: text(1000), objective: text(24000), requirements: text(36000), verificationCommand: text(12000),
    executionMode: z.enum(['direct', 'delegated']), assigneeId: optionalIdentifier, reviewerId: optionalIdentifier,
    participantIds: jsonText(z.array(identifier).max(4).refine((ids) => new Set(ids).size === ids.length), 1200),
    roomId: optionalIdentifier, sourceSessionId: optionalIdentifier, sourceTitle: text(1000), preparationTaskId: optionalIdentifier,
    materialManifest: jsonText(materialListSchema, 40000), creationRequestId: z.union([z.string().uuid(), z.literal('')]),
  }).partial().strict(),
  revision: z.object({ feedback: text(6000) }).partial().strict(),
  acceptance: z.object({ note: text(6000) }).partial().strict(),
  assistance: z.object({ answer: text(6000) }).partial().strict(),
  assignment: z.object({ assigneeId: optionalIdentifier, reviewerId: optionalIdentifier, note: text(1200),
    participantIds: jsonText(z.array(identifier).max(4).refine(ids => new Set(ids).size === ids.length), 1200),
  }).partial().strict(),
  'room-message': z.object({ body: text(24000),
    recipientIds: jsonText(z.array(identifier).max(4).refine((ids) => new Set(ids).size === ids.length), 1200),
    taskId: optionalIdentifier, sendRequestId: z.union([z.string().uuid(), z.literal('')]),
  }).partial().strict(),
  'managed-request': z.object({ objective: text(12000), requestId: z.union([z.string().uuid(), z.literal('')]) }).partial().strict(),
  'room-create': z.object({ name: text(60), requestId: z.union([z.string().uuid(), z.literal('')]) }).partial().strict(),
  'meeting-create': z.object({ objective: text(6000),
    memberIds: jsonText(z.array(identifier).max(4).refine(ids => new Set(ids).size === ids.length), 1200),
    requestId: z.union([z.string().uuid(), z.literal('')]),
  }).partial().strict(),
};

// These records are private UI state, never task input, agent context or SSE events.
// Tombstones retain the revision so a delayed write cannot resurrect a cleared draft.
export class UiDrafts {
  constructor(service) { this.service = service; }

  parse(input) {
    const parsed = requestSchema.parse(input);
    const normalize = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (normalize(parsed.workspace) !== normalize(this.service.root)) fail('工作区已变化，草稿仍保留在原窗口', 409);
    const scope = parsed.scope;
    if (scope.kind === 'room-message' || scope.kind === 'managed-request' || scope.kind === 'meeting-create') {
      if (!this.service.store.get('rooms', scope.roomId)) fail('草稿对应的聊天室不存在', 404);
    } else if (scope.kind !== 'new-task' && scope.kind !== 'room-create') {
      if (!this.service.store.get('tasks', scope.taskId)) fail('草稿对应的任务不存在', 404);
      if (scope.kind === 'assistance') {
        const help = this.service.store.get('assistance', scope.questionId);
        if (!help || help.taskId !== scope.taskId || help.planId !== scope.planId) fail('草稿与任务、计划或问题不匹配', 409);
      }
    }
    return { scope, id: createHash('sha256').update(JSON.stringify(scope)).digest('hex') };
  }

  response(scope, record) {
    return { workspace: this.service.root, revision: record?.revision || 0,
      draft: record && !record.deleted ? { scope, values: fieldSchemas[scope.kind].parse(record.values), updatedAt: record.updatedAt } : null };
  }

  read(input) {
    const { scope, id } = this.parse(input);
    return this.response(scope, this.service.store.get('uiDrafts', id));
  }

  write(input) {
    const { values: rawValues, revision, ...request } = z.object({ workspace: requestSchema.shape.workspace, scope: scopeSchema,
      values: z.record(z.unknown()), revision: revisionSchema }).strict().parse(input);
    const { scope, id } = this.parse(request);
    const values = fieldSchemas[scope.kind].parse(rawValues);
    if (Buffer.byteLength(JSON.stringify(values), 'utf8') > 128 * 1024) fail('草稿总量不能超过 128 KiB', 413);
    return this.service.store.transaction(() => {
      const previous = this.service.store.get('uiDrafts', id);
      if ((previous?.revision || 0) !== revision) fail('草稿已在其他窗口更新，当前文字仍保留；重试会保存本窗口的文字', 409);
      const record = { id, scope, values, revision: revision + 1, updatedAt: now(), deleted: false };
      this.service.store.put('uiDrafts', record);
      return this.response(scope, record);
    });
  }

  remove(input) {
    const { revision, ...request } = z.object({ workspace: requestSchema.shape.workspace, scope: scopeSchema, revision: revisionSchema }).strict().parse(input);
    const { scope, id } = this.parse(request);
    return this.service.store.transaction(() => {
      const previous = this.service.store.get('uiDrafts', id);
      if ((previous?.revision || 0) !== revision) fail('草稿已在其他窗口更新，尚未清除；请重新检查后重试', 409);
      const record = { id, scope, values: {}, revision: revision + 1, updatedAt: now(), deleted: true };
      this.service.store.put('uiDrafts', record);
      return this.response(scope, record);
    });
  }
}
