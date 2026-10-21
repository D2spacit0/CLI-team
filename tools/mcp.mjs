import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { request, compact } from './client.mjs';
import { importLocalMaterial } from './materials.mjs';

const server = new McpServer({ name: 'cli-team', version: '0.1.0' });
function tool(name, description, shape, handler) {
  server.tool(name, description, shape, async (input) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(compact(await handler(input))) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
}
tool('team_status', 'Get compact team status or the commander decision inbox.', {
  inbox: z.boolean().optional(), includeArchived: z.boolean().default(false),
}, ({ inbox, includeArchived }) => request(inbox ? '/api/control/inbox' : `/api/control/status${includeArchived ? '?archived=1' : ''}`));
tool('team_room', 'Create one reusable project channel. Subsequent tasks share this roomId but keep independent files and CLI sessions.', {
  name: z.string().trim().min(1).max(60),
}, (input) => request('/api/rooms', input));

tool('team_configure_controller', 'Configure the workspace main CLI and permitted workers for future goal requests. Existing tasks retain their team. Verification must be explicitly authorized; missing evidence never auto-passes.', {
  ownerId: z.string(), workerIds: z.array(z.string()).min(1).max(4), reviewerId: z.string().nullable().default(null),
  verification: z.object({ executable: z.string(), args: z.array(z.string()) }).nullable().default(null),
  autoDeliver: z.boolean().default(true),
}, (managedTeam) => request('/api/settings', { managedTeam }, { method: 'PATCH' }));

tool('team_submit_objective', 'Submit one goal to the configured main CLI. It plans, dispatches, reviews every step, requests corrections and delivers after verified final review. Reuse requestId on retries; this never restarts an existing task.', {
  requestId: z.string().uuid(), objective: z.string().trim().min(1).max(12000),
  title: z.string().max(120).optional(), roomId: z.string().default('team'),
}, (input) => request('/api/requests', input));
tool('team_external_sessions', 'List or attach DSH desktop progress read-only. This never acquires desktop write ownership or starts a model.', {
  action: z.enum(['list', 'import', 'refresh']).default('list'), sessionId: z.string().optional(),
}, async ({ action, sessionId }) => {
  if (action === 'import') {
    if (!sessionId) throw new Error('sessionId is required');
    const result = await request('/api/integrations/dsh/import', { sessionId });
    return { ...result, summary: result.summary.slice(0, 700), lastRequest: undefined };
  }
  const result = await request(action === 'list' ? '/api/integrations/dsh/sessions' : '/api/integrations/dsh/refresh',
    action === 'list' ? undefined : {});
  return { sessions: result.sessions.map(({ sessionId: id, title, workspace, activity, canControl, eventCount }) =>
    ({ sessionId: id, title, workspace, activity, canControl, eventCount })), warnings: result.warnings || result.errors || [] };
});
tool('team_message', 'Send a room message to explicit CLI member IDs, or start a bounded two-round discussion.', {
  taskId: z.string().optional().describe('Bind a read-only consultation to this task workspace; omit for room discussion.'),
  roomId: z.string().default('team'), body: z.string(), memberIds: z.array(z.string()).max(4).default([]),
  discussion: z.boolean().default(false),
  analysisOnly: z.boolean().default(false),
}, ({ roomId, body, memberIds, discussion, analysisOnly, taskId }) => discussion
  ? request('/api/meetings', { roomId, objective: body, memberIds })
  : request(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { body, recipientIds: memberIds, analysisOnly, taskId }));
tool('team_task', 'Dispatch an isolated task. sourceSessionId attaches a bounded DSH excerpt, never transfers desktop control or copies source files. Set start:false to stage supplied copies before execution.', {
  executionMode: z.enum(['direct', 'delegated']).default('direct').describe('delegated lets the assignee plan, dispatch participant work and synthesize results before acceptance.'),
  participantIds: z.array(z.string()).max(4).default([]).describe('For delegated mode select 1-4 enabled members, excluding the assignee and independent reviewer.'),
  title: z.string(), objective: z.string(), assigneeId: z.string().default('antigravity-builder'),
  reviewerId: z.string().nullable().default('antigravity-reviewer'), requirements: z.array(z.string()).default([]),
  verification: z.object({ executable: z.string(), args: z.array(z.string()) }).nullable().default(null),
  sourceSessionId: z.string().optional(), start: z.boolean().default(true),
  roomId: z.string().default('team'), category: z.enum(['work', 'test']).default('work'),
}, (input) => request('/api/tasks', input));
tool('team_materials', 'List input hashes, import one explicitly selected local file into a draft task, or remove a draft input. Never use this to select credentials or expand file access. Returns metadata only, not contents. Import before team_decide start; running task inputs are immutable.', {
  taskId: z.string(), action: z.enum(['list', 'import', 'remove']).default('list'),
  file: z.string().optional(), name: z.string().optional(), materialId: z.string().optional(),
}, ({ taskId, action, file, name, materialId }) => {
  if (action === 'import') return importLocalMaterial(taskId, file, name);
  const url = `/api/tasks/${encodeURIComponent(taskId)}/materials`;
  if (action === 'remove') {
    if (!materialId) throw new Error('materialId is required');
    return request(`${url}/${encodeURIComponent(materialId)}`, undefined, { method: 'DELETE' });
  }
  return request(url);
});
tool('team_assign', 'Reassign an idle draft or blocked task while preserving its workspace, source inputs and prior runs. Does not start execution or clear repair history.', {
  taskId: z.string(), assigneeId: z.string(), reviewerId: z.string().nullable(), note: z.string().min(1).max(1200),
  participantIds: z.array(z.string()).min(1).max(4).optional().describe('Replace the authorized worker pool of an idle delegated task; omit to keep the existing pool.'),
}, ({ taskId, ...input }) => request(`/api/tasks/${encodeURIComponent(taskId)}/reassign`, input));
tool('team_progress', 'Read current activity, dependencies, assistance questions, resume checkpoints and reassignment availability. File or analysis structure checks and agent completion are not final acceptance.', {
  taskId: z.string(),
}, ({ taskId }) => request(`/api/tasks/${encodeURIComponent(taskId)}/progress`));

tool('team_answer_assistance', 'Save an answer to a blocked assistance request in the current task plan. Saving does not start a run. Check team_progress, then use team_decide action:"start" explicitly to continue.', {
  taskId: z.string().trim().min(1), helpId: z.string().trim().min(1),
  answer: z.string().trim().min(1).max(6000),
}, ({ taskId, helpId, answer }) => request(`/api/tasks/${encodeURIComponent(taskId)}/assistance/${encodeURIComponent(helpId)}/answer`, { answer }));
tool('team_wait', 'Wait up to 60 seconds for a decision or terminal checkpoint. Ordinary activity does not wake the controller.', {
  id: z.string(), timeoutMs: z.number().int().min(100).max(60000).default(60000),
}, ({ id, timeoutMs }) => request(`/api/control/wait/${encodeURIComponent(id)}?timeout=${timeoutMs}`));
tool('team_evidence', 'Read a bounded evidence excerpt or run result. Do not fetch whole execution histories.', {
  id: z.string(),
}, ({ id }) => request(id.startsWith('evidence-') ? `/api/control/evidence/${encodeURIComponent(id)}` : `/api/runs/${encodeURIComponent(id)}`));
tool('team_decide', 'Start, pause, accept, revise or cancel a task. Pause preserves work for reassignment after processes stop. Archive/restore inactive tasks or channels without deletion or replay. Missing automated verification requires explicit acknowledgement.', {
  id: z.string(), action: z.enum(['start', 'pause', 'accept', 'revise', 'cancel', 'archive', 'restore']), note: z.string().default(''),
  acknowledgeMissingGate: z.boolean().default(false),
}, ({ id, action, note, acknowledgeMissingGate }) => request(
  `/api/${id.startsWith('task-') ? 'tasks' : id.startsWith('room-') ? 'rooms' : 'runs'}/${encodeURIComponent(id)}/${action}`,
  action === 'accept' ? { note, acknowledgeMissingGate } : action === 'revise' ? { feedback: note } : action === 'pause' ? { note } : {}));
await server.connect(new StdioServerTransport());
