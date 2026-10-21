import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { packager } from '@electron/packager';
import electron from 'electron';
import './build-desktop-icon.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('请在 Windows Node.js 24+ 下打包桌面程序。');
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('请先运行 npm run build。');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronPackage = path.join(root, 'node_modules', 'electron');
const installedElectron = JSON.parse(fs.readFileSync(path.join(electronPackage, 'package.json'), 'utf8'));
if (installedElectron.version !== manifest.devDependencies.electron) throw new Error('Electron 版本与项目锁定版本不一致，请先同步依赖。');
// Use the same official checksums as Electron's installer. Cached archives are
// still verified without requiring a fresh GitHub checksum download every time.
const checksums = JSON.parse(fs.readFileSync(path.join(electronPackage, 'checksums.json'), 'utf8'));
const archive = `electron-v${installedElectron.version}-win32-${process.arch}.zip`;
if (!/^[a-f0-9]{64}$/i.test(checksums[archive] || '')) throw new Error('Electron 官方包缺少当前平台的有效校验值。');
const work = path.join(root, 'work', 'desktop-builds');
fs.mkdirSync(work, { recursive: true });
const build = fs.mkdtempSync(path.join(work, 'build-'));
const source = path.join(build, 'app');
fs.mkdirSync(source);
// Explicit allowlist: never include user tasks, local credentials, logs or test data.
for (const directory of ['desktop', 'dist', 'server', 'tools']) fs.cpSync(path.join(root, directory), path.join(source, directory), { recursive: true });
for (const filename of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, filename), path.join(source, filename));
const npmCli = process.env.npm_execpath;
if (!npmCli || !fs.existsSync(npmCli)) throw new Error('请通过 npm run package:desktop 运行打包。');
const install = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit', windowsHide: true });
if (install.status !== 0) throw new Error('桌面依赖准备失败。');
const runtime = path.join(build, 'runtime');
fs.mkdirSync(runtime);
fs.copyFileSync(process.execPath, path.join(runtime, 'node.exe'));
const nodeLicense = path.join(root, 'desktop', 'assets', `node-LICENSE-${process.version}.txt`);
if (!fs.existsSync(nodeLicense)) throw new Error(`需要补充当前 Node 版本的官方 LICENSE：${nodeLicense}`);
fs.copyFileSync(nodeLicense, path.join(runtime, 'LICENSE.txt'));
fs.writeFileSync(path.join(runtime, 'VERSION.txt'), `${process.version}\nLicense source: https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE\n`);
const out = path.join(root, 'release', new Date().toISOString().replaceAll(/[:.]/g, '-'));
const [application] = await packager({ dir: source, out, name: 'CLI Team', platform: 'win32', arch: process.arch,
  electronVersion: manifest.devDependencies.electron, appVersion: manifest.version,
  download: { checksums },
  appBundleId: 'local.cli-team.desktop', executableName: 'CLI Team', overwrite: false, asar: false, prune: false,
  icon: path.join(root, 'desktop', 'assets', 'icon.ico'), extraResource: [runtime],
  win32metadata: { ProductName: 'CLI Team', FileDescription: 'CLI Team 桌面工作台', CompanyName: 'CLI Team' } });
const executable = path.join(application, 'CLI Team.exe');
fs.writeFileSync(path.join(application, '使用说明.txt'), '双击 CLI Team.exe 打开桌面工作台。请保留整个程序目录，不要单独移动 exe。\r\n无需安装 Node.js，不使用外部浏览器。成员客户端需自行安装并登录。\r\n工作目录可在程序设置中切换；关闭程序会停止本地协作服务。\r\n');
fs.mkdirSync(path.join(root, 'release'), { recursive: true });
fs.writeFileSync(path.join(root, 'release', 'latest-desktop.json'), JSON.stringify({ executable, application, version: manifest.version, builtAt: new Date().toISOString() }, null, 2));
const shortcutEnv = { ...process.env };
delete shortcutEnv.ELECTRON_RUN_AS_NODE;
const shortcutUpdate = spawnSync(electron, [path.join(root, 'tools', 'update-desktop-shortcut.mjs')],
  { cwd: root, env: shortcutEnv, stdio: 'inherit', windowsHide: true, timeout: 30000 });
if (shortcutUpdate.error || shortcutUpdate.status !== 0) {
  throw new Error(`桌面包已生成，但项目快捷方式更新失败：${shortcutUpdate.error?.message || `退出代码 ${shortcutUpdate.status}，信号 ${shortcutUpdate.signal || '无'}`}`);
}
console.log(`桌面程序：${executable}`);
