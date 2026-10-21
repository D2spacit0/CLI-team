import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// Only this fixed action function is evaluated in our own Electron renderer.
// Task IDs, answers, expected hashes and labels are passed as JSON data.
async function rendererAction({ action, title, answer, stepKey, expectedHash, checkType, expectedLogs, mergedLog }) {
  const normalized = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (element) => Boolean(element && element.getClientRects().length);
  const modal = () => document.querySelector('.modal-content');
  const taskVisible = () => normalized(document.querySelector('.modal-title')?.textContent) === title;
  const button = (label, scope = document) => [...scope.querySelectorAll('button')]
    .find((element) => visible(element) && (normalized(element.textContent) === label || element.getAttribute('aria-label') === label ||
      normalized(element.querySelector(':scope > span:not(.nav-badge)')?.textContent) === label));
  const wait = async (check, description) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const error = normalized(document.querySelector('[role="alert"]')?.textContent).slice(0, 350);
    throw new Error(`协助界面检查失败：${description}${error ? `；${error}` : ''}`);
  };
  const click = async (label, scope = document) => {
    const element = await wait(() => {
      const candidate = button(label, scope);
      return candidate && !candidate.disabled ? candidate : null;
    }, `找不到可用按钮“${label}”`);
    element.scrollIntoView({ block: 'center' });
    element.click();
  };
  const details = (prefix) => [...(modal()?.querySelectorAll('details') || [])]
    .find((element) => normalized(element.querySelector(':scope > summary')?.textContent).startsWith(prefix));
  const expand = async (prefix) => {
    const element = await wait(() => details(prefix), `未显示“${prefix}”`);
    if (!element.open) element.querySelector(':scope > summary').click();
    return element;
  };
  const refresh = async () => click('刷新进度', await wait(() => modal()?.querySelector('.coordination-panel'), '缺少协作进度面板'));

  if (action === 'answer-from-attention') {
    await click('待我处理');
    const item = await wait(() => [...document.querySelectorAll('.attention-item')]
      .find((element) => normalized(element.querySelector('.attention-item-title')?.textContent) === title), '待处理页没有显示求助任务');
    await click('去答复', item);
    await wait(taskVisible, '求助按钮没有打开对应任务');
    const position = await wait(() => {
      const section = modal()?.querySelector('[data-task-section="assistance"]');
      const body = modal()?.querySelector('.modal-body');
      const heading = section?.querySelector(':scope > summary');
      if (!section?.open || !body || !visible(heading)) return null;
      const target = heading.getBoundingClientRect(), viewport = body.getBoundingClientRect();
      return target.top >= viewport.top - 1 && target.bottom <= viewport.bottom + 1
        && body.scrollTop > 0 ? { headingTop: target.top, viewportTop: viewport.top, scrollTop: body.scrollTop } : null;
    }, '求助按钮没有定位到展开的答复区域');
    await wait(() => {
      const input = modal()?.querySelector('[data-task-section="assistance"] textarea[data-draft-question]');
      return visible(input) && !input.disabled;
    }, '定位后的答复表单不可编辑');
    return { openedFromAttention: true, sectionVisibleWithoutTestScrolling: true, ...position };
  }
  if (action === 'open-task') {
    if (modal() && !taskVisible()) await click('关闭任务详情', modal());
    if (!taskVisible()) {
      await click('任务看板');
      const card = await wait(() => [...document.querySelectorAll('.task-card')]
        .find((element) => normalized(element.querySelector('.task-card-title')?.textContent) === title), '任务看板未显示测试任务');
      card.click();
    }
    await wait(taskVisible, '任务详情没有打开');
    await wait(() => modal()?.querySelector('.coordination-panel'), '任务详情没有协作进度');
    return { taskVisible: true };
  }
  if (action === 'blocked-help') {
    const section = await expand('任务内协助');
    const field = await wait(() => {
      const input = section.querySelector('textarea');
      return visible(input) && !input.disabled ? input : null;
    }, '停稳的求助没有可用答复表单');
    field.scrollIntoView({ block: 'center' });
    const articles = section.querySelectorAll(':scope > article');
    if (articles.length !== 1 || !normalized(section.textContent).includes('等待补充答复')) throw new Error('求助记录或阻塞状态显示不正确');
    return { answerFormVisible: true, assistanceCards: articles.length };
  }
  if (action === 'save-answer') {
    const section = await expand('任务内协助');
    const field = await wait(() => {
      const input = section.querySelector('textarea');
      return visible(input) && !input.disabled ? input : null;
    }, '答复输入框不可用');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, answer);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await click('保存答复', section);
    await wait(() => normalized(section.textContent).includes('答复已保存，尚未恢复执行'), '保存后缺少尚未启动的明确提示');
    if (!section.open) throw new Error('答复保存后协助面板意外折叠');
    return { savedVisible: true, panelRemainedOpen: true };
  }
  if (action === 'continue') {
    const feedback = document.querySelector('#blocked-task-feedback');
    if (feedback && feedback.value.trim()) throw new Error('局部恢复检查不应携带重规划反馈');
    await click('继续任务', modal());
    return { continueClicked: true };
  }
  if (action === 'partial-resume') {
    await refresh();
    await wait(() => normalized(modal()?.textContent).includes('可保留已检查的 1/2 步'), '后继失败后没有显示保留 1/2 步');
    return { reusableStepCountVisible: true };
  }
  if (action === 'output-check') {
    const plan = await expand('本轮计划与依赖');
    const step = await wait(() => [...plan.querySelectorAll(':scope > article')]
      .find((element) => normalized(element.querySelector('strong')?.textContent).startsWith(`${stepKey} ·`)), '缺少步骤交付信息');
    const label = checkType === 'analysis' ? '分析结构检查：通过' : '文件交付检查：通过';
    await wait(() => normalized(step.textContent).includes(label), '没有显示步骤交付检查通过');
    const record = await wait(() => [...step.querySelectorAll('details')]
      .find((element) => normalized(element.querySelector(':scope > summary')?.textContent).startsWith('检查记录')), '没有显示检查记录');
    if (!record.open) record.querySelector('summary').click();
    await wait(() => [...record.querySelectorAll('code')].some((element) => visible(element) && element.textContent === expectedHash), '检查记录没有显示真实产物哈希');
    record.scrollIntoView({ block: 'center' });
    return { label, evidenceHashVisible: true };
  }
  if (action === 'review-ready') {
    await refresh();
    await wait(() => normalized(modal()?.textContent).includes('当前阶段：待整体验收'), '最终汇总后没有进入待整体验收');
    return { awaitingAcceptance: true };
  }
  if (action === 'assistance-logs') {
    const section = await expand('任务内协助');
    const articles = section.querySelectorAll(':scope > article');
    const links = [...section.querySelectorAll('button')].filter((element) => visible(element) && /^查看.*日志$/.test(normalized(element.textContent)));
    if (articles.length !== 1 || links.length !== expectedLogs) throw new Error(`求助日志去重失败：记录 ${articles.length}，日志按钮 ${links.length}`);
    const labels = links.map((element) => normalized(element.textContent));
    if (mergedLog && !labels.some((label) => label.includes('负责人处理 / 答复来源'))) throw new Error('同一个答复作业没有合并日志标签');
    links[0].scrollIntoView({ block: 'center' });
    links[0].click();
    await wait(() => normalized(document.querySelector('.modal-title')?.textContent).includes('作业执行日志'), '协助日志没有打开');
    await click('返回任务', modal());
    await wait(taskVisible, '查看日志后没有返回原任务');
    const returned = await expand('任务内协助');
    if (modal().querySelectorAll('.coordination-panel').length !== 1 || returned.querySelectorAll(':scope > article').length !== 1) {
      throw new Error('返回任务后协作面板或求助记录重复');
    }
    returned.scrollIntoView({ block: 'center' });
    return { assistanceCards: articles.length, logButtons: links.length, labels, returnedToTask: true };
  }
  throw new Error(`不支持的协助检查动作：${action}`);
}

