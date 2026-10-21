import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// This developer-owned driver runs only against the official smoke renderer.
// Its inputs are fixed scenario data, never agent output or executable code.
async function rendererAction({ action, title, values, ownerId, workerName, missingId, missingName }) {
  const text = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const rendered = (element) => Boolean(element && element.getClientRects().length);
  const testId = (id) => document.querySelector(`[data-testid="${id}"]`);
  const modal = () => document.querySelector('.modal-content');
  const form = () => testId('task-create-form');
  // React commits after the current input event. Hidden Chromium windows can
  // throttle animation frames even when DOM updates remain responsive; only
  // screenshots below need compositor-frame synchronization.
  const settleDom = () => new Promise((resolve) => setTimeout(resolve, 0));
  const wait = async (predicate, description) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const found = predicate();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const error = text(document.querySelector('[role="alert"]')?.textContent).slice(0, 350);
    throw new Error(`使用流程检查失败：${description}${error ? `；${error}` : ''}`);
  };
  const button = (label, scope = document) => [...scope.querySelectorAll('button')].find((element) => rendered(element) &&
    (text(element.textContent) === label || element.getAttribute('aria-label') === label ||
      text(element.querySelector(':scope > span:not(.nav-badge)')?.textContent) === label));
  const click = async (label, scope = document) => {
    const element = await wait(() => {
      const candidate = button(label, scope);
      return candidate && !candidate.matches(':disabled') && candidate;
    }, `找不到可用按钮“${label}”`);
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    element.click();
    await settleDom();
  };
  const clickId = async (id) => {
    const element = await wait(() => {
      const candidate = testId(id);
      return rendered(candidate) && !candidate.matches(':disabled') && candidate;
    }, `找不到可用操作 ${id}`);
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    element.click();
    await settleDom();
  };
  const setValue = async (element, value) => {
    if (!element || element.matches(':disabled')) throw new Error(`输入框不可用：${action}`);
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await settleDom();
  };
  const createField = (name) => testId(`task-create-${name}`) || (name === 'verification'
    ? form()?.querySelector('#task-check-json') : null);
  const createReady = () => form() && createField('title') && !createField('title').matches(':disabled');
  const createValues = () => ({ title: createField('title')?.value || '', objective: createField('objective')?.value || '',
    requirements: createField('requirements')?.value || '', assignee: createField('assignee')?.value || '',
    reviewer: createField('reviewer')?.value || '', verification: createField('verification')?.value || '',
    participants: [...(testId('task-create-participants')?.querySelectorAll('input:checked') || [])]
      .map((input) => text(input.closest('label')?.textContent)).sort() });
  const clippedRect = (element) => {
    const rect = element.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    }
    const centerX = rect.left + rect.width / 2, centerY = rect.top + rect.height / 2;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      fullyVisible: rect.left >= left - 1 && rect.right <= right + 1 && rect.top >= top - 1 && rect.bottom <= bottom + 1,
      centerVisible: centerX >= left && centerX <= right && centerY >= top && centerY <= bottom };
  };
  const expand = async (prefix) => {
    const section = await wait(() => [...(modal()?.querySelectorAll('details') || [])]
      .find((element) => text(element.querySelector(':scope > summary')?.textContent).startsWith(prefix)), `没有找到 ${prefix}`);
    if (!section.open) { section.querySelector(':scope > summary').click(); await settleDom(); }
    return section;
  };
  const taskVisible = () => text(document.querySelector('.modal-title')?.textContent) === title;
  const taskFields = () => ({
    answer: document.querySelector('.coordination-panel textarea'),
    feedback: testId('revise-feedback') || document.querySelector('#blocked-task-feedback'),
    note: testId('accept-note'), acknowledgement: testId('ack-missing-gate'),
  });
  const readTaskDraft = () => {
    const fields = taskFields();
    return { answer: fields.answer?.value || '', feedback: fields.feedback?.value || '', note: fields.note?.value || '',
      acknowledgement: Boolean(fields.acknowledgement?.checked) };
  };
  const waitTaskDraft = async () => {
    await wait(taskVisible, '没有返回原任务');
    await wait(() => {
      const fields = taskFields();
      return (fields.note || fields.answer) && [fields.answer, fields.feedback, fields.note]
        .filter(Boolean).every((field) => !field.matches(':disabled'))
        && !text(modal()?.textContent).includes('正在恢复文字草稿');
    }, '任务草稿输入框尚未恢复');
    await settleDom();
    return readTaskDraft();
  };

  if (action === 'ready') {
    await wait(() => document.querySelector('.nav-item') && !document.querySelector('.loading-screen'), '工作台未就绪');
    return { ready: true, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio } };
  }
  if (action === 'open-create') {
    await click('任务看板');
    await click('新建负责人协作任务');
    await wait(createReady, '新建表单未打开或草稿尚未恢复');
    await settleDom();
    return createValues();
  }
  if (action === 'fill-create') {
    for (const name of ['title', 'objective', 'requirements']) {
      if (Object.hasOwn(values, name)) await setValue(createField(name), values[name]);
    }
    if (Object.hasOwn(values, 'verification')) {
      const label = [...form().querySelectorAll('label')].find((element) => text(element.textContent) ===
        (values.verification ? '运行自动检查' : '人工核对完成标准'));
      const input = label?.querySelector('input[type="radio"]');
      if (!input || input.matches(':disabled')) throw new Error('检查方式不能选择');
      if (!input.checked) { input.click(); await settleDom(); }
      if (values.verification) {
        const [program, ...args] = JSON.parse(values.verification);
        await setValue(document.querySelector('#task-check-program'), program);
        await setValue(document.querySelector('#task-check-args'), args.join('\n'));
      }
    }
    await setValue(createField('assignee'), ownerId);
    await setValue(createField('reviewer'), '');
    const label = await wait(() => [...(testId('task-create-participants')?.querySelectorAll('label') || [])]
      .find((element) => text(element.textContent).includes(workerName)), '协作者选项不存在');
    const member = label.querySelector('input[type="checkbox"]');
    if (!member || member.disabled) throw new Error('固定协作者不能选择');
    if (!member.checked) { member.click(); await settleDom(); }
    return createValues();
  }
  if (action === 'read-create') { await wait(form, '新建草稿未恢复'); return createValues(); }
  if (action === 'close-modal') {
    const close = modal()?.querySelector('.modal-header button');
    if (!close || close.disabled) throw new Error('没有关闭弹窗的按钮');
    close.click();
    await wait(() => !modal(), '关闭按钮没有结束弹窗');
    return { closed: true };
  }
  if (action === 'closed') { await wait(() => !modal(), 'Escape 未关闭弹窗'); return { closed: true }; }
  if (action === 'discard-create') {
    await clickId('task-draft-discard');
    await click('确认放弃草稿', form());
    await wait(() => !modal(), '确认放弃后弹窗未关闭');
    await click('新建负责人协作任务');
    await wait(() => createReady() && !createField('title')?.value && !createField('objective')?.value, '明确放弃后草稿未清空');
    return createValues();
  }
  if (action === 'missing-member') {
    const choices = ['assignee', 'reviewer'].map((name) => {
      const select = createField(name), option = [...(select?.options || [])].find((item) => item.value === missingId);
      if (!select || select.value === missingId || (option && !option.disabled)) throw new Error(`缺失成员在 ${name} 中仍可用`);
      return { field: name, excluded: !option, disabled: Boolean(option?.disabled) };
    });
    const label = [...(testId('task-create-participants')?.querySelectorAll('label') || [])]
      .find((element) => text(element.textContent).includes(missingName));
    const input = label?.querySelector('input');
    if (input && (!input.disabled || input.checked)) throw new Error('缺失成员仍可作为协作者');
    return { choices, participantExcluded: !input, participantDisabled: Boolean(input?.disabled) };
  }
  if (action === 'layout') {
    const dialog = await wait(() => testId('task-create-dialog'), '缺少正式新建弹窗');
    const body = dialog.querySelector('.modal-body');
    if (!body) throw new Error('新建弹窗没有正文滚动区');
    const fields = [...form().querySelectorAll('input:not([type="file"]),select,textarea')].filter(rendered);
    const access = [];
    for (const field of fields) {
      field.scrollIntoView({ block: 'center', behavior: 'instant' });
      await settleDom();
      const rect = clippedRect(field);
      if (!rect.centerVisible) throw new Error(`表单字段被裁切：${field.dataset.testid || field.id || field.type}`);
      access.push({ id: field.dataset.testid || field.id || field.type, accessible: true });
    }
    body.scrollTop = body.scrollHeight;
    await settleDom();
    const primary = ['task-create-submit', 'task-create-start'].map((id) => {
      const element = testId(id);
      if (!rendered(element)) throw new Error(`主操作缺失：${id}`);
      const rect = clippedRect(element);
      if (!rect.fullyVisible) throw new Error(`主操作被裁切：${id} ${JSON.stringify(rect)}`);
      return { id, disabled: element.disabled, rect };
    });
    const focusable = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],summary')].filter(rendered);
    const first = dialog.querySelector('.modal-header button');
    first.focus();
    return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, body: {
      clientHeight: body.clientHeight, scrollHeight: body.scrollHeight, scrollTop: body.scrollTop }, fields: access, primary,
      keyboardLimit: focusable.length * 2 + 4 };
  }
  if (action === 'focus') {
    await settleDom();
    const element = document.activeElement;
    return { id: element?.dataset?.testid || '', tag: element?.tagName, label: text(element?.textContent).slice(0, 80),
      visible: rendered(element) && clippedRect(element).fullyVisible };
  }
  if (action === 'open-task') {
    await click('任务看板');
    const card = await wait(() => [...document.querySelectorAll('.task-card')]
      .find((element) => text(element.querySelector('.task-card-title')?.textContent) === title), '测试任务没有出现在看板');
    card.click();
    await wait(taskVisible, '任务详情未打开');
    await wait(() => modal()?.querySelector('.coordination-panel') && !text(modal().textContent).includes('正在读取此任务'), '进度未加载');
    return { taskVisible: true };
  }
  if (action === 'task-callout') {
    await click('团队讨论');
    const summaryElement = await wait(() => document.querySelector('[data-testid="room-task-scope"]'), '消息流没有显示任务待办入口');
    const summary = text(summaryElement.textContent);
    const calloutText = text(summaryElement.textContent);
    const actionButton = button(/处理验收|去答复|查看原因/.exec(calloutText)?.[0], summaryElement);
    if (!actionButton) throw new Error('任务待办入口缺少处理操作');
    actionButton.click();
    await wait(taskVisible, '消息流待办卡没有打开对应任务');
    await wait(() => modal()?.querySelector('.coordination-panel') && !text(modal().textContent).includes('正在读取此任务'), '待办卡打开后进度未加载');
    return { callout: calloutText, summary };
  }
  if (action === 'fill-task-draft') {
    if (Object.hasOwn(values, 'answer')) {
      await expand('任务内协助');
      await setValue(await wait(() => taskFields().answer && !taskFields().answer.disabled && taskFields().answer, '答复表单不可用'), values.answer);
    }
    if (Object.hasOwn(values, 'feedback')) {
      if (!taskFields().feedback) await click('要求修改', modal());
      await setValue(taskFields().feedback, values.feedback);
    }
    if (Object.hasOwn(values, 'note')) await setValue(taskFields().note, values.note);
    if (Object.hasOwn(values, 'acknowledgement')) {
      const checkbox = taskFields().acknowledgement;
      if (!checkbox || checkbox.disabled) throw new Error('遗漏门禁授权勾选不可用');
      if (checkbox.checked !== values.acknowledgement) { checkbox.click(); await settleDom(); }
    }
    return readTaskDraft();
  }
  if (action === 'read-task-draft') return waitTaskDraft();
  if (action === 'open-help-log') {
    await click('查看负责人处理日志', await expand('任务内协助'));
    await wait(() => text(document.querySelector('.modal-title')?.textContent).includes('作业执行日志'), '负责人日志未打开');
    return { logOpened: true };
  }
  if (action === 'open-task-log') {
    await click('查看日志', await expand('本任务作业记录'));
    await wait(() => text(document.querySelector('.modal-title')?.textContent).includes('作业执行日志'), '任务日志未打开');
    return { logOpened: true };
  }
  if (action === 'return-log') {
    await click('返回任务', modal());
    await wait(taskVisible, '日志未返回原任务');
    await wait(() => modal()?.querySelector('.coordination-panel'), '任务进度未重新挂载');
    return waitTaskDraft();
  }
  if (action === 'preview') {
    await click('review-output.txt', await wait(() => modal()?.querySelector('.task-files'), '没有可预览的交付文件'));
    await wait(() => document.querySelector('.artifact-reader .reader-body pre'), '成果正文没有加载');
    return { previewOpened: true };
  }
  if (action === 'return-preview') {
    await click('关闭预览', modal());
    await wait(taskVisible, '预览未返回原任务');
    return waitTaskDraft();
  }
  if (action === 'install-request-trace') {
    if (window.__usabilitySmoke) throw new Error('请求记录器不能重复安装');
    const originalFetch = window.fetch.bind(window);
    const state = { trace: [], failedOnce: false, originalFetch };
    window.__usabilitySmoke = state;
    window.fetch = async (input, init = {}) => {
      const target = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = (init.method || 'GET').toUpperCase();
      const tracked = target.origin === location.origin && method === 'POST' &&
        (target.pathname === '/api/tasks' || /^\/api\/tasks\/[^/]+\/(materials|start)$/.test(target.pathname));
      if (!tracked) return originalFetch(input, init);
      const payload = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      const record = { path: target.pathname, method, kind: target.pathname === '/api/tasks' ? 'create'
        : target.pathname.endsWith('/materials') ? 'material' : 'start' };
      if (record.kind === 'create') {
        record.title = payload.title; record.start = payload.start; record.creationRequestId = payload.creationRequestId;
      }
      if (record.kind === 'material') record.name = payload.name;
      if (record.kind === 'start') record.expectedState = payload.expectedState;
      state.trace.push(record);
      if (record.kind === 'material' && payload.name === 'second.txt' && !state.failedOnce) {
        state.failedOnce = true;
        record.status = 503;
        record.injected = true;
        return new Response(JSON.stringify({ error: 'USABILITY_UPLOAD_TRANSIENT：第二份材料的受控一次失败，请重试。' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      const response = await originalFetch(input, init);
      record.status = response.status;
      if (record.kind === 'create' && response.ok) record.taskId = (await response.clone().json()).id;
      return response;
    };
    return { installed: true };
  }
  if (action === 'trace') return window.__usabilitySmoke?.trace || [];
  if (action === 'remove-request-trace') {
    if (window.__usabilitySmoke) { window.fetch = window.__usabilitySmoke.originalFetch; delete window.__usabilitySmoke; }
    return { removed: true };
  }
  if (action === 'choose-materials') {
    const input = await wait(() => testId('task-create-material-input'), '缺少新建材料选择入口');
    const transfer = new DataTransfer();
    transfer.items.add(new File(['USABILITY_FIRST_INPUT\n'], 'first.txt', { type: 'text/plain' }));
    transfer.items.add(new File(['USABILITY_SECOND_INPUT\n'], 'second.txt', { type: 'text/plain' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settleDom();
    return { files: [...transfer.files].map((file) => file.name) };
  }
  if (action === 'prepare-start') { await clickId('task-create-start'); return { explicitStartClicked: true }; }
  if (action === 'material-failed') {
    await wait(() => window.__usabilitySmoke?.trace.some((entry) => entry.injected), '受控材料失败没有发生');
    await wait(() => form() && button('重试', form()) && !button('重试', form()).disabled, '材料失败后没有保留重试入口');
    return { dialogRetained: true, failureVisible: text(form().textContent).includes('USABILITY_UPLOAD_TRANSIENT') };
  }
  if (action === 'retry-material') { await click('重试', form()); return { retryClicked: true }; }
  if (action === 'materials-result-visible') {
    await wait(taskVisible, '材料任务尚未显示在详情中');
    await wait(() => {
      const accept = button('验收通过', modal());
      return accept && taskFields().note && !taskFields().note.matches(':disabled') && !taskFields().acknowledgement;
    }, '材料任务的通过门禁与待验收状态尚未显示');
    if (!button('验收通过', modal()).disabled) throw new Error('未填写必填备注时不应允许验收');
    await setValue(taskFields().note, '材料与交付文件已核对，等待用户决定。');
    await wait(() => !button('验收通过', modal()).disabled, '有效验收备注未解除备注校验');
    await wait(() => text(modal()?.querySelector('.task-files')?.textContent).includes('usability-complete.txt'),
      '材料任务的交付文件尚未显示');
    return { reviewVisible: true, accepted: false };
  }
  if (action === 'install-leave-control') {
    if (window.__usabilityLeave) throw new Error('草稿保存控制器不能重复安装');
    const state = { originalFetch: window.fetch.bind(window), armed: null, release: null, writes: [] };
    window.__usabilityLeave = state;
    window.fetch = async (input, init = {}) => {
      const target = new URL(typeof input === 'string' ? input : input.url, location.href);
      const isDraftWrite = target.origin === location.origin && target.pathname === '/api/ui-drafts'
        && (init.method || 'GET').toUpperCase() === 'PUT';
      const payload = isDraftWrite && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      if (!state.armed || payload?.scope?.kind !== 'new-task') return state.originalFetch(input, init);
      const outcome = state.armed;
      state.armed = null;
      const record = { outcome, status: null, injected: outcome === 'failure' };
      state.writes.push(record);
      if (state.writes.length > 2) throw new Error('草稿保存控制器超出固定场景次数');
      await new Promise((resolve) => { state.release = () => { state.release = null; resolve(); }; });
      if (outcome === 'failure') {
        record.status = 503;
        return new Response(JSON.stringify({ error: 'USABILITY_DRAFT_SAVE_UNAVAILABLE：受控草稿保存失败，请返回继续填写。' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      const response = await state.originalFetch(input, init);
      record.status = response.status;
      return response;
    };
    return { installed: true };
  }
  if (action === 'arm-leave-write') {
    const state = window.__usabilityLeave;
    if (!state || state.release || !['success', 'failure'].includes(values.outcome)) throw new Error('草稿保存控制器状态不正确');
    state.armed = values.outcome;
    return { armed: values.outcome };
  }
  if (action === 'edit-leave-draft') {
    await setValue(createField('title'), values.title);
    await wait(() => window.__usabilityLeave?.release, '没有拦住固定草稿保存请求');
    return createValues();
  }
  if (action === 'release-leave-write') {
    window.__usabilityLeave?.release?.();
    return { released: true };
  }
  if (action === 'read-leave-guard' || action === 'leave-locked' || action === 'leave-unlocked') {
    if (action !== 'read-leave-guard') await wait(() => {
      const layout = document.querySelector('.app-layout');
      return layout && layout.inert === (action === 'leave-locked');
    }, action === 'leave-locked' ? '保存期间工作台没有锁定输入' : '取消离开后工作台仍锁定输入');
    return { inert: Boolean(document.querySelector('.app-layout')?.inert), values: createValues(),
      discardConfirmation: Boolean(form() && button('确认放弃草稿', form())),
      error: text(form()?.querySelector('[role="alert"]')?.textContent), writes: window.__usabilityLeave?.writes || [] };
  }
  if (action === 'native-target') {
    if (!['task-create-title', 'task-draft-discard'].includes(values.id)) throw new Error('不允许的原生输入目标');
    const element = await wait(() => testId(values.id), '没有找到原生输入检查目标');
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = clippedRect(element);
    if (!rect.fullyVisible) throw new Error('原生输入检查目标被裁切');
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  }
  if (action === 'leave-editable') {
    await wait(() => !document.querySelector('.app-layout')?.inert && createField('title')?.value === values.title,
      '取消离开后原生输入未恢复或文字发生丢失');
    return createValues();
  }
  if (action === 'remove-leave-control') {
    const state = window.__usabilityLeave;
    if (state) {
      state.armed = null;
      state.release?.();
      window.fetch = state.originalFetch;
      delete window.__usabilityLeave;
    }
    return { removed: true };
  }
  throw new Error(`Unsupported usability action: ${action}`);
}

const rendererSource = rendererAction.toString();
const contained = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const hashFile = (filename) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const within = async (operation, milliseconds, description) => {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`使用流程没有继续推进：${description}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
};

export async function runUsabilitySmoke(window, { url, token, workspace, nodePath, prepareLeave, cancelLeave }) {
  const root = fs.realpathSync(workspace);
  assert.match(root, /[\\/]work[\\/]desktop-smoke[\\/]run-[^\\/]+$/i, '拒绝在真实工作目录执行使用流程检查');
  assert.ok(process.argv.includes('--desktop-smoke') && process.argv.includes('--usability-smoke'));
  const origin = new URL(url);
  assert.ok(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.port && origin.pathname === '/' && !origin.username && !origin.password && !origin.search && !origin.hash);
  assert.ok(typeof token === 'string' && token.length > 0 && path.isAbsolute(nodePath) && fs.statSync(nodePath).isFile());
  assert.ok(window && !window.isDestroyed());
  assert.equal(typeof prepareLeave, 'function');
  assert.equal(typeof cancelLeave, 'function');
  assert.equal(new URL(window.webContents.getURL()).origin, origin.origin);
  assert.deepEqual(window.getMinimumSize(), [1040, 700]);
  const fixtureRoot = fs.realpathSync(path.join(root, '.smoke-fixtures'));
  const cli = fs.realpathSync(path.join(fixtureRoot, 'usability-smoke-cli.mjs'));
  const acceptance = fs.realpathSync(path.join(fixtureRoot, 'usability-smoke-acceptance.mjs'));
  assert.ok(contained(root, fixtureRoot) && contained(fixtureRoot, cli) && contained(fixtureRoot, acceptance));
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${origin.origin}${route}`, { method, signal: AbortSignal.timeout(10000),
      headers: { 'X-CLI-Team-Desktop': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, `使用流程接口失败 ${method} ${route}：${String(result.error || response.status).replaceAll(token, '[REDACTED]')}`);
    return result;
  };
  const progressFile = path.join(root, 'usability-progress.ndjson');
  const markProgress = (action, state) => fs.appendFileSync(progressFile,
    `${JSON.stringify({ action, state, at: new Date().toISOString() })}\n`);
  const runUi = async (action, data = {}, timeout = 20000) => {
    assert.equal(new URL(window.webContents.getURL()).origin, origin.origin);
    markProgress(action, 'started');
    try {
      const result = await within(window.webContents.executeJavaScript(`(${rendererSource})(${JSON.stringify({ action, ...data })})`, true),
        timeout, action);
      markProgress(action, 'finished');
      return result;
    } catch (error) {
      markProgress(action, 'failed');
      throw error;
    }
  };
  const initial = await api('/api/bootstrap?archived=1');
  assert.equal(fs.realpathSync(initial.workspace.root), root);
  assert.ok(contained(root, fs.realpathSync(initial.workspace.workspacesPath)));
  assert.equal(initial.tasks.length, 0, '不得复用已有任务');
  assert.equal(initial.runs.length, 0, '不得复用已有执行记录');
  assert.equal(initial.meetings.length, 0, '不得操作已有讨论');
  assert.equal(initial.workspace.activeRuns, 0);
  const size = window.getSize(), zoom = window.webContents.getZoomFactor();
  const suffix = randomBytes(4).toString('hex');
  const ledgerFile = path.join(fixtureRoot, `usability-ledger-${suffix}.json`);
  fs.writeFileSync(ledgerFile, JSON.stringify({ version: 1, smokeRoot: root, tasks: [], calls: [] }), { flag: 'wx' });
  const readLedger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const register = (task, mode) => {
    assert.ok(contained(root, fs.realpathSync(task.workspace)) && fs.realpathSync(task.workspace) !== root);
    const ledger = readLedger();
    assert.ok(!ledger.tasks.some((item) => item.id === task.id));
    ledger.tasks.push({ id: task.id, workspace: task.workspace, mode });
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  };
  const screenshots = [];
  const capture = async (name) => {
    markProgress(`capture:${name}`, 'started');
    await within(window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'),
      4000, `等待截图画面 ${name}`);
    const filename = path.join(root, `usability-${name}.png`);
    const picture = await within(window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }), 6000, `截取 ${name}`);
    assert.equal(picture.isEmpty(), false, '正式桌面截图不能为空');
    fs.writeFileSync(filename, picture.toPNG());
    screenshots.push(filename);
    markProgress(`capture:${name}`, 'finished');
    return filename;
  };
  const snapshot = async (taskId) => {
    const progress = await api(`/api/tasks/${encodeURIComponent(taskId)}/progress`);
    const task = (await api('/api/bootstrap')).tasks.find((item) => item.id === taskId);
    assert.ok(task);
    return { task, progress };
  };
  const until = async (predicate, description) => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const result = await predicate();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error(`使用流程检查超时：${description}`);
  };
  const settled = (taskId, expectedStatus) => until(async () => {
    const result = await snapshot(taskId);
    if (!result.progress.active && result.task.status === expectedStatus) return result;
    if (!result.progress.active && result.task.status === 'blocked' && expectedStatus !== 'blocked') {
      throw new Error(`固定任务失败：${result.task.summary}`);
    }
    return null;
  }, `${taskId} 未进入 ${expectedStatus}`);
  const focusInputWindow = async () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.focus();
    await until(() => window.isFocused(), '正式测试窗口未获得原生焦点，无法检查真实键盘输入');
  };
  const key = async (keyCode) => {
    assert.equal(window.isFocused(), true, '真实键盘检查需要正式测试窗口保持原生焦点');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    return runUi('focus');
  };
  const nativeClick = async (id) => {
    assert.equal(window.isFocused(), true, '原生点击检查需要正式测试窗口保持焦点');
    const target = await runUi('native-target', { values: { id } });
    window.webContents.sendInputEvent({ type: 'mouseDown', ...target, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...target, button: 'left', clickCount: 1 });
    await runUi('focus');
  };
  const nativeText = async (text) => {
    assert.equal(window.isFocused(), true, '原生文字输入检查需要正式测试窗口保持焦点');
    assert.match(text, /^[A-Z]$/);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: text });
    window.webContents.sendInputEvent({ type: 'char', keyCode: text });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: text });
    await runUi('focus');
  };
  const reload = async () => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('桌面内容重载超时')), 15000);
      window.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
      window.webContents.reload();
    });
    await runUi('ready');
  };
  try {
    await api('/api/settings', { paused: true, maxParallel: 1, repairLimit: 0 }, 'PATCH');
    for (const member of initial.members.filter((item) => item.provider !== 'controller' && item.enabled)) {
      await api(`/api/members/${encodeURIComponent(member.id)}`, { enabled: false }, 'PATCH');
    }
    const missing = await api('/api/members', { name: `入口缺失 ${suffix}`, handle: `ux-missing-${suffix}`, provider: 'custom',
      executable: path.join(fixtureRoot, 'does-not-exist.exe'), role: 'builder', permission: 'edit', enabled: true });
    assert.equal(missing.status, 'missing');
    const createMember = (actor) => api('/api/members', { name: `固定${actor === 'owner' ? '负责人' : '协作者'} ${suffix}`,
      handle: `ux-${actor}-${suffix}`, provider: 'custom', executable: nodePath, prefixArgs: [cli, ledgerFile, actor],
      customArgs: [], inputMode: 'stdin', role: 'builder', permission: 'edit', enabled: true,
      skills: '正式桌面回归专用的固定 Node 协议程序，不调用真实模型。' });
    const owner = await createMember('owner'), worker = await createMember('worker');
    const seed = async (mode, letter) => {
      const task = await api('/api/tasks', { title: `UX ${mode} ${letter} ${suffix}`, objective: '固定执行器检查草稿往返与任务隔离',
        executionMode: mode === 'help' ? 'delegated' : 'direct', assigneeId: owner.id,
        participantIds: mode === 'help' ? [worker.id] : [], start: false, category: 'test' });
      register(task, mode);
      await api(`/api/tasks/${encodeURIComponent(task.id)}/start`, {});
      return task;
    };
    const helpA = await seed('help', 'A'), helpB = await seed('help', 'B');
    const reviewA = await seed('review', 'A'), reviewB = await seed('review', 'B');
    await api('/api/settings', { paused: false }, 'PATCH');
    for (const task of [helpA, helpB]) await settled(task.id, 'blocked');
    for (const task of [reviewA, reviewB]) {
      const state = await settled(task.id, 'review');
      assert.equal(state.task.gate.status, 'not_configured');
    }
    const baseline = await api('/api/bootstrap');
    assert.equal(baseline.tasks.length, 4);
    assert.equal(readLedger().calls.length, 8);
    await reload();
    const callouts = [];
    for (const task of [helpA, reviewA]) {
      await runUi('open-task', { title: task.title });
      const roomId = (await snapshot(task.id)).task.roomId;
      await runUi('close-modal');
      await new Promise(resolve => { window.webContents.once('did-finish-load', resolve);
        window.webContents.loadURL(origin.origin + '/#/rooms/' + encodeURIComponent(roomId)); });
      await runUi('ready');
      const callout = await runUi('task-callout', { title: task.title });
      assert.match(callout.callout, /等待你验收|需要你的答复|执行受阻/);
      assert.match(callout.summary, /去答复|处理验收|查看原因/);
      callouts.push({ task: task.title, ...callout });
      await runUi('close-modal');
    }
    await runUi('open-create');
    const draftValues = { title: `新建草稿 ${suffix}`, objective: '完整保留使用者未提交的目标与材料约束。'.repeat(24),
      requirements: '保留原始材料\n只执行明确授权工作', verification: '' };
    const draft = await runUi('fill-create', { values: draftValues, ownerId: owner.id, workerName: worker.name });
    assert.equal(draft.title, draftValues.title);
    assert.equal(draft.objective, draftValues.objective);
    assert.equal(draft.participants.length, 1);
    const missingMember = await runUi('missing-member', { missingId: missing.id, missingName: missing.name });
    const layouts = [];
    window.setSize(1040, 700);
    // Electron requires the hosting BrowserWindow to be focused for native
    // keyboard input. Keep this isolated window visible until UI checks finish;
    // hiding a previously shown window can suspend Windows compositor work.
    await focusInputWindow();
    for (const factor of [1, 1.25, 1.5]) {
      window.webContents.setZoomFactor(factor);
      const measured = await runUi('layout');
      assert.ok(measured.body.scrollHeight > measured.body.clientHeight, '最小窗口中的长表单应具有正文滚动范围');
      const reached = new Set();
      for (let count = 0; count < measured.keyboardLimit && reached.size < 2; count++) {
        const focus = await key('Tab');
        if (['task-create-submit', 'task-create-start'].includes(focus.id)) {
          assert.equal(focus.visible, true, `Tab 到达 ${focus.id} 后按钮仍被裁切`);
          reached.add(focus.id);
        }
      }
      assert.equal(reached.size, 2, `缩放 ${factor} 时 Tab 未到达两个主操作`);
      layouts.push({ factor, outerSize: window.getSize(), contentSize: window.getContentSize(), ...measured,
        nativeFocusVerified: true, keyboardReached: [...reached], screenshot: await capture(`layout-${Math.round(factor * 100)}`) });
    }
    window.webContents.setZoomFactor(1);
    await key('Escape');
    await runUi('closed');
    assert.deepEqual(await runUi('open-create'), draft, 'Escape 后新建草稿丢失');
    await runUi('close-modal');
    assert.deepEqual(await runUi('open-create'), draft, '关闭后新建草稿丢失');
    await runUi('close-modal');
    await reload();
    assert.deepEqual(await runUi('open-create'), draft, '重载后持久化新建草稿丢失');
    await runUi('close-modal');

    const helpDrafts = new Map([[helpA.id, { answer: 'HELP_A：仅处理材料 A。'.repeat(20), feedback: 'REVISION_A：保留第一份资料。'.repeat(15) }],
      [helpB.id, { answer: 'HELP_B：仅处理材料 B。'.repeat(20), feedback: 'REVISION_B：保留第二份资料。'.repeat(15) }]]);
    for (const task of [helpA, helpB]) {
      await runUi('open-task', { title: task.title });
      const blank = await runUi('read-task-draft', { title: task.title });
      assert.equal(blank.answer, '');
      assert.equal(blank.feedback, '');
      const expected = helpDrafts.get(task.id);
      await runUi('fill-task-draft', { values: expected });
      await runUi('open-help-log');
      const returned = await runUi('return-log', { title: task.title });
      assert.equal(returned.answer, expected.answer, '日志返回后协助答复丢失');
      assert.equal(returned.feedback, expected.feedback, '日志返回后返工反馈丢失');
      const state = await snapshot(task.id);
      assert.equal(state.progress.assistance[0].status, 'blocked');
      assert.equal(Boolean(state.progress.assistance[0].answer), false, '未保存草稿意外提交到后端');
      assert.equal(state.progress.totalRuns, 3);
      await capture(`help-draft-${task.id === helpA.id ? 'a' : 'b'}`);
      await runUi('close-modal');
    }
    await runUi('open-task', { title: helpA.title });
    const helpReturned = await runUi('read-task-draft', { title: helpA.title });
    assert.equal(helpReturned.answer, helpDrafts.get(helpA.id).answer, '切换任务后答复草稿串入');
    assert.equal(helpReturned.feedback, helpDrafts.get(helpA.id).feedback, '切换任务后反馈草稿串入');
    await runUi('close-modal');
    assert.deepEqual(await runUi('open-create'), draft, '查看其他任务日志后新建草稿丢失');
    await runUi('discard-create');
    await runUi('close-modal');

    const reviewDrafts = new Map([[reviewA.id, { note: 'ACCEPT_A：按原始资料人工核对。'.repeat(12), feedback: 'REVIEW_A：补全第一段依据。'.repeat(15) }],
      [reviewB.id, { note: 'ACCEPT_B：按第二份资料核对。'.repeat(12), feedback: 'REVIEW_B：补全第二段依据。'.repeat(15) }]]);
    for (const task of [reviewA, reviewB]) {
      await runUi('open-task', { title: task.title });
      const blank = await runUi('read-task-draft', { title: task.title });
      assert.equal(blank.note, '');
      assert.equal(blank.feedback, '');
      assert.equal(blank.acknowledgement, false);
      const expected = reviewDrafts.get(task.id);
      await runUi('fill-task-draft', { values: { ...expected, acknowledgement: true } });
      await runUi('preview');
      let returned = await runUi('return-preview', { title: task.title });
      assert.equal(returned.note, expected.note, '成果预览返回后验收备注丢失');
      assert.equal(returned.feedback, expected.feedback, '成果预览返回后修改意见丢失');
      assert.equal(returned.acknowledgement, false, '返回时不应恢复遗漏门禁授权');
      await runUi('fill-task-draft', { values: { acknowledgement: true } });
      await runUi('open-task-log');
      returned = await runUi('return-log', { title: task.title });
      assert.equal(returned.note, expected.note);
      assert.equal(returned.feedback, expected.feedback);
      assert.equal(returned.acknowledgement, false);
      assert.equal((await snapshot(task.id)).task.status, 'review', '预览与草稿不得接受任务');
      await capture(`review-draft-${task.id === reviewA.id ? 'a' : 'b'}`);
      await runUi('close-modal');
    }
    await runUi('open-task', { title: reviewA.title });
    const reviewReturned = await runUi('read-task-draft', { title: reviewA.title });
    assert.equal(reviewReturned.note, reviewDrafts.get(reviewA.id).note);
    assert.equal(reviewReturned.feedback, reviewDrafts.get(reviewA.id).feedback);
    assert.equal(reviewReturned.acknowledgement, false);
    await runUi('close-modal');
    await reload();
    for (const task of [helpA, helpB]) {
      await runUi('open-task', { title: task.title });
      const restored = await runUi('read-task-draft', { title: task.title });
      assert.equal(restored.answer, helpDrafts.get(task.id).answer, '页面重载后答复草稿未恢复');
      assert.equal(restored.feedback, helpDrafts.get(task.id).feedback, '页面重载后继续任务反馈未恢复');
      await runUi('close-modal');
    }
    for (const task of [reviewA, reviewB]) {
      await runUi('open-task', { title: task.title });
      const restored = await runUi('read-task-draft', { title: task.title });
      assert.equal(restored.note, reviewDrafts.get(task.id).note, '页面重载后验收备注未恢复');
      assert.equal(restored.feedback, reviewDrafts.get(task.id).feedback, '页面重载后修改意见未恢复');
      assert.equal(restored.acknowledgement, false, '页面重载不应恢复遗漏门禁授权');
      await runUi('close-modal');
    }
    assert.equal((await api('/api/bootstrap')).tasks.length, baseline.tasks.length, '填写和放弃草稿不应创建任务');
    assert.equal(readLedger().calls.length, 8, '浏览草稿意外启动了执行器');

    await runUi('install-request-trace');
    await runUi('open-create');
    const preparationTitle = `先选材料再开始 ${suffix}`;
    await runUi('fill-create', { values: { title: preparationTitle, objective: '读取选定的两份资料，保留原始字节，再汇总结果。',
      requirements: '开始前必须成功导入全部材料', verification: JSON.stringify([nodePath, '--test', acceptance]) },
    ownerId: owner.id, workerName: worker.name });
    await runUi('choose-materials');
    await runUi('prepare-start');
    const partialUi = await runUi('material-failed');
    assert.equal(partialUi.failureVisible, true);
    let trace = await runUi('trace');
    const created = trace.filter((entry) => entry.kind === 'create');
    assert.equal(created.length, 1);
    assert.equal(created[0].start, false, '材料导入前创建请求必须 start:false');
    assert.ok(typeof created[0].creationRequestId === 'string' && created[0].creationRequestId.length > 0,
      '创建待办必须携带用于重试恢复的请求标识');
    assert.ok(created[0].taskId);
    const prepared = await snapshot(created[0].taskId);
    assert.equal(prepared.task.status, 'backlog');
    assert.equal(prepared.progress.totalRuns, 0, '部分材料失败后不应派工');
    assert.equal(prepared.progress.active, false);
    assert.equal(trace.filter((entry) => entry.kind === 'start').length, 0);
    let materials = await api(`/api/tasks/${encodeURIComponent(prepared.task.id)}/materials`);
    assert.deepEqual(materials.materials.map((item) => item.name), ['first.txt']);
    assert.equal(materials.locked, false);
    assert.equal((await api('/api/bootstrap')).tasks.length, baseline.tasks.length + 1);
    register(prepared.task, 'materials');
    await capture('material-partial-failure');
    await runUi('retry-material');
    materials = await until(async () => {
      const result = await api(`/api/tasks/${encodeURIComponent(prepared.task.id)}/materials`);
      return result.materials.length === 2 && result;
    }, '重试后没有保留两份已导入材料');
    assert.equal((await snapshot(prepared.task.id)).progress.totalRuns, 0, '单项重试不应自动启动任务');
    assert.equal(materials.locked, false);
    trace = await runUi('trace');
    assert.equal(trace.filter((entry) => entry.kind === 'create').length, 1, '材料重试不能重复创建任务');
    assert.equal(trace.filter((entry) => entry.kind === 'start').length, 0);
    const inputHashes = materials.materials.map((item) => ({ name: item.name, sha256: item.sha256 }));
    for (const item of materials.materials) assert.equal(hashFile(path.join(prepared.task.workspace, item.relativePath)), item.sha256);
    await capture('material-ready-without-start');
    await runUi('prepare-start');
    const completed = await settled(prepared.task.id, 'review');
    assert.equal(completed.task.gate.status, 'passed', completed.task.summary);
    assert.equal(completed.progress.totalRuns, 3);
    assert.deepEqual(readLedger().calls.filter((call) => call.taskId === prepared.task.id).map((call) => call.stage), ['plan', 'delegate', 'implement']);
    for (const item of materials.materials) assert.equal(hashFile(path.join(prepared.task.workspace, item.relativePath)), item.sha256);
    trace = await runUi('trace');
    assert.equal(trace.filter((entry) => entry.kind === 'create').length, 1);
    assert.equal(trace.filter((entry) => entry.kind === 'start').length, 1);
    assert.equal(trace.find((entry) => entry.kind === 'start').expectedState, 'unstarted', '准备流程只能启动从未启动的待办');
    assert.equal(trace.filter((entry) => entry.kind === 'material' && entry.name === 'first.txt').length, 1);
    assert.equal(trace.filter((entry) => entry.kind === 'material' && entry.name === 'second.txt' && entry.injected).length, 1);
    assert.equal(trace.filter((entry) => entry.kind === 'material' && entry.name === 'second.txt' && !entry.injected && entry.status < 300).length, 1);
    assert.equal((await api('/api/bootstrap')).tasks.length, baseline.tasks.length + 1);
    assert.equal(readLedger().calls.length, 11);
    await runUi('materials-result-visible', { title: preparationTitle });
    await capture('materials-complete');

    await runUi('close-modal');
    await runUi('open-create');
    await runUi('fill-create', { values: { title: `退出保存校验 ${suffix}`, objective: '取消离开后保持完整文字，继续编辑及保存。',
      requirements: '保存期间禁止新的输入\n未确认离开前保留本窗口', verification: '' }, ownerId: owner.id, workerName: worker.name });
    await runUi('close-modal');
    let guardDraft = await runUi('open-create');
    await runUi('install-leave-control');
    await focusInputWindow();
    const departureChecks = [];
    for (const outcome of ['success', 'failure']) {
      await runUi('arm-leave-write', { values: { outcome } });
      guardDraft = await runUi('edit-leave-draft', { values: { title: `${guardDraft.title} ${outcome}` } });
      await nativeClick('task-create-title');
      await key('End');
      markProgress(`prepare-leave:${outcome}`, 'started');
      const saving = prepareLeave();
      let saved;
      try {
        assert.equal((await runUi('leave-locked')).inert, true);
        await nativeClick('task-create-title');
        await key('End');
        await nativeText('Z');
        await nativeClick('task-draft-discard');
        const locked = await runUi('read-leave-guard');
        assert.deepEqual(locked.values, guardDraft, '保存期间原生输入仍改动了草稿');
        assert.equal(locked.discardConfirmation, false, '保存期间原生点击仍触发了放弃草稿');
        await runUi('release-leave-write');
        saved = await within(saving, 16000, `等待 ${outcome} 保存握手`);
        markProgress(`prepare-leave:${outcome}`, saved ? 'saved' : 'save-failed');
        assert.equal(saved, outcome === 'success', '保存握手结果与受控请求结果不符');
        const finished = await runUi('leave-locked');
        assert.deepEqual(finished.values, guardDraft, '保存结果返回后草稿发生变化');
        if (outcome === 'failure') await until(async () => {
          const state = await runUi('read-leave-guard');
          return state.error.includes('USABILITY_DRAFT_SAVE_UNAVAILABLE') && state;
        }, '固定保存失败没有显示在草稿表单中');
        await capture(`leave-${outcome}-locked`);
      } finally {
        await runUi('release-leave-write', {}, 2000).catch(() => {});
        cancelLeave();
      }
      const resumed = await runUi('leave-unlocked');
      assert.deepEqual(resumed.values, guardDraft, '取消离开后文字丢失');
      await nativeClick('task-create-title');
      await key('End');
      await nativeText('Z');
      guardDraft = await runUi('leave-editable', { values: { title: `${guardDraft.title}Z` } });
      await runUi('close-modal');
      const persisted = await api('/api/ui-drafts/read', { workspace: root, scope: { kind: 'new-task', contextId: 'default' } });
      assert.equal(persisted.draft?.values.title, guardDraft.title, '恢复编辑后的文字没有保存到工作区');
      assert.deepEqual(await runUi('open-create'), guardDraft);
      departureChecks.push({ outcome, saved, lockedWhileSaving: true, nativeInputBlocked: true,
        nativeClickBlocked: true, lockedAfterResult: true, cancelRestoredEditing: true, resumedTextPersisted: true });
    }
    const departureWrites = (await runUi('read-leave-guard')).writes;
    assert.equal(departureWrites.length, 2);
    assert.equal(departureWrites[0].status, 200);
    assert.equal(departureWrites[1].status, 503);
    await capture('leave-cancel-resumed');
    await runUi('remove-leave-control');
    await runUi('discard-create');
    await runUi('close-modal');
    assert.equal((await api('/api/bootstrap')).tasks.length, baseline.tasks.length + 1, '保存握手不应创建额外任务');
    assert.equal(readLedger().calls.length, 11, '保存握手不应启动执行器');
    const result = { ok: true, syntheticProtocol: true, realModelCalls: 0, actualCliRunsStarted: readLedger().calls.length,
      officialMainWindow: true, temporarilyVisibleWindow: true,
      zoomKind: 'Chromium page zoom; Windows display scaling was not changed', layouts, missingMember, callouts,
      drafts: { createSurvivedClose: true, createSurvivedEscape: true, createSurvivedReload: true, createSurvivedTaskLog: true,
        taskIsolation: true, helpLogReturn: true, revisionLogAndPreviewReturn: true, acceptanceLogAndPreviewReturn: true,
        allTaskDraftsSurvivedReload: true, authorizationReset: true, implicitTaskStarts: 0 },
      preparation: { taskId: prepared.task.id, createdWithStartFalse: true, noStartOnPartialFailure: true,
        retryUsedSameTask: true, retryDidNotStart: true, explicitStartRequests: 1, startRequiresUnstarted: true,
        inputHashes, gate: completed.task.gate,
        injectedFailure: 'One renderer fetch response for second.txt returned fixed HTTP 503', trace },
      departureGuard: { checks: departureChecks, writes: departureWrites,
        injectedFailure: 'One renderer fetch response for a new-task draft PUT returned fixed HTTP 503', systemDialogsOpened: 0 },
      screenshots };
    fs.writeFileSync(path.join(root, 'usability-result.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    await capture('failure').catch(() => {});
    throw error;
  } finally {
    cancelLeave();
    await runUi('remove-leave-control', {}, 2000).catch(() => {});
    await runUi('remove-request-trace', {}, 2000).catch(() => {});
    window.webContents.setZoomFactor(zoom);
    window.setSize(...size);
    // The official main still needs a live renderer for its save handshake and
    // final screenshot. It closes this isolated window after writing its receipt.
  }
}
