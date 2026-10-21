import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Fixed developer-test driver for our own Electron renderer. It accepts data and
// named actions only; it never evaluates page content, paths or shell commands.
async function rendererAction({ action, title, ownerId, workerName, oldWorkerName, reviewerId, note }) {
  const normalized = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (element) => Boolean(element && element.getClientRects().length);
  const button = (label, scope = document) => [...scope.querySelectorAll('button')]
    .find((element) => visible(element) && (normalized(element.textContent) === label ||
      element.getAttribute('aria-label') === label ||
      normalized(element.querySelector(':scope > span:not(.nav-badge)')?.textContent) === label));
  const modal = () => document.querySelector('.modal-content');
  const wait = async (check, description) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = check();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const error = normalized(document.querySelector('[role="alert"]')?.textContent).slice(0, 350);
    throw new Error(`协作界面检查失败：${description}${error ? `；界面错误：${error}` : ''}`);
  };
  const taskVisible = () => normalized(document.querySelector('.modal-title')?.textContent) === title;
  const clickButton = async (label, scope = document) => {
    const element = await wait(() => {
      const candidate = button(label, scope);
      return candidate && !candidate.disabled ? candidate : null;
    }, `找不到可用按钮“${label}”`);
    element.click();
  };
  const setValue = (element, value) => {
    if (!element) throw new Error('协作界面检查失败：输入控件缺失');
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };

  if (action === 'open-task') {
    await clickButton('任务看板');
    const card = await wait(() => [...document.querySelectorAll('.task-card')]
      .find((element) => normalized(element.querySelector('.task-card-title')?.textContent) === title), '任务看板未显示种子任务');
    card.click();
    await wait(taskVisible, '任务详情没有打开');
    const text = await wait(() => {
      const content = normalized(modal()?.textContent);
      return content.includes('等待原因：全局调度已暂停') && content.includes('排队中') ? content : null;
    }, '任务进度没有显示真实排队原因');
    return { taskVisible: true, queueReasonVisible: true, excerpt: text.slice(text.indexOf('当前阶段：'), text.indexOf('当前阶段：') + 300) };
  }
  if (action === 'paused-from-attention') {
    await clickButton('关闭任务详情', modal());
    await clickButton('待我处理');
    const item = await wait(() => [...document.querySelectorAll('.attention-item')]
      .find((element) => normalized(element.querySelector('.attention-item-title')?.textContent) === title),
    '主动暂停任务没有出现在待处理页');
    const actionButton = await wait(() => button('继续任务', item), '暂停任务没有明确的继续入口');
    actionButton.click();
    await wait(taskVisible, '继续入口没有打开对应任务');
    await wait(() => normalized(modal()?.textContent).includes('当前阶段：已暂停'), '继续入口没有显示暂停状态');
    return { openedFromAttention: true, actionLabel: normalized(actionButton.textContent),
      continueActionVisible: Boolean(button('继续任务', modal())) };
  }
  if (action === 'pause') {
    await clickButton('暂停任务', modal());
    await wait(() => taskVisible() && normalized(modal()?.textContent).includes('当前阶段：已暂停'), '暂停后没有显示已暂停状态');
    await wait(() => document.querySelector('.task-assignment'), '暂停后没有提供调整分工表单');
    return { pausedVisible: true };
  }
  if (action === 'reassign') {
    const assignment = await wait(() => document.querySelector('.task-assignment'), '调整分工表单不存在');
    if (!assignment.open) assignment.querySelector('summary').click();
    const owner = await wait(() => {
      const element = document.querySelector('#reassign-builder');
      return visible(element) && !element.disabled ? element : null;
    }, '负责人选择框不可用');
    if (![...owner.options].some((option) => option.value === ownerId && !option.disabled)) throw new Error('协作界面检查失败：新负责人不是可选成员');
    setValue(owner, ownerId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const checkbox = (name) => [...assignment.querySelectorAll('.coordination-member')]
      .find((label) => normalized(label.querySelector('strong')?.textContent) === name)?.querySelector('input[type="checkbox"]');
    const oldWorker = await wait(() => checkbox(oldWorkerName), '原协作者选项不存在');
    if (oldWorker.checked) oldWorker.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = await wait(() => checkbox(workerName), '新协作者选项不存在');
    if (worker.disabled) throw new Error('协作界面检查失败：新协作者被错误禁用');
    if (!worker.checked) worker.click();
    setValue(document.querySelector('#reassign-reviewer'), reviewerId);
    setValue(document.querySelector('#reassign-note'), note);
    const save = await wait(() => {
      const element = button('保存分工', assignment);
      return element && !element.disabled ? element : null;
    }, '选择有效负责人、成员池和原因后仍不能保存分工');
    save.click();
    await wait(() => normalized(modal()?.textContent).includes('分工已保存，成果已保留'), '保存分工没有成功提示');
    return { validFormEnabled: true, savedVisible: true };
  }
  if (action === 'continue') {
    await clickButton('继续任务', modal());
    await wait(() => {
      const content = normalized(modal()?.textContent);
      return content.includes('当前阶段：负责人制定计划') && content.includes('等待原因：全局调度已暂停') && button('查看当前作业日志', modal());
    }, '继续后没有显示负责人重新规划及队列等待');
    return { planningVisible: true, queueReasonVisible: true };
  }
  if (action === 'log-and-return') {
    await clickButton('查看当前作业日志', modal());
    const logTitle = await wait(() => {
      const current = normalized(document.querySelector('.modal-title')?.textContent);
      return current.includes('作业执行日志') ? current : null;
    }, '当前作业日志没有打开');
    await clickButton('返回任务', modal());
    await wait(taskVisible, '查看日志后未返回原任务');
    await wait(() => normalized(modal()?.textContent).includes('等待原因：全局调度已暂停'), '返回任务后进度未重新加载');
    const materialsPanels = modal().querySelectorAll('.task-materials').length;
    const coordinationPanels = modal().querySelectorAll('.coordination-panel').length;
    if (materialsPanels !== 1 || coordinationPanels !== 1) {
      throw new Error(`协作界面检查失败：刷新后出现重复面板（材料 ${materialsPanels}，协作 ${coordinationPanels}）`);
    }
    return { openedLogTitle: logTitle, returnedToTask: true, materialsPanels, coordinationPanels };
  }
  throw new Error(`协作界面检查不支持此动作：${action}`);
}

