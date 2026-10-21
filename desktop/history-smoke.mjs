import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

async function rendererAction({ action, data = {} }) {
  const text = value => String(value || '').replace(/\s+/g, ' ').trim();
  const shown = element => Boolean(element?.getClientRects().length);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const wait = async (predicate, description) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const value = predicate(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(description);
  };
  const scroll = () => document.querySelector('.messages-scroll-area');
  const state = () => {
    const container = scroll(), viewport = container.getBoundingClientRect();
    const entries = [...container.querySelectorAll('[data-message-id]')];
    const anchor = entries.find(entry => entry.getBoundingClientRect().bottom > viewport.top);
    const older = container.querySelector('.timeline-history button');
    return {
      room: text(document.querySelector('.chat-header-title strong')?.textContent),
      ids: entries.map(entry => entry.dataset.messageId),
      anchor: anchor && { id: anchor.dataset.messageId, offset: anchor.querySelector('.message-card').getBoundingClientRect().top - viewport.top },
      top: container.scrollTop, atEnd: container.scrollHeight - container.clientHeight - container.scrollTop < 56,
      unread: text(document.querySelector('.new-messages-button')?.textContent),
      olderLabel: text(older?.textContent), olderDisabled: older?.disabled,
      errors: [...container.querySelectorAll('[role="alert"]')].map(element => text(element.textContent)),
      loading: text(container.querySelector('.empty-state')?.textContent),
      refreshDisabled: document.querySelector('[aria-label="刷新消息"]')?.disabled,
      requests: window.__historySmoke?.requests || [],
    };
  };
  const click = async selector => {
    const element = await wait(() => { const found = document.querySelector(selector); return shown(found) && !found.disabled && found; }, '按钮尚不可用：' + selector);
    element.click(); await settle();
  };
  if (action === 'state') return state();
  if (action === 'position') {
    const card = scroll().querySelector('[data-message-id="' + CSS.escape(data.id) + '"] .message-card');
    return card ? { id: data.id, offset: card.getBoundingClientRect().top - scroll().getBoundingClientRect().top } : null;
  }
  if (action === 'room') {
    const element = await wait(() => [...document.querySelectorAll('.room-item')].find(item => shown(item) && text(item.querySelector('.room-name')?.textContent) === data.name), '房间没有出现');
    element.click();
    await wait(() => state().room === data.name && !document.querySelector('textarea[aria-label="消息"]')?.disabled
      && (!state().refreshDisabled || state().errors.length), '房间未加载完毕');
    return state();
  }
  if (action === 'top' || action === 'anchor') {
    const container = scroll();
    if (action === 'top') container.scrollTop = 0;
    else {
      const card = container.querySelector('[data-message-id="' + CSS.escape(data.id) + '"] .message-card');
      if (!card) throw new Error('缺少目标消息');
      container.scrollTop += card.getBoundingClientRect().top - container.getBoundingClientRect().top - 18;
    }
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
    await settle(); return state();
  }
  if (action === 'older') {
    const button = await wait(() => { const found = document.querySelector('.timeline-history button'); return found && !found.disabled && found; }, '历史翻页不可用');
    const box = button.getBoundingClientRect(), viewport = scroll().getBoundingClientRect();
    if (box.top < viewport.top || box.bottom > viewport.bottom) throw new Error('历史按钮不在可点击的视口中');
    button.click(); if (data.twice) button.click(); await settle(); return state();
  }
  if (action === 'refresh') { await click('[aria-label="刷新消息"]'); return state(); }
  if (action === 'retry') { await click('.timeline-container .error-banner button'); return state(); }
  if (action === 'latest') { await click('.new-messages-button'); return state(); }
  if (action === 'count') {
    await wait(() => state().ids.length === data.count && (!data.last || state().ids.at(-1) === data.last)
      && !state().refreshDisabled, '消息数量或末条消息没有更新：' + data.count);
    return state();
  }
  if (action === 'error') {
    await wait(() => state().errors.some(error => error.includes(data.marker)), '没有显示指定加载错误');
    return state();
  }
  if (action === 'install') {
    const control = { original: window.fetch.bind(window), requests: [], rules: [], delayed: false, release: null, offline: null };
    window.__historySmoke = control;
    window.fetch = async (target, init = {}) => {
      const url = new URL(typeof target === 'string' ? target : target.url, location.href);
      const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages\/page$/);
      if (!match || (init.method && init.method !== 'GET')) return control.original(target, init);
      const roomId = decodeURIComponent(match[1]);
      const direction = url.searchParams.has('before') ? 'before' : url.searchParams.has('after') ? 'after' : 'initial';
      control.requests.push({ roomId, direction });
      if (control.offline === roomId) return new Response(JSON.stringify({ error: 'HISTORY_OFFLINE' }), { status: 503 });
      const index = control.rules.findIndex(rule => rule.roomId === roomId && rule.direction === direction);
      const rule = index >= 0 ? control.rules.splice(index, 1)[0] : null;
      if (rule?.mode === 'fail') return new Response(JSON.stringify({ error: 'HISTORY_PAGE_FAILED' }), { status: 503 });
      const response = await control.original(target, init);
      if (rule?.mode === 'delay') {
        control.delayed = true;
        await new Promise(resolve => { control.release = resolve; });
        control.delayed = false; control.release = null;
      }
      return response;
    };
    return { installed: true };
  }
  if (action === 'rule') { window.__historySmoke.rules.push(data); return {}; }
  if (action === 'delayed') { await wait(() => window.__historySmoke.delayed, '指定页面没有被延迟'); return state(); }
  if (action === 'release') { window.__historySmoke.release?.(); await settle(); return state(); }
  if (action === 'offline') { window.__historySmoke.offline = data.roomId || null; return {}; }
  if (action === 'navigation') {
    const button = [...document.querySelectorAll('.nav-item')].find(item => shown(item) && text(item.textContent).includes(data.label));
    if (!button) throw new Error('导航入口不存在');
    button.click(); await settle(); return {};
  }
  if (action === 'layout') {
    const button = document.querySelector('.timeline-history button');
    const rect = button?.getBoundingClientRect();
    const hit = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const viewport = scroll().getBoundingClientRect();
    const body = scroll().querySelector('.message-body')?.getBoundingClientRect();
    const send = document.querySelector('.compose-send'), sendRect = send.getBoundingClientRect();
    const sendHit = document.elementFromPoint(sendRect.left + sendRect.width / 2, sendRect.top + sendRect.height / 2);
    return { viewport: { width: innerWidth, height: innerHeight },
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
      readableBodyPixels: body ? Math.max(0, Math.min(body.bottom, viewport.bottom) - Math.max(body.top, viewport.top)) : 0,
      sendVisible: sendRect.top >= 0 && sendRect.bottom <= innerHeight + 1 && (sendHit === send || send.contains(sendHit)),
      olderVisible: Boolean(rect && rect.top >= 0 && rect.bottom <= innerHeight && (hit === button || button.contains(hit))) };
  }
  if (action === 'focus-history') {
    const button = document.querySelector('.timeline-history button');
    button.focus(); return { focused: document.activeElement === button, disabled: button.disabled };
  }
  if (action === 'remove') {
    if (window.__historySmoke) { window.__historySmoke.release?.(); window.fetch = window.__historySmoke.original; delete window.__historySmoke; }
    return {};
  }
  throw new Error('Unknown history smoke action');
}

