import type { BusinessConnection, BusinessProject, PublicationPreview } from '../types';

export function resolveSettingsProject(projects: BusinessProject[], requestedId?: string | null): { project: BusinessProject | null; error: string } {
  if (requestedId) {
    const project = projects.find(entry => entry.id === requestedId);
    if (!project) return { project: null, error: '指定的项目不存在。请选择要配置的项目。' };
    if (project.status === 'archived') return { project: null, error: `“${project.name}”已归档，不能继续绑定账号或修改团队。` };
    return { project, error: '' };
  }
  return { project: projects.find(entry => entry.status !== 'archived') || null, error: '' };
}

export function projectAccountBound(project: BusinessProject | null, connection: BusinessConnection | null): boolean {
  return Boolean(project?.account?.id && connection?.account?.id && connection.version &&
    project.account.id === connection.account.id && project.account.connectorVersion === connection.version);
}

export function publicationAccountReady(project: BusinessProject | null,
  preview: Pick<PublicationPreview, 'account' | 'connector'> | null): boolean {
  return Boolean(project?.account?.id && preview?.account?.id === project.account.id &&
    preview.account.platform === project.account.platform && preview.account.connectorVersion === project.account.connectorVersion &&
    preview.connector.status === 'ready' && preview.connector.capabilities?.publish === true &&
    projectAccountBound(project, preview.connector));
}

export function accountConnectionStep(project: BusinessProject | null, connection: BusinessConnection | null) {
  const status = connection?.status || 'unavailable';
  if (status === 'ready' && connection?.account?.id && connection.version) {
    if (!project) return { action: 'select' as const, title: '选择要绑定的项目', detail: '当前账号已经检测通过，选择具体项目后再明确绑定。' };
    if (projectAccountBound(project, connection)) return { action: 'done' as const, title: '账号已绑定到这个项目', detail: '回到整稿查看本版检查与审稿；最终发布仍需你的确认。' };
    return { action: 'bind' as const, title: '确认把当前账号绑定到这个项目', detail: '绑定会使这个项目的旧发布检查与批准失效，需要重新审查。' };
  }
  if (connection?.browserOpen) return { action: 'probe' as const, title: '完成浏览器登录后检测连接', detail: '请在已打开的浏览器完成平台登录，再回来检测当前账号。' };
  if (status === 'login_required') return { action: 'login' as const, title: '登录用于发布的平台账号', detail: '在独立浏览器窗口完成登录，再检测连接并明确绑定项目。' };
  return { action: 'probe' as const, title: '先检测发布连接', detail: connection?.reason || connection?.message || '检测会核对浏览器连接与当前账号，不会自动登录或绑定项目。' };
}
