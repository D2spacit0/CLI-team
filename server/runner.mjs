import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { buildInvocation, findExecutable, OutputCollector } from './adapters.mjs';
import { childEnvironment, killChild, redact } from './safety.mjs';
import { executeDsh } from './dsh-runner.mjs';

export async function runProcess({ executable, args, stdin = '', cwd, proxy, timeoutMs, signal, logFile, onLine }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile, { flags: 'w', encoding: 'utf8' });
    let child;
    let remainder = '';
    let output = '';
    let bytes = 0;
    let error = null;
    let timedOut = false;
    let completed = false;
    let timer;
    const finish = (code) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (remainder) onLine?.(remainder);
      log.end(() => resolve({ exitCode: code, output: redact(output), error,
        timedOut, cancelled: Boolean(signal?.aborted) }));
    };
    const cancel = () => killChild(child);
    log.on('error', (failure) => { error = failure.message; cancel(); });
    if (signal?.aborted) { finish(null); return; }
    try {
      child = spawn(executable, args, {
        cwd, env: childEnvironment(proxy), shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (failure) { error = failure.message; finish(null); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      timedOut = true; error = '执行超时'; killChild(child);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) { error = '输出超过 8 MiB 上限'; killChild(child); return; }
      log.write(redact(chunk));
      output = (output + chunk).slice(-64000);
      remainder += chunk;
      const lines = remainder.split(/\r?\n/);
      remainder = lines.pop() || '';
      for (const line of lines) if (line.trim()) {
        try { onLine?.(line); } catch (failure) { error = failure.message; killChild(child); }
      }
      if (remainder.length > 2 * 1024 * 1024) { error = '单个事件过大'; killChild(child); }
    });
    child.stderr.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      log.write(redact(`[stderr] ${chunk}`));
      output = (output + chunk).slice(-64000);
      if (bytes > 8 * 1024 * 1024) { error = '输出超过 8 MiB 上限'; killChild(child); }
    });
    child.on('error', (failure) => { error = failure.message; });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', (failure) => { if (failure.code !== 'EPIPE') error = failure.message; });
    child.stdin.end(stdin);
  });
}

export async function executeAgent(member, prompt, options) {
  if (member.provider === 'dsh') return executeDsh(member, prompt, options);
  let invocation;
  try { invocation = buildInvocation(member, prompt, options); }
  catch (error) {
    if (error.code !== 'CLI_INPUT_TOO_LONG') throw error;
    return { success: false, error: error.message, response: '', report: null,
      riskFlags: ['cli_input_too_long'], exitCode: null };
  }
  const collector = new OutputCollector(member.provider, options.workspace);
  const execution = await runProcess({
    ...invocation, cwd: options.workspace, proxy: options.proxy, signal: options.signal,
    timeoutMs: options.timeoutMinutes * 60000, logFile: options.streamLog,
    onLine: (line) => collector.line(line),
  });
  const result = collector.finish(execution.exitCode);
  if (execution.error) result.riskFlags.push('process_error');
  return { ...result, ...execution, error: execution.error || result.error || null,
    success: result.success && !execution.error && !result.error && !execution.cancelled };
}

export async function executeVerification(verification, options) {
  const executable = findExecutable(verification.executable);
  if (!executable) throw new Error('验收程序不存在');
  if (/\.(cmd|bat|ps1)$/i.test(executable) || /^(cmd|powershell|pwsh|sh|bash|zsh)(\.exe)?$/i.test(path.basename(executable))) {
    throw new Error('验收必须使用程序和参数数组，不支持 shell 命令');
  }
  const result = await runProcess({
    executable, args: verification.args, cwd: options.workspace, proxy: options.proxy,
    timeoutMs: Math.min(options.timeoutMinutes * 60000, 300000),
    signal: options.signal, logFile: options.logFile,
  });
  let testCount = null;
  let skipped = 0;
  const output = stripVTControlCharacters(result.output);
  const counts = output.match(/(?:#|\u2139)\s+tests\s+(\d+)|Ran (\d+) tests?|(\d+) passed/);
  if (counts) testCount = Number(counts[1] || counts[2] || counts[3]);
  const skipMatch = output.match(/(?:#|\u2139)\s+skipped\s+(\d+)|skipped[=:](\d+)|(\d+) skipped/);
  if (skipMatch) skipped = Number(skipMatch[1] || skipMatch[2] || skipMatch[3]);
  const todo = Number(output.match(/(?:#|\u2139)\s+todo\s+(\d+)/)?.[1] || 0);
  const cancelledTests = Number(output.match(/(?:#|\u2139)\s+cancelled\s+(\d+)/)?.[1] || 0);
  const nodeTests = /^node(?:\.exe)?$/i.test(path.basename(executable)) && verification.args.includes('--test');
  const missingTestReport = nodeTests && testCount === null;
  const noTestsExecuted = /skipping running files|no tests found|no tests ran|collected 0 items/i.test(output);
  const passed = result.exitCode === 0 && !result.error && !result.cancelled && testCount !== 0 &&
    skipped === 0 && todo === 0 && cancelledTests === 0 && !missingTestReport && !noTestsExecuted;
  return { ...result, testCount, skipped, todo, cancelledTests, missingTestReport, passed };
}
