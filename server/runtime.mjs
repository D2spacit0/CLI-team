import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { TeamService } from './service.mjs';
import { createApp } from './app.mjs';
import { assertStartupAllowed } from './startup-policy.mjs';

function acquireLock(dataDir, instanceId) {
  const filename = path.join(dataDir, 'service.lock');
  const recoveryPath = `${filename}.recovery`;
  const claim = () => {
    const descriptor = fs.openSync(filename, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, instanceId, createdAt: new Date().toISOString() })); }
    finally { fs.closeSync(descriptor); }
  };
  try { claim(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale-lock reclamation so a second starter cannot unlink a lock
    // already acquired by the first. An unreadable lock is never overwritten.
    let recovery;
    try { recovery = fs.openSync(recoveryPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('服务锁正在恢复，请稍后重新启动桌面程序');
      throw error;
    }
    try {
      let owner;
      try { owner = JSON.parse(fs.readFileSync(filename, 'utf8')); }
      catch { throw new Error('服务锁无法读取，请检查工作目录中的 .team/service.lock'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('服务锁记录无效，请检查工作目录中的 .team/service.lock');
      let stopped = false;
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') stopped = true;
        else throw new Error('已有服务进程无法验证，未覆盖服务锁');
      }
      if (!stopped) throw new Error('CLI Team 服务已经运行，请先关闭现有服务后再启动桌面程序');
      fs.unlinkSync(filename);
      claim();
    } finally {
      fs.closeSync(recovery);
      fs.unlinkSync(recoveryPath);
    }
  }
  return () => {
    try {
      const owner = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (owner.instanceId === instanceId) fs.unlinkSync(filename);
    } catch {}
  };
}

function controllerCredential(dataDir, provided) {
  const filename = path.join(dataDir, 'controller.token');
  if (!fs.existsSync(filename)) fs.writeFileSync(filename, provided || randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  const token = fs.readFileSync(filename, 'utf8').trim();
  if (!token) throw new Error('本地主控凭据为空，无法启动服务');
  if (provided !== undefined && token !== provided) throw new Error('提供的本地主控凭据与现有工作目录不一致');
  return token;
}

export async function startWorkbench({ root, dataDir, workspaceRoot, distDir, host = '127.0.0.1', port = 0,
  controllerToken, desktopToken = '', desktopOnly = false, dev = false, serviceOptions = {} } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('需要指定 CLI Team 工作目录');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('CLI Team 服务只能绑定本机回环地址');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('服务端口必须为 0 至 65535 的整数');
  if (desktopOnly && (typeof desktopToken !== 'string' || !desktopToken)) throw new Error('桌面访问凭据未配置');
  if (controllerToken !== undefined && (typeof controllerToken !== 'string' || !controllerToken.trim())) throw new Error('本地主控凭据无效');
  root = path.resolve(root);
  dataDir = path.resolve(dataDir || path.join(root, '.team'));
  workspaceRoot = path.resolve(workspaceRoot || path.join(root, 'workspaces'));
  distDir = path.resolve(distDir || path.join(root, 'dist'));
  assertStartupAllowed(root, dataDir);
  if (!dev && !fs.existsSync(path.join(distDir, 'index.html'))) throw new Error('桌面界面构建缺失，请先运行 npm run build');
  fs.mkdirSync(dataDir, { recursive: true });
  const instanceId = randomUUID();
  const releaseLock = acquireLock(dataDir, instanceId);
  const descriptorPath = path.join(dataDir, 'server.json');
  let service;
  let server;
  let app;
  let vite;
  let closing;
  const releaseDescriptor = () => {
    try {
      const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
      if (descriptor.instanceId === instanceId) fs.unlinkSync(descriptorPath);
    } catch {}
  };
  const onExit = () => { releaseDescriptor(); releaseLock(); };
  process.on('exit', onExit);
  const close = () => {
    if (!closing) closing = (async () => {
      app?.closeStreams();
      const serverClosed = new Promise((resolve, reject) => {
        if (!server?.listening) { resolve(); return; }
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      const results = await Promise.allSettled([serverClosed, service?.close(), vite?.close()]);
      releaseDescriptor();
      releaseLock();
      process.off('exit', onExit);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    })();
    return closing;
  };
  try {
    const token = controllerCredential(dataDir, controllerToken);
    service = new TeamService({ ...serviceOptions, root, dataDir, workspaceRoot });
    app = createApp(service, { controllerToken: token, desktopToken, desktopOnly });
    server = http.createServer(app);
    if (dev) {
      const { createServer } = await import('vite');
      vite = await createServer({ root, server: { middlewareMode: true,
        hmr: desktopOnly ? false : { server }, allowedHosts: ['localhost', '127.0.0.1'],
        watch: { ignored: ['**/.team/**', '**/work/**', '**/workspaces/**'] } }, appType: 'spa' });
      app.use(vite.middlewares);
    } else {
      app.use(express.static(distDir, { index: false, dotfiles: 'deny', cacheControl: !desktopOnly }));
      app.get('/{*page}', (_req, res) => res.sendFile(path.join(distDir, 'index.html'), { cacheControl: !desktopOnly }));
    }
    const address = host === '::1' ? '::1' : '127.0.0.1';
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, address, () => { server.off('error', reject); resolve(); });
    });
    const actualPort = server.address().port;
    const url = `http://${address === '::1' ? '[::1]' : address}:${actualPort}`;
    fs.writeFileSync(descriptorPath, JSON.stringify({ url, port: actualPort, pid: process.pid, root, instanceId,
      desktopOnly, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    return { url, service, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
