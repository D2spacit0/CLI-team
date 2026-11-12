import { z } from 'zod';

export function installBusinessApi(app, service) {
  const business = service.business;
  app.get('/api/business/state', (_req, res) => res.json(business.state()));
  app.post('/api/projects', (req, res) => res.status(201).json(business.createProject(req.body)));
  app.patch('/api/projects/:id', (req, res) => res.json(business.updateProject(req.params.id, req.body)));
  app.post('/api/projects/:id/pause', (req, res) => res.json(business.pauseProject(req.params.id)));
  app.post('/api/projects/:id/resume', (req, res) => res.json(business.resumeProject(req.params.id)));
  app.post('/api/projects/:id/messages', (req, res) => res.status(201).json(business.tell(req.params.id, req.body, req.controller ? 'controller' : 'user')));
  app.post('/api/projects/:id/facts', (req, res) => res.status(201).json(business.addFact(req.params.id, req.body, req.controller ? 'controller' : 'user')));
  app.patch('/api/projects/:id/facts/:factId', (req, res) => {
    if (req.controller) return res.status(403).json({ error: '主控应提交待采纳资料，由负责人核对后采纳，不能冒充用户修正已采纳事实' });
    res.json(business.reviseFact(req.params.id, req.params.factId, req.body));
  });
  app.post('/api/projects/:id/materials', (req, res) => res.status(201).json(business.importMaterial(req.params.id, req.body, req.controller ? 'controller' : 'user')));
  app.post('/api/projects/:id/account', (req, res) => res.json(business.bindAccount(req.params.id, req.body)));
  app.get('/api/content/:id/preview', (req, res) => res.json(service.publications.preview(req.params.id, req.query.versionId)));
  app.get('/api/content/:id/revisions/:versionId/images/:index', (req, res) => {
    const index = z.coerce.number().int().min(0).max(8).parse(req.params.index);
    const file = business.imageFile(req.params.id, req.params.versionId, index);
    res.setHeader('Cache-Control', 'private, no-store');
    res.type(file.asset.mime).send(file.bytes);
  });
  app.post('/api/content/:id/revision-requests', (req, res) => res.json(business.revisionRequest(req.params.id, req.body, req.controller ? 'controller' : 'user')));
  app.put('/api/content/:id/schedule', (req, res) => res.json(business.schedule(req.params.id, req.body)));
  app.post('/api/content/:id/abandon', (req, res) => res.json(business.abandon(req.params.id)));
  app.post('/api/publications/:id/revoke', (req, res) => res.json(service.publications.revoke(req.params.id)));
  app.post('/api/publications/:id/reconcile', async (req, res) => {
    const input = z.object({ noteUrl: z.string().url().max(2000).optional() }).strict().parse(req.body || {});
    res.json(await service.publications.verify(req.params.id, input));
  });
  app.get('/api/business/connection', (_req, res) => res.json(service.publications.connection()));
  app.post('/api/business/connection/probe', async (_req, res) => res.json(await service.publications.probe()));
  app.post('/api/business/connection/login', (_req, res) => res.status(403).json({ error: '请使用桌面设置中的“打开登录”，普通接口不能打开账号登录窗口' }));
  // A bearer token, a desktop header, or an actor property is not a human click.
  app.all(['/api/publications/approve', '/api/content/:id/approve', '/api/publications/:id/approve'], (_req, res) =>
    res.status(403).json({ error: '发布批准只接受桌面主窗口的原生最终确认' }));
}
