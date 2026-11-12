import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkbench } from './runtime.mjs';
import { redact } from './safety.mjs';

const desktopToken = process.env.CLI_TEAM_DESKTOP_TOKEN || '';
delete process.env.CLI_TEAM_DESKTOP_TOKEN;
const safeMessage = (error) => {
  const message = String(error?.message || error || '桌面后端错误');
  return redact(desktopToken ? message.replaceAll(desktopToken, '[REDACTED]') : message).slice(0, 2000);
};
const send = (message) => new Promise((resolve) => {
  if (!process.connected || !process.send) { resolve(); return; }
  process.send(message, () => resolve());
});
let workbench;
let starting;
let stopping;
let startupFailed = false;
let parentDisconnected = false;
let approvalSession;
const renderRequests = new Map();
function renderContent(spec) {
  if (parentDisconnected || !process.connected) return Promise.reject(new Error('桌面渲染连接已断开。'));
  const id = `backend-content-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { renderRequests.delete(id); reject(new Error('桌面图文渲染超时。')); }, 45000);
    renderRequests.set(id, { resolve, reject, timer });
    void send({ id, type: 'content:render', spec });
  });
}
function status() {
  if (!workbench) return { activeRuns: 0, queuedRuns: 0, runningTasks: 0 };
  return { activeRuns: workbench.service.active.size,
    queuedRuns: workbench.service.store.list('runs').filter((run) => run.status === 'queued').length,
    runningTasks: workbench.service.store.list('tasks').filter((task) => task.status === 'running').length };
}
async function shutdown(message = {}) {
  await starting?.catch(() => {});
  if (stopping) { await stopping; return; }
  if (startupFailed && !workbench) return;
  const snapshot = status();
  if (message.onlyIfIdle && (snapshot.activeRuns || snapshot.queuedRuns || snapshot.runningTasks)) {
    await send({ id: message.id, type: 'busy', message: '仍有任务或作业活动，请先完成或取消后再关闭工作目录' });
    return;
  }
  stopping = (async () => {
    try {
      approvalSession?.close();
      await workbench?.close();
      await send({ id: message.id, type: 'stopped' });
      process.exitCode = startupFailed ? 1 : 0;
    } catch (error) {
      await send({ id: message.id, type: 'error', message: safeMessage(error) });
      process.exitCode = 1;
    } finally {
      if (process.connected) process.disconnect();
    }
  })();
  await stopping;
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'content:render-result') {
    const pending = renderRequests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    renderRequests.delete(message.id);
    if (message.error) { pending.reject(new Error(String(message.error).slice(0, 1000))); return; }
    const result = message.result;
    if (typeof result?.png !== 'string' || result.png.length > 22 * 1024 * 1024) { pending.reject(new Error('桌面图片响应无效。')); return; }
    const { png, ...metadata } = result;
    pending.resolve({ ...metadata, buffer: Buffer.from(png, 'base64') });
  } else if (typeof message.type === 'string' && message.type.startsWith('publication:')) {
    void (async () => {
      await starting;
      if (stopping || parentDisconnected) throw new Error('桌面后端正在关闭。');
      const publications = workbench?.service.publications;
      if (!publications) throw new Error('发布服务尚未就绪。');
      let result;
      if (message.type === 'publication:session') {
        if (path.resolve(message.workspace || '') !== workbench.service.root) throw new Error('发布审批工作区不一致。');
        approvalSession?.close();
        approvalSession = publications.createDesktopApprovalSession({ workspace: publications.root, desktopSession: message.desktopSession });
        result = { established: true };
      } else if (message.type === 'publication:invalidate') {
        approvalSession?.invalidate();
        result = { invalidated: true };
      } else if (message.type === 'publication:login') {
        if (!approvalSession) throw new Error('桌面会话尚未验证。');
        result = await publications.openLogin();
      } else {
        if (!approvalSession) throw new Error('桌面会话尚未验证。');
        if (message.type === 'publication:begin') result = approvalSession.begin({ contentId: message.contentId, versionId: message.versionId, expectedDigest: message.expectedDigest });
        else if (message.type === 'publication:confirm') result = approvalSession.confirm(message.nonce);
        else if (message.type === 'publication:cancel') result = approvalSession.cancel(message.nonce);
        else throw new Error('不支持的发布桌面操作。');
      }
      await send({ id: message.id, type: 'publication:result', result });
    })().catch(error => send({ id: message.id, type: 'error', message: safeMessage(error) }));
  } else if (message.type === 'pause-all') {
    void (async () => {
      await starting;
      const service = workbench?.service;
      if (!service || stopping) throw new Error('本地服务尚未就绪。');
      if (typeof service.pauseAll === 'function') await service.pauseAll();
      else if (typeof service.business?.pauseAll === 'function') await service.business.pauseAll();
      else throw new Error('暂停全部入口尚未就绪。');
      await send({ id: message.id, type: 'paused' });
    })().catch(error => send({ id: message.id, type: 'error', message: safeMessage(error) }));
  } else if (message.type === 'status') {
    if (stopping) { void send({ id: message.id, type: 'error', message: '桌面后端正在关闭' }); return; }
    void send({ id: message.id, type: 'status', ...status() });
  } else if (message.type === 'shutdown') {
    void shutdown(message).catch(async (error) => { await send({ id: message.id, type: 'error', message: safeMessage(error) }); });
  }
});
process.once('disconnect', () => {
  parentDisconnected = true;
  approvalSession?.close();
  for (const pending of renderRequests.values()) { clearTimeout(pending.timer); pending.reject(new Error('桌面渲染连接已断开。')); }
  renderRequests.clear();
  void shutdown();
});
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

starting = (async () => {
  if (!process.send || !process.connected) throw new Error('桌面后端必须由 CLI Team 桌面程序启动');
  const root = process.env.CLI_TEAM_ROOT;
  const assetRoot = process.env.CLI_TEAM_ASSET_ROOT;
  if (!root || !assetRoot) throw new Error('桌面工作目录或界面资源目录未配置');
  workbench = await startWorkbench({ root, distDir: path.join(assetRoot, 'dist'), desktopToken, desktopOnly: true, port: 0,
    serviceOptions: { contentRenderer: renderContent } });
  if (!parentDisconnected) await send({ type: 'ready', url: workbench.url, root: workbench.service.root });
})();
try { await starting; }
catch (error) {
  startupFailed = true;
  await send({ type: 'error', message: safeMessage(error) });
  if (!process.send) console.error(safeMessage(error));
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
