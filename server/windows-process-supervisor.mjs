import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const sourcePath = fileURLToPath(new URL('./windows-process-supervisor.cs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const compiled = new Map();

function supervisorExecutable(directory) {
  const digest = hash(fs.readFileSync(sourcePath));
  const cacheKey = `${directory}:${digest}`;
  const existing = compiled.get(cacheKey);
  if (existing && fs.existsSync(existing)) return existing;
  const filename = path.join(directory, `supervisor-${digest.slice(0, 20)}-${randomUUID()}.exe`);
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework'].map(architecture => path.join(windowsRoot, 'Microsoft.NET', architecture,
    'v4.0.30319', 'csc.exe')).find(candidate => fs.existsSync(candidate));
  if (!compiler) throw new Error('Windows进程树监督器所需的系统.NET编译器不可用，尚未启动成员');
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `compile-${randomUUID()}.exe`);
  const compilation = spawnSync(compiler, ['/nologo', '/target:exe', '/optimize+', '/reference:System.Web.Extensions.dll',
    `/out:${temporary}`, sourcePath], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 64000 });
  if (compilation.error || compilation.status !== 0) {
    try { fs.unlinkSync(temporary); } catch { /* A failed compilation need not create a file. */ }
    throw new Error(`Windows进程树监督器编译失败，尚未启动成员：${compilation.error?.code || compilation.status}`);
  }
  // A fresh host never replaces an executable still loaded by an older
  // surviving supervisor. Only this host's compilation is cached in memory.
  fs.renameSync(temporary, filename);
  compiled.set(cacheKey, filename);
  return filename;
}

export function prepareWindowsSupervision({ executable, args, cwd, directory }) {
  if (process.platform !== 'win32') return null;
  if (!path.isAbsolute(executable) || !path.isAbsolute(cwd) || !Array.isArray(args) ||
      args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('成员启动必须使用绝对程序路径与参数数组');
  const helper = supervisorExecutable(path.join(directory, 'helpers'));
  const identity = randomUUID();
  const controlRoot = path.join(directory, identity);
  fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  const supervision = { version: 1, kind: 'windows_job', id: identity, issuedAt: new Date().toISOString(),
    receiptPath: path.join(controlRoot, 'exit.json'), startPath: path.join(controlRoot, 'start.json') };
  const cancelPath = path.join(controlRoot, 'cancel'), specPath = path.join(controlRoot, 'launch.json');
  fs.writeFileSync(specPath, JSON.stringify({ ...supervision, executable, args, cwd, cancelPath }), { flag: 'wx', mode: 0o600 });
  return { executable: helper, args: [specPath], supervision,
    cancel() { fs.writeFileSync(cancelPath, identity, { mode: 0o600 }); },
    cleanup() { try { fs.unlinkSync(specPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } } };
}

export function inspectWindowsSupervision(processState) {
  const proof = processState?.supervision;
  const unconfirmed = reason => ({ confirmed: false, reason });
  if (proof?.kind !== 'windows_job' || proof.version !== 1 || typeof proof.id !== 'string' ||
      !path.isAbsolute(proof.receiptPath || '') || !Number.isSafeInteger(processState.pid) || processState.pid <= 0) {
    return unconfirmed('缺少受监督的Windows进程树身份，不能凭根PID消失解除隔离');
  }
  try {
    const stat = fs.lstatSync(proof.receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) return unconfirmed('进程树退出记录不是有效的普通文件');
    const receipt = JSON.parse(fs.readFileSync(proof.receiptPath, 'utf8'));
    if (receipt.version !== 1 || receipt.kind !== 'windows_job' || receipt.id !== proof.id || receipt.issuedAt !== proof.issuedAt ||
        receipt.supervisorPid !== processState.pid || receipt.treeExitConfirmed !== true || receipt.activeProcesses !== 0 ||
        !(receipt.assignedBeforeResume === true || receipt.neverResumed === true) ||
        !Number.isFinite(Date.parse(receipt.checkedAt)) || Date.parse(receipt.checkedAt) < Date.parse(proof.issuedAt)) {
      return unconfirmed('进程树退出记录与本次受监督调用不一致');
    }
    return { confirmed: true, method: 'windows_job_empty', pid: processState.pid, checkedAt: receipt.checkedAt,
      supervisionId: proof.id, receipt };
  } catch { return unconfirmed('Windows监督器尚未留下整棵进程树退出证明'); }
}
