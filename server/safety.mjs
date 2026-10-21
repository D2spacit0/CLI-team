import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveInside(root, target) {
  const resolved = path.resolve(root, target);
  if (!inside(root, resolved)) throw new Error('路径超出工作区');
  let ancestor = resolved;
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  const rootReal = fs.realpathSync(root);
  const ancestorReal = fs.realpathSync(ancestor);
  if (!inside(rootReal, ancestorReal)) throw new Error('路径经过指向工作区外的链接');
  return resolved;
}

export function redact(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|AIza)[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client_secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;}\]]+/gi, '$1[REDACTED]');
}

export function validProxy(proxy) {
  if (!proxy) return '';
  let url;
  try { url = new URL(proxy); } catch { throw new Error('代理地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') throw new Error('代理仅支持无凭据的 HTTP/HTTPS 地址');
  return url.origin;
}

export function systemProxy() {
  if (process.env.CLI_TEAM_PROXY) return validProxy(process.env.CLI_TEAM_PROXY);
  if (process.platform !== 'win32') return '';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  try {
    const config = JSON.parse(result.stdout);
    if (config.ProxyEnable !== 1 || !config.ProxyServer) return '';
    let address = config.ProxyServer;
    if (address.includes('=')) {
      const entries = Object.fromEntries(address.split(';').map((item) => item.split('=').map((part) => part.trim())));
      address = entries.https || entries.http || '';
    }
    return address ? validProxy(address.includes('://') ? address : `http://${address}`) : '';
  } catch { return ''; }
}

export function childEnvironment(proxy) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
  // Nested Node test runners otherwise skip their files while returning exit 0.
  delete env.NODE_TEST_CONTEXT;
  if (proxy === '') {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
  }
  if (proxy) Object.assign(env, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
    http_proxy: proxy, https_proxy: proxy, all_proxy: proxy });
  const bypass = [...new Set(['localhost', '127.0.0.1', '::1', ...[env.NO_PROXY, env.no_proxy]
    .filter(Boolean).flatMap(value => value.split(',').map(item => item.trim()).filter(Boolean))])].join(',');
  env.NO_PROXY = bypass;
  env.no_proxy = bypass;
  return env;
}

export function killChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}

const ignoredDirectories = new Set(['.git', 'node_modules', '.team', '__pycache__', '.venv']);
const privateFile = /(^\.env($|\.)|credentials|\.pem$|\.key$|id_rsa|id_ed25519)/i;

export function manifest(root, { includePrivate = true } = {}) {
  const files = [];
  const skipped = [];
  let totalBytes = 0;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignoredDirectories.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) { skipped.push(relativePath); continue; }
      if (entry.isDirectory()) { resolveInside(root, absolute); walk(absolute); }
      else if (entry.isFile()) {
        if (!includePrivate && privateFile.test(entry.name)) continue;
        if (files.length >= 3000 || stat.size > 20 * 1024 * 1024 || totalBytes + stat.size > 100 * 1024 * 1024) {
          throw new Error('产物超过本地验收大小上限');
        }
        totalBytes += stat.size;
        files.push({ name: entry.name, relativePath, size: stat.size,
          sha256: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') });
      }
    }
  }
  walk(root);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const revision = createHash('sha256').update(JSON.stringify({ files, skipped })).digest('hex');
  return { revision, files, skipped };
}

export function localOnly(req, res, next) {
  const expectedPort = req.socket.localPort;
  const permitted = new Set([`127.0.0.1:${expectedPort}`, `localhost:${expectedPort}`, `[::1]:${expectedPort}`]);
  if (!permitted.has(req.headers.host)) return res.status(403).json({ error: '仅允许本机访问' });
  if (req.headers.origin && ![...permitted].some((host) => req.headers.origin === `http://${host}`)) {
    return res.status(403).json({ error: '拒绝跨站请求' });
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '拒绝跨站请求' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}
