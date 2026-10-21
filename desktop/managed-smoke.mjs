import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inside } from '../server/safety.mjs';

async function rendererAction({ action, ownerId, workerName, reviewerId, nodePath, gatePath, objective, taskId }) {
  const normalized = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const wait = async (predicate, message) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(message);
  };
  const click = async (label, scope = document) => {
    const button = await wait(() => [...scope.querySelectorAll('button')].find((element) => !element.disabled &&
      (normalized(element.textContent) === label || element.getAttribute('aria-label') === label)), '找不到按钮：' + label);
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const set = async (id, value) => {
    const element = await wait(() => document.getElementById(id), '找不到输入：' + id);
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  if (action === 'configure') {
    await wait(() => document.querySelector('textarea[aria-label="消息"]'), '工作台未就绪');
    const tab = [...document.querySelectorAll('.app-sidebar button')].find((element) => normalized(element.querySelector('span')?.textContent) === '工作区设置');
    tab.click();
    await set('managed-ownerId', ownerId);
    await set('managed-reviewerId', reviewerId);
    const form = document.querySelector('[data-testid="managed-team-settings"]');
    const worker = [...form.querySelectorAll('label')].find((element) => normalized(element.textContent).startsWith(workerName));
    worker.querySelector('input').click();
    await set('managed-check-executable', nodePath);
    await set('managed-check-args', gatePath);
    await click('保存主控团队', form);
    await wait(() => form.textContent.includes('主控团队已保存'), '主控团队未保存');
    return { saved: true };
  }
  if (action === 'draft') {
    await click('交给主控', document.querySelector('.header-actions'));
    await wait(() => document.querySelector('#managed-objective:not(:disabled)'), '目标输入未就绪');
    await set('managed-objective', objective);
    await click('稍后继续', document.querySelector('[data-testid="managed-request"]'));
    await wait(() => !document.querySelector('[data-testid="managed-request"]'), '目标保存后弹窗没有关闭');
    return { closed: true };
  }
  if (action === 'restore') {
    await click('交给主控', document.querySelector('.header-actions'));
    await wait(() => document.querySelector('#managed-objective')?.value === objective, '目标草稿未恢复');
    return { restored: true };
  }
  if (action === 'inject-lost-receipt') {
    const control = { original: window.fetch.bind(window), requests: [], lost: false };
    window.__managedSmoke = control;
    window.fetch = async (target, init = {}) => {
      const url = new URL(typeof target === 'string' ? target : target.url, location.href);
      if (url.origin !== location.origin || url.pathname !== '/api/requests' || init.method !== 'POST') return control.original(target, init);
      control.requests.push(JSON.parse(init.body));
      const response = await control.original(target, init);
      if (!control.lost && response.ok) {
        control.lost = true;
        return new Response(JSON.stringify({ error: 'MANAGED_RECEIPT_LOST' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return response;
    };
    return { installed: true };
  }
  if (action === 'submit-lost') {
    const form = document.querySelector('[data-testid="managed-request"]');
    await click('交给主控执行', form);
    await wait(() => form.textContent.includes('MANAGED_RECEIPT_LOST'), '没有显示丢失回执的错误');
    return { retained: document.querySelector('#managed-objective').value === objective,
      frozen: document.querySelector('#managed-objective').disabled };
  }
  if (action === 'retry') {
    await wait(() => document.querySelector('[data-testid="managed-request"]')?.textContent.includes('请先配置主控与协作团队'),
      '团队设置改变后界面未刷新');
    await click('重试同一请求', document.querySelector('[data-testid="managed-request"]'));
    await wait(() => document.querySelector('[data-task-detail="' + CSS.escape(taskId) + '"]'), '没有打开同一任务');
    return { requestCount: window.__managedSmoke.requests.length,
      requestIds: window.__managedSmoke.requests.map((request) => request.requestId) };
  }
  if (action === 'delivery') {
    const receipt = await wait(() => {
      const element = document.querySelector('[data-testid="task-delivery"]');
      return element?.textContent.includes('主控已交付') && element;
    }, '未呈现主控交付结果');
    const text = normalized(receipt.textContent);
    receipt.scrollIntoView({ block: 'start' });
    await click('查看主控终审日志', receipt);
    await wait(() => [...document.querySelectorAll('.modal-title')].some((element) => element.textContent.includes('主控终审与交付')), '终审日志未打开');
    await click('关闭作业日志');
    await wait(() => document.querySelector('[data-testid="task-delivery"]'), '日志返回后交付报告丢失');
    return { text, returnedFromLog: true };
  }
  if (action === 'layout') {
    const primary = document.querySelector('[data-testid="managed-request"] button[type="submit"]');
    const rect = primary.getBoundingClientRect();
    return { viewport: { width: innerWidth, height: innerHeight }, primaryVisible: rect.top >= 0 && rect.bottom <= innerHeight &&
      rect.left >= 0 && rect.right <= innerWidth,
      objectivePresent: Boolean(document.querySelector('#managed-objective')) };
  }
  if (action === 'remove-control' && window.__managedSmoke) { window.fetch = window.__managedSmoke.original; delete window.__managedSmoke; }
}

export async function runManagedSmoke(window, { url, token, workspace, nodePath, prepareLeave, cancelLeave }) {
  const root = fs.realpathSync(workspace);
  const allowed = fs.realpathSync(path.join(path.dirname(root), '..', 'desktop-smoke'));
  assert.ok(inside(allowed, root) && root !== allowed);
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(url + route, { method, headers: { 'X-CLI-Team-Desktop': token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok, `Managed smoke API failure ${method} ${route} (${response.status})`);
    return response.json();
  };
  const initial = await api('/api/bootstrap');
  assert.equal(fs.realpathSync(initial.workspace.root), root);
  assert.equal(initial.tasks.length, 0); assert.equal(initial.runs.length, 0);
  await api('/api/settings', { paused: true }, 'PATCH');
  const cliPath = path.join(root, '.smoke-fixtures', 'managed-cli.mjs');
  const gatePath = path.join(root, '.smoke-fixtures', 'managed-acceptance.mjs');
  const member = (name, handle, permission) => api('/api/members', { name, handle, provider: 'custom', role: permission === 'plan' ? 'reviewer' : 'builder',
    executable: nodePath, prefixArgs: [cliPath], permission, enabled: true, inputMode: 'stdin' });
  const owner = await member('托管主控', 'managed-owner', 'edit');
  const worker = await member('托管协作者', 'managed-worker', 'edit');
  const reviewer = await member('托管独立评审', 'managed-reviewer', 'plan');
  const objective = '主控拆解目标，检查 module.json 并推动返工，最后交付集成结果';
  const runUi = (action, extra = {}) => window.webContents.executeJavaScript('(' + rendererAction.toString() + ')(' +
    JSON.stringify({ action, ownerId: owner.id, workerName: worker.name, reviewerId: reviewer.id, nodePath, gatePath, objective, ...extra }) + ')', true);
  const until = async (predicate, message, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 100)); }
    throw new Error(message);
  };
  const size = window.getSize(), zoom = window.webContents.getZoomFactor();
  const capture = async (name) => {
    await window.webContents.capturePage();
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const file = path.join(root, name + '.png');
    fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG());
    return file;
  };
  try {
    await window.loadURL(url);
    const configuration = await runUi('configure');
    await runUi('draft');
    assert.equal(await prepareLeave(), true); cancelLeave();
    await window.loadURL(window.webContents.getURL());
    const restored = await runUi('restore');
    window.setSize(1040, 700);
    const layouts = [], screenshots = [];
    for (const factor of [1, 1.25, 1.5]) {
      window.webContents.setZoomFactor(factor);
      // Hidden Electron windows can report the previous layout until the
      // compositor paints. Capture first, then verify the CSS viewport itself.
      screenshots.push(await capture('managed-goal-' + Math.round(factor * 100)));
      const contentSize = window.getContentSize();
      const layout = await until(async () => {
        const measured = await runUi('layout');
        return Math.abs(measured.viewport.width - contentSize[0] / factor) <= 1 &&
          Math.abs(measured.viewport.height - contentSize[1] / factor) <= 1 && measured;
      }, `缩放 ${factor} 后渲染视口未更新`, 5000);
      assert.equal(layout.primaryVisible, true, '托管目标提交按钮被遮挡');
      assert.equal(layout.objectivePresent, true);
      layouts.push({ factor, contentSize, ...layout });
    }
    window.webContents.setZoomFactor(1); window.setSize(...size);
    await runUi('inject-lost-receipt');
    const lost = await runUi('submit-lost');
    assert.equal(lost.retained, true); assert.equal(lost.frozen, true);
    const queued = await api('/api/bootstrap');
    assert.equal(queued.tasks.length, 1);
    const taskId = queued.tasks[0].id;
    await api('/api/settings', { managedTeam: null }, 'PATCH');
    const retry = await runUi('retry', { taskId });
    assert.equal(retry.requestCount, 2); assert.equal(new Set(retry.requestIds).size, 1);
    await api('/api/settings', { paused: false }, 'PATCH');
    const task = await until(async () => {
      const progress = await api('/api/bootstrap');
      const current = progress.tasks.find((item) => item.id === taskId);
      if (current?.status === 'blocked') throw new Error('托管任务受阻：' + current.summary);
      return current?.status === 'done' && current;
    }, '主控未完成交付');
    const delivery = await runUi('delivery');
    screenshots.push(await capture('managed-delivery'));
    const progress = await api('/api/tasks/' + taskId + '/progress');
    assert.equal(task.repairCount, 1); assert.equal(task.delivery.status, 'delivered');
    assert.equal(task.gate.status, 'passed'); assert.equal(task.reviewVerdict, 'approve');
    assert.equal(progress.runs.length, 8);
    assert.equal(progress.runs.filter((run) => run.stage === 'delegate').length, 2);
    assert.equal(progress.runs.filter((run) => run.stage === 'step_review').length, 2);
    assert.ok(progress.runs.every((run) => run.startedAt && run.exitCode === 0));
    const final = await api('/api/bootstrap');
    assert.equal(final.tasks.length, 1);
    return { ok: true, realModelCalls: 0, actualCliRunsStarted: 8, taskId, configuration, restored, lost,
      retry: { ...retry, recoveredAfterTeamChanged: true },
      repairs: task.repairCount, delivery, gate: task.gate, layouts, screenshots };
  } catch (error) { await capture('managed-failure'); throw error; }
  finally { await runUi('remove-control').catch(() => {}); cancelLeave(); window.webContents.setZoomFactor(zoom); window.setSize(...size); }
}