const rendererSource = rendererAction.toString();
const contained = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const hashFile = (filename) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

export async function runAssistanceSmoke(window, { url, token, workspace, nodePath }) {
  const root = fs.realpathSync(workspace);
  assert.match(root, /[\\/]work[\\/]desktop-smoke[\\/]run-[^\\/]+$/i, '拒绝在真实工作目录执行协助检查');
  assert.ok(contained(root, fs.realpathSync(path.join(root, '.team'))));
  const origin = new URL(url);
  assert.ok(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.port && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash);
  assert.ok(typeof token === 'string' && token.length > 0);
  assert.ok(path.isAbsolute(nodePath) && fs.statSync(nodePath).isFile());
  assert.ok(window && !window.isDestroyed());
  assert.equal(new URL(window.webContents.getURL()).origin, origin.origin);
  const fixtureRoot = fs.realpathSync(path.join(root, '.smoke-fixtures'));
  assert.ok(contained(root, fixtureRoot));
  const cli = fs.realpathSync(path.join(fixtureRoot, 'assistance-smoke-cli.mjs'));
  const acceptance = fs.realpathSync(path.join(fixtureRoot, 'assistance-smoke-acceptance.mjs'));
  assert.ok(contained(fixtureRoot, cli) && contained(fixtureRoot, acceptance));
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${origin.origin}${route}`, { method, signal: AbortSignal.timeout(10000),
      headers: { 'X-CLI-Team-Desktop': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.ok(response.ok, `协助检查接口失败 ${method} ${route}：${String(data.error || response.status).replaceAll(token, '[REDACTED]')}`);
    return data;
  };
  const initial = await api('/api/bootstrap?archived=1');
  assert.equal(fs.realpathSync(initial.workspace.root), root);
  assert.ok(contained(root, fs.realpathSync(initial.workspace.workspacesPath)));
  assert.equal(initial.tasks.length, 0, '拒绝覆盖已有任务');
  assert.equal(initial.runs.length, 0, '拒绝复用已有执行记录');
  assert.equal(initial.meetings.length, 0, '拒绝操作已有讨论');
  assert.equal(initial.workspace.activeRuns, 0);
  await api('/api/settings', { paused: false, repairLimit: 0, maxParallel: 2 }, 'PATCH');
  const suffix = randomBytes(4).toString('hex');
  const screenshots = [];
  const capture = async (name) => {
    const filename = path.join(root, `assistance-${name}.png`);
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    fs.writeFileSync(filename, (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    screenshots.push(filename);
    return filename;
  };
  const snapshot = async (taskId) => {
    // Read task status after progress so a newly settled run cannot be paired
    // with the blocked task snapshot from before the user clicked Continue.
    const progress = await api(`/api/tasks/${encodeURIComponent(taskId)}/progress`);
    const bootstrap = await api('/api/bootstrap');
    const task = bootstrap.tasks.find((item) => item.id === taskId);
    assert.ok(task);
    return { task, progress };
  };
  const settled = async (taskId, afterRuns = -1) => {
    const deadline = Date.now() + 25000;
    let state;
    while (Date.now() < deadline) {
      state = await snapshot(taskId);
      if (state.progress.totalRuns > afterRuns && !state.progress.active && ['blocked', 'review'].includes(state.task.status)) return state;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`协助任务未停稳：${JSON.stringify({ taskId, status: state?.task.status, summary: state?.task.summary,
      currentRuns: state?.progress.currentRuns?.map(({ stage, status }) => ({ stage, status })) })}`);
  };
  const runUi = (task, action, extra = {}) => {
    assert.equal(new URL(window.webContents.getURL()).origin, origin.origin);
    return window.webContents.executeJavaScript(`(${rendererSource})(${JSON.stringify({ action, title: task.title, ...extra })})`, true);
  };
  const createScenario = async (scenario) => {
    const stateFile = path.join(fixtureRoot, `${scenario}-state.json`);
    const createMember = (actor, permission) => api('/api/members', { name: `固定${scenario}-${actor} ${suffix}`,
      handle: `smoke-${scenario}-${actor}-${suffix}`, provider: 'custom', role: actor === 'reviewer' ? 'reviewer' : 'builder',
      executable: nodePath, prefixArgs: [cli, scenario, stateFile, actor], customArgs: [], inputMode: 'stdin', enabled: true,
      permission, skills: '桌面检查专用固定 Node 协议进程，不调用真实模型。' });
    const owner = await createMember('owner', 'edit');
    const worker = await createMember('worker', scenario === 'direct' ? 'plan' : 'edit');
    const reviewer = await createMember('reviewer', 'plan');
    const task = await api('/api/tasks', { title: `协助${scenario === 'manual' ? '人工答复与恢复' : '答复日志去重'} ${suffix}`,
      objective: '使用固定进程验证负责人派工、求助答复、步骤交付检查与继续执行', executionMode: 'delegated',
      assigneeId: owner.id, participantIds: [worker.id], reviewerId: reviewer.id,
      requirements: ['求助答复不是验收成功', '已通过交付检查的独立产物必须保留'],
      verification: { executable: nodePath, args: ['--test', acceptance] }, start: false, category: 'test' });
    const taskRoot = fs.realpathSync(task.workspace);
    assert.ok(contained(root, taskRoot) && taskRoot !== root);
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, scenario, smokeRoot: root, workspace: taskRoot, calls: [], counts: {} }), { flag: 'wx' });
    await api(`/api/tasks/${encodeURIComponent(task.id)}/start`, {});
    return { task, stateFile, readState: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
  };
  try {
    const manual = await createScenario('manual');
    const blocked = await settled(manual.task.id);
    assert.equal(blocked.task.status, 'blocked');
    assert.equal(blocked.progress.assistance.length, 1);
    const help = blocked.progress.assistance[0];
    assert.equal(help.status, 'blocked');
    assert.deepEqual(manual.readState().calls.map(({ stage }) => stage), ['plan', 'delegate', 'coordinate']);
    assert.notEqual(blocked.task.gate.status, 'passed');
    const ui = { opened: await runUi(manual.task, 'answer-from-attention') };
    await capture('attention-answer');
    ui.blocked = await runUi(manual.task, 'blocked-help');
    await capture('blocked-help');
    const answer = '字段使用 stable_record_id；SMOKE_MANUAL_STABLE_ID。请按此字段继续原步骤。';
    ui.saved = await runUi(manual.task, 'save-answer', { answer });
    const saved = await snapshot(manual.task.id);
    assert.equal(saved.task.status, 'blocked', '保存答复不应启动任务');
    assert.equal(saved.progress.active, false);
    assert.equal(saved.progress.totalRuns, blocked.progress.totalRuns);
    assert.equal(saved.progress.assistance[0].answer, answer);
    assert.equal(saved.progress.assistance[0].status, 'answered');
    assert.equal(manual.readState().calls.length, 3, '保存答复不应启动子进程');
    await capture('answer-saved');
    ui.continued = await runUi(manual.task, 'continue');
    const partial = await settled(manual.task.id, saved.progress.totalRuns);
    assert.equal(partial.task.status, 'blocked');
    assert.match(partial.task.summary, /SMOKE_NEXT_STEP_TEMPORARY_FAILURE/);
    assert.equal(partial.progress.resume.available, true);
    assert.equal(partial.progress.resume.reusableSteps, 1);
    assert.equal(partial.progress.resume.totalSteps, 2);
    const first = partial.progress.coordination.steps.find((step) => step.key === 'prepare');
    assert.equal(first.outputCheck.status, 'passed');
    const prepared = path.join(manual.task.workspace, 'prepared.json');
    const preparedHash = hashFile(prepared);
    assert.equal(first.outputCheck.files[0].sha256, preparedHash);
    ui.partial = await runUi(manual.task, 'partial-resume');
    ui.fileCheck = await runUi(manual.task, 'output-check', { stepKey: 'prepare', checkType: 'files', expectedHash: preparedHash });
    await capture('partial-resume');
    ui.resumed = await runUi(manual.task, 'continue');
    const completed = await settled(manual.task.id, partial.progress.totalRuns);
    assert.equal(completed.task.status, 'review', completed.task.summary);
    assert.equal(completed.task.gate.status, 'passed');
    assert.equal(completed.task.reviewVerdict, 'approve');
    assert.equal(completed.progress.coordination.steps.find((step) => step.key === 'prepare').runId, first.runId);
    assert.equal(hashFile(prepared), preparedHash, '继续任务改写了保留步骤的产物');
    assert.deepEqual(manual.readState().counts, { 'plan:-': 1, 'delegate:prepare': 2, 'coordinate:-': 1,
      'delegate:finish': 2, 'implement:-': 1, 'review:-': 1 });
    ui.review = await runUi(manual.task, 'review-ready');
    ui.manualLogs = await runUi(manual.task, 'assistance-logs', { expectedLogs: 1 });
    await capture('manual-complete');

    const direct = await createScenario('direct');
    const directDone = await settled(direct.task.id);
    assert.equal(directDone.task.status, 'review', directDone.task.summary);
    assert.equal(directDone.task.gate.status, 'passed');
    assert.equal(directDone.task.reviewVerdict, 'approve');
    assert.equal(directDone.progress.assistance.length, 1);
    const directHelp = directDone.progress.assistance[0];
    assert.equal(directHelp.status, 'answered');
    assert.equal(directHelp.coordinatorRunId, directHelp.answerRunId, '去重场景必须真实引用同一个答复作业');
    const analysis = directDone.progress.coordination.steps[0].outputCheck;
    assert.equal(analysis.status, 'passed');
    assert.equal(analysis.type, 'analysis');
    const directUi = { opened: await runUi(direct.task, 'open-task') };
    directUi.analysisCheck = await runUi(direct.task, 'output-check', { stepKey: 'inspect', checkType: 'analysis', expectedHash: analysis.sections[0].sha256 });
    await capture('analysis-check');
    directUi.logs = await runUi(direct.task, 'assistance-logs', { expectedLogs: 1, mergedLog: true });
    await capture('answer-log-dedup');
    assert.deepEqual(direct.readState().calls.map(({ stage }) => stage), ['plan', 'delegate', 'coordinate', 'delegate', 'implement', 'review']);
    return { ok: true, syntheticProtocol: true, realModelCalls: 0,
      actualCliRunsStarted: manual.readState().calls.length + direct.readState().calls.length,
      manual: { taskId: manual.task.id, helpId: help.id, preservedRunId: first.runId, preparedHash,
        savedWithoutStarting: true, reusedSteps: partial.progress.resume.reusableSteps, counts: manual.readState().counts, ui },
      direct: { taskId: direct.task.id, helpId: directHelp.id, sharedAnswerRunId: directHelp.answerRunId,
        counts: direct.readState().counts, ui: directUi }, screenshots };
  } catch (error) {
    await capture('failure').catch(() => {});
    throw error;
  }
}
