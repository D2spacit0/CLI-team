import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, shell } from 'electron';

const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const shortcut = path.join(root, 'CLI Team 桌面端.lnk');

function inside(directory, filename) {
  const relative = path.relative(directory, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function updateShortcut() {
  try {
    if (process.platform !== 'win32') throw new Error('桌面快捷方式仅支持 Windows。');
    const releases = fs.realpathSync(path.join(root, 'release'));
    if (!inside(root, releases)) throw new Error('release 目录必须位于当前项目内。');
    const latest = JSON.parse(fs.readFileSync(path.join(releases, 'latest-desktop.json'), 'utf8'));
    const target = fs.realpathSync(latest.executable);
    const application = fs.realpathSync(latest.application);
    if (!inside(releases, target) || path.dirname(target) !== application || path.basename(target) !== 'CLI Team.exe'
      || !fs.statSync(target).isFile()) throw new Error('最新桌面程序必须位于本项目 release 目录内。');
    const builtAt = new Date(latest.builtAt);
    if (!Number.isFinite(builtAt.getTime())) throw new Error('最新桌面包缺少有效构建时间。');

    const history = path.join(root, 'work', 'desktop-shortcuts');
    fs.mkdirSync(history, { recursive: true });
    const run = fs.mkdtempSync(path.join(history, 'update-'));
    app.setPath('userData', path.join(run, 'profile'));
    app.setPath('sessionData', path.join(run, 'session'));
    await app.whenReady();

    const existing = fs.lstatSync(shortcut, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('快捷方式路径不是普通文件，未覆盖。');
    const previous = existing ? shell.readShortcutLink(shortcut) : undefined;
    if (previous && (!inside(releases, path.resolve(previous.target)) || path.basename(previous.target) !== 'CLI Team.exe')) {
      throw new Error('现有快捷方式指向自定义程序，未覆盖。');
    }
    const backup = previous ? path.join(run, 'previous.lnk') : null;
    if (backup) fs.copyFileSync(shortcut, backup, fs.constants.COPYFILE_EXCL);
    const description = `CLI Team 桌面工作台 · ${new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(builtAt)}`;
    // Update only the build target and its label; keep any existing launch arguments
    // and working directory. Never touch shortcuts outside this project.
    const options = { target, description, appUserModelId: 'local.cli-team.desktop' };
    if (!previous) Object.assign(options, { cwd: root, icon: target, iconIndex: 0 });
    else if (!previous.icon || path.resolve(previous.icon) === path.resolve(previous.target)) Object.assign(options, { icon: target, iconIndex: 0 });
    if (!shell.writeShortcutLink(shortcut, previous ? 'update' : 'create', options)) throw new Error('Windows 未能保存桌面快捷方式。');
    const written = shell.readShortcutLink(shortcut);
    if (fs.realpathSync(written.target) !== target) throw new Error('快捷方式保存后的目标不一致。');
    const receipt = path.join(run, 'receipt.json');
    fs.writeFileSync(receipt, JSON.stringify({ shortcut, target: written.target, previousTarget: previous?.target ?? null,
      backup, builtAt: latest.builtAt, verified: true }, null, 2));
    console.log(`项目快捷方式：${shortcut}\n更新记录：${receipt}`);
    app.exit(0);
  } catch (error) {
    console.error(`桌面快捷方式更新失败：${error.message}`);
    app.exit(1);
  }
}

// Electron waits for its ESM entry module to finish before emitting ready.
// Keep this promise out of top-level await so whenReady can resolve.
void updateShortcut();
