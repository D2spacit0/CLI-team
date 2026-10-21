import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runHistorySmoke } from './history-smoke.mjs';

// Fixed developer scenarios in a fresh work/desktop-smoke workspace only.
async function rendererAction({ action, roomName, roomId, body, taskId, messageId, taskStep }) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const shown = (element) => Boolean(element && element.getClientRects().length);
  const wait = async (predicate, description) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error('工作台检查失败：' + description);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const input = () => document.querySelector('textarea[aria-label="消息"]');
  const button = (label, scope = document) => [...scope.querySelectorAll('button')].find((element) => shown(element)
    && (normalize(element.textContent) === label || element.getAttribute('aria-label') === label));
  const click = async (label, scope = document) => {
    const element = await wait(() => {
      const candidate = button(label, scope);
      return candidate && !candidate.disabled && candidate;
    }, '找不到可用按钮 ' + label);
    element.click();
    await settle();
  };
  const setValue = async (element, value) => {
    if (!element || element.matches(':disabled')) throw new Error('输入暂不可用');
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await settle();
  };
  const state = () => ({
    body: input()?.value, disabled: input()?.disabled,
    preview: normalize(document.querySelector('.compose-delivery')?.textContent),
    error: normalize(document.querySelector('.compose-error')?.textContent),
    sendLabel: normalize(document.querySelector('.compose-send')?.textContent),
    sendDisabled: document.querySelector('.compose-send')?.disabled,
    unavailableSummary: normalize(document.querySelector('.recipient-more-toggle')?.textContent),
    unavailableExpanded: document.querySelector('.recipient-more-toggle')?.getAttribute('aria-expanded'),
    recipientBarHeight: document.querySelector('.compose-recipients-bar')?.getBoundingClientRect().height || 0,
    scheduleClass: document.querySelector('button[aria-label="恢复调度"]')?.className || '',
    unavailable: [...document.querySelectorAll('.member-chip[data-unavailable-reason]')].map((element) => ({
      name: normalize(element.querySelector('span')?.textContent),
      reason: element.dataset.unavailableReason,
      visible: normalize(element.querySelector('.member-unavailable-label')?.textContent),
      disabled: element.disabled,
    })),
    requests: window.__workbenchSmoke?.requests || 0,
  });

  if (action === 'ready') {
    await wait(() => document.querySelector('[data-testid="room-workbench"]') && input() && !input().disabled, '聊天工作台没有就绪');
    return state();
  }
  if (action === 'connection') {
    const navigation = [...document.querySelectorAll('.nav-item')].find((item) => normalize(item.textContent).includes('成员'));
    navigation.click();
    const section = await wait(() => document.querySelector('section[aria-label="DSH 接入测试 接入状态"]'), '成员接入状态未显示');
    await click('检查接入', section);
    await wait(() => normalize(section.textContent).includes('协议与模型配置已验证'), 'DSH 协议检查没有回到界面');
    section.querySelector('details').open = true;
    const details = normalize(section.textContent);
    if (!details.includes('模型服务认证：未检查')) throw new Error('协议握手被误标为认证通过');
    await click('编辑配置', section.closest('.member-card'));
    let picker = await wait(() => {
      const control = document.querySelector('#member-model-choice'); return control && !control.matches(':disabled') && control;
    }, '模型选择器尚未可编辑');
    if (picker.value !== '') throw new Error('模型初始状态没有跟随 CLI 默认');
    const options = [...picker.options].map((option) => option.value);
    if (!options.includes('local/test')) throw new Error('没有显示 ACP 返回的模型选项');
    await setValue(picker, 'local/test');
    await click('保存成员配置', picker.closest('form'));
    await wait(() => !document.querySelector('#member-model-choice'), '指定模型未保存');
    const afterSave = await wait(() => document.querySelector('section[aria-label="DSH 接入测试 接入状态"]'), '成员卡片未更新');
    await click('编辑配置', afterSave.closest('.member-card'));
    picker = await wait(() => {
      const control = document.querySelector('#member-model-choice'); return control && !control.matches(':disabled') && control;
    }, '模型选择器尚未恢复可编辑');
    const restored = picker.value === 'local/test' || document.querySelector('input[aria-label="指定模型标识"]')?.value === 'local/test';
    if (!restored) throw new Error('用户指定的模型没有保存');
    await setValue(picker, '');
    await click('保存成员配置', picker.closest('form'));
    await wait(() => !document.querySelector('#member-model-choice'), '恢复 CLI 默认未保存');
    await click('团队讨论');
    await wait(() => input() && !input().disabled, '模型检查后没有返回聊天工作台');
    return { protocolVerified: true, authenticationNotClaimed: true, optionsFromCli: true,
      explicitSelectionSaved: true, cliDefaultRestored: true };
  }
  if (action === 'room') {
    const candidate = await wait(() => [...document.querySelectorAll('.room-item')].find((element) => shown(element) &&
      normalize(element.querySelector('.room-name')?.textContent) === roomName) ||
      [...document.querySelectorAll('select[aria-label="讨论房间"]')].find((element) => [...element.options].some((option) => option.value === roomId)),
    '目标房间尚未加载');
    if (candidate instanceof HTMLSelectElement) await setValue(candidate, roomId);
    else { candidate.click(); await settle(); }
    await wait(() => new URL(location.href).searchParams.get('room') === roomId && input() && !input().disabled, '房间切换或草稿恢复未完成');
    return state();
  }
  if (action === 'create-room') {
    await click('创建新讨论室');
    const name = await wait(() => {
      const control = document.querySelector('input[placeholder="例如: 架构设计、安全评审"]');
      return control && !control.matches(':disabled') && control;
    }, '新建频道草稿尚未恢复为可编辑状态');
    await setValue(name, roomName);
    await click('确认创建', name.closest('form'));
    await wait(() => normalize(document.querySelector('.chat-header-title strong')?.textContent) === roomName && input() && !input().disabled,
      '新建频道没有保持选中');
    const created = new URL(location.href).searchParams.get('room');
    await wait(() => location.hash === '#/rooms/' + encodeURIComponent(created), '新建频道路由没有同步');
    return { id: created, name: roomName };
  }
  if (action === 'restored-room') {
    await wait(() => normalize(document.querySelector('.chat-header-title strong')?.textContent) === roomName && input() && !input().disabled,
      '刷新没有恢复新建频道');
    return { id: new URL(location.href).searchParams.get('room'), hash: location.hash };
  }
  if (action === 'draft') { await setValue(input(), body); return state(); }
  if (action === 'state') return state();
  if (action === 'recipient-details') {
    const toggle = await wait(() => document.querySelector('.recipient-more-toggle'), '没有不可用成员摘要入口');
    const collapsedHeight = state().recipientBarHeight;
    toggle.click();
    await settle();
    const expanded = state();
    const unavailable = [...document.querySelectorAll('.compose-unavailable-members .member-chip[data-unavailable-reason]')];
    if (expanded.unavailableExpanded !== 'true' || !unavailable.length) throw new Error('不可用成员没有按需展开');
    if (!unavailable.every((element) => element.disabled && element.dataset.unavailableReason
      && normalize(element.querySelector('.member-unavailable-label')?.textContent) === element.dataset.unavailableReason)) {
      throw new Error('展开后的不可用成员没有说明原因');
    }
    toggle.click();
    await settle();
    const collapsed = state();
    if (collapsed.unavailableExpanded !== 'false') throw new Error('不可用成员无法收起');
    if (expanded.recipientBarHeight <= collapsedHeight || collapsed.recipientBarHeight > collapsedHeight + 1) {
      throw new Error('不可用成员展开与收起的布局状态不一致');
    }
    return { collapsed, expanded, collapsedHeight };
  }
  if (action === 'recipient-expand') {
    const toggle = await wait(() => document.querySelector('.recipient-more-toggle'), '没有可展开的成员摘要入口');
    if (toggle.getAttribute('aria-expanded') !== 'false') throw new Error('收件人成员区初始状态不是收起');
    toggle.click();
    await settle();
    const expanded = state();
    if (expanded.unavailableExpanded !== 'true') throw new Error('收件人成员区没有展开');
    return expanded;
  }
  if (action === 'recipient-collapsed') {
    await wait(() => document.querySelector('.recipient-more-toggle')?.getAttribute('aria-expanded') === 'false',
      '切换房间后收件人成员区没有自动收起');
    return state();
  }
  if (action === 'install-control') {
    if (window.__workbenchSmoke) throw new Error('请求控制器已经存在');
    const control = { original: window.fetch.bind(window), mode: '', delayed: false, release: null, requests: 0 };
    window.__workbenchSmoke = control;
    window.fetch = async (target, init = {}) => {
      const url = new URL(typeof target === 'string' ? target : target.url, location.href);
      const send = url.origin === location.origin && /^\/api\/rooms\/[^/]+\/messages$/.test(url.pathname) && init.method === 'POST';
      if (!send) return control.original(target, init);
      control.requests++;
      const mode = control.mode;
      control.mode = '';
      if (mode === 'fail') return new Response(JSON.stringify({ error: 'WORKBENCH_SEND_UNAVAILABLE' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      const response = await control.original(target, init);
      if (mode === 'lost') throw new Error('WORKBENCH_RESPONSE_LOST_AFTER_COMMIT');
      if (mode === 'delay') {
        control.delayed = true;
        await new Promise((resolve) => { control.release = resolve; });
      }
      return response;
    };
    return { installed: true };
  }
  if (action === 'delay-send' || action === 'fail-send' || action === 'lose-send') {
    window.__workbenchSmoke.mode = action === 'delay-send' ? 'delay' : action === 'lose-send' ? 'lost' : 'fail';
    await click(state().sendLabel);
    if (action === 'delay-send') await wait(() => window.__workbenchSmoke.delayed, '服务回执尚未被延迟');
    else await wait(() => state().error.includes(action === 'lose-send' ? 'WORKBENCH_RESPONSE_LOST_AFTER_COMMIT' : 'WORKBENCH_SEND_UNAVAILABLE'), '发送失败未显示');
    return state();
  }
  if (action === 'release-send') { window.__workbenchSmoke.release?.(); await settle(); return state(); }
  if (action === 'send') { await click(state().sendLabel); await wait(() => !input().disabled && input().value === '', '发送完成后未清理当前草稿'); return state(); }
  if (action === 'ime') {
    input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }));
    input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await settle();
    return state();
  }
  if (action === 'shortcut-send') {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(() => !input().disabled && input().value === '', 'Ctrl+Enter 没有发送');
    return state();
  }
  if (action === 'message') {
    await wait(() => document.querySelector('[data-message-id="' + CSS.escape(messageId) + '"]'), '没有加载消息 ' + messageId);
    return { count: document.querySelectorAll('[data-message-id="' + CSS.escape(messageId) + '"]').length };
  }
  if (action === 'scroll-top') {
    const scroll = document.querySelector('.messages-scroll-area');
    if (scroll.scrollHeight < scroll.clientHeight + 100) throw new Error('聊天记录不足以覆盖滚动测试');
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    await settle();
    return { top: scroll.scrollTop };
  }
  if (action === 'scroll-state') {
    const scroll = document.querySelector('.messages-scroll-area');
    return { top: scroll.scrollTop, atEnd: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 56, unread: normalize(document.querySelector('.new-messages-button')?.textContent) };
  }
  if (action === 'latest') {
    const element = await wait(() => document.querySelector('.new-messages-button'), '没有新消息提示');
    element.click(); await settle();
    return { latestClicked: true };
  }
  if (action === 'task') {
    const row = await wait(() => document.querySelector('.room-task-scope .room-task-row'), '没有关联任务入口');
    row.click();
    await settle();
    const expanded = document.querySelector('.room-task-scope')?.classList.contains('expanded');
    const ariaExpanded = row.getAttribute('aria-expanded');
    if (!expanded || ariaExpanded !== 'true') throw new Error('任务入口展开状态未同步');
    const action = await wait(() => [...document.querySelectorAll('.room-task-scope button')]
      .find((element) => shown(element) && normalize(element.textContent) === '查看并启动'), '没有任务处理入口');
    action.click();
    const detail = await wait(() => document.querySelector('.workbench-detail-dock [data-task-detail="' + CSS.escape(taskId) + '"]'), '任务未在工作台侧栏打开');
    await wait(() => !normalize(detail.textContent).includes('正在读取此任务的进度'), '任务进度没有加载');
    const result = { docked: true, conversationRetained: shown(input()), role: detail.getAttribute('role'),
      expanded, ariaExpanded };
    await click('材料', detail);
    await wait(() => detail.querySelector('[data-task-section="materials"]'), '缺少材料入口');
    await click('关闭任务详情', detail);
    return result;
  }
  if (action === 'task-route-step') {
    const detailSelector = '.workbench-detail-dock [data-task-detail="' + CSS.escape(taskId) + '"]';
    const detailOpen = () => Boolean(document.querySelector(detailSelector));
    if (taskStep === 'open') {
      await wait(detailOpen, '任务没从深链恢复');
      return { hash: location.hash, open: true, historyLength: history.length };
    }
    if (taskStep === 'close') {
      const detail = document.querySelector(detailSelector);
      if (!detail) throw new Error('任务详情面板不存在');
      const back = [...detail.querySelectorAll('button')].find((element) => shown(element) && normalize(element.textContent) === '关闭');
      if (!back) throw new Error('任务详情缺少返回按钮');
      back.click();
      await wait(() => !detailOpen(), '返回后任务详情没有关闭');
      if (location.hash.includes('task=')) throw new Error('返回后地址仍保留任务详情');
      return { hash: location.hash, open: false, historyLength: history.length };
    }
    if (taskStep === 'back') {
      history.back();
      await wait(detailOpen, '浏览器后退没有重新打开任务详情');
      return { hash: location.hash, open: true, historyLength: history.length };
    }
    if (taskStep === 'forward') {
      history.forward();
      await wait(() => !detailOpen(), '浏览器前进没有关闭任务详情');
      return { hash: location.hash, open: false, historyLength: history.length };
    }
    if (taskStep === 'back-again') {
      history.back();
      await wait(detailOpen, '重新后退没有恢复任务详情');
      return { hash: location.hash, open: true, historyLength: history.length };
    }
    throw new Error('未知的任务路由步骤 ' + taskStep);
  }
  if (action === 'task-route-restored') {
    const detail = await wait(() => document.querySelector('.workbench-detail-dock [data-task-detail="' + CSS.escape(taskId) + '"]'), '刷新没有恢复任务详情');
    const close = detail.querySelector('[aria-label="关闭任务详情"]');
    if (!close) throw new Error('刷新恢复的详情缺少关闭入口');
    close.click();
    await wait(() => !document.querySelector('.workbench-detail-dock [data-task-detail]'), '刷新恢复后仍无法关闭详情');
    return { hash: location.hash };
  }
  if (action === 'log') {
    const context = document.querySelector('.workbench-context');
    if (!shown(context)) await click('房间信息');
    const tab = [...context.querySelectorAll('[role="tab"]')].find((element) => normalize(element.textContent).startsWith('日志'));
    tab.click(); await settle();
    await click('查看日志', context);
    const detail = await wait(() => {
      const current = document.querySelector('.workbench-detail-dock .modal-content');
      return current?.querySelector('[data-run-state="queued"]') && current;
    }, '日志未显示真实排队原因');
    const result = { docked: true, queued: true,
      status: detail.querySelector('[data-run-state="queued"]').textContent };
    const close = detail.querySelector('[aria-label="关闭作业日志"]');
    close.click();
    await settle();
    const runListContext = document.querySelector('.workbench-context');
    const reason = runListContext.querySelector('[data-run-reason]');
    if (!reason || !normalize(reason.textContent).includes('等待')) throw new Error('日志列表没有显示排队原因');
    return { ...result, listReason: normalize(reason.textContent) };
  }
  if (action === 'layout') {
    await wait(() => input() && !input().disabled, '布局检查时输入不可用');
    const element = document.querySelector('.compose-send');
    const rect = element.getBoundingClientRect();
    const onScreen = rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const summary = document.querySelector('[data-testid="room-task-scope"]');
    const summaryRect = summary?.getBoundingClientRect();
    const delivery = document.querySelector('.compose-delivery');
    return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
      sendVisible: onScreen && (hit === element || element.contains(hit)), textareaVisible: shown(input()),
      summaryVisible: Boolean(summaryRect && summaryRect.top >= 0 && summaryRect.bottom <= innerHeight + 1),
      summaryText: normalize(summary?.textContent), deliveryText: normalize(delivery?.textContent),
      deliveryTone: delivery?.getAttribute('data-tone') };
  }
  if (action === 'remove-control') {
    if (window.__workbenchSmoke) { window.__workbenchSmoke.release?.(); window.fetch = window.__workbenchSmoke.original; delete window.__workbenchSmoke; }
    return { removed: true };
  }
  throw new Error('Unknown workbench scenario');
}

