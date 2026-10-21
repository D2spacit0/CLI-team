import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import { localOnly, redact, resolveInside } from './safety.mjs';
import { UiDrafts } from './ui-drafts.mjs';

export function createApp(service, { controllerToken = '', desktopToken = '', desktopOnly = false } = {}) {
  if (desktopOnly && !desktopToken) throw new Error('桌面访问凭据未配置');
  const matchesToken = (candidate, expected) => Boolean(typeof candidate === 'string' && expected &&
    Buffer.byteLength(candidate) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(candidate), Buffer.from(expected)));
  const app = express();
  app.disable('x-powered-by');
  app.use(localOnly);
  app.use((req, res, next) => {
    const candidate = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    req.controller = matchesToken(candidate, controllerToken);
    if (desktopOnly) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'");
      if (!req.controller && !matchesToken(req.headers['x-cli-team-desktop'], desktopToken)) {
        return res.status(401).json({ error: '请通过 CLI Team 桌面程序访问' });
      }
    }
    next();
  });
  app.post('/api/tasks/:id/materials', express.json({ limit: '12mb', inflate: false }));
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    if (['POST', 'PATCH', 'PUT'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: '请求需要 application/json' });
    }
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'CLI Team', version: '0.1.0' }));
  app.get('/api/bootstrap', (req, res) => res.json(service.bootstrap({ includeArchived: req.query.archived === '1' })));
  const drafts = new UiDrafts(service);
  app.use('/api/ui-drafts', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.post('/api/ui-drafts/read', (req, res) => res.json(drafts.read(req.body)));
  app.put('/api/ui-drafts', (req, res) => res.json(drafts.write(req.body)));
  app.delete('/api/ui-drafts', (req, res) => res.json(drafts.remove(req.body)));
  app.get('/api/rooms/:id/messages', (req, res) => res.json(service.messages(req.params.id)));
  app.get('/api/rooms/:id/messages/page', (req, res) => res.json(service.messagePage(req.params.id, req.query)));
  app.get('/api/rooms/:id/message-requests/:requestId', (req, res) =>
    res.json(service.messageReceipt(req.params.id, req.params.requestId, req.controller ? 'controller' : 'user')));
  app.post('/api/rooms', (req, res) => res.status(201).json(service.createRoom(req.body)));
  app.post('/api/rooms/:id/archive', (req, res) => res.json(service.setRoomArchived(req.params.id, true)));
  app.post('/api/rooms/:id/restore', (req, res) => res.json(service.setRoomArchived(req.params.id, false)));
  app.post('/api/rooms/:id/messages', (req, res) => res.status(201).json(service.send(req.params.id, req.body, req.controller ? 'controller' : 'user')));
  app.post('/api/rooms/:id/members/:memberId/reset', (req, res) => res.json(service.resetConversation(req.params.id, req.params.memberId, req.body)));
  app.post('/api/members/discover', (_req, res) => res.json(service.discover()));
  app.post('/api/members/:id/probe', async (req, res) => res.json(await service.probeMember(req.params.id)));
  app.get('/api/integrations/dsh/sessions', (_req, res) => res.json(service.dshSessions()));
  app.post('/api/integrations/dsh/import', (req, res) => res.json(service.importDshSession(req.body)));
  app.post('/api/integrations/dsh/refresh', (_req, res) => res.json(service.refreshDshSessions()));
  app.post('/api/members', (req, res) => res.status(201).json(service.saveMember(req.body)));
  app.patch('/api/members/:id', (req, res) => res.json(service.saveMember(req.body, req.params.id)));
  app.patch('/api/settings', (req, res) => res.json(service.updateSettings(req.body)));
  app.post('/api/tasks', (req, res) => res.status(201).json(service.createTask(req.body)));
  app.post('/api/requests', (req, res) => res.status(201).json(service.managedTasks.submit(req.body)));
  app.get('/api/tasks/:id/materials', (req, res) => res.json(service.taskMaterials(req.params.id)));
  app.get('/api/tasks/:id/progress', (req, res) => res.json(service.taskProgress(req.params.id)));
  app.post('/api/tasks/:id/assistance/:helpId/answer', (req, res) =>
    res.json(service.answerTaskAssistance(req.params.id, req.params.helpId, req.body, req.controller ? 'controller' : 'user')));
  app.post('/api/tasks/:id/materials', (req, res) => res.status(201).json(service.importMaterial(req.params.id, req.body)));
  app.delete('/api/tasks/:id/materials/:materialId', (req, res) => res.json(service.removeMaterial(req.params.id, req.params.materialId)));
  app.post('/api/tasks/:id/start', (req, res) => {
    const { expectedState } = z.object({ expectedState: z.literal('unstarted').optional() }).strict().parse(req.body ?? {});
    res.json(expectedState === 'unstarted' ? service.startPreparedTask(req.params.id) : service.startTask(req.params.id));
  });
  app.post('/api/tasks/:id/reassign', (req, res) => res.json(service.reassignTask(req.params.id, req.body, req.controller ? 'controller' : 'user')));
  app.post('/api/tasks/:id/revise', (req, res) => {
    if (typeof req.body.feedback !== 'string' || !req.body.feedback.trim() || req.body.feedback.length > 6000) {
      return res.status(400).json({ error: '需要 1 至 6000 字符的返工要求' });
    }
    res.json(service.startTask(req.params.id, req.body.feedback));
  });
  app.post('/api/tasks/:id/accept', (req, res) => res.json(service.acceptTask(req.params.id, req.body, req.controller ? 'controller' : 'user')));
  app.post('/api/tasks/:id/cancel', (req, res) => res.json(service.cancelTask(req.params.id)));
  app.post('/api/tasks/:id/pause', (req, res) => res.json(service.pauseTask(req.params.id, req.body, req.controller ? 'controller' : 'user')));
  app.post('/api/tasks/:id/archive', (req, res) => res.json(service.setTaskArchived(req.params.id, true)));
  app.post('/api/tasks/:id/restore', (req, res) => res.json(service.setTaskArchived(req.params.id, false)));
  app.post('/api/meetings', (req, res) => res.status(201).json(service.createMeeting(req.body)));
  app.post('/api/runs/:id/cancel', (req, res) => res.json(service.cancelRun(req.params.id)));
  app.get('/api/runs/:id', (req, res) => res.json(service.runDetails(req.params.id)));
  app.get('/api/artifacts/:id/preview', (req, res) => res.json(service.artifactPreview(req.params.id)));
  app.get('/api/artifacts/:id', (req, res) => {
    const { artifact, bytes } = service.artifactFile(req.params.id);
    res.attachment(artifact.name).send(bytes);
  });
  const streams = new Set();
  app.get('/api/events', (req, res) => {
    if (streams.size >= 20) return res.status(429).json({ error: '实时连接数量达到上限' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': desktopOnly ? 'no-store, no-transform' : 'no-cache, no-transform', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'connected', revision: 0, payload: {} })}\n\n`);
    const onChange = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    service.on('change', onChange);
    streams.add(res);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
    heartbeat.unref();
    req.on('close', () => { clearInterval(heartbeat); service.off('change', onChange); streams.delete(res); });
  });
  app.use('/api/control', (req, res, next) => {
    if (!req.controller) return res.status(401).json({ error: '需要本地主控凭据' });
    service.controllerSeen();
    next();
  });
  app.get('/api/control/inbox', (_req, res) => res.json(service.inbox()));
  app.get('/api/control/status', (req, res) => {
    const state = service.bootstrap({ includeArchived: req.query.archived === '1' });
    res.json({ workspace: state.workspace.root, paused: state.workspace.paused, activeRuns: state.workspace.activeRuns,
      managedTeam: state.workspace.managedTeam || null,
      archived: state.archived,
      members: state.members.map(({ id, handle, provider, role, status, skills }) => ({ id, handle, provider, role, status, skills })),
      tasks: state.tasks.slice(0, 12).map(({ id, title, status, gate, summary, roomId, archivedAt, executionMode, assigneeId, coordination, managed, delivery }) =>
        ({ id, title, status, gate, roomId, archivedAt, executionMode: executionMode || 'direct', assigneeId,
          ...(managed ? { managed: true, deliveryStatus: delivery?.status || null } : {}),
          coordination: coordination ? { phase: coordination.phase, round: coordination.round,
            totalSteps: coordination.steps.length, completedSteps: coordination.steps.filter((step) => step.status === 'succeeded').length } : null,
          summary: summary.slice(0, 400) })),
      meetings: state.meetings.slice(0, 5).map(({ id, phase, summary }) => ({ id, phase, summary: summary.slice(0, 400) })),
      externalSessions: state.externalSessions.slice(0, 5).map(({ id, sessionId, title, activity, canControl, eventCount }) =>
        ({ id, sessionId, title, activity, canControl, eventCount })) });
  });
  app.get('/api/control/evidence/:id', (req, res) => {
    const evidence = service.require('evidence', req.params.id);
    const filename = resolveInside(service.dataDir, evidence.logFile);
    const output = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').slice(-5000) : '';
    const { logFile, ...receipt } = evidence;
    res.json({ ...receipt, output: redact(output) });
  });
  app.post('/api/control/notices/:id/resolve', (req, res) => {
    res.json(service.store.update('notices', req.params.id, { resolved: true }));
  });
  app.get('/api/control/wait/:id', async (req, res) => {
    const timeout = Math.max(100, Math.min(60000, Number(req.query.timeout) || 30000));
    const snapshot = () => {
      const task = service.store.get('tasks', req.params.id);
      if (task) return { kind: 'task', id: task.id, state: task.status, summary: task.summary.slice(0, 1500), gate: task.gate,
        terminal: !['backlog', 'running'].includes(task.status) &&
          !service.store.list('runs').some((run) => run.taskId === task.id && service.active.has(run.id)) };
      const meeting = service.store.get('meetings', req.params.id);
      if (meeting) return { kind: 'meeting', id: meeting.id, state: meeting.phase, summary: meeting.summary.slice(0, 1800),
        terminal: ['complete', 'blocked', 'cancelled'].includes(meeting.phase) };
      const storedRun = service.store.get('runs', req.params.id);
      const run = storedRun ? service.publicRun(storedRun) : null;
      if (run) return { kind: 'run', id: run.id, state: run.status, summary: run.summary.slice(0, 1500),
        riskFlags: run.riskFlags, terminal: !['queued', 'running'].includes(run.status) && !service.active.has(run.id) };
      return null;
    };
    const initial = snapshot();
    if (!initial) return res.status(404).json({ error: '记录不存在' });
    if (initial.terminal) return res.json(initial);
    let timer;
    const done = (value) => { clearTimeout(timer); service.off('change', changed); if (!res.writableEnded) res.json(value); };
    const changed = () => { const value = snapshot(); if (value?.terminal) done(value); };
    service.on('change', changed);
    timer = setTimeout(() => done({ ...snapshot(), waiting: true }), timeout);
    res.on('close', () => { clearTimeout(timer); service.off('change', changed); });
    changed();
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error, _req, res, _next) => {
    const status = error instanceof ZodError || error instanceof SyntaxError ? 400 : error.status || 500;
    const message = error instanceof ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : error.message;
    res.status(status).json({ error: redact(message || '请求失败') });
  });
  app.closeStreams = () => { for (const response of streams) response.end(); };
  return app;
}
