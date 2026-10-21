import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Execute only named actions in our own renderer. Fixture content is never code.
async function rendererAction({ action, data = {} }) {
  const text = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = element => Boolean(element?.getClientRects().length);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const wait = async (predicate, message) => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const value = predicate(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(message);
  };
  const goal = () => document.querySelector('[data-testid="managed-request"]');
  const button = (label, root = document) => [...root.querySelectorAll('button')].find(element => visible(element)
    && (text(element.textContent) === label || element.getAttribute('aria-label') === label
      || text(element.querySelector(':scope > span:not(.nav-badge)')?.textContent) === label));
  const click = async (label, root = document, twice = false) => {
    const element = await wait(() => { const found = button(label, root); return found && !found.disabled && found; }, `缺少可用按钮：${label}`);
    element.click(); if (twice) element.click(); await settle();
  };
  if (action === 'ready') {
    await wait(() => document.querySelector('.header-actions button') && !document.querySelector('.loading-spinner'), '工作台尚未就绪');
    const state = { fetch: window.fetch.bind(window), controls: [], requests: [], releases: [], waiting: false };
    window.__managedRequestSmoke = state;
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.origin !== location.origin) return state.fetch(input, init);
      const method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null;
      if (url.pathname === '/api/requests' && method === 'POST') state.requests.push({ ...body, hasSignal: Boolean(init.signal) });
      const index = state.controls.findIndex(item => item.path === url.pathname && (item.method || 'POST') === method
        && (!item.kind || body?.scope?.kind === item.kind));
      if (index < 0) return state.fetch(input, init);
      const control = state.controls[index]; if (!control.repeat) state.controls.splice(index, 1);
      const failure = () => new Response(JSON.stringify({ error: control.error || 'MANAGED_UX_UNAVAILABLE' }),
        { status: control.status || 503, headers: { 'Content-Type': 'application/json' } });
      if (control.mode === 'fail') return failure();
      if (control.mode === 'timeout') {
        if (!init.signal) throw new Error('MANAGED_REQUEST_NO_TIMEOUT');
        return new Promise((_, reject) => {
          if (init.signal.aborted) reject(init.signal.reason);
          else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      }
      if (control.mode === 'hold-fail' || control.mode === 'hold-before') {
        state.waiting = true;
        await new Promise(resolve => state.releases.push(resolve)); state.waiting = false;
        if (control.mode === 'hold-fail') return failure();
      }
      const response = await state.fetch(input, init);
      if (control.mode === 'lost') throw new Error('MANAGED_UX_REPLY_LOST');
      if (control.mode === 'hold-reply') {
        state.waiting = true;
        await new Promise(resolve => state.releases.push(resolve)); state.waiting = false;
      }
      return response;
    };
    return true;
  }
  if (action === 'control') { window.__managedRequestSmoke.controls = Array.isArray(data) ? data : [data]; return true; }
  if (action === 'release') {
    window.__managedRequestSmoke.controls = [];
    for (const resolve of window.__managedRequestSmoke.releases.splice(0)) resolve(); await settle(); return true;
  }
  if (action === 'waiting') { await wait(() => window.__managedRequestSmoke.waiting, '请求未进入等待状态'); return true; }
  if (action === 'sent') { await wait(() => window.__managedRequestSmoke.requests.length > 0, '目标请求未发出'); return true; }
  if (action === 'open') { await click('交给主控', document.querySelector('.header-actions')); await wait(goal, '目标输入未打开'); return true; }
  if (action === 'loaded') { await wait(() => { const input = document.querySelector('#managed-objective'); return input && !input.disabled; }, '目标输入尚不可编辑'); return true; }
  if (action === 'click') { await click(data.label, data.goal ? goal() : document, data.twice); return true; }
  if (action === 'edit') {
    const element = await wait(() => { const found = document.querySelector(data.selector || '#managed-objective');
      return visible(found) && !found.disabled && found; }, '输入尚不可编辑');
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, data.value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await settle(); return true;
  }
  if (action === 'worker') {
    const label = [...document.querySelectorAll('[data-testid="managed-team-settings"] label')].find(element => text(element.textContent).startsWith(data.name));
    const input = label?.querySelector('input'); if (!input || input.disabled) throw new Error('协作成员不可选择');
    if (!input.checked) input.click(); await settle(); return true;
  }
  if (action === 'escape') {
    (data.window ? window : document.querySelector('#managed-objective')).dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true, cancelable: true, isComposing: Boolean(data.composing) }));
    await settle(); return true;
  }
  if (action === 'close-attempts') {
    goal()?.querySelector('.modal-header button')?.click(); goal()?.closest('.modal-overlay')?.click(); await settle(); return true;
  }
  if (action === 'error') {
    await wait(() => [...document.querySelectorAll('[role="alert"]')].some(element => visible(element) && text(element.textContent).includes(data.text || 'MANAGED_UX_UNAVAILABLE')), '没有显示操作失败及保留内容的反馈'); return true;
  }
  if (action === 'text') { await wait(() => text((data.goal ? goal() : document.body)?.textContent).includes(data.text), `页面未显示：${data.text}`); return true; }
  if (action === 'closed') { await wait(() => !goal(), '目标输入未关闭'); return true; }
  if (action === 'task') { await wait(() => document.querySelector(`[data-task-detail="${CSS.escape(data.id)}"]`), '已创建的任务没有显示'); return true; }
  if (action === 'saved') { await wait(() => text(goal()?.querySelector('[role="status"]')?.textContent).includes('已保存'), '目标尚未保存'); return true; }
  if (action === 'focus') { await wait(() => document.activeElement?.id === 'managed-objective', '草稿恢复后焦点没有进入目标输入'); return true; }
  if (action === 'layout') {
    const primary = goal().querySelector('button[type="submit"]'), footer = goal().querySelector('.modal-footer').getBoundingClientRect();
    const body = goal().querySelector('.modal-body'), retry = goal().querySelector('[data-testid="managed-draft-retry"]');
    const bounds = retry?.getBoundingClientRect();
    const retryReachable = Boolean(bounds && bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth
      && retry.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)));
    return { viewport: { width: innerWidth, height: innerHeight }, footerVisible: footer.top >= 0 && footer.bottom <= innerHeight
      && footer.left >= 0 && footer.right <= innerWidth, primaryVisible: visible(primary), retryReachable, bodyCanScroll: body.scrollHeight > body.clientHeight };
  }
  if (action === 'state') return {
    goalOpen: Boolean(goal()), objective: document.querySelector('#managed-objective')?.value,
    disabled: document.querySelector('#managed-objective')?.disabled,
    content: text(goal()?.textContent), taskId: document.querySelector('[data-task-detail]')?.dataset.taskDetail,
    focus: document.activeElement?.id || document.activeElement?.getAttribute('aria-label'),
    buttons: [...document.querySelectorAll('button')].filter(visible).map(element => ({ text: text(element.textContent), disabled: element.disabled })),
    requests: window.__managedRequestSmoke.requests,
  };
  throw new Error(`未知的主控目标场景：${action}`);
}

