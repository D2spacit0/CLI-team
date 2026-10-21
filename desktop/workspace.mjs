import fs from 'node:fs';
import path from 'node:path';

export function defaultWorkspace(appRoot, executableDir, packaged) {
  if (!packaged) return path.resolve(appRoot);
  // A build beside the existing project continues to use its original data.
  let candidate = executableDir;
  for (let level = 0; level < 5; level++, candidate = path.dirname(candidate)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'));
      if (manifest.name === 'cli-team' && fs.existsSync(path.join(candidate, 'server', 'service.mjs'))) return candidate;
    } catch {}
  }
  return path.join(executableDir, 'workspace');
}

export function loadWorkspace(settingsPath, fallback) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (typeof settings.workspace === 'string' && path.isAbsolute(settings.workspace)) return settings.workspace;
  } catch {}
  return fallback;
}

export function saveWorkspace(settingsPath, workspace) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporary = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ workspace }, null, 2), { flag: 'wx' });
  fs.renameSync(temporary, settingsPath);
}

export function trustedSender(event, window, origin) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.startsWith(`${origin}/`));
}
