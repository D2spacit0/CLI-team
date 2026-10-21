import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import { BackendHost } from './backend-host.mjs';
import { defaultWorkspace, loadWorkspace, saveWorkspace, trustedSender } from './workspace.mjs';

const appRoot = app.getAppPath();
const executableDir = path.dirname(app.getPath('exe'));
const smoke = process.argv.includes('--desktop-smoke');
const smokeRoot = process.env.CLI_TEAM_SMOKE_ROOT || path.join(appRoot, 'work', 'desktop-smoke-invalid');
const stateRoot = smoke ? path.join(smokeRoot, '.desktop') :
  app.isPackaged ? path.join(executableDir, '.desktop') : path.join(appRoot, '.team', 'desktop');
let startupError;
try {
  if (smoke && !process.env.CLI_TEAM_SMOKE_ROOT) throw new Error('启动检查必须指定独立测试目录。');
  fs.mkdirSync(stateRoot, { recursive: true });
  app.setPath('userData', path.join(stateRoot, 'profile'));
  app.setPath('sessionData', path.join(stateRoot, 'session'));
} catch (error) { startupError = error; }
app.setAppUserModelId('local.cli-team.desktop');
const settingsPath = path.join(stateRoot, 'settings.json');
let workspace = smoke ? path.resolve(smokeRoot) :
  loadWorkspace(settingsPath, defaultWorkspace(appRoot, executableDir, app.isPackaged));
const nodePath = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'node.exe') : process.env.CLI_TEAM_NODE_EXECUTABLE;
const backend = new BackendHost({ appRoot, nodePath: nodePath || '', logPath: path.join(stateRoot, 'desktop.log') });
let window, desktopSession, quitting = false, switching = false, started = false, preloadReady = false, closing = false;
let rendererOrigin = '';
let draftLeave;

