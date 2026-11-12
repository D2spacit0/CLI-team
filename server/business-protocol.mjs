import { z } from 'zod';

const identifier = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(6000);
const reference = z.object({ kind: identifier, id: identifier, revision: z.union([z.number().int(), z.string()]).optional(),
  digest: z.string().max(128).optional() }).strict();
const output = z.discriminatedUnion('type', [
  z.object({ type: z.literal('analysis'), sections: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).min(1).max(8) }).strict(),
  z.object({ type: z.literal('files'), files: z.array(z.object({ path: z.string().min(1).max(180),
    format: z.enum(['any', 'text', 'json']).default('any') }).strict()).min(1).max(8) }).strict(),
]);
export const businessActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ask_peer'), memberId: identifier, question: text,
    references: z.array(reference).max(12).default([]) }).strict(),
  z.object({ type: z.literal('contribute'), threadId: identifier.optional(), message: text,
    references: z.array(reference).max(12).default([]) }).strict(),
  z.object({ type: z.literal('request_revision'), workItemId: identifier, reason: text,
    versionId: identifier.optional() }).strict(),
  z.object({ type: z.literal('propose_work'), key: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    title: z.string().trim().min(1).max(120), objective: text, memberId: identifier,
    kind: z.enum(['research', 'copy', 'visual', 'integrate', 'review', 'analysis']),
    dependsOn: z.array(identifier).max(12).default([]), inputRefs: z.array(reference).max(20).default([]),
    output, priority: z.number().int().min(0).max(10).default(5), proposalId: identifier.optional(),
    receiverId: identifier.optional(), acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(8).optional(),
    dueAt: z.string().datetime().optional(),
  }).strict(),
  z.object({ type: z.literal('resolve_work'), workItemId: identifier, generation: z.number().int().positive(),
    decision: z.enum(['retry', 'cancel', 'defer']), reason: text, dueAt: z.string().datetime().optional() }).strict(),
  z.object({ type: z.literal('propose_fact'), factType: z.enum(['fact', 'judgment', 'preference']).default('judgment'),
    content: text, source: z.object({ label: z.string().max(200), url: z.string().max(2000).optional(),
      referenceId: identifier.optional() }).strict(), factId: identifier.optional(), adopt: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('request_tool'), tool: z.enum(['research.read', 'template.render', 'material.read', 'publication.candidates', 'metrics.read']),
    arguments: z.record(z.unknown()).default({}) }).strict(),
]);
export const businessReportSchema = z.object({ version: z.literal(1),
  actions: z.array(businessActionSchema).max(12).default([]),
}).strict();

// JSON schema is supplied to clients that support constrained structured output.
// The Zod schema above remains authoritative at every ingestion boundary.
const str = { type: 'string', minLength: 1, maxLength: 6000 };
const ident = { type: 'string', minLength: 1, maxLength: 200 };
const refs = { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false,
  required: ['kind', 'id'], properties: { kind: ident, id: ident, revision: { anyOf: [{ type: 'integer' }, { type: 'string' }] }, digest: { type: 'string' } } } };
const action = (type, properties, required) => ({ type: 'object', additionalProperties: false,
  required: ['type', ...required], properties: { type: { const: type, type: 'string' }, ...properties } });
export const businessReportJsonSchema = { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
  required: ['version', 'actions'], properties: { version: { const: 1, type: 'integer' }, actions: { type: 'array', maxItems: 12, items: { anyOf: [
    action('ask_peer', { memberId: ident, question: str, references: refs }, ['memberId', 'question']),
    action('contribute', { threadId: ident, message: str, references: refs }, ['message']),
    action('request_revision', { workItemId: ident, reason: str, versionId: ident }, ['workItemId', 'reason']),
    action('propose_work', { key: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' }, title: str, objective: str, memberId: ident,
      kind: { type: 'string', enum: ['research', 'copy', 'visual', 'integrate', 'review', 'analysis'] },
      dependsOn: { type: 'array', maxItems: 12, items: ident }, inputRefs: refs,
      output: { anyOf: [action('analysis', { sections: { type: 'array', minItems: 1, maxItems: 8, items: ident } }, ['sections']),
        action('files', { files: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false,
          required: ['path', 'format'], properties: { path: ident, format: { type: 'string', enum: ['any', 'text', 'json'] } } } } }, ['files'])] },
      priority: { type: 'integer', minimum: 0, maximum: 10 }, proposalId: ident, receiverId: ident,
      acceptanceCriteria: { type: 'array', minItems: 1, maxItems: 8, items: str }, dueAt: { type: 'string', format: 'date-time' } }, ['key', 'title', 'objective', 'memberId', 'kind', 'output']),
    action('resolve_work', { workItemId: ident, generation: { type: 'integer', minimum: 1 },
      decision: { type: 'string', enum: ['retry', 'cancel', 'defer'] }, reason: str, dueAt: { type: 'string', format: 'date-time' } },
    ['workItemId', 'generation', 'decision', 'reason']),
    action('propose_fact', { factType: { type: 'string', enum: ['fact', 'judgment', 'preference'] }, content: str,
      source: { type: 'object', additionalProperties: false, required: ['label'], properties: { label: str, url: str, referenceId: ident } },
      factId: ident, adopt: { type: 'boolean' } }, ['content', 'source']),
    action('request_tool', { tool: { type: 'string', enum: ['research.read', 'template.render', 'material.read', 'publication.candidates', 'metrics.read'] },
      arguments: { type: 'object', additionalProperties: true } }, ['tool', 'arguments']),
  ] } } } }] };
