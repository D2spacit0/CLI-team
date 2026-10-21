import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inspectCliEntry } from './adapters.mjs';
import { executeDsh } from './dsh-runner.mjs';
import { dshDesktopInfo, dshInstalledVersion } from './dsh-installation.mjs';
import { dshHome } from './dsh-sessions.mjs';
import { childEnvironment, killChild } from './safety.mjs';
import { diagnosticText, runtimeHint } from './runtime-diagnostics.mjs';

export const cliTransports = { dsh: 'acp', claude: 'stream-json', gemini: 'stream-json',
  antigravity: 'stream-json', codex: 'exec-json', opencode: 'run-json', custom: 'custom' };

const stamp = (filename) => {
  try { const value = fs.statSync(filename); return [filename, value.size, value.mtimeMs]; }
  catch { return [filename, null]; }
};

export function runtimeFingerprint(member, sourceHome = dshHome()) {
  const entry = inspectCliEntry(member);
  const files = [entry.executable, entry.entryPoint].filter(Boolean);
  const desktop = dshDesktopInfo(member);
  if (desktop) files.push(desktop.archive);
  if (member.provider === 'dsh') files.push(...['settings.yaml', 'cordis.patch.yml',
    'profiles/acp/cordis.patch.yml', 'profiles/desktop/cordis.patch.yml', 'profiles/web/cordis.patch.yml']
    .map((relative) => path.join(sourceHome, relative)));
  return createHash('sha256').update(JSON.stringify([member.provider, member.executable, member.prefixArgs || [],
    member.customArgs || [], member.inputMode, member.model, member.permission, member.dshConfigProfile || 'auto', files.map(stamp)])).digest('hex');
}

export function memberRuntime(member) {
  const entry = inspectCliEntry(member);
  const fingerprint = runtimeFingerprint(member);
  if (entry.detected && member.runtime?.fingerprint === fingerprint) return member.runtime;
  return { status: entry.detected ? 'unchecked' : 'missing', transport: cliTransports[member.provider],
    fingerprint, entry, error: entry.error, checkedAt: null,
    checks: { entry: entry.detected ? 'passed' : 'failed', launch: 'not_checked', protocol: 'not_checked', model: 'not_checked', authentication: 'not_checked' } };
}


function probeVersion(member, entry, options) {
  return new Promise((resolve) => {
    if (options.signal?.aborted) { resolve({ error: '接入检查已取消', exitCode: null }); return; }
    const child = spawn(entry.executable, [...(member.prefixArgs || []), '--version'], {
      cwd: options.workspace, env: childEnvironment(options.proxy), shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', bytes = 0, error = null;
    const stop = () => { error = '接入检查已取消'; killChild(child); };
    options.signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => { error = 'CLI 版本检查超过 10 秒'; killChild(child); }, 10000);
    const read = (chunk) => {
      bytes += chunk.length;
      if (bytes > 65536) { error = 'CLI 版本检查输出过大'; killChild(child); }
      else output += chunk;
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (cause) => { error = diagnosticText(cause.message); });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      const version = output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] || null;
      resolve({ exitCode, version, error: error || (exitCode !== 0 ? `CLI 版本检查退出码为 ${exitCode}` : !version ? '未识别到 CLI 版本信息' : null) });
    });
  });
}

export async function probeCli(member, options) {
  const entry = inspectCliEntry(member);
  const checks = { entry: entry.detected ? 'passed' : 'failed', launch: 'not_checked', protocol: 'not_checked', model: 'not_checked', authentication: 'not_checked' };
  const base = { checkedAt: new Date().toISOString(), transport: cliTransports[member.provider], entry, checks };
  if (!entry.detected) return { ...base, status: 'missing', error: entry.error };
  if (member.provider === 'custom') return { ...base, status: 'unchecked', error: null,
    hint: '自定义客户端仅检查入口。请通过实际任务验证自定义协议。' };
  if (member.provider !== 'dsh') {
    const result = await probeVersion(member, entry, options);
    checks.launch = result.error ? 'failed' : 'passed';
    return { ...base, ...result, status: result.error ? 'failed' : 'available',
      hint: '版本检查不发送模型请求；登录、模型和任务执行需在实际运行中验证。' };
  }
  const probeId = createHash('sha256').update(member.id).digest('hex').slice(0, 20);
  const directory = path.join(options.dataDir, 'probes', probeId);
  fs.mkdirSync(directory, { recursive: true });
  const result = await executeDsh({ ...member, id: `probe-${probeId}`, permission: 'plan' }, null, {
    ...options, workspace: directory, dataDir: directory, streamLog: path.join(directory, 'connection.ndjson'),
    conversationId: null, analysisOnly: true, timeoutMinutes: 0.5,
  });
  const diagnostics = result.diagnostics;
  checks.launch = diagnostics?.processStarted ? 'passed' : 'failed';
  checks.protocol = diagnostics?.protocolVersion ? 'passed' : 'failed';
  checks.model = result.success && diagnostics?.selectedModel ? 'passed' : diagnostics?.stage === 'model' ? 'failed' : 'not_checked';
  return { ...base, status: result.success ? checks.model === 'passed' ? 'ready' : 'available' : 'failed', error: result.error,
    version: dshInstalledVersion(member), diagnostics,
    models: diagnostics?.models || [], selectedModel: diagnostics?.selectedModel || null,
    hint: result.error ? diagnostics?.hint || runtimeHint(result.error, diagnostics?.stage)
      : `已完成协议握手和会话创建${checks.model === 'passed' ? '，模型配置已确认' : '；此版本未提供模型信息'}。此检查不发送模型请求，尚未验证模型服务认证。` };
}
