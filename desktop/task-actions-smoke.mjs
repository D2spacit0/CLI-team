import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Named actions against our own developer renderer; page data is never executed.
async function rendererAction({ action, data = {} }) {
  const text = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = element => Boolean(element?.getClientRects().length);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const value = predicate(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(label);
  };
  const top = () => [...document.querySelectorAll('.modal-content')].filter(visible).at(-1);
  const task = () => document.querySelector('[data-task-detail]');
  const button = (label, root = document) => [...root.querySelectorAll('button')].find(element => visible(element)
    && (text(element.textContent) === label || element.getAttribute('aria-label') === label
      || text(element.querySelector(':scope > span:not(.nav-badge)')?.textContent) === label));
  const click = async (label, root = document, twice = false) => {
    const element = await wait(() => { const scope = typeof root === 'function' ? root() : root;
      const value = scope && button(label, scope); return value && !value.disabled && value; }, `缺少可用按钮：${label}`);
    element.click(); if (twice) element.click(); await settle();
  };
  const edit = async (selector, value) => {
    const element = await wait(() => { const value = document.querySelector(selector); return visible(value) && !value.matches(':disabled') && value; }, `输入尚不可编辑：${selector}`);
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await settle();
  };
  if (action === 'ready') {
    await wait(() => document.querySelector('textarea[aria-label="消息"]') && !document.querySelector('textarea[aria-label="消息"]').disabled, '工作台未就绪');
    const state = { fetch: window.fetch.bind(window), alerts: [], requests: [], controls: [], waiting: false, release: null, clears: 0, bootstrapReads: [] };
    window.__taskActionsSmoke = state;
    window.alert = message => state.alerts.push(String(message));
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = init.method || 'GET';
      if (method === 'POST' && /^\/api\/(tasks|runs)\//.test(url.pathname)) state.requests.push({ path: url.pathname, body: JSON.parse(init.body || '{}') });
      const index = state.controls.findIndex(item => item.path === url.pathname && (item.method || 'POST') === method);
      if (index < 0) {
        const response = await state.fetch(input, init);
        if (url.pathname === '/api/ui-drafts' && method === 'DELETE' && response.ok) state.clears++;
        if (url.pathname === '/api/bootstrap' && response.ok) state.bootstrapReads.push(url.search);
        return response;
      }
      const control = state.controls.splice(index, 1)[0];
      if (control.mode === 'fail') return new Response(JSON.stringify({ error: 'TASK_ACTIONS_UNAVAILABLE' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      if (control.mode === 'hold-fail') {
        state.waiting = true;
        await new Promise(resolve => { state.release = resolve; }); state.waiting = false;
        return new Response(JSON.stringify({ error: 'TASK_ACTIONS_UNAVAILABLE' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      const response = await state.fetch(input, init);
      if (control.mode === 'lost') throw new Error('TASK_ACTIONS_REPLY_LOST');
      state.waiting = true;
      await new Promise(resolve => { state.release = resolve; }); state.waiting = false;
      return response;
    };
    return true;
  }
  if (action === 'control') { window.__taskActionsSmoke.controls = Array.isArray(data) ? data : [data]; return true; }
  if (action === 'waiting') { await wait(() => window.__taskActionsSmoke.waiting, '请求未进入等待状态'); return true; }
  if (action === 'release') { window.__taskActionsSmoke.release?.(); await settle(); return true; }
  if (action === 'open') {
    await click('任务看板');
    const card = await wait(() => [...document.querySelectorAll('.task-card')].find(element => text(element.querySelector('.task-card-title')?.textContent) === data.title), '任务卡片未显示');
    card.click();
    await wait(() => task()?.querySelector('.coordination-panel'), '任务进度未加载'); return true;
  }
  if (action === 'click') { await click(data.label, data.global ? document : top, data.twice); return true; }
  if (action === 'edit') { await edit(data.selector, data.value); return true; }
  if (action === 'check') {
    const input = await wait(() => document.querySelector(data.selector), '复选框不存在');
    if (input.checked !== data.checked) input.click(); await settle(); return true;
  }
  if (action === 'assignment-open') {
    const details = await wait(() => task()?.querySelector('.task-assignment'), '调整分工入口缺失');
    if (!details.open) details.querySelector('summary').click();
    await wait(() => !details.querySelector('#reassign-note')?.matches(':disabled'), '改派草稿未恢复'); return true;
  }
  if (action === 'dismiss') { top()?.querySelector('.modal-header button')?.click(); await settle(); return true; }
  if (action === 'escape') {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: Boolean(data.composing) }));
    await settle(); return true;
  }
  if (action === 'close-attempts') {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    if (text(top()?.querySelector('.modal-title')?.textContent) === data.title) {
      top()?.querySelector('.modal-header button')?.click();
      top()?.closest('.modal-overlay')?.click();
    }
    await settle(); return true;
  }
  if (action === 'error') {
    await wait(() => window.__taskActionsSmoke.alerts.length || [...document.querySelectorAll('[role="alert"]')].some(element => visible(element) && text(element.textContent).includes(data.text || 'TASK_ACTIONS_UNAVAILABLE')), '操作失败没有可见反馈'); return true;
  }
  if (action === 'text') { await wait(() => text(top()?.textContent).includes(data.text), `当前页面未显示：${data.text}`); return true; }
  if (action === 'page-text') { await wait(() => text(document.querySelector(data.selector || '.archive-view')?.textContent).includes(data.text), `当前页面未显示：${data.text}`); return true; }
  if (action === 'layout') {
    const bounds = top().getBoundingClientRect();
    return { viewport: { width: innerWidth, height: innerHeight }, bounds: { top: bounds.top, left: bounds.left, right: bounds.right, bottom: bounds.bottom },
      buttons: [...top().querySelectorAll('button')].filter(visible).map(element => { const rect = element.getBoundingClientRect();
        return { text: text(element.textContent), top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom }; }) };
  }
  if (action === 'task-visible') { await wait(() => task()?.dataset.taskDetail === data.id && top() === task(), '未返回当前任务详情'); return true; }
  if (action === 'closed') { await wait(() => !top(), '弹窗未关闭'); return true; }
  if (action === 'state') return {
    title: text(top()?.querySelector('.modal-title')?.textContent), taskId: task()?.dataset.taskDetail,
    content: text(top()?.textContent), error: [...document.querySelectorAll('[role="alert"]')].filter(visible).map(element => text(element.textContent)).join('\n'),
    fields: Object.fromEntries([...document.querySelectorAll('input[id],textarea[data-testid],select[id]')].map(element => [element.dataset.testid || element.id, element.value])),
    consent: document.querySelector('[data-testid="ack-missing-gate"]')?.checked,
    focus: { text: text(document.activeElement?.textContent), label: document.activeElement?.getAttribute('aria-label'), id: document.activeElement?.id },
    buttons: [...(top()?.querySelectorAll('button') || [])].filter(visible).map(element => ({ text: text(element.textContent), disabled: element.disabled })),
    alerts: window.__taskActionsSmoke.alerts, requests: window.__taskActionsSmoke.requests, clears: window.__taskActionsSmoke.clears, bootstrapReads: window.__taskActionsSmoke.bootstrapReads,
  };
  throw new Error(`未知的任务操作场景：${action}`);
}
const source = rendererAction.toString();

export async function runTaskActionsSmoke(window, { url, token, workspace, nodePath, prepareLeave, cancelLeave }) {
  const root = fs.realpathSync(workspace), origin = new URL(url).origin;
  assert.match(root, /[\\/]work[\\/]desktop-smoke[\\/]run-[^\\/]+$/i);
  assert.ok(process.argv.includes('--desktop-smoke') && process.argv.includes('--task-actions-smoke'));
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + route, { method, headers: { 'X-CLI-Team-Desktop': token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const value = await response.json();
    assert.ok(response.ok, `任务检查接口失败：${route} ${String(value.error || response.status).replaceAll(token, '[REDACTED]')}`); return value;
  };
  assert.equal((await api('/api/bootstrap?archived=1')).tasks.length, 0);
  const runUi = (action, data) => {
    assert.equal(new URL(window.webContents.getURL()).origin, origin);
    return window.webContents.executeJavaScript(`(${source})(${JSON.stringify({ action, data })})`, true);
  };
  const reload = async () => {
    await runUi('release').catch(() => {}); cancelLeave();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('任务操作页面刷新超时')), 12000);
      window.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); }); window.webContents.reload();
    });
    await runUi('ready');
  };
  const until = async predicate => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 70)); }
    throw new Error('任务状态未在测试时限内就绪');
  };
  const getTask = async id => (await api('/api/bootstrap?archived=1')).tasks.find(task => task.id === id);
  const screenshots = [];
  const capture = async name => {
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const filename = path.join(root, `task-actions-${name}.png`); fs.writeFileSync(filename, (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); screenshots.push(filename); return filename;
  };
  const checks = [];
  const check = async (name, action) => {
    try { await action(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, error: String(error.message).replaceAll(token, '[REDACTED]'), screenshot: await capture(name).catch(() => null), state: await runUi('state').catch(() => null) }); }
    finally { await reload(); }
    fs.writeFileSync(path.join(root, 'task-actions-checks.json'), JSON.stringify(checks, null, 2));
  };
  const member = name => api('/api/members', { name, handle: name === '操作成员甲' ? 'actions-a' : 'actions-b', provider: 'custom', role: 'builder', permission: 'edit', enabled: true,
    executable: nodePath, inputMode: 'stdin', prefixArgs: [path.join(root, '.smoke-fixtures', 'task-actions-cli.mjs'), root], customArgs: [] });
  const first = await member('操作成员甲'), second = await member('操作成员乙');
  const create = title => api('/api/tasks', { title, objective: 'TASK_ACTIONS_FIXED_DELIVERY：只生成固定交付说明，验证用户操作流程', executionMode: 'direct', assigneeId: first.id, reviewerId: null, start: false });
  const reviews = [];
  await api('/api/settings', { paused: false }, 'PATCH');
  for (const title of ['验收失败恢复', '验收回执恢复', '返工失败恢复', '返工回执恢复', '验收迟到返回', '验收草稿清理恢复']) {
    const task = await create(title); reviews.push(task);
    fs.writeFileSync(path.join(root, 'task-actions-fixture.json'), JSON.stringify(reviews.map(item => ({ id: item.id, workspace: item.workspace }))));
    await api(`/api/tasks/${task.id}/start`, {});
    await until(async () => (await getTask(task.id)).status === 'review');
    assert.equal(fs.readFileSync(path.join(task.workspace, '交付说明.txt'), 'utf8'), `TASK_ACTIONS_FIXED_DELIVERY\n${task.id}\n`);
  }
  await api('/api/settings', { paused: true }, 'PATCH');
  await reload();
  await check('task-create-composing-escape', async () => {
    await runUi('click', { label: '任务看板', global: true });
    await runUi('click', { label: '新建单人任务', global: true });
    await runUi('escape', { composing: true });
    const state = await runUi('state'); assert.ok(state.title.includes('任务'), '输入法取消选字不应关闭新建任务');
    await runUi('escape'); await runUi('closed');
  });
  await check('start-inline-error-and-retry', async () => {
    const task = await create('启动失败原地重试'); await reload(); await runUi('open', task);
    await runUi('control', { path: `/api/tasks/${task.id}/start`, mode: 'fail' });
    await runUi('click', { label: '启动任务', twice: true }); await runUi('error');
    const state = await runUi('state'); assert.deepEqual(state.alerts, []); assert.match(state.error, /TASK_ACTIONS_UNAVAILABLE/); assert.equal(state.taskId, task.id);
    await runUi('click', { label: '启动任务' }); await runUi('text', { text: '等待原因：全局调度已暂停' });
    assert.equal((await api(`/api/tasks/${task.id}/progress`)).totalRuns, 1);
  });
  await check('start-lost-reply-recovers-current-state', async () => {
    const task = await create('启动回执丢失'); await reload(); await runUi('open', task);
    await runUi('control', { path: `/api/tasks/${task.id}/start`, mode: 'lost' }); await runUi('click', { label: '启动任务', twice: true });
    await runUi('text', { text: '已核对' });
    assert.equal((await api(`/api/tasks/${task.id}/progress`)).totalRuns, 1); assert.deepEqual((await runUi('state')).alerts, []);
  });
  await check('unverified-reply-requires-status-refresh-before-retry', async () => {
    const task = await create('未知结果先核对'); await reload(); await runUi('open', task);
    await runUi('control', [{ path: `/api/tasks/${task.id}/start`, mode: 'fail' }, { path: '/api/bootstrap', method: 'GET', mode: 'fail' }]);
    await runUi('click', { label: '启动任务' }); await runUi('text', { text: '暂时无法核对任务状态' });
    assert.ok((await runUi('state')).buttons.some(item => ['启动任务', '正在启动'].includes(item.text) && item.disabled));
    assert.equal((await api(`/api/tasks/${task.id}/progress`)).totalRuns, 0);
    await runUi('click', { label: '刷新任务状态' }); await runUi('text', { text: '已核对当前状态' });
    await runUi('click', { label: '启动任务' }); await until(async () => (await api(`/api/tasks/${task.id}/progress`)).totalRuns === 1);
    await runUi('text', { text: '启动请求已提交' });
  });
  await check('late-start-receipt-cannot-replace-newer-paused-state', async () => {
    const task = await create('较晚启动回执保留暂停'); await reload(); await runUi('open', task);
    await runUi('control', { path: `/api/tasks/${task.id}/start`, mode: 'hold' }); await runUi('click', { label: '启动任务' }); await runUi('waiting');
    await api(`/api/tasks/${task.id}/pause`, {}); await runUi('text', { text: '当前阶段：已暂停' });
    await runUi('release'); await runUi('text', { text: '启动请求已提交' }); await runUi('text', { text: '当前阶段：已暂停' });
    assert.equal((await getTask(task.id)).status, 'blocked');
  });
  await check('late-task-refresh-keeps-current-archive-page', async () => {
    const archived = await create('归档记录不能消失'), task = await create('启动中查看归档');
    await api(`/api/tasks/${archived.id}/archive`, {}); await reload(); await runUi('open', task);
    await runUi('control', { path: `/api/tasks/${task.id}/start`, mode: 'hold' }); await runUi('click', { label: '启动任务' }); await runUi('waiting');
    await runUi('click', { label: '关闭任务详情' }); await runUi('click', { label: '归档记录', global: true }); await runUi('page-text', { text: archived.title });
    const count = (await runUi('state')).bootstrapReads.length;
    await runUi('release'); await until(async () => (await runUi('state')).bootstrapReads.length > count);
    assert.ok((await runUi('state')).bootstrapReads.slice(count).every(query => query === '?archived=1'), '后续刷新必须使用当前页面条件');
    await runUi('page-text', { text: archived.title });
  });
  await check('cancel-dismiss-restores-task', async () => {
    const task = await create('取消确认返回'); await reload(); await runUi('open', task);
    await runUi('click', { label: '取消任务' }); await runUi('dismiss'); await runUi('task-visible', task);
    await runUi('click', { label: '取消任务' }); await runUi('escape'); await runUi('task-visible', task);
    assert.equal((await getTask(task.id)).status, 'backlog');
  });
  await check('cancel-busy-error-and-retry', async () => {
    const task = await create('取消失败保持上下文'); await reload(); await runUi('open', task);
    await runUi('click', { label: '取消任务' }); await runUi('control', { path: `/api/tasks/${task.id}/cancel`, mode: 'hold-fail' });
    await runUi('click', { label: '确认取消', twice: true }); await runUi('waiting'); await runUi('close-attempts', { title: '取消任务' });
    assert.equal((await runUi('state')).title, '取消任务', '处理中关闭入口必须一致锁定');
    await runUi('release'); await runUi('error');
    const failed = await runUi('state'); assert.deepEqual(failed.alerts, []); assert.match(failed.error, /TASK_ACTIONS_UNAVAILABLE/); assert.equal(failed.title, '取消任务');
    await capture('cancel-inline-error'); await runUi('click', { label: '确认取消' }); await runUi('task-visible', task);
    assert.equal((await getTask(task.id)).status, 'cancelled'); assert.match((await runUi('state')).content, /任务已取消/);
    assert.equal(failed.requests.filter(item => item.path.endsWith('/cancel')).length, 1);
  });
  await check('cancel-lost-reply-recovers-without-repeat', async () => {
    const task = await create('取消回执丢失'); await reload(); await runUi('open', task);
    await runUi('click', { label: '取消任务' }); await runUi('control', { path: `/api/tasks/${task.id}/cancel`, mode: 'lost' });
    await runUi('click', { label: '确认取消', twice: true }); await runUi('task-visible', task); await runUi('text', { text: '已核对' });
    const state = await runUi('state'); assert.deepEqual(state.alerts, []); assert.equal(state.requests.filter(item => item.path.endsWith('/cancel')).length, 1);
    assert.equal((await getTask(task.id)).status, 'cancelled');
  });
  await check('confirmation-keyboard-focus-and-escape', async () => {
    const task = await create('确认键盘返回'); await reload(); await runUi('open', task); await runUi('click', { label: '取消任务' });
    assert.equal((await runUi('state')).focus.text, '返回任务', '默认焦点应放在返回操作');
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await until(async () => (await runUi('state')).focus.text === '确认取消');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await runUi('task-visible', task); assert.equal((await getTask(task.id)).status, 'backlog');
  });
  await check('confirmation-at-minimum-window-and-zoom', async () => {
    const task = await create('较长任务名称也必须完整说明取消后果，并保留返回按钮和确认按钮'); await reload(); await runUi('open', task);
    const size = window.getSize(), zoom = window.webContents.getZoomFactor();
    try {
      window.setSize(1040, 700);
      for (const factor of [1, 1.25, 1.5]) {
        window.webContents.setZoomFactor(factor);
        await runUi('click', { label: '取消任务' }); await runUi('text', { text: '任务不能再继续' });
        const layout = await runUi('layout');
        for (const rect of [layout.bounds, ...layout.buttons]) {
          assert.ok(rect.top >= -1 && rect.left >= -1 && rect.right <= layout.viewport.width + 1 && rect.bottom <= layout.viewport.height + 1, `确认框控件超出视口：${factor}`);
        }
        if (factor === 1.5) await capture('confirmation-150-percent');
        await runUi('escape'); await runUi('task-visible', task);
      }
    } finally { window.webContents.setZoomFactor(zoom); window.setSize(...size); }
  });
  await check('stop-run-keeps-log-and-task-return', async () => {
    const task = await create('终止作业返回日志'); await api(`/api/tasks/${task.id}/start`, {}); await reload(); await runUi('open', task);
    const run = (await api(`/api/tasks/${task.id}/progress`)).currentRuns[0];
    await runUi('click', { label: '查看当前作业日志' }); await runUi('click', { label: '终止执行' });
    await runUi('control', { path: `/api/runs/${run.id}/cancel`, mode: 'fail' }); await runUi('click', { label: '确认终止' }); await runUi('error');
    assert.deepEqual((await runUi('state')).alerts, []); assert.match((await runUi('state')).error, /TASK_ACTIONS_UNAVAILABLE/);
    await runUi('click', { label: '确认终止' }); await runUi('text', { text: '终端实时输出' });
    assert.equal((await api(`/api/runs/${run.id}`)).run.status, 'cancelled');
    await runUi('click', { label: '返回任务' }); await runUi('task-visible', task); assert.equal((await getTask(task.id)).status, 'blocked');
  });
  await check('stop-run-lost-reply-keeps-stopped-log', async () => {
    const task = await create('作业终止回执丢失'); await api(`/api/tasks/${task.id}/start`, {}); await reload(); await runUi('open', task);
    const run = (await api(`/api/tasks/${task.id}/progress`)).currentRuns[0];
    await runUi('click', { label: '查看当前作业日志' }); await runUi('click', { label: '终止执行' });
    await runUi('control', { path: `/api/runs/${run.id}/cancel`, mode: 'lost' }); await runUi('click', { label: '确认终止', twice: true });
    await runUi('text', { text: '终端实时输出' });
    const state = await runUi('state'); assert.deepEqual(state.alerts, []); assert.match(state.content, /已取消/);
    assert.equal(state.requests.filter(item => item.path.endsWith('/cancel')).length, 1);
  });
  await check('assignment-draft-survives-navigation-and-refresh', async () => {
    const task = await create('改派草稿往返'); await api(`/api/tasks/${task.id}/start`, {}); await api(`/api/tasks/${task.id}/pause`, {});
    await reload(); await runUi('open', task); await runUi('assignment-open');
    await runUi('edit', { selector: '#reassign-builder', value: second.id }); await runUi('edit', { selector: '#reassign-note', value: '保留现有成果，由乙接手完成' });
    await runUi('click', { label: '查看日志' }); await runUi('click', { label: '返回任务' }); await runUi('assignment-open');
    assert.equal((await runUi('state')).fields['reassign-note'], '保留现有成果，由乙接手完成');
    await reload(); await runUi('open', task); await runUi('assignment-open');
    const restored = await runUi('state'); assert.equal(restored.fields['reassign-builder'], second.id); assert.equal(restored.fields['reassign-note'], '保留现有成果，由乙接手完成');
    assert.ok(restored.buttons.find(item => item.text === '继续任务')?.disabled, '未应用的分工不能按原成员启动');
    await capture('restored-assignment');
    await runUi('control', { path: `/api/tasks/${task.id}/reassign`, mode: 'fail' }); await runUi('click', { label: '保存分工', twice: true }); await runUi('error');
    assert.equal((await runUi('state')).fields['reassign-note'], '保留现有成果，由乙接手完成');
    await runUi('click', { label: '保存分工' }); await runUi('text', { text: '分工已保存，成果已保留' });
    assert.equal((await getTask(task.id)).assigneeId, second.id); assert.equal((await getTask(task.id)).status, 'blocked');
    assert.equal((await api(`/api/tasks/${task.id}/progress`)).totalRuns, 1);
  });
  await check('assignment-discard-and-task-isolation', async () => {
    const task = await create('待应用分工'), other = await create('另一任务分工'); await reload(); await runUi('open', task); await runUi('assignment-open');
    await runUi('edit', { selector: '#reassign-builder', value: second.id }); await runUi('edit', { selector: '#reassign-note', value: '尚未应用的改派说明' });
    assert.ok((await runUi('state')).buttons.find(item => item.text === '启动任务')?.disabled);
    await runUi('click', { label: '关闭任务详情' }); await runUi('open', other); await runUi('assignment-open');
    assert.equal((await runUi('state')).fields['reassign-note'], ''); assert.equal((await runUi('state')).fields['reassign-builder'], first.id);
    assert.ok((await runUi('state')).buttons.find(item => item.text === '保存分工')?.disabled, '未改变分工不能重复保存');
    await runUi('click', { label: '关闭任务详情' }); await runUi('open', task); await runUi('assignment-open');
    assert.equal((await runUi('state')).fields['reassign-note'], '尚未应用的改派说明');
    await runUi('click', { label: '恢复当前分工' }); await until(async () => !(await runUi('state')).buttons.find(item => item.text === '启动任务')?.disabled);
    assert.equal((await runUi('state')).fields['reassign-builder'], first.id); assert.equal((await runUi('state')).fields['reassign-note'], '');
    assert.equal((await api(`/api/tasks/${task.id}/progress`)).totalRuns, 0);
  });
  await check('assignment-lost-reply-recovers-members-and-note-without-replay', async () => {
    const task = await create('改派回执丢失'); await reload(); await runUi('open', task); await runUi('assignment-open');
    await runUi('edit', { selector: '#reassign-builder', value: second.id }); await runUi('edit', { selector: '#reassign-note', value: '由乙接手，先核对现有成果' });
    await runUi('control', { path: `/api/tasks/${task.id}/reassign`, mode: 'lost' }); await runUi('click', { label: '保存分工', twice: true });
    await runUi('text', { text: '已核对成员分工和改派说明' });
    await until(async () => (await runUi('state')).buttons.some(item => item.text === '启动任务' && !item.disabled));
    const state = await runUi('state'); assert.equal(state.fields['reassign-note'], ''); assert.deepEqual(state.alerts, []);
    assert.equal(state.requests.filter(item => item.path.endsWith('/reassign')).length, 1);
    const updated = await getTask(task.id); assert.equal(updated.assigneeId, second.id); assert.match(updated.pendingFeedback, /由乙接手，先核对现有成果/);
    assert.equal((await api(`/api/tasks/${task.id}/progress`)).totalRuns, 0);
  });
  const accept = async task => {
    await runUi('open', task); await runUi('edit', { selector: '[data-testid="accept-note"]', value: '已核对交付说明，接受本轮成果' });
    assert.ok((await runUi('state')).buttons.find(item => item.text === '验收通过')?.disabled, '未配置机器验收必须显式人工确认');
    await runUi('check', { selector: '[data-testid="ack-missing-gate"]', checked: true });
  };
  await check('accept-inline-error-preserves-note-and-result', async () => {
    const task = reviews[0]; await accept(task); await runUi('control', { path: `/api/tasks/${task.id}/accept`, mode: 'fail' });
    await runUi('click', { label: '验收通过', twice: true }); await runUi('error');
    const state = await runUi('state'); assert.deepEqual(state.alerts, []); assert.match(state.error, /TASK_ACTIONS_UNAVAILABLE/); assert.equal(state.fields['accept-note'], '已核对交付说明，接受本轮成果');
    await runUi('click', { label: '验收通过' }); await runUi('task-visible', task); await runUi('text', { text: '验收已通过' });
    assert.equal((await getTask(task.id)).status, 'done');
    assert.match((await runUi('state')).content, /已记录的验收意见.*已核对交付说明，接受本轮成果/);
    await capture('acceptance-complete');
  });
  await check('accept-lost-reply-does-not-repeat-acceptance', async () => {
    const task = reviews[1]; await accept(task); await runUi('control', { path: `/api/tasks/${task.id}/accept`, mode: 'lost' });
    await runUi('click', { label: '验收通过', twice: true }); await runUi('text', { text: '已核对' });
    const state = await runUi('state'); assert.equal(state.taskId, task.id); assert.deepEqual(state.alerts, []);
    assert.equal(state.requests.filter(item => item.path.endsWith('/accept')).length, 1); assert.equal((await getTask(task.id)).status, 'done');
  });
  const revise = async task => {
    await runUi('open', task); await runUi('click', { label: '要求修改' }); await runUi('edit', { selector: '[data-testid="revise-feedback"]', value: '补充交付文件中的使用说明，保留已有内容' });
  };
  await check('revise-inline-error-preserves-feedback-and-result', async () => {
    const task = reviews[2]; await revise(task); await runUi('control', { path: `/api/tasks/${task.id}/revise`, mode: 'fail' });
    await runUi('click', { label: '提交修改要求', twice: true }); await runUi('error');
    const state = await runUi('state'); assert.deepEqual(state.alerts, []); assert.match(state.error, /TASK_ACTIONS_UNAVAILABLE/); assert.equal(state.fields['revise-feedback'], '补充交付文件中的使用说明，保留已有内容');
    await runUi('click', { label: '提交修改要求' }); await runUi('task-visible', task); await runUi('text', { text: '修改要求已提交' });
    assert.equal((await api(`/api/tasks/${task.id}/progress`)).totalRuns, 2);
  });
  await check('revise-lost-reply-recovers-without-duplicate-run', async () => {
    const task = reviews[3]; await revise(task); await runUi('control', { path: `/api/tasks/${task.id}/revise`, mode: 'lost' });
    await runUi('click', { label: '提交修改要求', twice: true }); await runUi('text', { text: '已核对' });
    assert.deepEqual((await runUi('state')).alerts, []); assert.equal((await api(`/api/tasks/${task.id}/progress`)).totalRuns, 2);
  });
  await check('late-acceptance-preserves-another-task-and-its-input', async () => {
    const task = reviews[4], other = await create('验收中查看另一任务'); await reload(); await accept(task);
    await runUi('control', { path: `/api/tasks/${task.id}/accept`, mode: 'hold' }); await runUi('click', { label: '验收通过' }); await runUi('waiting');
    await runUi('click', { label: '关闭任务详情' }); await runUi('open', other); await runUi('assignment-open');
    await runUi('edit', { selector: '#reassign-note', value: '另一任务尚未保存的内容' });
    await runUi('release'); await until(async () => (await runUi('state')).clears > 0); await runUi('task-visible', other);
    await until(async () => (await getTask(task.id)).status === 'done');
    assert.equal((await runUi('state')).fields['reassign-note'], '另一任务尚未保存的内容');
  });
  await check('completed-task-draft-cleanup-recovers-exit-without-resubmitting', async () => {
    const task = reviews[5]; await accept(task); await runUi('control', { path: '/api/ui-drafts', method: 'DELETE', mode: 'fail' });
    await runUi('click', { label: '验收通过' }); await runUi('text', { text: '文字草稿清理失败' });
    await until(async () => (await runUi('state')).buttons.some(item => item.text === '重试清理草稿' && !item.disabled));
    assert.equal((await getTask(task.id)).status, 'done');
    assert.equal(await prepareLeave(), false, '清理失败不能误报退出握手已完成'); cancelLeave();
    await capture('cleanup-after-acceptance');
    await runUi('click', { label: '重试清理草稿' }); await runUi('text', { text: '已清理提交时的草稿' });
    assert.equal((await runUi('state')).requests.filter(item => item.path.endsWith('/accept')).length, 1);
    assert.equal(await prepareLeave(), true); cancelLeave();
  });
  const started = (await api('/api/bootstrap?archived=1')).runs.filter(run => run.startedAt);
  assert.equal(started.length, reviews.length, '只允许注册的固定文件作业执行');
  return { ok: checks.every(item => item.ok), checks, screenshots, realModelCalls: 0, fixedFileRuns: started.length };
}
