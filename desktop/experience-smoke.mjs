import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Fixed user journeys in an isolated developer workspace. No real model is used.
async function rendererAction({ action, data = {} }) {
  const text = value => String(value || '').replace(/\s+/g, ' ').trim();
  const shown = element => Boolean(element?.getClientRects().length);
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(typeof label === 'function' ? label() : label);
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const button = (label, root = document) => [...root.querySelectorAll('button')].find(element => shown(element)
    && (text(element.textContent) === label || element.getAttribute('aria-label') === label
      || text(element.querySelector(':scope > span:not(.nav-badge)')?.textContent) === label));
  const click = async (label, root = document) => {
    const element = await wait(() => { const found = button(label, root); return found && !found.disabled && found; }, `缺少可用操作：${label}`);
    element.click(); await settle();
  };
  const value = async (element, next) => {
    if (!element || element.matches(':disabled')) throw new Error('目标输入不可编辑');
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, next);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await settle();
  };
  const modal = () => [...document.querySelectorAll('.modal-content')].find(shown);
  const settings = () => [...document.querySelectorAll('.settings-view form')].find(form => text(form.textContent).includes('运行参数配置'));
  const setting = name => settings()?.querySelector(`[name="${name}"]`)
    || [...(settings()?.querySelectorAll('.form-group') || [])].find(group => text(group.querySelector('label')?.textContent).includes(name))?.querySelector('input');
  if (action === 'ready') {
    await wait(() => document.querySelector('textarea[aria-label="消息"]') && !document.querySelector('textarea[aria-label="消息"]').disabled, '工作台未加载');
    const state = { fetch: window.fetch.bind(window), alerts: [], traces: [], responses: {}, pending: null, release: null,
      waiting: false, clipboardWrites: [], clipboardFailure: false, artifactRequests: [],
      failNext: null, recoveredFailures: [] };
    window.__experienceSmoke = state;
    window.alert = message => state.alerts.push(String(message));
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = init.method || 'GET';
      if (state.failNext?.path === url.pathname && state.failNext.method === method) {
        const failure = state.failNext;
        state.failNext = null;
        state.recoveredFailures.push(failure);
        return new Response(JSON.stringify({ error: failure.error }), { status: 503,
          headers: { 'Content-Type': 'application/json' } });
      }
      if (/^\/api\/artifacts\//.test(url.pathname)) state.artifactRequests.push({ path: url.pathname, method, at: Date.now() });
      const tracked = url.origin === location.origin && /^\/api\/(settings|rooms|meetings|members)(\/|$)/.test(url.pathname) && ['POST', 'PATCH'].includes(method);
      if (tracked) state.traces.push({ path: url.pathname, method, body: JSON.parse(init.body || '{}') });
      if (state.responses[url.pathname]) return new Response(JSON.stringify(state.responses[url.pathname]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      const control = state.pending;
      if (!control || url.pathname !== control.path || method !== control.method) return state.fetch(input, init);
      state.pending = null;
      if (control.mode === 'fail') return new Response(JSON.stringify({ error: 'EXPERIENCE_SERVICE_UNAVAILABLE' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      const response = await state.fetch(input, init);
      if (control.mode === 'lost') throw new Error('EXPERIENCE_REPLY_LOST');
      state.waiting = true;
      await new Promise(resolve => { state.release = resolve; });
      state.waiting = false;
      return response;
    };
    return { ready: true };
  }
  if (action === 'nav') { await click(data.label); return true; }
  if (action === 'trace') return { alerts: window.__experienceSmoke.alerts, requests: window.__experienceSmoke.traces,
    artifactRequests: window.__experienceSmoke.artifactRequests, dialog: text(modal()?.textContent),
    values: [...(modal()?.querySelectorAll('input,textarea') || [])].map(input => ({ value: input.value,
      disabled: input.matches(':disabled'), checked: input.checked })) };
  if (action === 'control') { window.__experienceSmoke.pending = data; return true; }
  if (action === 'release') { window.__experienceSmoke.release?.(); await settle(); return true; }
  if (action === 'waiting') { await wait(() => window.__experienceSmoke.waiting, '请求未进入延迟窗口'); return true; }
  if (action === 'edit-setting') {
    const input = await wait(() => setting(data.name), '设置字段缺失');
    await value(input, data.value);
    return { value: input.value, disabled: input.disabled };
  }
  if (action === 'read-setting') return { value: setting(data.name)?.value, disabled: setting(data.name)?.matches(':disabled'),
    notice: text(settings()?.textContent), alerts: window.__experienceSmoke.alerts };
  if (action === 'save-settings') { await click('保存并应用设置', settings()); return true; }
  if (action === 'save-settings-twice') {
    settings().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    settings().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle(); return true;
  }
  if (action === 'saved-settings') { await wait(() => text(settings()?.textContent).includes('设置已保存'), '保存结果未显示'); return true; }
  if (action === 'settings-error') {
    await wait(() => text(settings()?.querySelector('[role="alert"]')?.textContent).includes('EXPERIENCE_SERVICE_UNAVAILABLE'), '保存失败未在原表单提示');
    return { alerts: window.__experienceSmoke.alerts };
  }
  if (action === 'settings-scroll') { settings().scrollIntoView({ block: 'start' }); await settle(); return true; }
  if (action === 'team-owner') { await value(await wait(() => document.querySelector('#managed-ownerId'), '主控团队表单缺失'), data.id); return true; }
  if (action === 'team-state') return { owner: document.querySelector('#managed-ownerId')?.value };
  if (action === 'room-select') {
    const item = await wait(() => [...document.querySelectorAll('.room-item')].find(element => text(element.querySelector('.room-name')?.textContent) === data.name), '聊天室入口缺失');
    item.click(); await wait(() => text(document.querySelector('.chat-header-title strong')?.textContent) === data.name, '没有切换到指定聊天室'); return true;
  }
  if (action === 'open-room') { await click('创建新讨论室'); return true; }
  if (action === 'room-name') { await value(await wait(() => {
    const input = modal()?.querySelector('input'); return input && !input.disabled && input;
  }, '聊天室草稿未恢复为可编辑状态'), data.name); return true; }
  if (action === 'room-submit-twice') {
    const form = modal().querySelector('form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle(); return true;
  }
  if (action === 'room-created') {
    await wait(() => text(document.querySelector('.chat-header-title strong')?.textContent) === data.name && !modal(), '新房间没有打开');
    return { roomId: new URL(location.href).searchParams.get('room') };
  }
  if (action === 'room-state') return { name: modal()?.querySelector('input')?.value, disabled: modal()?.querySelector('input')?.disabled,
    error: text(modal()?.querySelector('[role="alert"]')?.textContent), content: text(modal()?.textContent), alerts: window.__experienceSmoke.alerts };
  if (action === 'open-meeting') { await click('发起讨论'); return true; }
  if (action === 'meeting-form') {
    const form = await wait(() => modal()?.querySelector('form'), '讨论表单缺失');
    if (data.objective !== undefined) await value(await wait(() => {
      const input = form.querySelector('textarea'); return input && !input.disabled && input;
    }, '讨论草稿未恢复为可编辑状态'), data.objective);
    for (const name of data.members || []) {
      const label = [...form.querySelectorAll('label')].find(element => text(element.textContent).includes(name));
      const input = label?.querySelector('input[type="checkbox"]');
      if (!input || input.disabled) throw new Error(`成员不可选择：${name}`);
      if (!input.checked) { input.click(); await settle(); }
    }
    return { objective: form.querySelector('textarea')?.value, content: text(form.textContent) };
  }
  if (action === 'meeting-submit-twice') {
    const form = modal().querySelector('form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle(); return true;
  }
  if (action === 'modal-button') { await click(data.label, modal()); return true; }
  if (action === 'modal-closed') { await wait(() => !modal(), '弹窗未关闭'); return true; }
  if (action === 'meeting-error') {
    await wait(() => text(modal()?.querySelector('[role="alert"]')?.textContent).includes('EXPERIENCE_REPLY_LOST'), '讨论响应丢失后没有保留表单错误');
    return { objective: modal()?.querySelector('textarea')?.value, frozen: modal()?.querySelector('textarea')?.disabled };
  }
  if (action === 'dialog-error') { await wait(() => text(modal()?.querySelector('[role="alert"]')?.textContent).includes(data.text), '对话框没有显示预期错误'); return true; }
  if (action === 'meeting-selections') return [...modal().querySelectorAll('input[type="checkbox"]')].map(input => ({ name: text(input.closest('label')?.textContent), checked: input.checked, disabled: input.matches(':disabled') }));
  if (action === 'member-open') {
    const card = await wait(() => [...document.querySelectorAll('.member-card')].find(element => text(element.querySelector('.member-name')?.textContent) === data.name), '成员卡片缺失');
    await click('编辑配置', card); return true;
  }
  if (action === 'member-edit') {
    const input = await wait(() => modal()?.querySelector('input'), '成员表单未打开');
    await value(input, data.name); return true;
  }
  if (action === 'member-prefix') {
    const group = [...modal().querySelectorAll('.form-group')].find(element => text(element.querySelector('label')?.textContent).includes('前置参数'));
    await value(group.querySelector('input'), data.value); return true;
  }
  if (action === 'member-handle') {
    const input = modal().querySelector('input[pattern]');
    await value(input, data.value);
    return { valid: input.checkValidity(), patternMismatch: input.validity.patternMismatch };
  }
  if (action === 'member-double-save') {
    const form = modal().querySelector('form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle(); return true;
  }
  if (action === 'member-frozen') {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    return { open: Boolean(modal()), disabled: Boolean(modal()?.querySelector('input')?.matches(':disabled')), name: modal()?.querySelector('input')?.value };
  }
  if (action === 'clipboard-setup') {
    const state = window.__experienceSmoke;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async content => {
      if (state.clipboardFailure) throw new Error('TEST_CLIPBOARD_DENIED');
      state.clipboardWrites.push(content);
    } } });
    return true;
  }
  if (action === 'copy-message') {
    window.__experienceSmoke.clipboardFailure = Boolean(data.fail);
    const card = await wait(() => [...document.querySelectorAll('.message-card')].find(element => text(element.querySelector('.message-body')?.textContent).includes(data.body)), '待复制的消息未出现');
    card.querySelector('button[title="复制正文"]').click();
    await wait(() => data.fail ? card.querySelector('[role="alert"]') : text(card.textContent).includes('已复制'), '复制操作没有反馈');
    return { writes: window.__experienceSmoke.clipboardWrites, failed: Boolean(card.querySelector('[role="alert"]')) };
  }
  if (action === 'preview-open') { await click(`预览 ${data.name}`); return true; }
  if (action === 'preview-ready') { await wait(() => text(modal()?.querySelector('pre')?.textContent).includes('EXPERIENCE_FIXED_DELIVERY'),
    '预览重试未显示文件内容：' + JSON.stringify({ dialog: text(modal()?.textContent),
      requests: window.__experienceSmoke.artifactRequests })); return true; }
  if (action === 'download') { await click(`下载 ${data.name}`, data.modal ? modal() : document); return true; }
  if (action === 'download-error') { await wait(() => [...document.querySelectorAll('[role="alert"]')].some(element => shown(element) && text(element.textContent).includes(data.text)), '下载失败没有原地提示'); return true; }
  if (action === 'context-artifacts') { const tab = await wait(() => document.querySelector('#room-tab-artifacts'), '成果侧栏未打开'); tab.click(); await settle(); return true; }
  if (action === 'external-fixture') {
    const session = { sessionId: 'experience-external', title: '同步版本验证', workspace: data.workspace,
      activity: 'idle', formatVersion: 4, eventCount: 2, partial: false, updatedAt: '2026-10-14T01:00:00Z',
      lastEventAt: null, lastTool: '', summary: '旧的答复', lastRequest: '', model: '', provider: 'local', mode: 'observe', ownership: 'desktop', canControl: false };
    window.__experienceSmoke.responses['/api/integrations/dsh/sessions'] = { home: data.workspace, sessions: [session], warnings: [] };
    window.__experienceSmoke.responses['/api/integrations/dsh/refresh'] = { sessions: [{ ...session, updatedAt: '2026-10-14T01:01:00Z', summary: '刚刚同步的新答复' }], errors: [] };
    return true;
  }
  if (action === 'external-ready') { await wait(() => text(document.querySelector('.external-summary')?.textContent) === '刚刚同步的新答复', '旧列表覆盖了刚同步的答复'); return true; }
  if (action === 'external-failure') {
    const state = window.__experienceSmoke;
    state.responses = {};
    state.failNext = { path: '/api/integrations/dsh/sessions', method: 'GET',
      error: 'EXPERIENCE_DSH_UNAVAILABLE' };
    return true;
  }
  if (action === 'external-error') {
    const alert = await wait(() => [...document.querySelectorAll('.external-error[role="alert"]')]
      .find(element => text(element.textContent).includes('EXPERIENCE_DSH_UNAVAILABLE')), '外部会话失败没有显示可恢复错误');
    return { retry: Boolean(button('重试同步', alert)), text: text(alert.textContent) };
  }
  if (action === 'external-retry-ready') {
    await wait(() => window.__experienceSmoke.recoveredFailures.some(failure =>
      failure.path === '/api/integrations/dsh/sessions') && !document.querySelector('.external-error[role="alert"]')
      && !document.querySelector('[aria-label="同步 DSH 会话"]:disabled')
      && (Boolean(document.querySelector('.external-row')) || Boolean(document.querySelector('.external-empty'))),
    () => '外部会话重试后没有回到有效空状态：' + text(document.querySelector('.external-view')?.textContent));
    return true;
  }
  if (action === 'tasks-empty') {
    const empty = await wait(() => document.querySelector('.tasks-empty'), '空看板没有说明与下一步');
    return { text: text(empty.textContent), buttons: [...empty.querySelectorAll('button')].map(element => text(element.textContent)) };
  }
  if (action === 'click-external-retry') {
    const alert = await wait(() => document.querySelector('.external-error[role="alert"]'), '外部会话错误未显示');
    const retry = await wait(() => button('重试同步', alert), '外部会话错误缺少重试入口');
    retry.click(); await settle(); return true;
  }
  if (action === 'visible-text') { await wait(() => [...document.querySelectorAll(data.selector || 'button')].some(element => shown(element) && text(element.textContent).includes(data.text)), '没有显示预期内容：' + data.text); return true; }
  if (action === 'task-open') {
    await click('任务看板');
    const card = await wait(() => [...document.querySelectorAll('.task-card')].find(element => text(element.querySelector('.task-card-title')?.textContent) === data.title), '任务卡片未显示');
    card.click(); await wait(() => modal()?.querySelector('.coordination-panel'), '任务详情未加载'); return true;
  }
  if (action === 'open-task-log') { await click('查看当前作业日志', modal()); return true; }
  if (action === 'log-error') {
    await wait(() => modal() && text(modal().textContent).includes('EXPERIENCE_SERVICE_UNAVAILABLE') && button('重试加载', modal()), '日志初次失败后未保留重试入口');
    return { alerts: window.__experienceSmoke.alerts };
  }
  if (action === 'log-ready') { await wait(() => modal()?.querySelector('.log-terminal'), '日志重试没有恢复'); return true; }
  if (action === 'task-still-open') { await wait(() => modal()?.querySelector('.coordination-panel') && text(modal().textContent).includes(data.title), '迟到日志响应改变了当前任务页面'); return true; }
  throw new Error(`未知场景 ${action}`);
}
const source = rendererAction.toString();

export async function runExperienceSmoke(window, { url, token, workspace, nodePath, prepareLeave, cancelLeave }) {
  const root = fs.realpathSync(workspace), origin = new URL(url).origin;
  assert.match(root, /[\\/]work[\\/]desktop-smoke[\\/]run-[^\\/]+$/i);
  assert.ok(process.argv.includes('--desktop-smoke') && process.argv.includes('--experience-smoke'));
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + route, { method, headers: { 'X-CLI-Team-Desktop': token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const value = await response.json();
    assert.ok(response.ok, `体验检查接口失败 ${route}：${String(value.error || response.status).replaceAll(token, '[REDACTED]')}`);
    return value;
  };
  const initial = await api('/api/bootstrap?archived=1');
  assert.equal(initial.workspace.root, root);
  assert.equal(initial.tasks.length + initial.runs.length + initial.meetings.length, 0, '只允许使用空的体验测试目录');
  await api('/api/settings', { paused: true, maxHops: 2 }, 'PATCH');
  const member = (name, handle, enabled = true) => api('/api/members', { name, handle: handle || (name === '体验成员甲' ? 'experience-a' : 'experience-b'), provider: 'custom',
    role: 'builder', permission: 'edit', executable: nodePath, enabled, inputMode: 'stdin', prefixArgs: [], customArgs: [] });
  const first = await member('体验成员甲'), second = await member('体验成员乙');
  const runUi = (action, data) => {
    assert.equal(new URL(window.webContents.getURL()).origin, origin);
    return window.webContents.executeJavaScript(`(${source})(${JSON.stringify({ action, data })})`, true);
  };
  const reload = async () => {
    await runUi('release').catch(() => {});
    cancelLeave();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('体验页面刷新超时')), 12000);
      window.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
      window.webContents.reload();
    });
    await runUi('ready');
  };
  const until = async predicate => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 60)); }
    throw new Error('操作结果未返回');
  };
  const checks = [], screenshots = [];
  const capture = async name => {
    // A hidden Electron window can return its previous compositor frame.
    // Request a frame, wait for painting, then capture the actual current UI.
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const filename = path.join(root, `experience-${name}.png`);
    fs.writeFileSync(filename, (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    screenshots.push(filename);
  };
  const check = async (name, test) => {
    try { await reload(); await test(); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: error.message, state: await runUi('trace').catch(() => null) }); }
    await capture(name);
    fs.writeFileSync(path.join(root, 'experience-checks.json'), JSON.stringify({ checks, screenshots }, null, 2));
  };
  await check('empty-workspace-next-steps', async () => {
    await runUi('nav', { label: '任务看板' });
    const empty = await runUi('tasks-empty');
    assert.match(empty.text, /还没有任务/);
    assert.deepEqual(empty.buttons, ['提交第一个目标', '创建单人任务']);
  });
  const fixtureMember = await api('/api/members', { name: '固定文件成员', handle: 'experience-delivery', provider: 'custom',
    role: 'builder', permission: 'edit', executable: nodePath, enabled: true, inputMode: 'stdin',
    prefixArgs: [path.join(root, '.smoke-fixtures/experience-cli.mjs'), root], customArgs: [] });
  const delivery = await api('/api/tasks', { title: '体验检查交付文件', objective: 'EXPERIENCE_FIXED_DELIVERY', assigneeId: fixtureMember.id, start: true });
  await api('/api/settings', { paused: false }, 'PATCH');
  await until(async () => (await api('/api/bootstrap')).tasks.find(task => task.id === delivery.id)?.status === 'review');
  await api('/api/settings', { paused: true }, 'PATCH');
  const artifact = (await api('/api/bootstrap')).artifacts.find(item => item.taskId === delivery.id);
  assert.ok(artifact);
  const expectedBytes = fs.readFileSync(path.join(delivery.workspace, artifact.relativePath));
  const downloads = [], downloadDirectory = path.join(root, 'downloads');
  fs.mkdirSync(downloadDirectory);
  const onDownload = (_event, item, contents) => {
    const entry = { name: item.getFilename(), status: 'started' };
    downloads.push(entry);
    if (contents && contents !== window.webContents) { item.cancel(); entry.status = 'unexpected'; return; }
    const filename = path.join(downloadDirectory, `${downloads.length}-${path.basename(item.getFilename())}`);
    item.setSavePath(filename);
    item.once('done', (_done, state) => {
      entry.status = state; entry.file = filename;
      if (state === 'completed') {
        try { entry.sha256 = createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
        catch (error) { entry.status = 'failed'; entry.error = error.message; }
      }
    });
  };
  window.webContents.session.on('will-download', onDownload);
  const downloaded = async count => {
    await until(() => downloads.length === count && downloads.at(-1).status === 'completed');
    assert.equal(downloads.at(-1).sha256, artifact.sha256);
    assert.deepEqual(fs.readFileSync(downloads.at(-1).file), expectedBytes);
  };
  await check('zero-handoffs', async () => {
    await runUi('nav', { label: '工作区设置' });
    assert.equal((await runUi('edit-setting', { name: 'maxHops', value: '0' })).value, '0', '禁止成员转交需要能保存零次');
    await runUi('save-settings'); await runUi('saved-settings');
    assert.equal((await api('/api/bootstrap')).workspace.maxHops, 0);
  });
  await check('partial-settings', async () => {
    await api('/api/settings', { paused: true, maxHops: 2, runTimeoutMinutes: 10 }, 'PATCH');
    await reload(); await runUi('nav', { label: '工作区设置' });
    await runUi('edit-setting', { name: 'runTimeoutMinutes', value: '12' });
    await api('/api/settings', { paused: false, maxHops: 4 }, 'PATCH');
    await runUi('save-settings'); await runUi('saved-settings');
    const saved = (await api('/api/bootstrap')).workspace;
    assert.equal(saved.paused, false, '保存超时设置误覆盖了已改变的调度状态');
    assert.equal(saved.maxHops, 4, '保存一个字段覆盖了其他窗口的设置');
    assert.equal(saved.runTimeoutMinutes, 12);
    const requests = (await runUi('trace')).requests.filter(request => request.path === '/api/settings');
    assert.deepEqual(Object.keys(requests.at(-1).body), ['runTimeoutMinutes']);
  });
  await check('settings-failure', async () => {
    await runUi('nav', { label: '工作区设置' });
    await runUi('edit-setting', { name: 'repairLimit', value: '3' });
    await runUi('control', { path: '/api/settings', method: 'PATCH', mode: 'fail' });
    await runUi('save-settings');
    assert.deepEqual((await runUi('settings-error')).alerts, [], '不应弹出系统错误框打断填写');
    assert.equal((await runUi('read-setting', { name: 'repairLimit' })).value, '3');
    await runUi('settings-scroll'); await capture('settings-inline-error');
    await runUi('save-settings'); await runUi('saved-settings');
  });
  await check('settings-save-lock-and-current-pause', async () => {
    await api('/api/settings', { paused: true }, 'PATCH');
    await reload(); await runUi('nav', { label: '工作区设置' });
    await runUi('edit-setting', { name: 'runTimeoutMinutes', value: '11' });
    assert.equal(await prepareLeave(), false, '未保存设置不能直接离开工作区'); cancelLeave();
    await runUi('control', { path: '/api/settings', method: 'PATCH', mode: 'delay' });
    await runUi('save-settings-twice'); await runUi('waiting');
    assert.equal((await runUi('read-setting', { name: 'runTimeoutMinutes' })).disabled, true);
    assert.equal(await prepareLeave(), false, '保存尚未确认时不能离开工作区'); cancelLeave();
    await api('/api/settings', { paused: false }, 'PATCH');
    await runUi('visible-text', { text: '暂停调度' });
    await runUi('release'); await runUi('saved-settings');
    await runUi('visible-text', { text: '暂停调度' });
    assert.equal((await runUi('trace')).requests.filter(request => request.path === '/api/settings').length, 1);
    assert.equal(await prepareLeave(), true); cancelLeave();
    await api('/api/settings', { paused: true }, 'PATCH');
  });
  await check('pause-reply-preserves-current-settings', async () => {
    await api('/api/settings', { paused: true, maxParallel: 2 }, 'PATCH');
    await reload(); await runUi('nav', { label: '工作区设置' });
    await runUi('control', { path: '/api/settings', method: 'PATCH', mode: 'delay' });
    await runUi('nav', { label: '恢复调度' }); await runUi('waiting');
    await api('/api/settings', { maxParallel: 3 }, 'PATCH');
    await until(async () => (await runUi('read-setting', { name: 'maxParallel' })).value === '3');
    await runUi('release');
    await runUi('visible-text', { text: '暂停调度' });
    assert.equal((await runUi('read-setting', { name: 'maxParallel' })).value, '3', '暂停请求的旧响应覆盖了较新的运行参数');
    await api('/api/settings', { paused: true }, 'PATCH');
  });
  await check('team-draft-navigation', async () => {
    await runUi('nav', { label: '工作区设置' });
    await runUi('team-owner', { id: first.id });
    await runUi('nav', { label: '成员管理' });
    await runUi('nav', { label: '工作区设置' });
    assert.equal((await runUi('team-state')).owner, first.id, '查看成员后丢失未保存的团队选择');
  });
  await check('room-double-submit', async () => {
    await api('/api/settings', { paused: true }, 'PATCH');
    await runUi('nav', { label: '团队讨论' });
    await runUi('open-room'); await runUi('room-name', { name: '重复点击只创建一个频道' });
    await runUi('control', { path: '/api/rooms', method: 'POST', mode: 'delay' });
    await runUi('room-submit-twice'); await runUi('waiting');
    await runUi('release'); await runUi('room-created', { name: '重复点击只创建一个频道' });
    const found = (await api('/api/bootstrap')).rooms.filter(room => room.name === '重复点击只创建一个频道');
    assert.equal(found.length, 1, '双击创建生成重复频道');
    assert.equal((await runUi('trace')).requests.filter(request => request.path === '/api/rooms').length, 1);
  });
  await check('room-lost-reply-refresh', async () => {
    await runUi('nav', { label: '团队讨论' }); await runUi('open-room');
    await runUi('room-name', { name: '断线后恢复的频道' });
    await runUi('control', { path: '/api/rooms', method: 'POST', mode: 'lost' });
    await runUi('room-submit-twice'); await runUi('dialog-error', { text: 'EXPERIENCE_REPLY_LOST' });
    assert.equal((await runUi('room-state')).disabled, true);
    await reload(); await runUi('open-room');
    await runUi('modal-button', { label: '核对并重试' });
    await runUi('room-created', { name: '断线后恢复的频道' });
    assert.equal((await api('/api/bootstrap')).rooms.filter(room => room.name === '断线后恢复的频道').length, 1);
  });
  await check('meeting-draft-retry', async () => {
    await runUi('nav', { label: '团队讨论' }); await runUi('open-meeting');
    await runUi('meeting-form', { objective: '请比较两个方案的取舍', members: [first.name, second.name] });
    await runUi('modal-button', { label: '稍后继续' }); await runUi('modal-closed'); await runUi('open-meeting');
    assert.equal((await runUi('meeting-form')).objective, '请比较两个方案的取舍', '关闭后丢失讨论草稿');
    await runUi('control', { path: '/api/meetings', method: 'POST', mode: 'lost' });
    await runUi('meeting-submit-twice');
    assert.equal((await runUi('meeting-error')).frozen, true, '回执未确认时必须保持原请求');
    await capture('meeting-pending-receipt');
    await reload(); await runUi('open-meeting');
    await runUi('modal-button', { label: '核对并重试' }); await runUi('modal-closed');
    const state = await api('/api/bootstrap');
    const meetings = state.meetings.filter(item => item.objective === '请比较两个方案的取舍');
    assert.equal(meetings.length, 1, '重试重复发起讨论');
    assert.equal(state.runs.filter(run => run.meetingId === meetings[0].id).length, 2);
  });
  await check('meeting-member-limit-and-disabled-choice', async () => {
    const third = await member('体验成员丙', 'experience-c'), fourth = await member('体验成员丁', 'experience-d');
    const fifth = await member('体验成员戊', 'experience-e'), disabled = await member('已停用体验成员', 'experience-disabled', false);
    await reload(); await runUi('open-meeting');
    await runUi('meeting-form', { objective: '先保存参与人选择', members: [first.name, second.name, third.name, fourth.name] });
    const selections = await runUi('meeting-selections');
    assert.equal(selections.filter(item => item.checked).length, 4);
    assert.equal(selections.find(item => item.name.includes(fifth.name)).disabled, true);
    assert.equal(selections.find(item => item.name.includes(disabled.name)).disabled, true);
    await runUi('modal-button', { label: '稍后继续' }); await runUi('modal-closed');
    const state = await api('/api/bootstrap');
    assert.ok(!state.meetings.some(item => item.objective === '先保存参与人选择'), '保存讨论草稿不得发起任务');
  });
  await check('member-validation-retry-and-save-lock', async () => {
    const editing = await member('配置编辑体验成员', 'experience-editor');
    await reload(); await runUi('nav', { label: '成员管理' }); await runUi('member-open', { name: editing.name });
    assert.deepEqual(await runUi('member-handle', { value: 'INVALID Handle' }), { valid: false, patternMismatch: true });
    assert.deepEqual(await runUi('member-handle', { value: editing.handle }), { valid: true, patternMismatch: false });
    await runUi('member-prefix', { value: '不是 JSON' });
    await runUi('member-double-save'); await runUi('dialog-error', { text: '前置参数格式不正确' });
    assert.equal((await runUi('trace')).requests.length, 0, '参数无效时不应提交');
    await runUi('member-prefix', { value: '[]' }); await runUi('member-edit', { name: '保存失败后重试的成员' });
    await runUi('control', { path: `/api/members/${editing.id}`, method: 'PATCH', mode: 'fail' });
    await runUi('member-double-save'); await runUi('dialog-error', { text: 'EXPERIENCE_SERVICE_UNAVAILABLE' });
    assert.deepEqual((await runUi('trace')).alerts, []);
    await capture('member-inline-error');
    await runUi('control', { path: `/api/members/${editing.id}`, method: 'PATCH', mode: 'delay' });
    await runUi('member-double-save'); await runUi('waiting');
    assert.deepEqual(await runUi('member-frozen'), { open: true, disabled: true, name: '保存失败后重试的成员' });
    assert.equal(await prepareLeave(), false); cancelLeave();
    await runUi('release'); await runUi('modal-closed');
    assert.equal((await api('/api/bootstrap')).members.find(item => item.id === editing.id).name, '保存失败后重试的成员');
    assert.equal((await runUi('trace')).requests.filter(request => request.path === `/api/members/${editing.id}`).length, 2);
  });
  await check('copy-feedback-and-retry', async () => {
    const body = '复制体验检查：保留中文和换行\n第二行';
    await api('/api/rooms/team/messages', { body, recipientIds: [] });
    await reload(); await runUi('nav', { label: '团队讨论' }); await runUi('room-select', { name: '团队大厅' });
    await runUi('clipboard-setup');
    assert.equal((await runUi('copy-message', { body: '复制体验检查', fail: true })).failed, true);
    const copied = await runUi('copy-message', { body: '复制体验检查', fail: false });
    assert.deepEqual(copied.writes, [body]); assert.equal(copied.failed, false);
  });
  await check('artifact-preview-and-download-recovery', async () => {
    await runUi('nav', { label: '产物文件' });
    await runUi('control', { path: `/api/artifacts/${artifact.id}/preview`, method: 'GET', mode: 'fail' });
    await runUi('preview-open', { name: artifact.name }); await runUi('dialog-error', { text: 'EXPERIENCE_SERVICE_UNAVAILABLE' });
    await runUi('modal-button', { label: '重试预览' }); await runUi('preview-ready');
    await runUi('control', { path: `/api/artifacts/${artifact.id}`, method: 'GET', mode: 'fail' });
    await runUi('download', { name: artifact.name, modal: true });
    await runUi('download-error', { text: 'EXPERIENCE_SERVICE_UNAVAILABLE' });
    assert.equal(downloads.length, 0, 'HTTP 错误不能保存成成果文件');
    await capture('download-inline-error');
    await runUi('download', { name: artifact.name, modal: true }); await downloaded(1);
    await runUi('modal-button', { label: '关闭预览' }); await runUi('modal-closed');
    await runUi('download', { name: artifact.name }); await downloaded(2);
    assert.deepEqual((await runUi('trace')).alerts, []);
  });
  await check('artifact-download-from-task-and-room', async () => {
    await runUi('task-open', { title: delivery.title });
    await runUi('download', { name: artifact.name, modal: true }); await downloaded(3);
    await runUi('modal-button', { label: '关闭任务详情' }); await runUi('modal-closed');
    await runUi('nav', { label: '团队讨论' });
    const room = (await api('/api/bootstrap')).rooms.find(item => item.id === delivery.roomId);
    await runUi('room-select', { name: room.name }); await runUi('context-artifacts');
    await runUi('download', { name: artifact.name }); await downloaded(4);
  });
  await check('log-initial-retry', async () => {
    const task = await api('/api/tasks', { title: '日志加载恢复', objective: '验证初次读取失败后仍能就地重试', assigneeId: first.id, start: true });
    const runs = (await api(`/api/tasks/${task.id}/progress`)).currentRuns;
    assert.equal(runs.length, 1);
    await reload(); await runUi('task-open', { title: task.title });
    await runUi('control', { path: `/api/runs/${runs[0].id}`, method: 'GET', mode: 'fail' });
    await runUi('open-task-log');
    assert.deepEqual((await runUi('log-error')).alerts, []);
    await runUi('modal-button', { label: '重试加载' }); await runUi('log-ready');
    await runUi('modal-button', { label: '返回任务' });
  });
  await check('late-log-response-preserves-navigation', async () => {
    const task = await api('/api/tasks', { title: '日志延迟与页面返回', objective: '迟到的响应不能改变当前页面', assigneeId: second.id, start: true });
    const runs = (await api(`/api/tasks/${task.id}/progress`)).currentRuns;
    await reload(); await runUi('task-open', { title: task.title });
    await runUi('control', { path: `/api/runs/${runs[0].id}`, method: 'GET', mode: 'delay' });
    await runUi('open-task-log'); await runUi('waiting');
    await runUi('modal-button', { label: '返回任务' });
    await runUi('release'); await runUi('task-still-open', { title: task.title });
  });
  await check('external-session-keeps-newest-sync', async () => {
    await runUi('external-fixture', { workspace: root }); await runUi('nav', { label: '外部会话' }); await runUi('external-ready');
  });
  await check('external-session-failure-retries', async () => {
    await runUi('external-failure'); await runUi('nav', { label: '团队讨论' });
    await runUi('nav', { label: '外部会话' });
    const failure = await runUi('external-error');
    assert.equal(failure.retry, true);
    await runUi('click-external-retry');
    await runUi('external-retry-ready');
  });
  await check('room-archive-restores-messages', async () => {
    const room = await api('/api/rooms', { name: '归档与恢复体验频道' });
    await api(`/api/rooms/${room.id}/messages`, { body: '恢复后仍可查看的内容', recipientIds: [] });
    await reload(); await runUi('nav', { label: '团队讨论' }); await runUi('room-select', { name: room.name });
    await runUi('nav', { label: '归档频道' });
    await until(async () => (await api('/api/bootstrap?archived=1')).rooms.find(item => item.id === room.id)?.archivedAt);
    await runUi('nav', { label: '归档记录' }); await runUi('nav', { label: `恢复频道 ${room.name}` });
    await until(async () => !(await api('/api/bootstrap?archived=1')).rooms.find(item => item.id === room.id)?.archivedAt);
    await runUi('nav', { label: '团队讨论' }); await runUi('room-select', { name: room.name });
    await runUi('visible-text', { selector: '.message-body', text: '恢复后仍可查看的内容' });
  });
  await reload();
  window.webContents.session.removeListener('will-download', onDownload);
  const actualCliRunsStarted = (await api('/api/bootstrap?archived=1')).runs.filter(run => run.startedAt).length;
  assert.equal(actualCliRunsStarted, 1, '只允许预先登记的固定文件执行器启动');
  const result = { ok: checks.every(check => check.passed), realModelCalls: 0, actualCliRunsStarted, checks, screenshots, downloads };
  fs.writeFileSync(path.join(root, 'experience-checks.json'), JSON.stringify(result, null, 2));
  return result;
}
