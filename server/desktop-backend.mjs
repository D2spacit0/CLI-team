import path from 'node:path';
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
  if (message.type === 'status') {
    if (stopping) { void send({ id: message.id, type: 'error', message: '桌面后端正在关闭' }); return; }
    void send({ id: message.id, type: 'status', ...status() });
  } else if (message.type === 'shutdown') {
    void shutdown(message).catch(async (error) => { await send({ id: message.id, type: 'error', message: safeMessage(error) }); });
  }
});
process.once('disconnect', () => { parentDisconnected = true; void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

starting = (async () => {
  if (!process.send || !process.connected) throw new Error('桌面后端必须由 CLI Team 桌面程序启动');
  const root = process.env.CLI_TEAM_ROOT;
  const assetRoot = process.env.CLI_TEAM_ASSET_ROOT;
  if (!root || !assetRoot) throw new Error('桌面工作目录或界面资源目录未配置');
  workbench = await startWorkbench({ root, distDir: path.join(assetRoot, 'dist'), desktopToken, desktopOnly: true, port: 0 });
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