const rendererSource = rendererAction.toString();
function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function smokeWorkspace(workspace) {
  assert.equal(typeof workspace, 'string', '协作检查必须指定独立工作目录');
  assert.ok(path.isAbsolute(workspace), '协作检查目录必须使用绝对路径');
  const resolved = fs.realpathSync(workspace);
  const segments = resolved.split(/[\\/]/).map((segment) => segment.toLowerCase());
  const marker = segments.findIndex((segment, index) => segment === 'work' && segments[index + 1] === 'desktop-smoke');
  assert.ok(marker >= 0 && marker + 2 < segments.length, '拒绝操作真实目录：协作检查仅允许 work/desktop-smoke 下的独立子目录');
  assert.ok(contained(resolved, fs.realpathSync(path.join(resolved, '.team'))), '测试目录的 .team 不得链接到目录外');
  return resolved;
}

export async function runCoordinationSmoke(window, { url, token, workspace, nodePath }) {
  const root = smokeWorkspace(workspace);
  const origin = new URL(url);
  assert.ok(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.port && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, '协作检查只连接本机桌面后端');
  assert.ok(typeof token === 'string' && token.length > 0, '协作检查缺少桌面访问令牌');
  assert.ok(path.isAbsolute(nodePath) && fs.statSync(nodePath).isFile(), '协作检查缺少 Node 运行时');
  assert.ok(window && !window.isDestroyed(), '协作检查需要已加载的桌面窗口');
  assert.equal(new URL(window.webContents.getURL()).origin, origin.origin, '桌面窗口未加载当前测试后端');
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${origin.origin}${route}`, { method,
      headers: { 'X-CLI-Team-Desktop': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    assert.ok(response.ok, `协作检查接口失败 ${method} ${route}：${String(result.error || response.status).replaceAll(token, '[REDACTED]')}`);
    return result;
  };
  const initial = await api('/api/bootstrap?archived=1');
  assert.equal(fs.realpathSync(initial.workspace.root), root, '后端工作目录与独立测试目录不一致，拒绝改写');
  assert.ok(contained(root, fs.realpathSync(initial.workspace.workspacesPath)), '任务目录必须位于独立测试目录内');
  assert.equal(initial.tasks.length, 0, '测试目录已有任务，拒绝覆盖已有工作');
  assert.equal(initial.runs.length, 0, '测试目录已有作业，拒绝改变调度设置');
  assert.equal(initial.meetings.length, 0, '测试目录已有讨论，拒绝改变调度设置');
  assert.equal(initial.workspace.activeRuns, 0, '测试目录仍有执行进程，拒绝运行检查');
  await api('/api/settings', { paused: true }, 'PATCH');
  const suffix = randomBytes(4).toString('hex');
  const createMember = (name, handle, permission = 'edit') => api('/api/members', {
    name: `${name} ${suffix}`, handle: `smoke-${handle}-${suffix}`, provider: 'custom', role: permission === 'plan' ? 'reviewer' : 'builder',
    executable: nodePath, prefixArgs: [], customArgs: [], inputMode: 'stdin', enabled: true, permission,
    skills: `${name}：桌面交互检查专用成员；只检查排队，禁止恢复全局调度`,
  });
  const owner = await createMember('冒烟原负责人', 'owner-a');
  const nextOwner = await createMember('冒烟新负责人', 'owner-b');
  const worker = await createMember('冒烟原协作者', 'worker-a');
  const nextWorker = await createMember('冒烟新协作者', 'worker-b');
  const reviewer = await createMember('冒烟独立评审', 'reviewer', 'plan');
  const task = await api('/api/tasks', { title: `桌面协作检查 ${suffix}`, objective: '验证暂停、调整分工、继续排队和日志返回，不执行模型',
    executionMode: 'delegated', assigneeId: owner.id, participantIds: [worker.id], reviewerId: null,
    requirements: ['保持全局调度暂停', '保留已存在的任务文件'], verification: null, start: true, category: 'test' });
  const taskRoot = fs.realpathSync(task.workspace);
  assert.ok(contained(root, taskRoot) && taskRoot !== root, '服务返回了测试目录外的任务路径');
  const marker = path.join(taskRoot, 'coordination-smoke-preserved.txt');
  const markerContent = `保留成果验证 ${suffix}\n`;
  fs.writeFileSync(marker, markerContent, { flag: 'wx' });
  const progress = () => api(`/api/tasks/${encodeURIComponent(task.id)}/progress`);
  const initialProgress = await progress();
  const initialPlan = initialProgress.currentRuns.find((run) => run.stage === 'plan' && run.memberId === owner.id);
  assert.ok(initialPlan && initialPlan.status === 'queued' && !initialPlan.startedAt, '初始负责人规划必须排队且未启动');
  assert.match(initialPlan.waitReason, /全局调度已暂停/, '后端未提供全局暂停等待原因');
  const runUi = (action, extra = {}) => window.webContents.executeJavaScript(`(${rendererSource})(${JSON.stringify({ action, title: task.title, ...extra })})`, true);
  const ui = { queued: await runUi('open-task') };
  ui.paused = await runUi('pause');
  const paused = await progress();
  assert.equal(paused.active, false, '暂停后作业仍未停稳');
  assert.equal(paused.canReassign, true, '停稳任务没有开放改派');
  ui.attention = await runUi('paused-from-attention');
  assert.equal(ui.attention.openedFromAttention, true, '待处理页没有打开暂停任务');
  assert.equal(ui.attention.continueActionVisible, true, '暂停任务详情缺少继续操作');
  ui.reassigned = await runUi('reassign', { ownerId: nextOwner.id, workerName: nextWorker.name, oldWorkerName: worker.name, reviewerId: reviewer.id, note: '桌面冒烟改派：保留成果，由新的负责人重新规划' });
  const afterSave = (await api('/api/bootstrap')).tasks.find((item) => item.id === task.id);
  assert.equal(afterSave.status, 'blocked', '保存分工不应自动启动任务');
  assert.equal(afterSave.assigneeId, nextOwner.id, '负责人改派没有保存');
  assert.deepEqual(afterSave.participantIds, [nextWorker.id], '协作者名单改派没有保存');
  assert.equal(afterSave.reviewerId, reviewer.id, '独立评审选择没有保存');
  assert.match(afterSave.pendingFeedback, /桌面冒烟改派：保留成果，由新的负责人重新规划/, '改派说明没有保留用于交接');
  assert.equal(fs.readFileSync(marker, 'utf8'), markerContent, '改派覆盖了已有成果');
  ui.continued = await runUi('continue');
  const replanned = await progress();
  const nextPlan = replanned.currentRuns.find((run) => run.stage === 'plan' && run.memberId === nextOwner.id);
  assert.ok(nextPlan && nextPlan.status === 'queued' && !nextPlan.startedAt, '继续后没有为新负责人排队规划作业');
  assert.notEqual(nextPlan.id, initialPlan.id, '继续操作没有创建新一轮规划');
  ui.logs = await runUi('log-and-return');
  const final = await api('/api/bootstrap');
  const finalProgress = await progress();
  assert.equal(final.workspace.paused, true, '协作检查不允许恢复全局调度');
  assert.equal(final.workspace.activeRuns, 0, '协作检查不允许真正启动模型进程');
  assert.ok(finalProgress.runs.every((run) => !run.startedAt && run.status !== 'running'), '协作检查意外启动了作业');
  assert.equal(fs.readFileSync(marker, 'utf8'), markerContent, '继续任务改变了已有成果');
  return { ok: true, workspace: root, taskId: task.id,
    memberIds: { originalOwner: owner.id, newOwner: nextOwner.id, originalWorker: worker.id, newWorker: nextWorker.id, reviewer: reviewer.id },
    initialPlanId: initialPlan.id, replannedRunId: nextPlan.id, queueReason: nextPlan.waitReason,
    globalPaused: final.workspace.paused, actualAgentRunsStarted: 0, preservedFile: marker, ui };
}
