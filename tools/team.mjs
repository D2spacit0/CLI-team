import { parseArgs } from 'node:util';
import { request, compact } from './client.mjs';
import { importLocalMaterial } from './materials.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    room: { type: 'string', default: 'team' }, to: { type: 'string' },
    title: { type: 'string' }, objective: { type: 'string' }, assignee: { type: 'string' },
    reviewer: { type: 'string' }, checks: { type: 'string' }, requirements: { type: 'string' },
    members: { type: 'string' }, note: { type: 'string' }, feedback: { type: 'string' },
    'help-id': { type: 'string' }, answer: { type: 'string' },
    timeout: { type: 'string', default: '30000' }, manual: { type: 'boolean', default: false },
    analysis: { type: 'boolean', default: false },
    delegate: { type: 'boolean', default: false },
    'source-session': { type: 'string' },
    draft: { type: 'boolean', default: false },
    file: { type: 'string' }, name: { type: 'string' }, material: { type: 'string' },
    archived: { type: 'boolean', default: false }, category: { type: 'string' }, task: { type: 'string' },
    'request-id': { type: 'string' }, 'manual-delivery': { type: 'boolean', default: false },
  },
});
const [command = 'status', entityId] = positionals;
try {
  let result;
  switch (command) {
    case 'status': result = await request(`/api/control/status${values.archived ? '?archived=1' : ''}`); break;
    case 'room':
      result = await request('/api/rooms', { name: values.name || positionals.slice(1).join(' ') }); break;
    case 'archive':
    case 'restore':
      if (!entityId || !/^(task|room)-/.test(entityId)) throw new Error('需要 TASK_ID 或 ROOM_ID');
      result = await request(`/api/${entityId.startsWith('task-') ? 'tasks' : 'rooms'}/${encodeURIComponent(entityId)}/${command}`, {}); break;
    case 'inbox': result = await request('/api/control/inbox'); break;
    case 'configure-team': {
      if (!values.assignee || !values.members) throw new Error('需要 --assignee 主控成员 ID 和 --members 协作成员 ID 列表');
      const checks = values.checks ? JSON.parse(values.checks) : null;
      result = await request('/api/settings', { managedTeam: { ownerId: values.assignee,
        workerIds: values.members.split(',').map((id) => id.trim()).filter(Boolean), reviewerId: values.reviewer || null,
        verification: checks ? { executable: checks[0], args: checks.slice(1) } : null, autoDeliver: !values['manual-delivery'] } }, { method: 'PATCH' });
      break;
    }
    case 'submit':
      if (!values['request-id'] || !values.objective) throw new Error('需要 submit --request-id UUID --objective 目标；重试时复用同一请求 ID');
      result = await request('/api/requests', { requestId: values['request-id'], objective: values.objective, roomId: values.room,
        ...(values.title ? { title: values.title } : {}) });
      break;
    case 'dsh-list': {
      const catalog = await request('/api/integrations/dsh/sessions');
      result = { sessions: catalog.sessions.map(({ sessionId, title, activity, workspace, eventCount, canControl }) =>
        ({ sessionId, title, activity, workspace, eventCount, canControl })), warnings: catalog.warnings };
      break;
    }
    case 'dsh-import':
      result = await request('/api/integrations/dsh/import', { sessionId: entityId }); break;
    case 'dsh-refresh':
      result = await request('/api/integrations/dsh/refresh', {}); break;
    case 'reset-conversation':
      if (!values.to) throw new Error('需要 --room ROOM_ID 和 --to MEMBER_ID');
      result = await request(`/api/rooms/${encodeURIComponent(values.room)}/members/${encodeURIComponent(values.to)}/reset`, { confirm: true, taskId: values.task }); break;
    case 'send':
      result = await request(`/api/rooms/${encodeURIComponent(values.room)}/messages`, {
        body: positionals.slice(1).join(' '), recipientIds: values.to ? values.to.split(',') : [],
        analysisOnly: values.analysis, taskId: values.task,
      }); break;
    case 'task': {
      const checks = values.checks ? JSON.parse(values.checks) : null;
      result = await request('/api/tasks', {
        title: values.title, objective: values.objective,
        assigneeId: values.assignee || 'antigravity-builder', reviewerId: values.reviewer || null,
        executionMode: values.delegate ? 'delegated' : 'direct',
        participantIds: values.members ? values.members.split(',').map((id) => id.trim()).filter(Boolean) : [],
        requirements: values.requirements ? JSON.parse(values.requirements) : [],
        verification: checks ? { executable: checks[0], args: checks.slice(1) } : null, start: !values.draft,
        sourceSessionId: values['source-session'],
        roomId: values.room, category: values.category || 'work',
      }); break;
    }
    case 'start':
      result = await request(`/api/tasks/${encodeURIComponent(entityId)}/start`, {}); break;
    case 'pause':
      result = await request(`/api/tasks/${encodeURIComponent(entityId)}/pause`, { note: values.note || '' }); break;
    case 'progress':
      result = await request(`/api/tasks/${encodeURIComponent(entityId)}/progress`); break;
    case 'answer': {
      const helpId = values['help-id']?.trim();
      const answer = values.answer?.trim();
      if (!entityId || !helpId || !answer) throw new Error('需要 answer TASK_ID --help-id HELP_ID --answer 答复内容');
      if (answer.length > 6000) throw new Error('协作答复不能超过 6000 个字符');
      result = await request(`/api/tasks/${encodeURIComponent(entityId)}/assistance/${encodeURIComponent(helpId)}/answer`, { answer });
      break;
    }
    case 'assign':
      if (!values.assignee || !values.note) throw new Error('改派需要 --assignee MEMBER_ID 和 --note 原因');
      result = await request(`/api/tasks/${encodeURIComponent(entityId)}/reassign`, {
        assigneeId: values.assignee, reviewerId: values.reviewer || null, note: values.note,
        ...(values.members !== undefined ? { participantIds: values.members.split(',').map((id) => id.trim()).filter(Boolean) } : {}),
      }); break;
    case 'materials':
      result = await request(`/api/tasks/${encodeURIComponent(entityId)}/materials`); break;
    case 'import-material':
      result = await importLocalMaterial(entityId, values.file, values.name); break;
    case 'remove-material':
      if (!values.material) throw new Error('需要 --material MATERIAL_ID');
      result = await request(`/api/tasks/${encodeURIComponent(entityId)}/materials/${encodeURIComponent(values.material)}`, undefined, { method: 'DELETE' }); break;
    case 'meeting':
      result = await request('/api/meetings', { roomId: values.room, objective: values.objective,
        memberIds: (values.members || 'antigravity-builder,antigravity-reviewer').split(',') }); break;
    case 'wait':
      result = await request(`/api/control/wait/${encodeURIComponent(entityId)}?timeout=${Number(values.timeout)}`); break;
    case 'evidence':
      result = await request(entityId.startsWith('evidence-') ? `/api/control/evidence/${encodeURIComponent(entityId)}` : `/api/runs/${encodeURIComponent(entityId)}`); break;
    case 'accept':
      result = await request(`/api/tasks/${encodeURIComponent(entityId)}/accept`, {
        note: values.note || '主控已检查验收证据', acknowledgeMissingGate: values.manual,
      }); break;
    case 'revise':
      result = await request(`/api/tasks/${encodeURIComponent(entityId)}/revise`, { feedback: values.feedback }); break;
    case 'cancel':
      result = await request(`/api/${entityId.startsWith('task-') ? 'tasks' : 'runs'}/${encodeURIComponent(entityId)}/cancel`, {}); break;
    default: throw new Error('命令：status, inbox, configure-team, submit, room, archive, restore, send, task, start, pause, progress, answer, assign, materials, import-material, remove-material, meeting, wait, evidence, accept, revise, cancel, dsh-list, dsh-import, dsh-refresh, reset-conversation');
  }
  console.log(JSON.stringify(compact(result), null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
