import fs from 'node:fs';
import path from 'node:path';
import { fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { redact } from '../server/safety.mjs';

const START_TIMEOUT = 30000;
const REQUEST_TIMEOUT = 15000;
const EXIT_TIMEOUT = 5000;

function waitForExit(state, timeout = EXIT_TIMEOUT) {
  if (state.closed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout);
    state.exited.then(() => { clearTimeout(timer); resolve(true); });
  });
}

export class BackendHost extends EventEmitter {
  constructor({ appRoot, nodePath, logPath }) {
    super();
    Object.assign(this, { appRoot, nodePath, logPath, child: null, pending: new Map(), sequence: 0, stopping: false, state: null });
  }

  reportError(error, token = this.token) {
    const message = redact(String(error?.message || error || '本地服务发生错误'));
    this.emit('host-error', new Error(token ? message.replaceAll(token, '[REDACTED]') : message));
  }

  rejectRequests(state, error) {
    for (const pending of this.pending.values()) if (pending.state === state) pending.reject(error);
  }

  async start(root) {
    if (this.child) throw new Error('本地服务尚未关闭，不能重复启动。');
    if (!fs.existsSync(this.nodePath)) throw new Error('桌面运行环境缺失，请重新解压完整程序目录。');
    const token = randomBytes(32).toString('hex');
    this.token = token;
    this.stopping = false;
    let logging = true;
    try { fs.mkdirSync(path.dirname(this.logPath), { recursive: true }); }
    catch (error) { logging = false; this.reportError(new Error(`桌面日志目录不可写：${error.message}`), token); }
    const environment = { ...process.env, CLI_TEAM_ROOT: root, CLI_TEAM_ASSET_ROOT: this.appRoot, CLI_TEAM_DESKTOP_TOKEN: token };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = fork(path.join(this.appRoot, 'server', 'desktop-backend.mjs'), [], {
      execPath: this.nodePath, execArgv: [], cwd: root, env: environment,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const state = { child, closed: false, stopping: false, ready: false, exited: null, stopPromise: null };
    this.child = child;
    this.state = state;
    let resolveExit, resolveReady, rejectReady;
    state.exited = new Promise((resolve) => { resolveExit = resolve; });
    this.exited = state.exited;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timeout = setTimeout(() => rejectReady(new Error('本地服务启动超时，请查看桌面日志。')), START_TIMEOUT);
    const failStart = (error) => { clearTimeout(timeout); rejectReady(error); };
    const finish = (code) => {
      if (state.closed) return;
      state.closed = true;
      failStart(new Error('本地服务未完成启动。'));
      this.rejectRequests(state, new Error('本地服务已退出。'));
      if (this.state === state) { this.child = null; this.url = ''; }
      resolveExit(code);
      if (state.ready && !state.stopping) this.emit('unexpected-exit', code);
    };
    const log = (chunk) => {
      if (!logging) return;
      try { fs.appendFileSync(this.logPath, redact(String(chunk)).replaceAll(token, '[REDACTED]')); }
      catch (error) {
        logging = false;
        this.reportError(new Error(`桌面日志写入失败，后续日志未写入：${error.message}`), token);
      }
    };
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    child.stdout?.on('error', (error) => this.reportError(error, token));
    child.stderr?.on('error', (error) => this.reportError(error, token));
    child.once('close', finish);
    child.once('exit', () => { if (!state.ready) failStart(new Error('本地服务未完成启动。')); });
    child.on('error', (error) => {
      failStart(error);
      this.rejectRequests(state, error);
      if (state.ready && !state.stopping) this.reportError(error, token);
      // A failed spawn can have no PID or exit event. Its later close is idempotent.
      if (!child.pid) finish(null);
    });
    child.once('disconnect', () => {
      const error = new Error('本地服务控制连接已断开。');
      this.rejectRequests(state, error);
      if (!state.ready) failStart(error);
      else if (!state.stopping && !state.closed) this.reportError(error, token);
    });
    child.on('message', (message) => {
      if (!message || typeof message !== 'object' || state.closed) return;
      const pending = this.pending.get(message.id);
      if (pending?.state === state) {
        if (message.type === 'busy' || message.type === 'error') {
          pending.reject(Object.assign(new Error(String(message.message || (message.type === 'busy' ? '任务仍在运行，请停止任务后再切换目录。' : '本地服务操作失败。'))), { code: message.type }));
        } else pending.resolve(message);
        return;
      }
      if (message.type === 'ready' && !state.ready) {
        try {
          const url = new URL(message.url);
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            throw new Error('本地服务返回了无效的连接地址。');
          }
          clearTimeout(timeout);
          state.ready = true;
          this.url = url.origin;
          resolveReady(message);
        } catch (error) { failStart(error); }
      } else if (message.type === 'error') {
        const error = new Error(String(message.message || '本地服务发生错误。'));
        if (!state.ready) failStart(error);
        else this.reportError(error, token);
      }
    });
    try { return await ready; }
    catch (error) {
      clearTimeout(timeout);
      state.stopping = true;
      this.stopping = true;
      try { await this.forceStop(state); }
      catch (stopError) { throw new AggregateError([error, stopError], `${error.message}；${stopError.message}`); }
      throw error;
    }
  }

  request(type, extra = {}) {
    const state = this.state;
    if (!state || state.closed || !state.child.connected) return Promise.reject(new Error('本地服务尚未连接。'));
    const id = `desktop-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const settle = (action, value) => {
        if (!this.pending.has(id)) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        action(value);
      };
      const timeout = setTimeout(() => settle(reject, new Error('本地服务响应超时。')), REQUEST_TIMEOUT);
      this.pending.set(id, { state, resolve: (value) => settle(resolve, value), reject: (error) => settle(reject, error) });
      try {
        state.child.send({ ...extra, id, type }, (error) => { if (error) this.pending.get(id)?.reject(error); });
      } catch (error) { this.pending.get(id)?.reject(error); }
    });
  }

  async forceStop(state) {
    if (state.closed) return;
    const { child } = state;
    state.stopping = true;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        await new Promise((resolve, reject) => {
          let killer, timer, settled = false;
          const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error && !state.closed) reject(error); else resolve();
          };
          try {
            killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.once('error', (error) => finish(new Error(`无法终止本地服务进程树：${error.message}`)));
            killer.once('close', (code) => finish(code === 0 ? null : new Error(`终止本地服务进程树失败（退出码 ${code}）。`)));
            timer = setTimeout(() => {
              try { killer.kill('SIGKILL'); } catch {}
              finish(new Error('终止本地服务进程树超时。'));
            }, EXIT_TIMEOUT);
          } catch (error) { finish(error); }
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    if (!await waitForExit(state)) throw new Error('本地服务仍未退出，请检查桌面日志；已保留进程状态以便重试关闭。');
  }

  async stop({ onlyIfIdle = false } = {}) {
    const state = this.state;
    if (!state || state.closed) return;
    if (state.stopPromise) {
      try { await state.stopPromise; return; }
      catch (error) { if (onlyIfIdle) throw error; }
    }
    state.stopping = true;
    this.stopping = true;
    state.stopPromise = (async () => {
      try {
        await this.request('shutdown', { onlyIfIdle });
      } catch (error) {
        if (onlyIfIdle) {
          state.stopping = false;
          this.stopping = false;
          throw error;
        }
        this.reportError(error);
        await this.forceStop(state);
        return;
      }
      if (!await waitForExit(state)) {
        this.reportError(new Error('本地服务已响应关闭，但未按时退出；正在终止进程树。'));
        await this.forceStop(state);
      }
    })();
    try { await state.stopPromise; }
    finally { state.stopPromise = null; }
  }
}
