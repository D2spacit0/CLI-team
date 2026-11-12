import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cardSpecSchema } from '../desktop/content-renderer.mjs';

const requestSchema = z.object({ name: z.enum(['render_card', 'publication_connection', 'publication_verify']),
  input: z.unknown() }).strict();

/** Tool calls are structured capabilities, not executable strings or model-selected programs. */
export class BusinessToolService {
  constructor({ store, renderer, publications } = {}) { Object.assign(this, { store, renderer, publications }); }
  capabilities() {
    return [{ name: 'render_card', available: typeof this.renderer === 'function', productionMethod: 'trusted_template' },
      { name: 'publication_connection', available: Boolean(this.publications), readOnly: true },
      { name: 'publication_verify', available: Boolean(this.publications), readOnly: true }];
  }
  async execute(request, context = {}) {
    const { name, input } = requestSchema.parse(request);
    if (!context.projectId || !context.workItemId || !context.sourceRunId || !context.allowedTools?.includes(name)) {
      throw Object.assign(new Error('当前工作项没有调用此业务工具的能力。'), { status: 403 });
    }
    const record = { id: `tool-call-${randomUUID()}`, name, projectId: context.projectId, workItemId: context.workItemId,
      sourceRunId: context.sourceRunId, status: 'running', createdAt: new Date().toISOString() };
    this.store.put('businessToolCalls', record);
    try {
      let result;
      if (name === 'render_card') {
        const spec = cardSpecSchema.parse(input);
        if (!this.renderer) throw new Error('图文模板渲染需要桌面程序保持运行。');
        result = await this.renderer(spec);
        if (!Buffer.isBuffer(result?.buffer) || result.buffer.length > 15 * 1024 * 1024 || result.width !== 1080 || result.height !== 1440) throw new Error('模板渲染返回了无效图片。');
      } else if (name === 'publication_connection') {
        z.object({}).strict().parse(input);
        result = this.publications.connection();
      } else {
        const { attemptId } = z.object({ attemptId: z.string().min(1).max(180) }).strict().parse(input);
        const attempt = this.store.get('publicationAttempts', attemptId);
        if (!attempt || attempt.projectId !== context.projectId) throw new Error('核实对象不属于当前业务项目。');
        result = await this.publications.verify(attemptId);
      }
      this.store.update('businessToolCalls', record.id, { status: 'succeeded', finishedAt: new Date().toISOString(),
        result: name === 'render_card' ? { width: result.width, height: result.height, templateVersion: result.templateVersion, productionMethod: 'trusted_template' } : { status: result.status } });
      return result;
    } catch (error) {
      this.store.update('businessToolCalls', record.id, { status: 'failed', reason: String(error.message).slice(0, 1000), finishedAt: new Date().toISOString() });
      throw error;
    }
  }
}
