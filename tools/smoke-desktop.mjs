import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { killChild } from '../server/safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'work', 'desktop-smoke');
fs.mkdirSync(directory, { recursive: true });
const workspace = fs.mkdtempSync(path.join(directory, 'run-'));
const packaged = process.argv.includes('--packaged');
const coordination = process.argv.includes('--coordination-smoke');
const assistance = process.argv.includes('--assistance-smoke');
const usability = process.argv.includes('--usability-smoke');
const workbench = process.argv.includes('--workbench-smoke');
const managed = process.argv.includes('--managed-smoke');
const experience = process.argv.includes('--experience-smoke');
const taskActions = process.argv.includes('--task-actions-smoke');
const managedRequest = process.argv.includes('--managed-request-smoke');
if ([coordination, assistance, usability, workbench, managed, experience, taskActions, managedRequest].filter(Boolean).length > 1) throw new Error('请分别运行各项桌面场景，每次使用独立测试目录。');
if (assistance || usability || managed || workbench || experience || taskActions) {
  const fixtures = path.join(workspace, '.smoke-fixtures');
  fs.mkdirSync(fixtures);
  for (const name of taskActions ? ['task-actions-cli.mjs'] : experience ? ['experience-cli.mjs'] : workbench ? ['fake-dsh.mjs'] : managed ? ['managed-cli.mjs', 'managed-acceptance.mjs'] : usability ? ['usability-smoke-cli.mjs', 'usability-smoke-acceptance.mjs'] : ['assistance-smoke-cli.mjs', 'assistance-smoke-acceptance.mjs']) {
    fs.copyFileSync(path.join(root, 'tests', 'fixtures', name), path.join(fixtures, name), fs.constants.COPYFILE_EXCL);
  }
}
const executable = packaged ? JSON.parse(fs.readFileSync(path.join(root, 'release', 'latest-desktop.json'), 'utf8')).executable : electron;
const env = { ...process.env, CLI_TEAM_SMOKE_ROOT: workspace, CLI_TEAM_NODE_EXECUTABLE: process.execPath };
if (workbench) env.DSH_HOME = path.join(workspace, '.smoke-dsh');
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [...(packaged ? [] : [root]), '--desktop-smoke', ...(coordination ? ['--coordination-smoke'] : []),
  ...(assistance ? ['--assistance-smoke'] : []), ...(usability ? ['--usability-smoke'] : []), ...(workbench ? ['--workbench-smoke'] : []), ...(managed ? ['--managed-smoke'] : []), ...(experience ? ['--experience-smoke'] : []), ...(taskActions ? ['--task-actions-smoke'] : []), ...(managedRequest ? ['--managed-request-smoke'] : [])], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
const relay = (label) => (chunk) => {
  output = (output + chunk).slice(-4000);
  process.stderr.write(`[desktop:${label}] ${chunk}`);
};
child.stdout.on('data', relay('out'));
child.stderr.on('data', relay('err'));
const timeout = setTimeout(() => killChild(child), workbench ? 420000 : usability || experience || taskActions || managedRequest ? 240000 : assistance || managed ? 180000 : coordination ? 90000 : 60000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
clearTimeout(timeout);
const receipt = path.join(workspace, 'desktop-smoke.json');
if (!fs.existsSync(receipt)) throw new Error(`桌面启动检查未返回结果（${code}）：${output}`);
const result = JSON.parse(fs.readFileSync(receipt, 'utf8'));
if (code !== 0 || !result.ok || !result.rendererLoaded || !result.preloadReady) throw new Error(`桌面检查失败：${JSON.stringify(result)}`);
if (coordination && !result.coordination?.ok) throw new Error('桌面协作操作检查没有返回通过收据。');
if (assistance && !result.assistance?.ok) throw new Error('桌面协助与恢复检查没有返回通过收据。');
if (usability && !result.usability?.ok) throw new Error('桌面使用流程检查没有返回通过收据。');
if (workbench && !result.workbench?.ok) throw new Error('聊天工作台检查没有返回通过收据。');
if (managed && !result.managed?.ok) throw new Error('主控托管检查没有返回通过收据。');
if (experience && !result.experience?.ok) throw new Error(`日常操作检查失败：${JSON.stringify({ receipt, checks: result.experience?.checks })}`);
if (taskActions && !result.taskActions?.ok) throw new Error(`任务操作检查失败：${JSON.stringify({ receipt, checks: result.taskActions?.checks })}`);
if (managedRequest && !result.managedRequest?.ok) throw new Error(`主控目标操作检查失败：${JSON.stringify({ receipt, checks: result.managedRequest?.checks })}`);
if (fs.existsSync(path.join(workspace, '.team', 'service.lock'))) throw new Error('退出后未释放工作目录锁。');
try { process.kill(result.backendPid, 0); throw new Error('退出后本地服务仍在运行。'); }
catch (error) { if (error.code !== 'ESRCH') throw error; }
console.log(JSON.stringify({ ...result, packaged, backendStopped: true, receipt }, null, 2));