function flushRendererDrafts() {
  if (!started || !window || window.isDestroyed() || !preloadReady) return Promise.resolve(true);
  if (draftLeave) return draftLeave.promise;
  const requestId = randomUUID();
  let finish;
  const promise = new Promise((resolve) => { finish = resolve; });
  const timer = setTimeout(() => draftLeave?.id === requestId && draftLeave.finish(false), 15000);
  let settled = false;
  draftLeave = { id: requestId, promise, finish: (saved) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish(saved);
  } };
  window.webContents.send('desktop:prepare-leave', requestId);
  return promise;
}
function cancelRendererLeave() {
  if (!draftLeave) return;
  const requestId = draftLeave.id;
  draftLeave.finish(false);
  draftLeave = undefined;
  if (window && !window.isDestroyed()) window.webContents.send('desktop:cancel-leave', requestId);
}
async function allowLeaving({ exit = false } = {}) {
  if (await flushRendererDrafts()) return true;
  let proceed = false;
  try {
    const result = await dialog.showMessageBox(window, { type: 'warning', title: '当前内容尚未全部保存',
      message: '仍有未保存的设置、草稿或正在提交的操作，请返回工作台处理后再离开。',
      detail: exit ? '选择仍然退出会停止当前操作；未保存的设置和文字可能丢失。' : '当前工作目录与填写内容会保留。',
      buttons: exit ? ['返回保存', '仍然退出'] : ['返回保存'], defaultId: 0, cancelId: 0 });
    proceed = exit && result.response === 1;
    return proceed;
  } finally { if (!proceed) cancelRendererLeave(); }
}
async function stopAndQuit(saveDrafts = false) {
  if (quitting) return;
  if (saveDrafts && !await allowLeaving({ exit: true })) return;
  if (quitting) return;
  quitting = true;
  try {
    await backend.stop();
    app.quit();
  } catch (error) {
    quitting = false;
    cancelRendererLeave();
    if (smoke) throw error;
    dialog.showErrorBox('CLI Team 尚未退出', `${error.message}\n当前窗口已保留，请重试关闭。`);
  }
}
async function requestQuit() {
  if (quitting || closing || switching) return;
  closing = true;
  try {
    const status = await backend.request('status').catch(() => ({}));
    if (status.activeRuns || status.queuedRuns || status.runningTasks) {
      const result = await dialog.showMessageBox(window, { type: 'question', title: '退出 CLI Team',
        message: '退出将停止正在执行和排队的任务，成果会保留。', buttons: ['继续工作', '停止任务并退出'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return;
    }
    await stopAndQuit(true);
  } finally { closing = false; }
}
function validate(event) {
  if (!trustedSender(event, window, rendererOrigin)) throw new Error('拒绝来自其他页面的桌面操作。');
}
function setConnectionPolicy() {
  desktopSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${backend.url}/`) && !details.url.startsWith('devtools://') });
  });
  desktopSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'x-cli-team-desktop') delete headers[key];
    if (details.url.startsWith(`${backend.url}/`)) headers['X-CLI-Team-Desktop'] = backend.token;
    callback({ requestHeaders: headers });
  });
}
async function connect(root) {
  fs.mkdirSync(root, { recursive: true });
  await backend.start(root);
  workspace = root;
  rendererOrigin = backend.url;
  setConnectionPolicy();
  if (window) {
    preloadReady = false;
    await window.loadURL(backend.url);
  }
}

if (startupError) {
  if (smoke) { console.error(startupError.message); app.exit(1); }
  else { dialog.showErrorBox('CLI Team 无法准备桌面目录', `${startupError.message}\n请把完整程序放在可写的目录后重试。`); app.quit(); }
}
else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', (event) => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
  app.on('window-all-closed', () => { void stopAndQuit(); });
  backend.on('unexpected-exit', () => {
    if (started && !switching && !quitting) {
      cancelRendererLeave();
      dialog.showErrorBox('CLI Team 本地服务已停止',
        '当前窗口会保留，已保存的任务和文件不受影响。\n尚未保存的文字暂时无法写入，请先复制需要保留的内容，再退出并重新打开桌面程序。');
    }
  });
  backend.on('host-error', (error) => {
    if (!quitting && started) dialog.showErrorBox('CLI Team 本地服务提示', error.message);
  });
  void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  desktopSession = session.fromPartition(`cli-team-${process.pid}`);
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  desktopSession.setPermissionCheckHandler(() => false);
  ipcMain.on('desktop:preload-ready', (event) => { if (trustedSender(event, window, rendererOrigin)) preloadReady = true; });
  ipcMain.on('desktop:leave-ready', (event, requestId, saved) => {
    if (!trustedSender(event, window, rendererOrigin) || requestId !== draftLeave?.id || typeof saved !== 'boolean') return;
    draftLeave.finish(saved);
  });
  ipcMain.handle('desktop:get-info', (event) => { validate(event); return { version: app.getVersion(), workspace, platform: process.platform }; });
  ipcMain.handle('desktop:open-workspace', async (event) => {
    validate(event);
    const error = await shell.openPath(workspace);
    if (error) throw new Error(error);
  });
  ipcMain.handle('desktop:select-workspace', async (event) => {
    validate(event);
    if (switching || closing || quitting) throw new Error('正在切换工作目录或退出，请稍后重试。');
    switching = true;
    const previous = workspace;
    try {
      const selected = await dialog.showOpenDialog(window, { title: '选择 CLI Team 工作目录', defaultPath: workspace,
        properties: ['openDirectory', 'createDirectory'] });
      if (selected.canceled || !selected.filePaths[0] || path.resolve(selected.filePaths[0]) === workspace) return { changed: false, workspace };
      if (!await allowLeaving()) return { changed: false, workspace: previous };
      await backend.stop({ onlyIfIdle: true });
      try { await connect(path.resolve(selected.filePaths[0])); saveWorkspace(settingsPath, workspace); }
      catch (error) {
        await backend.stop();
        try {
          await connect(previous);
          await dialog.showMessageBox(window, { type: 'error', title: '工作目录未切换',
            message: error.message, detail: '已恢复原来的工作目录，原有任务和文件保留。' });
        } catch (rollbackError) {
          dialog.showErrorBox('工作目录恢复失败', `${error.message}\n恢复原目录时：${rollbackError.message}\n请重新打开桌面程序。`);
          await stopAndQuit();
        }
        return { changed: false, workspace: previous };
      }
      return { changed: true, workspace };
    } finally { switching = false; cancelRendererLeave(); }
  });
  try {
    await connect(workspace);
    if (quitting) { await backend.stop(); }
    else {
    window = new BrowserWindow({ width: 1440, height: 960, minWidth: 1040, minHeight: 700, show: false,
      title: 'CLI Team 桌面工作台', backgroundColor: '#101217', autoHideMenuBar: true,
      icon: path.join(appRoot, 'desktop', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(appRoot, 'desktop', 'preload.cjs'), session: desktopSession,
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false,
        backgroundThrottling: !smoke },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${backend.url}/`)) event.preventDefault(); });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      void requestQuit();
    });
    await window.loadURL(backend.url);
    started = true;
    if (smoke) {
      const blocked = await fetch(`${backend.url}/api/health`);
      const health = await fetch(`${backend.url}/api/health`, { headers: { 'X-CLI-Team-Desktop': backend.token } });
      if (blocked.status !== 401 || !health.ok || !preloadReady) throw new Error('桌面服务隔离或安全桥接检查失败。');
      if (['--coordination-smoke', '--assistance-smoke', '--usability-smoke', '--workbench-smoke', '--managed-smoke', '--experience-smoke', '--task-actions-smoke', '--managed-request-smoke'].filter((flag) => process.argv.includes(flag)).length > 1) {
        throw new Error('每项桌面场景检查必须使用不同的独立测试目录。');
      }
      const coordination = process.argv.includes('--coordination-smoke')
        ? await (await import('./coordination-smoke.mjs')).runCoordinationSmoke(window,
          { url: backend.url, token: backend.token, workspace, nodePath: backend.nodePath })
        : undefined;
      const experience = process.argv.includes('--experience-smoke')
        ? await (await import('./experience-smoke.mjs')).runExperienceSmoke(window,
          { url: backend.url, token: backend.token, workspace, nodePath: backend.nodePath,
            prepareLeave: flushRendererDrafts, cancelLeave: cancelRendererLeave })
        : undefined;
      const assistance = process.argv.includes('--assistance-smoke')
        ? await (await import('./assistance-smoke.mjs')).runAssistanceSmoke(window,
          { url: backend.url, token: backend.token, workspace, nodePath: backend.nodePath })
        : undefined;
      const usability = process.argv.includes('--usability-smoke')
        ? await (await import('./usability-smoke.mjs')).runUsabilitySmoke(window,
          { url: backend.url, token: backend.token, workspace, nodePath: backend.nodePath,
            prepareLeave: flushRendererDrafts, cancelLeave: cancelRendererLeave })
        : undefined;
      const workbench = process.argv.includes('--workbench-smoke')
        ? await (await import('./workbench-smoke.mjs')).runWorkbenchSmoke(window,
          { url: backend.url, token: backend.token, workspace, nodePath: backend.nodePath,
            prepareLeave: flushRendererDrafts, cancelLeave: cancelRendererLeave })
        : undefined;
      const taskActions = process.argv.includes('--task-actions-smoke')
        ? await (await import('./task-actions-smoke.mjs')).runTaskActionsSmoke(window,
          { url: backend.url, token: backend.token, workspace, nodePath: backend.nodePath, prepareLeave: flushRendererDrafts, cancelLeave: cancelRendererLeave })
        : undefined;
      const managedRequest = process.argv.includes('--managed-request-smoke')
        ? await (await import('./managed-request-smoke.mjs')).runManagedRequestSmoke(window,
          { url: backend.url, token: backend.token, workspace, nodePath: backend.nodePath, prepareLeave: flushRendererDrafts, cancelLeave: cancelRendererLeave })
        : undefined;
      const screenshot = path.join(workspace, 'desktop-smoke.png');
      const managed = process.argv.includes('--managed-smoke')
        ? await (await import('./managed-smoke.mjs')).runManagedSmoke(window,
          { url: backend.url, token: backend.token, workspace, nodePath: backend.nodePath,
            prepareLeave: flushRendererDrafts, cancelLeave: cancelRendererLeave })
        : undefined;
      fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
      const draftsSaved = await flushRendererDrafts();
      if (!draftsSaved) throw new Error('桌面退出前草稿保存握手未通过。');
      fs.writeFileSync(path.join(workspace, 'desktop-smoke.json'), JSON.stringify({ ok: true, version: app.getVersion(),
        electron: process.versions.electron, rendererLoaded: !window.webContents.isLoading(),
        preloadReady, browserDenied: blocked.status, workspace, screenshot, pid: process.pid, backendPid: backend.child?.pid,
        draftsSaved, ...(coordination ? { coordination } : {}), ...(assistance ? { assistance } : {}),
        ...(usability ? { usability } : {}), ...(workbench ? { workbench } : {}), ...(managed ? { managed } : {}), ...(experience ? { experience } : {}), ...(taskActions ? { taskActions } : {}), ...(managedRequest ? { managedRequest } : {}) }, null, 2));
      await stopAndQuit();
    } else { saveWorkspace(settingsPath, workspace); window.show(); }
    }
  } catch (error) {
    if (smoke) fs.writeFileSync(path.join(workspace, 'desktop-smoke.json'), JSON.stringify({ ok: false, error: error.message }));
    else dialog.showErrorBox('CLI Team 启动失败', `${error.message}\n\n已有任务和文件不会被覆盖。`);
    await stopAndQuit();
  }
  }).catch(async (error) => {
    if (smoke) fs.writeFileSync(path.join(workspace, 'desktop-smoke.json'), JSON.stringify({ ok: false, error: error.message }));
    else dialog.showErrorBox('CLI Team 桌面初始化失败', error.message);
    await stopAndQuit();
  });
}