export async function runWorkbenchSmoke(window, { url, token, workspace, nodePath, prepareLeave, cancelLeave }) {
  const root = fs.realpathSync(workspace);
  const parts = root.split(/[\\/]/).map((part) => part.toLowerCase());
  assert.ok(parts.some((part, index) => part === 'work' && parts[index + 1] === 'desktop-smoke' && parts[index + 2]), '工作台检查只允许独立冒烟目录');
  const origin = new URL(url);
  assert.equal(origin.hostname, '127.0.0.1');
  assert.equal(new URL(window.webContents.getURL()).origin, origin.origin);
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin.origin + route, { method, headers: { 'X-CLI-Team-Desktop': token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    assert.ok(response.ok, '工作台检查接口失败：' + String(result.error || response.status).replaceAll(token, '[REDACTED]'));
    return result;
  };
  const initial = await api('/api/bootstrap');
  assert.equal(fs.realpathSync(initial.workspace.root), root);
  assert.equal(initial.tasks.length, 0);
  assert.equal(initial.runs.length, 0);
  await api('/api/settings', { paused: true }, 'PATCH');
  const member = await api('/api/members', { name: '工作台测试成员', handle: 'workbench-builder', provider: 'custom', role: 'builder',
    executable: nodePath, prefixArgs: [], customArgs: [], inputMode: 'stdin', enabled: true, permission: 'edit' });
  const dshMember = await api('/api/members', { name: 'DSH 接入测试', handle: 'connection-test', provider: 'dsh', role: 'researcher',
    executable: nodePath, prefixArgs: [path.join(root, '.smoke-fixtures', 'fake-dsh.mjs'), 'success'], model: '', enabled: false, permission: 'plan' });
  const alpha = await api('/api/rooms', { name: '工作台检查 A' });
  const beta = await api('/api/rooms', { name: '工作台检查 B' });
  const task = await api('/api/tasks', { title: '检查任务侧栏', objective: '保持全局暂停，不启动任何模型', roomId: alpha.id,
    assigneeId: member.id, reviewerId: null, executionMode: 'direct', requirements: [], verification: null, start: false, category: 'test' });
  for (let index = 0; index < 24; index++) await api('/api/rooms/' + alpha.id + '/messages', { body: '历史消息 ' + index + '\n用于检查阅读位置。继续保留这段记录，不触发任何成员执行。' });
  const progress = path.join(root, 'workbench-progress.log');
  const startedAt = Date.now();
  const runUi = (action, extra = {}) => {
    fs.appendFileSync(progress, `${new Date().toISOString()} +${Date.now() - startedAt}ms ${action}\n`);
    return window.webContents.executeJavaScript('(' + rendererAction.toString() + ')(' + JSON.stringify({ action, ...extra }) + ')', true)
      .catch(error => { error.message = `${action}：${error.message}`; throw error; });
  };
  const room = (target) => runUi('room', { roomId: target.id, roomName: target.name });
  const until = async (predicate, description) => {
    const deadline = Date.now() + 14000;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 80)); }
    throw new Error(description);
  };
  const readDraft = (target) => api('/api/ui-drafts/read', { workspace: root, scope: { kind: 'room-message', roomId: target.id } });
  const size = window.getSize(), zoom = window.webContents.getZoomFactor();
  const screenshots = [];
  try {
    const ready = await runUi('ready');
    assert.match(ready.scheduleClass, /\bbtn-warning\b/, '暂停状态应使用警示色，而不是危险操作样式');
    assert.doesNotMatch(ready.scheduleClass, /\bbtn-danger\b/, '恢复调度不应被标记为危险操作');
    const connection = await runUi('connection');
    assert.equal((await api('/api/bootstrap')).members.find((item) => item.id === dshMember.id).model, '');
    await room(alpha);
    const createdRoom = await runUi('create-room', { roomName: '从界面创建并恢复的频道' });
    await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    const restoredRoom = await runUi('restored-room', { roomName: createdRoom.name });
    assert.equal(restoredRoom.id, createdRoom.id);
    assert.equal(restoredRoom.hash, '#/rooms/' + encodeURIComponent(createdRoom.id));
    await room(alpha);
    await runUi('install-control');
    const outgoing = '@workbench-builder 核对消息发送范围，保持任务不启动。';
    const preview = await runUi('draft', { body: outgoing });
    assert.match(preview.preview, /工作台测试成员/);
    assert.equal(preview.sendLabel, '派给 1 名成员');
    assert.match(preview.unavailableSummary, /名不可用/);
    assert.equal(preview.unavailableExpanded, 'false');
    assert.equal(preview.unavailable.length, 0, '不可用成员默认不应挤占发送区');
    const recipientDetails = await runUi('recipient-details');
    assert.ok(recipientDetails.expanded.unavailable.length > 0);
    assert.equal(recipientDetails.collapsed.unavailableExpanded, 'false');
    await runUi('recipient-expand');
    await room(beta);
    assert.equal((await runUi('recipient-collapsed')).unavailableExpanded, 'false', '切换房间后收件人展开区残留');
    assert.equal((await runUi('state')).body, '');
    await runUi('draft', { body: 'B 的独立草稿' });
    await room(alpha);
    assert.equal((await runUi('state')).body, outgoing);
    await runUi('delay-send');
    const accepted = (await api('/api/rooms/' + alpha.id + '/messages')).find((message) => message.body === outgoing);
    assert.ok(accepted);
    assert.equal(await prepareLeave(), false, '发送回执未返回时不得确认安全离开');
    cancelLeave();
    await room(beta);
    await runUi('draft', { body: 'A 发送期间继续编辑 B，文字需要保留。' });
    await runUi('release-send');
    await until(async () => (await readDraft(alpha)).draft?.values.body === '', 'A 的发送成功没有清理自身草稿');
    assert.equal((await runUi('state')).body, 'A 发送期间继续编辑 B，文字需要保留。');
    await room(alpha);
    assert.equal((await runUi('message', { messageId: accepted.id })).count, 1, 'HTTP 与 SSE 产生重复消息');
    const failedBody = '发送失败时保留原文';
    await runUi('draft', { body: failedBody });
    const failed = await runUi('fail-send');
    assert.equal(failed.body, failedBody);
    await runUi('send');
    const lostBody = '@workbench-builder 回执丢失后重开仍不得重复派工';
    await runUi('draft', { body: lostBody });
    const lost = await runUi('lose-send');
    assert.equal(lost.body, lostBody);
    await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    await runUi('restored-room', { roomName: alpha.name });
    assert.equal((await runUi('state')).body, lostBody);
    await runUi('install-control');
    await runUi('send');
    const recovered = (await api('/api/rooms/' + alpha.id + '/messages')).filter(message => message.body === lostBody);
    assert.equal(recovered.length, 1, '丢失回执后的重试创建了重复消息');
    const recoveredRuns = (await api('/api/bootstrap')).runs.filter(run => run.triggerMessageId === recovered[0].id);
    assert.equal(recoveredRuns.length, 1, '丢失回执后的重试重复派工');
    const imeBody = '中文输入法组合阶段不能发送';
    await runUi('draft', { body: imeBody });
    const beforeIme = await runUi('state');
    const afterIme = await runUi('ime');
    assert.equal(afterIme.requests, beforeIme.requests, '输入法组合阶段触发了派工');
    assert.equal(afterIme.body, imeBody);
    await runUi('shortcut-send');
    await runUi('scroll-top');
    const latest = await api('/api/rooms/' + alpha.id + '/messages', { body: '阅读历史期间新增的消息' });
    await runUi('message', { messageId: latest.id });
    const historic = await runUi('scroll-state');
    assert.ok(historic.top < 5, 'SSE 刷新抢走了历史阅读位置');
    assert.match(historic.unread, /新消息/);
    await room(beta);
    await room(alpha);
    await runUi('message', { messageId: latest.id });
    assert.ok((await runUi('scroll-state')).top < 5, '切回房间没有恢复阅读位置');
    assert.match((await runUi('scroll-state')).unread, /新消息/, '未读的新消息提示在切换房间后丢失');
    // A later message must still expose the jump-to-latest control after returning.
    const next = await api('/api/rooms/' + alpha.id + '/messages', { body: '返回后再来一条消息' });
    await runUi('message', { messageId: next.id });
    await runUi('latest');
    assert.equal((await runUi('scroll-state')).atEnd, true);
    const inspector = await runUi('task', { taskId: task.id });
    assert.equal(inspector.docked, true);
    assert.equal(inspector.role, 'region');
    await new Promise(resolve => { window.webContents.once('did-finish-load', resolve);
      window.webContents.loadURL(origin.origin + '/#/rooms/' + encodeURIComponent(alpha.id) + '?task=' + encodeURIComponent(task.id)); });
    const taskRoute = { open: await runUi('task-route-step', { taskId: task.id, taskStep: 'open' }) };
    try {
      taskRoute.closed = await runUi('task-route-step', { taskId: task.id, taskStep: 'close' });
      taskRoute.reopened = await runUi('task-route-step', { taskId: task.id, taskStep: 'back' });
      taskRoute.forward = await runUi('task-route-step', { taskId: task.id, taskStep: 'forward' });
      taskRoute.final = await runUi('task-route-step', { taskId: task.id, taskStep: 'back-again' });
      assert.equal(taskRoute.final.hash, taskRoute.reopened.hash);
    } catch (error) {
      error.message += `；历史步骤：${JSON.stringify(taskRoute)}`;
      throw error;
    }
    await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    await runUi('task-route-restored', { taskId: task.id });
    const log = await runUi('log');
    const layouts = [];
    for (const [width, height, factor] of [[1440, 900, 1], [1040, 700, 1], [1040, 700, 1.25], [1040, 700, 1.5]]) {
      window.setSize(width, height);
      window.webContents.setZoomFactor(factor);
      // Paint the hidden window before sampling its resized CSS viewport.
      await window.webContents.capturePage();
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const screenshot = path.join(root, 'workbench-' + width + '-' + factor + '.png');
      fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
      const contentSize = window.getContentSize();
      let layout;
      await until(async () => {
        layout = await runUi('layout');
        return Math.abs(layout.viewport.width - contentSize[0] / factor) <= 1 &&
          Math.abs(layout.viewport.height - contentSize[1] / factor) <= 1;
      }, '工作台缩放后的视口未更新');
      assert.equal(layout.noHorizontalOverflow, true, '工作台产生页面横向溢出');
      assert.equal(layout.sendVisible, true, '发送按钮不可见或被覆盖');
    assert.equal(layout.summaryVisible, true, '任务状态入口不可见');
    assert.match(layout.summaryText, /准备启动|查看并启动/);
    assert.match(layout.deliveryText, /只保存到聊天室|将派给/);
      layouts.push({ width, height, zoom: factor, contentSize, ...layout });
      screenshots.push(screenshot);
    }
    const history = await runHistorySmoke(window, { api, root, memberId: member.id });
    const final = await api('/api/bootstrap');
    assert.equal(final.tasks.find((item) => item.id === task.id).status, 'backlog');
    assert.equal(final.runs.filter((run) => run.startedAt).length, 0, '交互检查启动了模型进程');
    const result = { ok: true, realModelCalls: 0, actualCliRunsStarted: 0, fixtureCliHandshakes: 1, connection, draftsIsolated: true,
      createdRoomSelectedAndRestored: true,
      delayedSendClearedOnlyOrigin: true, sendFailureRetainedDraft: true, lostReceiptRecoveredAfterReload: true, duplicateMessageCount: 1,
      compositionDidNotSend: true, historyPositionRetained: true, sendBlocksLeave: true,
      taskSummaryAndDeliveryIntent: true, recipientDetails, inspector, taskRoute, log, layouts, screenshots, history };
    fs.writeFileSync(path.join(root, 'workbench-result.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    fs.writeFileSync(path.join(root, 'workbench-failure.png'), (await window.webContents.capturePage()).toPNG());
    throw error;
  } finally {
    await runUi('remove-control').catch(() => {});
    cancelLeave();
    window.webContents.setZoomFactor(zoom);
    window.setSize(...size);
  }
}