export async function runHistorySmoke(window, { api, root, memberId }) {
  assert.match(root.replaceAll('\\', '/'), /\/work\/desktop-smoke\/run-[^/]+$/);
  const runUi = (action, data = {}) => window.webContents.executeJavaScript('(' + rendererAction.toString() + ')(' + JSON.stringify({ action, data }) + ')', true)
    .catch(error => { error.message = `${action}: ${error.message}`; throw error; });
  const screenshots = [], checks = [], layouts = [];
  const capture = async name => {
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const filename = path.join(root, 'history-' + name + '.png');
    fs.writeFileSync(filename, (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    screenshots.push(filename); return filename;
  };
  const stable = async before => {
    const after = await runUi('position', { id: before.anchor?.id });
    assert.equal(after?.id, before.anchor?.id, '当前阅读的消息已经不在加载范围');
    assert.ok(Math.abs(after.offset - before.anchor.offset) < 2, `消息阅读位置偏移：${after.offset - before.anchor.offset}`);
  };
  const alpha = await api('/api/rooms', { name: '历史翻页检查' });
  const beta = await api('/api/rooms', { name: '历史切换检查' });
  const gamma = await api('/api/rooms', { name: '首次加载失败检查' });
  const task = await api('/api/tasks', { title: '历史记录归档检查', objective: '仅检查记录显示，不启动成员', assigneeId: memberId, roomId: alpha.id, start: false, category: 'test' });
  const messages = [];
  for (let index = 0; index < 230; index++) messages.push(await api(`/api/rooms/${alpha.id}/messages`, {
    body: `历史记录 ${String(index + 1).padStart(3, '0')}\n分页前后的正文应保持连续，阅读时新消息不会把当前位置带走。`,
    ...(index % 3 === 0 ? { taskId: task.id } : {}),
  }));
  const size = window.getSize(), zoom = window.webContents.getZoomFactor();
  window.setSize(1440, 900); window.webContents.setZoomFactor(1);
  try {
    await runUi('install');
    await runUi('room', alpha);
    let current = await runUi('count', { count: 100, last: messages.at(-1).id });
    assert.deepEqual(current.ids, messages.slice(-100).map(message => message.id));
    checks.push('initial-page-is-bounded');
    await runUi('top');
    await runUi('rule', { roomId: alpha.id, direction: 'before', mode: 'fail' });
    await runUi('older');
    current = await runUi('error', { marker: 'HISTORY_PAGE_FAILED' });
    assert.equal(current.ids.length, 100);
    assert.equal(current.olderLabel, '重试加载更早消息');
    await capture('older-error');
    const beforePage = await runUi('top');
    await runUi('older');
    current = await runUi('count', { count: 200 });
    await stable(beforePage);
    assert.equal(current.unread, '回到最新', '更早的历史不应计为新消息');
    assert.deepEqual(current.ids, messages.slice(-200).map(message => message.id));
    checks.push('older-failure-retry-keeps-reading-position');

    const beforeFinalPage = await runUi('top');
    const requestCount = beforeFinalPage.requests.filter(request => request.roomId === alpha.id && request.direction === 'before').length;
    await runUi('rule', { roomId: alpha.id, direction: 'before', mode: 'delay' });
    await runUi('older', { twice: true });
    await runUi('delayed');
    const newMessages = [];
    for (let index = 0; index < 4; index++) newMessages.push(await api(`/api/rooms/${alpha.id}/messages`, { body: `翻页同时到达的新消息 ${index + 1}` }));
    await runUi('release');
    current = await runUi('count', { count: 234, last: newMessages.at(-1).id });
    await stable(beforeFinalPage);
    assert.match(current.unread, /^4 条新消息/);
    assert.equal(current.requests.filter(request => request.roomId === alpha.id && request.direction === 'before').length - requestCount, 1);
    assert.deepEqual(current.ids, [...messages, ...newMessages].map(message => message.id));
    checks.push('concurrent-arrivals-and-double-click-do-not-skip-pages');
    await capture('loaded-history');

    await runUi('latest');
    const reading = await runUi('anchor', { id: messages[50].id });
    await runUi('rule', { roomId: alpha.id, direction: 'after', mode: 'delay' });
    await runUi('refresh'); await runUi('delayed');
    await runUi('room', beta);
    const betaMessage = await api(`/api/rooms/${beta.id}/messages`, { body: '只有房间 B 的内容' });
    await runUi('count', { count: 1, last: betaMessage.id });
    await runUi('release');
    assert.deepEqual((await runUi('state')).ids, [betaMessage.id]);
    await runUi('room', alpha);
    current = await runUi('count', { count: 234 });
    await stable(reading);
    checks.push('late-response-and-room-return-keep-their-own-history');

    await runUi('navigation', { label: '任务看板' });
    await runUi('navigation', { label: '团队讨论' });
    current = await runUi('count', { count: 234 });
    await stable(reading);
    checks.push('navigation-return-restores-reading-position');

    await runUi('rule', { roomId: alpha.id, direction: 'after', mode: 'fail' });
    await runUi('refresh');
    current = await runUi('error', { marker: 'HISTORY_PAGE_FAILED' });
    await stable(reading);
    assert.equal(current.ids.length, 234);
    await runUi('retry'); await runUi('count', { count: 234 });
    checks.push('refresh-failure-retains-history-and-position');

    const gammaMessage = await api(`/api/rooms/${gamma.id}/messages`, { body: '首次加载失败后可恢复的内容' });
    await runUi('offline', { roomId: gamma.id });
    await runUi('room', gamma);
    current = await runUi('error', { marker: 'HISTORY_OFFLINE' });
    assert.equal(current.ids.length, 0); assert.equal(current.loading, ''); assert.equal(current.refreshDisabled, false);
    await capture('initial-error');
    await runUi('offline');
    await runUi('retry'); await runUi('count', { count: 1, last: gammaMessage.id });
    checks.push('initial-load-can-be-retried');

    await runUi('room', alpha);
    await runUi('latest');
    const beforeCatchup = await runUi('anchor', { id: messages[50].id });
    await runUi('offline', { roomId: alpha.id });
    await runUi('refresh'); await runUi('error', { marker: 'HISTORY_OFFLINE' });
    const missed = [];
    for (let index = 0; index < 205; index++) missed.push(await api(`/api/rooms/${alpha.id}/messages`, { body: `断线期间的记录 ${index + 1}` }));
    await runUi('offline');
    await runUi('retry');
    current = await runUi('count', { count: 439, last: missed.at(-1).id });
    await stable(beforeCatchup);
    assert.match(current.unread, /^205 条新消息/);
    assert.deepEqual(current.ids, [...messages, ...newMessages, ...missed].map(message => message.id));
    checks.push('more-than-two-pages-of-missed-messages-are-complete');

    const beforeArchive = await runUi('anchor', { id: messages[50].id });
    const hidden = new Set(messages.filter(message => message.taskId === task.id).map(message => message.id));
    await api(`/api/tasks/${task.id}/archive`, {});
    current = await runUi('count', { count: 439 - hidden.size });
    assert.ok(current.ids.every(id => !hidden.has(id)));
    await stable(beforeArchive);
    await api(`/api/tasks/${task.id}/restore`, {});
    current = await runUi('count', { count: 439 });
    await stable(beforeArchive);
    assert.equal(current.unread, beforeArchive.unread, '恢复旧消息不能增加未读计数');
    checks.push('archive-and-restore-update-the-whole-opened-range');

    await runUi('remove');
    await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    await runUi('count', { count: 100, last: missed.at(-1).id });
    for (const factor of [1, 1.25, 1.5]) {
      window.setSize(1040, 700); window.webContents.setZoomFactor(factor);
      await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await runUi('top');
      const layout = await runUi('layout');
      layouts.push({ factor, ...layout });
      assert.equal(layout.noHorizontalOverflow, true);
      assert.equal(layout.olderVisible, true);
      assert.ok(layout.readableBodyPixels >= 24, '矮窗口需要保留可读的消息正文');
      assert.equal(layout.sendVisible, true, '发送按钮应完整显示');
      if (factor === 1.5) await capture('small-window');
    }
    const beforeKeyboard = await runUi('top');
    window.webContents.focus();
    assert.deepEqual(await runUi('focus-history'), { focused: true, disabled: false });
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    current = await runUi('count', { count: 200 });
    await stable(beforeKeyboard);
    assert.equal(current.unread, '回到最新');
    checks.push('history-control-fits-small-window-and-supports-keyboard');
    const result = { ok: true, checks, layouts, screenshots, realModelCalls: 0, seededMessages: 441 };
    fs.writeFileSync(path.join(root, 'history-result.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const screenshot = await capture('failure').catch(() => null);
    fs.writeFileSync(path.join(root, 'history-result.json'), JSON.stringify({ ok: false, checks, layouts, error: error.message,
      state: await runUi('state').catch(() => null), screenshot }, null, 2));
    throw error;
  } finally {
    await runUi('remove').catch(() => {});
    window.webContents.setZoomFactor(zoom); window.setSize(...size);
  }
}