export async function runManagedRequestSmoke(window, { url, token, workspace, nodePath, prepareLeave, cancelLeave }) {
  const root = fs.realpathSync(workspace), origin = new URL(url).origin;
  assert.match(root, /[\\/]work[\\/]desktop-smoke[\\/]run-[^\\/]+$/i);
  assert.ok(process.argv.includes('--desktop-smoke') && process.argv.includes('--managed-request-smoke'));
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + route, { method, headers: { 'X-CLI-Team-Desktop': token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    assert.ok(response.ok, `主控目标检查接口失败：${route} ${String(result.error || response.status).replaceAll(token, '[REDACTED]')}`); return result;
  };
  const runUi = (action, data) => {
    assert.equal(new URL(window.webContents.getURL()).origin, origin);
    return window.webContents.executeJavaScript(`(${rendererAction.toString()})(${JSON.stringify({ action, data })})`, true);
  };
  const reload = async (roomId = 'team') => {
    await runUi('release').catch(() => {}); cancelLeave();
    await window.loadURL(`${origin}/?room=${encodeURIComponent(roomId)}`); await runUi('ready');
  };
  const initial = await api('/api/bootstrap'); assert.equal(fs.realpathSync(initial.workspace.root), root); assert.equal(initial.tasks.length, 0);
  await api('/api/settings', { paused: true }, 'PATCH');
  const member = (name, handle) => api('/api/members', { name, handle, provider: 'custom', role: 'builder', permission: 'edit', enabled: true,
    executable: nodePath, prefixArgs: ['--version'], customArgs: [], inputMode: 'stdin' });
  const owner = await member('目标主控', 'goal-owner'), worker = await member('目标协作者', 'goal-worker');
  const team = { ownerId: owner.id, workerIds: [worker.id], reviewerId: null, verification: null, autoDeliver: true };
  const channel = await api('/api/rooms', { name: '目标所属频道' });
  const scope = roomId => ({ workspace: root, scope: { kind: 'managed-request', roomId } });
  const readDraft = (roomId = 'team') => api('/api/ui-drafts/read', scope(roomId));
  const reset = async () => {
    await reload();
    for (const roomId of ['team', channel.id]) {
      const draft = await readDraft(roomId); await api('/api/ui-drafts', { ...scope(roomId), revision: draft.revision }, 'DELETE');
    }
    await api('/api/settings', { paused: true, managedTeam: team }, 'PATCH'); await reload();
  };
  const screenshots = [], checks = [], size = window.getSize(), zoom = window.webContents.getZoomFactor();
  const capture = async name => {
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const file = path.join(root, `managed-request-${name}.png`);
    fs.writeFileSync(file, (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); screenshots.push(file); return file;
  };
  const check = async (name, action) => {
    try { await action(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, error: String(error.message).replaceAll(token, '[REDACTED]'),
      screenshot: await capture(name).catch(() => null), state: await runUi('state').catch(() => null) }); }
    finally { window.webContents.setZoomFactor(zoom); window.setSize(...size); await reset(); }
    fs.writeFileSync(path.join(root, 'managed-request-checks.json'), JSON.stringify(checks, null, 2));
  };
  const openGoal = async objective => { await runUi('open'); await runUi('loaded'); if (objective) { await runUi('edit', { value: objective }); await runUi('saved'); } };
  const failure = (method = 'PUT', extra = {}) => ({ path: method === 'POST' ? '/api/ui-drafts/read' : '/api/ui-drafts', method, kind: 'managed-request', mode: 'fail', repeat: true, ...extra });
  const latest = async objective => (await api('/api/bootstrap')).tasks.find(task => task.objective === objective);
  try {
    await reset();
    await check('read-failure-retry-in-place', async () => {
      await runUi('control', failure('POST')); await runUi('open'); await runUi('error');
      assert.equal((await runUi('state')).disabled, true);
      await runUi('release'); await runUi('click', { label: '重试读取草稿' }); await runUi('loaded');
    });
    await check('focus-after-draft-recovery', async () => {
      await runUi('control', failure('POST', { mode: 'hold-before', repeat: false })); await runUi('open'); await runUi('waiting');
      await runUi('release'); await runUi('loaded'); await runUi('focus');
    });
    await check('failed-save-keeps-close-open', async () => {
      await openGoal(); await runUi('control', failure()); await runUi('edit', { value: '保存失败仍保留的目标' }); await runUi('error');
      await runUi('click', { label: '稍后继续', goal: true });
      assert.equal((await runUi('state')).goalOpen, true, '保存失败时关闭丢失了可恢复的输入入口');
      await runUi('release'); await runUi('click', { label: '重试保存目标' }); await runUi('saved');
      await runUi('click', { label: '稍后继续', goal: true }); await runUi('closed'); await reload(); await openGoal();
      assert.equal((await runUi('state')).objective, '保存失败仍保留的目标');
    });
    await check('failed-save-keeps-settings-detour-open', async () => {
      await api('/api/settings', { managedTeam: null }, 'PATCH'); await reload(); await openGoal();
      await runUi('control', failure()); await runUi('edit', { value: '先保存再去设置团队' }); await runUi('error');
      await runUi('click', { label: '配置团队', goal: true });
      assert.equal((await runUi('state')).goalOpen, true, '保存失败时仍离开了目标输入');
      await runUi('release'); await runUi('click', { label: '重试保存目标' }); await runUi('saved');
      await runUi('click', { label: '配置团队', goal: true }); await runUi('closed');
      await runUi('text', { text: '返回继续填写目标' });
    });
    await check('closing-waits-for-save-and-blocks-repeat-actions', async () => {
      await openGoal(); await runUi('control', failure('PUT', { mode: 'hold-before', repeat: false }));
      await runUi('edit', { value: '等待保存回执再关闭' }); await runUi('waiting');
      await runUi('click', { label: '稍后继续', goal: true }); await runUi('escape', { window: true }); await runUi('close-attempts');
      assert.equal((await runUi('state')).goalOpen, true); assert.equal(await prepareLeave(), false); cancelLeave();
      await runUi('release'); await runUi('closed'); assert.equal((await readDraft()).draft.values.objective, '等待保存回执再关闭');
    });
    await check('ime-escape-preserves-goal', async () => {
      await openGoal('中文输入法取消选字'); await runUi('escape', { composing: true });
      assert.equal((await runUi('state')).goalOpen, true, '取消选字关闭了目标输入');
      assert.equal((await runUi('state')).objective, '中文输入法取消选字');
      window.webContents.focus(); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await runUi('closed');
    });
    await check('settings-and-members-return-to-original-goal', async () => {
      await api('/api/settings', { managedTeam: null }, 'PATCH'); await reload(channel.id); await openGoal('属于原频道的目标');
      await runUi('click', { label: '配置团队', goal: true }); await runUi('click', { label: '管理成员' });
      await runUi('click', { label: '返回配置主控团队' });
      await runUi('edit', { selector: '#managed-ownerId', value: owner.id }); await runUi('worker', { name: worker.name });
      await runUi('click', { label: '保存主控团队' }); await runUi('text', { text: '主控团队已保存' });
      await runUi('click', { label: '返回继续填写目标' }); await runUi('loaded');
      assert.equal((await runUi('state')).objective, '属于原频道的目标');
      await capture('returned-goal');
      await runUi('click', { label: '交给主控执行', goal: true }); await runUi('closed'); const task = await latest('属于原频道的目标');
      assert.ok(task); assert.equal(task.roomId, channel.id); await runUi('task', { id: task.id });
    });
    await check('saved-team-usable-during-list-refresh-failure', async () => {
      await api('/api/settings', { managedTeam: null }, 'PATCH'); await reload(); await openGoal('使用刚保存的团队');
      await runUi('click', { label: '配置团队', goal: true });
      await runUi('edit', { selector: '#managed-ownerId', value: owner.id }); await runUi('worker', { name: worker.name });
      await runUi('control', { path: '/api/bootstrap', method: 'GET', mode: 'fail', repeat: true });
      await runUi('click', { label: '保存主控团队' }); await runUi('text', { text: '主控团队已保存' });
      await runUi('open'); await runUi('loaded'); const state = await runUi('state');
      assert.ok(state.content.includes(owner.name)); assert.equal(state.buttons.find(button => button.text === '交给主控执行')?.disabled, false);
    });
    await check('pre-submit-save-failure-allows-correction', async () => {
      await openGoal('还未提交的目标'); await runUi('control', failure()); await runUi('click', { label: '交给主控执行', goal: true });
      await runUi('error', { text: '目标尚未' }); const state = await runUi('state'); assert.equal(state.requests.length, 0);
      assert.equal(state.disabled, false, '未发送的请求仍锁住了目标'); await runUi('release');
      await runUi('edit', { value: '保存恢复后修正的目标' }); await runUi('saved'); assert.equal((await readDraft()).draft.values.requestId, '');
    });
    await check('explicit-rejection-allows-edit-and-resubmit', async () => {
      await openGoal('队列暂满的目标'); await runUi('control', { path: '/api/requests', mode: 'fail', status: 429 });
      await runUi('click', { label: '交给主控执行', goal: true, twice: true }); await runUi('error'); await runUi('loaded');
      await runUi('edit', { value: '更正后提交的目标' }); await runUi('saved'); await runUi('click', { label: '交给主控执行', goal: true });
      await runUi('closed'); const task = await latest('更正后提交的目标'); assert.ok(task); await runUi('task', { id: task.id });
      assert.equal((await runUi('state')).requests.length, 2);
    });
    await check('pending-submit-blocks-native-escape-and-leave', async () => {
      await openGoal('提交中保护原目标'); await runUi('control', { path: '/api/requests', mode: 'hold-reply' });
      await runUi('click', { label: '交给主控执行', goal: true, twice: true }); await runUi('waiting');
      window.webContents.focus(); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await runUi('escape', { window: true }); await runUi('close-attempts');
      assert.equal((await runUi('state')).goalOpen, true); assert.equal(await prepareLeave(), false); cancelLeave();
      await runUi('release'); await runUi('closed'); assert.equal((await runUi('state')).requests.length, 1);
    });
    await check('lost-reply-reload-reuses-request-after-team-change', async () => {
      await openGoal('回执丢失后找回同一目标'); await runUi('control', { path: '/api/requests', mode: 'lost' });
      await runUi('click', { label: '交给主控执行', goal: true, twice: true }); await runUi('error', { text: 'MANAGED_UX_REPLY_LOST' });
      const state = await runUi('state'); assert.equal(state.disabled, true); assert.equal(state.requests.length, 1);
      const task = await latest('回执丢失后找回同一目标'); assert.ok(task);
      // A later rejected retry cannot erase uncertainty about the first request.
      await runUi('control', { path: '/api/requests', mode: 'fail', status: 400 });
      await runUi('click', { label: '重试同一请求', goal: true }); await runUi('error');
      assert.equal((await runUi('state')).disabled, true); assert.equal((await readDraft()).draft.values.requestId, state.requests[0].requestId);
      await api('/api/settings', { managedTeam: null }, 'PATCH'); await reload(); await runUi('open');
      await runUi('text', { text: '重试同一请求', goal: true }); await runUi('click', { label: '重试同一请求', goal: true }); await runUi('task', { id: task.id });
      const retry = (await runUi('state')).requests; assert.equal(retry.length, 1); assert.equal(retry[0].requestId, state.requests[0].requestId);
      const progress = await api(`/api/tasks/${task.id}/progress`); assert.equal(progress.totalRuns, 1);
    });
    await check('clear-failure-retries-cleanup-without-resubmission', async () => {
      await openGoal('提交后只重试清理草稿'); await runUi('control', failure('DELETE'));
      await runUi('click', { label: '交给主控执行', goal: true }); await runUi('closed'); const task = await latest('提交后只重试清理草稿'); assert.ok(task);
      await runUi('task', { id: task.id }); await runUi('text', { text: '重试清理草稿' });
      await capture('cleanup-recovery');
      assert.equal(await prepareLeave(), false); cancelLeave();
      await runUi('release'); await runUi('click', { label: '重试清理草稿', twice: true }); await runUi('text', { text: '已清理提交时的草稿' });
      assert.equal((await readDraft()).draft, null); assert.equal((await runUi('state')).requests.length, 1);
      assert.equal(await prepareLeave(), true); cancelLeave();
    });
    await check('created-task-survives-bootstrap-failure', async () => {
      await openGoal('列表读取失败仍能打开刚创建的任务'); await runUi('control', { path: '/api/bootstrap', method: 'GET', mode: 'fail', repeat: true });
      await runUi('click', { label: '交给主控执行', goal: true }); await runUi('closed'); const task = await latest('列表读取失败仍能打开刚创建的任务'); assert.ok(task);
      await runUi('task', { id: task.id }); assert.equal((await runUi('state')).requests.length, 1);
    });
    await check('submission-timeout-preserves-request-for-retry', async () => {
      await openGoal('超时后核对同一目标'); await runUi('control', { path: '/api/requests', mode: 'timeout' });
      await runUi('click', { label: '交给主控执行', goal: true });
      await runUi('sent');
      const sent = (await runUi('state')).requests[0]; assert.equal(sent.hasSignal, true, '提交请求缺少超时边界');
      const deadline = Date.now() + 18000;
      while (Date.now() < deadline && !(await runUi('state')).content.includes('重试同一请求')) await new Promise(resolve => setTimeout(resolve, 150));
      await runUi('text', { text: '提交结果尚未确认', goal: true });
      await runUi('click', { label: '重试同一请求', goal: true }); await runUi('closed');
      const requests = (await runUi('state')).requests; assert.equal(requests.length, 2); assert.equal(requests[1].requestId, sent.requestId);
    });
    await check('small-window-keeps-recovery-and-submit-reachable', async () => {
      await openGoal('小窗口中继续填写与重试\n'.repeat(25)); await runUi('control', failure());
      await runUi('edit', { value: '小窗口中继续填写与重试\n'.repeat(26) }); await runUi('error'); window.setSize(1040, 700);
      const layouts = [];
      for (const factor of [1, 1.25, 1.5]) {
        window.webContents.setZoomFactor(factor); await capture(`goal-error-${Math.round(factor * 100)}`);
        const layout = await runUi('layout'), contentSize = window.getContentSize();
        assert.ok(Math.abs(layout.viewport.width - contentSize[0] / factor) <= 1); assert.ok(Math.abs(layout.viewport.height - contentSize[1] / factor) <= 1);
        assert.equal(layout.footerVisible, true); assert.equal(layout.primaryVisible, true); assert.equal(layout.retryReachable, true);
        layouts.push({ factor, ...layout });
      }
      await runUi('release'); await runUi('click', { label: '重试保存目标' }); await runUi('saved'); await capture('goal-recovered-150');
      fs.writeFileSync(path.join(root, 'managed-request-layouts.json'), JSON.stringify(layouts, null, 2));
    });
    const final = await api('/api/bootstrap?archived=1');
    assert.ok(final.workspace.paused); assert.ok(final.runs.every(run => !run.startedAt));
    return { ok: checks.every(check => check.ok), checks, screenshots, realModelCalls: 0, actualCliRunsStarted: 0,
      createdTasks: final.tasks.length, queuedRuns: final.runs.length };
  } finally { await runUi('release').catch(() => {}); cancelLeave(); window.webContents.setZoomFactor(zoom); window.setSize(...size); }
}
