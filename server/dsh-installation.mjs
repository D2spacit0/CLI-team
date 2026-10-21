import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractFile, statFile, uncache } from '@electron/asar';

const cliPath = 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js';
const packagePath = 'dsh/node_modules/@deepseek-ai/dsh/package.json';
const archives = new Map();
const file = (name) => { try { return fs.statSync(name).isFile(); } catch { return false; } };
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function dshDesktopCommand(root) {
  return { executable: path.join(root, 'DeepSeek Harness.exe'),
    prefixArgs: ['--expose-internals', path.join(root, 'resources', 'app.asar', cliPath)] };
}

export function dshDesktopInfo(member) {
  if (member?.provider !== 'dsh' || !path.isAbsolute(member.executable || '') ||
      path.basename(member.executable).toLowerCase() !== 'deepseek harness.exe') return null;
  const expected = dshDesktopCommand(path.dirname(member.executable));
  if (member.prefixArgs?.length !== 2 || member.prefixArgs[0] !== '--expose-internals' ||
      !samePath(member.prefixArgs[1], expected.prefixArgs[1]) || !file(expected.executable)) return null;
  const archive = path.join(path.dirname(expected.executable), 'resources', 'app.asar');
  try {
    const stat = fs.statSync(archive);
    const stamp = String([stat.size, stat.mtimeMs]);
    const cached = archives.get(archive);
    if (cached?.stamp === stamp) return cached.info;
    uncache(archive);
    const archiveCli = path.normalize(cliPath);
    const archivePkg = path.normalize(packagePath);
    if (!statFile(archive, archiveCli)?.size || statFile(archive, archivePkg).size > 65536) return null;
    const pkg = JSON.parse(extractFile(archive, archivePkg).toString('utf8'));
    if (pkg.name !== '@deepseek-ai/dsh' || !/^\d+\.\d+\.\d+[-+\w.]*$/.test(pkg.version)) return null;
    const info = { archive, entryPoint: expected.prefixArgs[1], version: pkg.version };
    archives.set(archive, { stamp, info });
    return info;
  } catch { return null; }
}

let registry = { at: 0, roots: [] };
function installedRoots() {
  if (Date.now() - registry.at < 30000) return registry.roots;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-ChildItem -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'DeepSeek Harness*' } | Select-Object -ExpandProperty InstallLocation -ErrorAction SilentlyContinue"],
  { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536, shell: false });
  registry = { at: Date.now(), roots: String(result.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && path.isAbsolute(s)) };
  return registry.roots;
}

export function discoverDshDesktop(roots) {
  if (process.platform !== 'win32') return { executable: '', prefixArgs: [] };
  const candidates = roots || [process.env.DSH_INSTALL_DIR,
    ...[process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean).map((p) => path.join(p, 'deepseek-harness')),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'deepseek-harness')] : []),
    ...installedRoots()];
  for (const root of new Set(candidates.filter((p) => p && path.isAbsolute(p)))) {
    const candidate = dshDesktopCommand(root);
    if (dshDesktopInfo({ provider: 'dsh', ...candidate })) return candidate;
  }
  return { executable: '', prefixArgs: [] };
}

export function dshInstalledVersion(member) {
  const desktop = dshDesktopInfo(member);
  if (desktop) return desktop.version;
  const entry = (member.prefixArgs || []).find((arg) => path.isAbsolute(arg) && /\.[cm]?js$/i.test(arg));
  if (!entry) return null;
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 6; depth++, directory = path.dirname(directory)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (pkg.name === '@deepseek-ai/dsh' && /^\d+\.\d+\.\d+[-+\w.]*$/.test(pkg.version)) return pkg.version;
    } catch {}
  }
  return null;
}

export function usesDshLiveConfig(member) {
  const version = dshInstalledVersion(member);
  const [major, minor] = (version || '0.0').split('.').map(Number);
  return major > 0 || minor >= 2;
}
