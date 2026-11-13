import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { chromium } from 'playwright-core';
import { startWorkbench } from '../server/runtime.mjs';
import { normalizePublicationPayload } from '../server/connectors/xiaohongshu.mjs';
import { childEnvironment, killChild } from '../server/safety.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(projectRoot, 'work', 'workbench-focus-20261113', 'ui-proof');
fs.mkdirSync(outputBase, { recursive: true });
const output = fs.mkdtempSync(path.join(outputBase, 'run-'));
const workspace = path.join(output, 'workspace');
fs.mkdirSync(workspace);
const renderDirectory = path.join(output, 'render');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const result = { kind: 'Isolated UI rehearsal with real loopback service, real API and PNGs freshly rendered by Electron in this run',
  startedAt: new Date().toISOString(),
  realCli: false, realPublication: false, realNativeApproval: false, fixtureSeededReviewAndHandoffStates: true,
  output, checks: [], layouts: [], visualChecks: [], externalRequests: [], configurationWrites: [] };
let runtime, browser, context, page, executorCalls = 0, readOnlyNavigation = false;
const pageErrors = [], consoleErrors = [];
const scopedEnvironment = () => {
  const env = childEnvironment('');
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_DISABLE_SANDBOX;
  return env;
};
function findBrowser() {
  const explicit = process.env.CLI_TEAM_UI_BROWSER;
  if (explicit) {
    assert.ok(path.isAbsolute(explicit) && fs.statSync(explicit, { throwIfNoEntry: false })?.isFile(),
      'CLI_TEAM_UI_BROWSER must name an existing absolute Chrome/Edge executable.');
    return explicit;
  }
  const candidates = process.platform === 'win32' ? [...new Set([
    process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA,
    'C:\\Program Files', 'C:\\Program Files (x86)',
  ].filter(Boolean))].flatMap(directory => [path.join(directory, 'Google/Chrome/Application/chrome.exe'),
    path.join(directory, 'Microsoft/Edge/Application/msedge.exe')]) : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find(filename => fs.statSync(filename, { throwIfNoEntry: false })?.isFile());
  assert.ok(found, 'Install Chrome/Edge or set CLI_TEAM_UI_BROWSER; this check never disables the browser sandbox.');
  return found;
}
async function renderImages() {
  fs.mkdirSync(renderDirectory);
  const stdoutPath = path.join(renderDirectory, 'stdout.log'), stderrPath = path.join(renderDirectory, 'stderr.log');
  const stdout = fs.openSync(stdoutPath, 'wx'), stderr = fs.openSync(stderrPath, 'wx');
  const env = { ...scopedEnvironment(), CLI_TEAM_RENDER_SMOKE_ROOT: renderDirectory };
  const args = [path.join(projectRoot, 'desktop', 'content-render-smoke.mjs')];
  const began = Date.now();
  let child, timer, timedOut = false, settlement;
  try {
    child = spawn(electron, args, { cwd: projectRoot, env, windowsHide: true, stdio: ['ignore', stdout, stderr] });
    timer = setTimeout(() => { timedOut = true; killChild(child); }, 90000);
    settlement = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
  } finally {
    clearTimeout(timer); fs.closeSync(stdout); fs.closeSync(stderr);
  }
  result.render = { executable: electron, args, pid: child.pid, ...settlement, timedOut, elapsedMs: Date.now() - began,
    directory: renderDirectory, stdoutPath, stderrPath, electronRunAsNodeRemoved: !Object.hasOwn(env, 'ELECTRON_RUN_AS_NODE') };
  assert.equal(timedOut, false, `Electron rendering timed out; inspect ${stderrPath}`);
  assert.equal(settlement.exitCode, 0, `Electron rendering failed; inspect ${stderrPath}`);
  const receipt = JSON.parse(fs.readFileSync(path.join(renderDirectory, 'render-smoke.json'), 'utf8'));
  assert.equal(receipt.ok, true); assert.equal(receipt.overflowRejected, true);
  assert.equal(receipt.credentialAccess, false);
  const images = ['cover', 'list'].map(name => {
    const filename = path.join(renderDirectory, `${name}.png`), bytes = fs.readFileSync(filename);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(bytes.readUInt32BE(16), 1080); assert.equal(bytes.readUInt32BE(20), 1440);
    assert.equal(receipt[name].bytes, bytes.length);
    assert.equal(receipt[name].renderCheck?.passed, true); assert.equal(receipt[name].renderCheck?.fontLoaded, true);
    assert.equal(receipt[name].renderCheck?.overflow, false);
    result.render[name] = { path: filename, sha256: sha256(bytes), ...receipt[name] };
    return { bytes, source: { kind: 'template', label: '界面演练：本次真实模板渲染产物' },
      templateVersion: receipt[name].templateVersion, renderCheck: receipt[name].renderCheck };
  });
  result.render.receipt = receipt;
  return images;
}
const settlePaint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const navigateTab = async name => {
  const toggle = page.getByRole('button', { name: '展开/收起菜单', exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('navigation', { name: '主功能导航', exact: true }).getByRole('button',
    { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) }).click();
};
async function inspectVisuals(name, selectors, { primaryRequired = false } = {}) {
  await settlePaint();
  const measurement = await page.evaluate(({ name, selectors }) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const colorContext = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = color => {
      colorContext.clearRect(0, 0, 1, 1); colorContext.fillStyle = color; colorContext.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = colorContext.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (front, back) => [0, 1, 2].map(index => front[index] * front[3] + back[index] * (1 - front[3])).concat(1);
    const background = element => {
      const layers = [];
      for (let node = element; node; node = node.parentElement) layers.unshift(rgba(getComputedStyle(node).backgroundColor));
      return layers.reduce((back, front) => over(front, back), [255, 255, 255, 1]);
    };
    const luminance = rgb => rgb.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const visible = element => Boolean(element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 &&
      getComputedStyle(element).visibility !== 'hidden' && !element.closest('[hidden],[aria-hidden="true"],[inert]'));
    const surfaces = selectors.map(selector => {
      const element = [...document.querySelectorAll(selector)].find(visible);
      if (!element) return { selector, visible: false };
      const style = getComputedStyle(element), color = background(element);
      return { selector, visible: true, backgroundColor: style.backgroundColor, effectiveColor: color,
        backgroundImage: style.backgroundImage, luminance: luminance(color) };
    });
    const primaryButtons = [...document.querySelectorAll('button.btn-primary:not(:disabled)')].filter(visible).map(element => {
      const style = getComputedStyle(element), base = background(element);
      const gradientColors = style.backgroundImage.includes('gradient(') ?
        (style.backgroundImage.match(/rgba?\([^)]+\)/g) || []).map(color => over(rgba(color), base)) : [];
      const samples = gradientColors.length ? gradientColors : [base];
      const ratios = samples.map(back => {
        const text = over(rgba(style.color), back), a = luminance(text), b = luminance(back);
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      });
      return { label: element.textContent.trim(), foreground: style.color, backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage, contrast: Math.min(...ratios), samples: samples.length,
        fontSize: style.fontSize, fontWeight: style.fontWeight };
    });
    return { name, viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      surfaces, primaryButtons };
  }, { name, selectors });
  result.visualChecks.push(measurement);
  assert.ok(measurement.documentWidth <= measurement.viewport.width + 1, `${name}: document overflows horizontally`);
  assert.ok(measurement.surfaces.every(surface => surface.visible && surface.luminance < .15), `${name}: visible canvas surfaces must be dark`);
  if (primaryRequired) assert.ok(measurement.primaryButtons.length > 0, `${name}: no enabled primary button was measured`);
  for (const button of measurement.primaryButtons) assert.ok(button.contrast >= 4.5,
    `${name}: primary button ${button.label} contrast ${button.contrast.toFixed(2)} is below 4.5`);
  return measurement;
}
async function inspectReducedMotion() {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await settlePaint();
  try {
    const measurement = await page.evaluate(() => {
      const milliseconds = value => value.split(',').map(part => part.trim().endsWith('ms') ? parseFloat(part) : parseFloat(part) * 1000);
      const violations = [], animatedElements = [];
      const elements = [...document.querySelectorAll('.team-workbench, .team-workbench *, .business-main-nav *')];
      for (const element of elements) {
        if (!element.getBoundingClientRect().width || !element.getBoundingClientRect().height) continue;
        for (const pseudo of [null, '::before', '::after']) {
          const style = getComputedStyle(element, pseudo);
          if (pseudo && ['none', 'normal'].includes(style.content)) continue;
          const sample = { selector: element.tagName.toLowerCase() + (element.classList.length ? `.${[...element.classList].join('.')}` : ''),
            pseudo, animationName: style.animationName, animationDuration: style.animationDuration, animationPlayState: style.animationPlayState,
            transitionDuration: style.transitionDuration, scrollBehavior: style.scrollBehavior };
          if (style.animationName !== 'none') animatedElements.push(sample);
          if (milliseconds(style.transitionDuration).some(value => value > 1) ||
            (style.animationName !== 'none' && style.animationPlayState !== 'paused' && milliseconds(style.animationDuration).some(value => value > 1)) ||
            style.scrollBehavior === 'smooth') violations.push(sample);
        }
      }
      return { mediaMatches: matchMedia('(prefers-reduced-motion: reduce)').matches, sampledElements: elements.length, animatedElements, violations };
    });
    result.reducedMotion = measurement;
    assert.equal(measurement.mediaMatches, true); assert.ok(measurement.sampledElements > 0);
    assert.deepEqual(measurement.violations, [], 'reduced motion must suppress long transitions, decorative animations and smooth CSS scrolling');
  } finally { await page.emulateMedia({ reducedMotion: 'no-preference' }); }
}
const check = async (name, action) => {
  try { await action(); result.checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { result.checks.push({ name, passed: false, error: error.message }); throw error; }
};
const saveDraft = async (input, value) => {
  await input.waitFor();
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/ui-drafts') && response.request().method() === 'PUT' && response.ok()),
    input.fill(value),
  ]);
};
const startWork = async kind => {
  await page.locator('.header-actions').getByRole('button', { name: '开始新工作', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '开始新工作', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: kind === 'project' ? /持续运营内容/ : /完成一次任务/ }).click();
};
const openInspection = async () => {
  const disclosure = page.locator('details').filter({ has: page.locator('summary', { hasText: '检查、审稿与版本记录' }) }).first();
  await disclosure.waitFor();
  if (!await disclosure.evaluate(element => element.open)) await disclosure.locator(':scope > summary').click();
};
const assertApprovalUnavailable = async message => {
  assert.equal(await page.locator('.business-approve-button:enabled').count(), 0, message);
};
const inspectRestoredFocus = async name => {
  await page.waitForFunction(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body || !active.isConnected ||
        active.closest('[inert],[hidden],[aria-hidden="true"]') || active.matches(':disabled')) return false;
    const rect = active.getBoundingClientRect();
    return getComputedStyle(active).visibility !== 'hidden' && rect.width > 0 && rect.height > 0 &&
      rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0;
  });
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    return { label: active.getAttribute('aria-label') || active.textContent.trim().slice(0, 120), tag: active.tagName,
      connected: active.isConnected, inert: Boolean(active.closest('[inert]')), isBody: active === document.body,
      rect: active.getBoundingClientRect().toJSON() };
  });
  result.focusRestoration ||= [];
  result.focusRestoration.push({ name, ...focus });
  return focus;
};
const inspectReturnControl = async (name, label) => {
  const button = page.getByRole('button', { name: label, exact: true });
  await button.waitFor(); await settlePaint();
  const measurement = await button.evaluate(element => {
    const rect = element.getBoundingClientRect(), xInset = Math.min(8, rect.width / 4), yInset = Math.min(8, rect.height / 4);
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const points = [center, { x: rect.left + xInset, y: rect.top + yInset },
      { x: rect.right - xInset, y: rect.top + yInset }, { x: rect.left + xInset, y: rect.bottom - yInset },
      { x: rect.right - xInset, y: rect.bottom - yInset }];
    const scroller = element.closest('.settings-view,.members-view')?.querySelector('.workflow-config-content');
    return { viewport: { width: innerWidth, height: innerHeight }, rect: rect.toJSON(), center,
      fullyWithinViewport: rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      disabled: element.disabled, inert: Boolean(element.closest('[inert]')),
      hitTests: points.map(point => ({ ...point, reachesButton: element.contains(document.elementFromPoint(point.x, point.y)) })),
      scroll: scroller ? { top: scroller.scrollTop, maximum: scroller.scrollHeight - scroller.clientHeight } : null };
  });
  result.returnControls ||= [];
  result.returnControls.push({ name, label, ...measurement });
  assert.equal(measurement.fullyWithinViewport, true, `${name}: the complete return button must stay within the viewport`);
  assert.equal(measurement.disabled, false, `${name}: the return button must be enabled`);
  assert.equal(measurement.inert, false, `${name}: the return button must accept input`);
  assert.ok(measurement.hitTests.every(point => point.reachesButton), `${name}: the return button must not be clipped or covered`);
  return measurement;
};
const inspectReturnAfterScroll = async (name, label, viewSelector) => {
  const selector = `${viewSelector} .workflow-config-content`;
  await page.locator(selector).evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
  await page.waitForFunction(selector => {
    const element = document.querySelector(selector);
    return element && element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
  }, selector);
  const measurement = await inspectReturnControl(name, label);
  assert.ok(measurement.scroll && measurement.scroll.maximum - measurement.scroll.top <= 1,
    `${name}: the page content must actually reach its scroll end before inspecting the return control`);
  return measurement;
};
const openFeaturedContent = async () => {
  await page.locator('.team-featured-output').getByRole('button', { name: '查看内容', exact: true }).click();
};
const inspectFocusedDefault = async (name, title) => {
  await settlePaint();
  const measurement = await page.evaluate(title => {
    const root = document.querySelector('.team-workbench');
    const visible = element => {
      if (!element || element.closest('[hidden],[inert],[aria-hidden="true"]') || !element.getBoundingClientRect().width ||
          !element.getBoundingClientRect().height || getComputedStyle(element).visibility !== 'visible') return false;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === 'DETAILS' && !ancestor.open && !ancestor.querySelector(':scope > summary')?.contains(element)) return false;
      }
      return true;
    };
    const shown = selector => [...root.querySelectorAll(selector)].filter(visible);
    const titles = [], textNodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (textNodes.nextNode()) {
      const node = textNodes.currentNode, text = node.textContent.trim();
      if (!text.includes(title) || node.parentElement.closest('.team-inspector') || !visible(node.parentElement)) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      if (!range.getClientRects().length) continue;
      titles.push({ text, occurrences: text.split(title).length - 1, element: node.parentElement.tagName, className: node.parentElement.className });
    }
    const details = selector => [...root.querySelectorAll(selector)].map(element => ({ open: element.open,
      summary: element.querySelector(':scope > summary')?.textContent.trim(), visible: visible(element) }));
    const scroller = root.querySelector('.team-conversation-scroll'), scrollRect = scroller.getBoundingClientRect();
    const outputWithinScroll = selector => {
      const element = root.querySelector(selector), rect = element?.getBoundingClientRect();
      return { rect: rect?.toJSON(), fullyVisible: Boolean(rect && rect.width > 0 && rect.height > 0 &&
        rect.top >= scrollRect.top && rect.bottom <= scrollRect.bottom && rect.left >= scrollRect.left && rect.right <= scrollRect.right &&
        rect.top >= 0 && rect.bottom <= innerHeight) };
    };
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      primaryCount: shown('.team-next-step').length, primaryKind: root.querySelector('.team-next-step')?.getAttribute('data-project-state'),
      primaryActions: shown('.team-next-step button').length, featuredCount: shown('.team-featured-output').length,
      visiblePhases: shown('.team-work-phase').length, phaseCount: root.querySelectorAll('.team-work-phase').length,
      titleOccurrences: titles.reduce((total, item) => total + item.occurrences, 0), titleLocations: titles,
      otherStatuses: details('.team-other-statuses'), process: details('.team-process-details'), history: details('.team-output-history'),
      sidebarHistoryCount: root.querySelectorAll('.team-sidebar .team-history-row').length,
      duplicateStatusRegions: root.querySelectorAll('.team-attention,.team-project-condition,.team-approval-prompt').length,
      featuredVisibility: { scroller: scrollRect.toJSON(), label: outputWithinScroll('.team-featured-output .team-output-heading'),
        title: outputWithinScroll('.team-featured-output h3'),
        button: outputWithinScroll('.team-featured-output .team-reopen-inspector') },
      headerRunCount: document.querySelectorAll('.header-actions .runs-count-pill').length,
      headerPauseCount: document.querySelectorAll('.header-actions button[aria-label="暂停调度"],.header-actions button[aria-label="恢复调度"]').length };
  }, title);
  result.focusedDefaults ||= [];
  result.focusedDefaults.push({ name, ...measurement });
  assert.ok(measurement.documentWidth <= measurement.viewport.width + 1, `${name}: the default workbench must not overflow horizontally`);
  assert.equal(measurement.primaryCount, 1, `${name}: show one recommended next step`);
  assert.equal(measurement.primaryKind, 'paused', `${name}: pause takes priority while work failure and review also exist`);
  assert.equal(measurement.primaryActions, 1, `${name}: show one recommended action`);
  assert.equal(measurement.featuredCount, 1, `${name}: show one current output`);
  assert.equal(measurement.titleOccurrences, 1, `${name}: the current title must appear only once outside an opened inspector`);
  assert.equal(measurement.visiblePhases, 0, `${name}: internal work phases are collapsed by default`);
  assert.ok(measurement.phaseCount > 0, `${name}: phase records must still exist`);
  assert.equal(measurement.process.length, 1);
  assert.equal(measurement.process[0].open, false);
  assert.equal(measurement.otherStatuses.length, 1);
  assert.equal(measurement.otherStatuses[0].open, false);
  assert.ok(measurement.otherStatuses[0].visible, `${name}: the other-issues disclosure itself must remain discoverable`);
  assert.ok(measurement.history.every(entry => !entry.open));
  assert.equal(measurement.sidebarHistoryCount, 0);
  assert.equal(measurement.duplicateStatusRegions, 0);
  assert.equal(measurement.headerRunCount, 0);
  assert.equal(measurement.headerPauseCount, 0);
  assert.equal(measurement.featuredVisibility.label.fullyVisible, true, `${name}: the current-output label must be fully visible inside the conversation`);
  assert.equal(measurement.featuredVisibility.title.fullyVisible, true, `${name}: the current-output title must be fully visible inside the conversation`);
  assert.equal(measurement.featuredVisibility.button.fullyVisible, true, `${name}: the open-content button must be fully visible inside the conversation`);
  return measurement;
};
const createProjectFromForm = async () => {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/projects') && response.request().method() === 'POST'),
    page.getByRole('button', { name: '建立项目并开始', exact: true }).click(),
  ]);
  const created = await response.json();
  assert.ok(response.ok(), JSON.stringify(created));
  await page.getByRole('dialog', { name: '持续运营内容', exact: true }).waitFor({ state: 'detached' });
  await page.locator(`.team-conversation[data-project-id="${created.id}"]`).waitFor();
  return created;
};
try {
  assert.ok(fs.existsSync(path.join(projectRoot, 'dist', 'index.html')), 'Run npm run build before smoke:business-ui.');
  const index = fs.readFileSync(path.join(projectRoot, 'dist', 'index.html'), 'utf8');
  const assets = [...index.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => `dist${match[1]}`);
  result.build = ['dist/index.html', ...assets].map(filename => ({ path: filename, sha256: sha256(fs.readFileSync(path.join(projectRoot, filename))) }));
  const beforeScreenshot = 'docs/assets/simple-workflow-20261113.png';
  if (fs.existsSync(path.join(projectRoot, beforeScreenshot))) result.comparisonReference = {
    path: beforeScreenshot, sha256: sha256(fs.readFileSync(path.join(projectRoot, beforeScreenshot))),
    kind: 'Prior implementation screenshot from the preceding isolated rehearsal; retained unchanged as a visual reference, not a pixel-diff baseline.' };
  const browserExecutable = findBrowser();
  const images = await renderImages();
  runtime = await startWorkbench({ root: workspace, distDir: path.join(projectRoot, 'dist'),
    serviceOptions: { detect: () => ({ executable: '', prefixArgs: [] }), proxy: '',
      agentExecutor: async () => { executorCalls++; throw new Error('UI proof must not start a CLI executor.'); },
      probe: async () => { throw new Error('UI proof must not probe official CLI accounts.'); } } });
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(runtime.url).hostname));
  const service = runtime.service;
  service.updateSettings({ paused: true });
  const owner = service.saveMember({ name: '演练负责人', handle: 'rehearsal-owner', provider: 'custom', role: 'builder', executable: process.execPath, enabled: true, permission: 'edit' });
  const reviewer = service.saveMember({ name: '演练审稿员', handle: 'rehearsal-reviewer', provider: 'custom', role: 'reviewer', executable: process.execPath, enabled: false, permission: 'plan' });
  const researcher = service.saveMember({ name: '演练研究员', handle: 'rehearsal-researcher', provider: 'custom', role: 'researcher', executable: process.execPath, enabled: false, permission: 'edit' });
  const unrelated = service.saveMember({ name: '演练其他项目成员', handle: 'rehearsal-unrelated', provider: 'custom', role: 'builder', executable: process.execPath, enabled: false, permission: 'edit' });
  const unavailableWorker = service.saveMember({ name: '演练已停用成员', handle: 'rehearsal-unavailable', provider: 'custom', role: 'researcher', executable: process.execPath, enabled: false, permission: 'edit' });
  context = await chromium.launchPersistentContext(path.join(output, 'browser-profile'), { executablePath: browserExecutable,
    chromiumSandbox: true, headless: true, env: scopedEnvironment(), viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  browser = context.browser(); assert.ok(browser);
  const session = await browser.newBrowserCDPSession();
  const launch = await session.send('Browser.getBrowserCommandLine');
  const disabledSandboxFlags = launch.arguments.filter(argument => /^--(?:no-sandbox|disable-setuid-sandbox|disable-web-security)(?:=|$)/.test(argument));
  assert.deepEqual(disabledSandboxFlags, []);
  assert.equal(launch.arguments.some(argument => argument.startsWith('--remote-debugging-port')), false);
  result.sandboxEnabled = disabledSandboxFlags.length === 0;
  result.browser = { executable: browserExecutable, version: browser.version(), profile: path.join(output, 'browser-profile'),
    disabledSandboxFlags, remoteDebuggingPortFlags: launch.arguments.filter(argument => argument.startsWith('--remote-debugging-port')) };
  await context.route('**/*', route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin !== new URL(runtime.url).origin) {
      result.externalRequests.push({ origin: requestUrl.origin, method: route.request().method() }); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (readOnlyNavigation && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
      /^\/api\/(?:settings|members|discover|business\/connection|projects)/.test(pathname)) {
      result.configurationWrites.push({ path: pathname, method: request.method() });
    }
  });
  await page.goto(runtime.url);
  await check('one start entry separates a one-off task from ongoing content work without losing task drafts', async () => {
    const mainEntry = page.locator('.header-actions').getByRole('button', { name: '开始新工作', exact: true });
    await mainEntry.waitFor();
    assert.equal(await mainEntry.count(), 1, 'the header has one primary work entry');
    await mainEntry.click();
    const chooser = page.getByRole('dialog', { name: '开始新工作', exact: true });
    await chooser.waitFor();
    await page.screenshot({ path: path.join(output, 'start-work-1440.png') });
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      assert.equal(await chooser.evaluate(element => element.contains(document.activeElement)), true,
        'new work keyboard focus must remain in its dialog');
    }
    await chooser.getByRole('button', { name: /完成一次任务/ }).click();
    const request = page.getByTestId('managed-request');
    await request.waitFor();
    assert.equal(await request.getByRole('button', { name: '开始这项任务', exact: true }).isDisabled(), true,
      'choosing a work type does not bypass missing team setup');
    const text = '流程演练：完成一项带明确验收标准的任务。';
    await saveDraft(request.locator('#managed-objective'), text);
    await request.getByRole('button', { name: '稍后继续', exact: true }).click();
    await startWork('task');
    await page.waitForFunction(expected => document.querySelector('#managed-objective')?.value === expected, text);
    assert.equal(await request.locator('#managed-objective').inputValue(), text);
    await request.getByRole('button', { name: '稍后继续', exact: true }).click();
    assert.equal(service.store.list('tasks').length, 0, 'saving a goal draft must not start a task');
  });
  await check('project setup detour returns to the exact saved goal after a real member configuration change and reload', async () => {
    await startWork('project');
    await saveDraft(page.getByLabel('项目名称', { exact: true }), '首用演练 A · 保留创建草稿');
    await saveDraft(page.locator('.business-create-dialog').getByLabel(/^希望团队持续做什么/), '演练目标：按实际工作节奏形成中文图文，先补齐独立审稿成员。');
    await saveDraft(page.getByLabel('已有资料与内容要求', { exact: false }), '首用演练草稿：成员配置回来后不能丢失这些要求。');
    assert.equal(await page.getByRole('button', { name: '建立项目并开始', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '稍后继续', exact: true }).click();
    await page.getByRole('dialog', { name: '持续运营内容', exact: true }).waitFor({ state: 'detached' });
    const deferredFocus = await inspectRestoredFocus('deferring project creation restores its primary entry');
    assert.equal(deferredFocus.label, '开始新工作');
    await startWork('project');
    await page.waitForFunction(() => document.querySelector('.business-create-dialog input')?.value === '首用演练 A · 保留创建草稿');
    await page.getByRole('button', { name: '去配置成员', exact: true }).click();
    await page.locator('.members-view').waitFor();
    await settlePaint();
    assert.equal(await page.locator('.header-actions [aria-label="开始新工作"]').evaluate(element => element === document.activeElement), false,
      'leaving creation for member settings must not restore focus to the old header entry');
    const route = new URLSearchParams(page.url().split('?').at(-1));
    assert.ok(page.url().includes('#/members'));
    assert.match(route.get('return') || '', /^#\/projects(?:\?|\/)/);
    const card = page.locator('.member-card').filter({ has: page.locator('.member-name', { hasText: '演练审稿员' }) });
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith(`/api/members/${reviewer.id}`) && response.request().method() === 'PATCH'),
      card.getByRole('button', { name: '启用', exact: true }).click(),
    ]);
    assert.ok(response.ok());
    assert.equal(service.store.get('members', reviewer.id).enabled, true);
    await page.reload();
    await page.locator('.members-view').waitFor();
    await card.waitFor();
    await inspectReturnControl('member-setup-after-reload-1440', '返回继续创建项目');
    let memberReturn;
    for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      memberReturn = await inspectReturnAfterScroll(`member-setup-at-scroll-end-${size.width}`, '返回继续创建项目', '.members-view');
      if (size.width === 390) assert.ok(memberReturn.scroll.top > 0, 'the narrow member page must exercise actual scrolling');
      await page.screenshot({ path: path.join(output, `members-return-${size.width}.png`) });
    }
    await page.mouse.click(memberReturn.center.x, memberReturn.center.y);
    await page.getByLabel('项目名称', { exact: true }).waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => document.querySelector('.business-create-dialog input')?.value === '首用演练 A · 保留创建草稿');
    await page.locator('.business-create-dialog button[type="submit"]:enabled').waitFor();
    assert.equal(await page.getByLabel('项目名称', { exact: true }).inputValue(), '首用演练 A · 保留创建草稿');
    assert.match(await page.locator('.business-create-dialog').getByLabel(/^希望团队持续做什么/).inputValue(), /先补齐独立审稿成员/);
    assert.match(await page.getByLabel('已有资料与内容要求', { exact: false }).inputValue(), /不能丢失/);
    assert.equal(await page.getByRole('button', { name: '建立项目并开始', exact: true }).isDisabled(), false,
      'an originally empty reviewer choice must be filled from the newly configured reviewer');
    await page.screenshot({ path: path.join(output, 'create-after-members-1440.png') });
    await createProjectFromForm();
    assert.equal(service.projects.list().length, 1);
    assert.equal(await page.locator('.team-inspector').count(), 0, 'a new project starts with its conversation unobstructed');
  });
  const firstProject = service.projects.list()[0];
  service.saveMember({ enabled: true }, researcher.id);
  service.saveMember({ enabled: true }, unrelated.id);
  service.saveMember({ enabled: true }, unavailableWorker.id);
  service.updateSettings({ managedTeam: { ownerId: owner.id, workerIds: [researcher.id, unavailableWorker.id], reviewerId: reviewer.id,
    verification: null, autoDeliver: true } });
  service.saveMember({ enabled: false }, unavailableWorker.id);
  await check('real project creation into the new single-page workbench', async () => {
    await page.reload();
    await page.locator('.team-conversation').waitFor();
    await startWork('project');
    await page.getByLabel('项目名称', { exact: true }).fill('界面演练 · 工作方法');
    await page.locator('.business-create-dialog').getByLabel(/^希望团队持续做什么/).fill('演练数据：为刚开始管理个人工作的人制作实用方法图文，保留来源与实际使用限制。');
    await page.getByLabel('已有资料与内容要求', { exact: false }).fill('界面演练数据，不进行真实成员运行或发布。使用具体、自然的中文，标明模板制作。');
    assert.equal(await page.getByRole('button', { name: '建立项目并开始', exact: true }).isDisabled(), true,
      'an unavailable member inherited from the default team must require an explicit decision');
    await page.locator('.business-create-dialog summary').filter({ hasText: '调整项目成员' }).click();
    const unavailableChoice = page.getByRole('checkbox', { name: /演练已停用成员/ });
    assert.equal(await unavailableChoice.isChecked(), true, 'the unavailable default worker remains visible until explicitly removed');
    assert.equal(await unavailableChoice.isDisabled(), false, 'an unavailable optional worker must be removable');
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/ui-drafts') && response.request().method() === 'PUT' && response.ok() &&
        response.request().postDataJSON().scope.kind === 'new-project' &&
        !JSON.parse(response.request().postDataJSON().values.memberIds).includes(unavailableWorker.id)),
      unavailableChoice.click(),
    ]);
    await unavailableChoice.waitFor({ state: 'detached' });
    const teamDraft = service.store.list('uiDrafts').find(entry => entry.scope.kind === 'new-project' && !entry.deleted);
    assert.ok(teamDraft);
    assert.equal(JSON.parse(teamDraft.values.memberIds).includes(unavailableWorker.id), false);
    await page.locator('.business-create-dialog button[type="submit"]:enabled').waitFor();
    await page.locator('.business-create-dialog summary').filter({ hasText: '调整项目成员' }).click();
    await page.screenshot({ path: path.join(output, 'create-project.png') });
    await createProjectFromForm();
    assert.equal(service.projects.list().length, 2);
    assert.equal(await page.locator('.team-inspector').count(), 0);
    assert.equal(await page.locator('.team-command-strip').count(), 1,
      'switching from the first project to a newly created project must not retain the previous command strip');
    assert.equal(await page.locator('.team-next-step').count(), 1);
    assert.equal(await page.locator('.team-conversation').count(), 1);
    assert.equal(await page.locator(`.team-conversation[data-project-id="${firstProject.id}"]`).count(), 0,
      'the previous project conversation must not remain in the DOM after switching projects');
  });
  const project = service.projects.list().find(entry => entry.id !== firstProject.id);
  assert.ok(project);
  assert.deepEqual([...project.memberIds].sort(), [owner.id, reviewer.id, researcher.id].sort(),
    'new projects inherit the selected default roster, not every enabled member');
  assert.equal(project.memberIds.includes(unrelated.id), false);
  assert.equal(project.memberIds.includes(unavailableWorker.id), false);
  result.defaultTeam = { memberIds: project.memberIds, unrelatedMemberId: unrelated.id,
    unavailableWorkerId: unavailableWorker.id, unavailableMemberRetainedUntilExplicitRemoval: true };
  const composer = page.getByLabel('告诉负责人新的要求', { exact: true });
  const draftText = '演练草稿：请补充怎样接住临时任务的具体例子。';
  await check('the daily view starts with one truthful next step and expands the actual team process on demand', async () => {
    const disclosure = page.locator('.team-process-details');
    assert.equal(await disclosure.evaluate(element => element.open), false);
    assert.equal(await page.locator('.team-work-phase:visible').count(), 0);
    await page.locator('.team-next-step').getByText(/暂停/).first().waitFor();
    assert.equal(await page.locator('.team-next-step').getByText(/正在执行|团队正在改稿/).count(), 0,
      'paused scheduling cannot be reported as work in progress');
    const phases = page.locator('.team-phase-toggle');
    for (const phase of await phases.all()) assert.equal(await phase.getAttribute('aria-expanded'), 'false');
    await page.screenshot({ path: path.join(output, 'daily-project-1440.png') });
    await disclosure.locator(':scope > summary').click();
    assert.equal(await disclosure.evaluate(element => element.open), true);
    assert.ok((await disclosure.innerText()).trim().length > (await disclosure.locator(':scope > summary').innerText()).trim().length,
      'opening team process must reveal actual records or an explicit empty state');
    await disclosure.locator(':scope > summary').click();
    assert.equal(await page.locator('.team-work-phase:visible').count(), 0);
    const layout = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      inspector: document.querySelectorAll('.team-inspector').length, conversation: document.querySelector('.team-conversation').getBoundingClientRect().toJSON() }));
    assert.equal(layout.inspector, 0); assert.ok(layout.documentWidth <= layout.width);
    result.dailyView = layout;
    const settingsBefore = structuredClone(service.settings());
    readOnlyNavigation = true;
    await page.locator('.team-next-step').getByRole('button', { name: '查看暂停设置', exact: true }).click();
    const runtimeSection = page.getByRole('region', { name: '工作区调度', exact: true });
    await runtimeSection.waitFor();
    const runtimeFocus = await inspectRestoredFocus('paused work links to the explicit workspace scheduling control');
    assert.equal(runtimeFocus.label, '工作区调度');
    const runtimeParams = new URLSearchParams(page.url().split('?').at(-1));
    assert.equal(runtimeParams.get('panel'), 'runtime');
    assert.equal(runtimeParams.get('project'), project.id);
    assert.equal(await runtimeSection.getByRole('button', { name: '恢复工作区调度', exact: true }).isDisabled(), false);
    assert.deepEqual(service.settings(), settingsBefore, 'viewing runtime settings must not resume scheduling');
    assert.deepEqual(result.configurationWrites, []);
    await inspectReturnControl('runtime-settings-after-auto-position-1440', '返回项目');
    const runtimeReturn = await inspectReturnAfterScroll('runtime-settings-at-scroll-end-1440', '返回项目', '.settings-view:not([hidden])');
    assert.ok(runtimeReturn.scroll.top > 0, 'runtime settings must exercise actual scrolling');
    await page.mouse.click(runtimeReturn.center.x, runtimeReturn.center.y);
    await page.locator(`.team-conversation[data-project-id="${project.id}"]`).waitFor();
    assert.equal(service.settings().paused, true);
    readOnlyNavigation = false;
  });
  await check('messages default to the owner and create an actual user conversation thread', async () => {
    assert.equal(await page.getByLabel('消息收件人', { exact: true }).isVisible(), false);
    await page.locator('summary').filter({ hasText: '调整收件人' }).click();
    assert.equal(await page.getByLabel('消息收件人', { exact: true }).inputValue(), '');
    await page.locator('summary').filter({ hasText: '调整收件人' }).click();
    await composer.fill('演练交代：写清楚这些方法的适用边界。');
    await page.locator('.team-project-composer').getByRole('button', { name: '发送', exact: true }).click();
    await page.locator('.team-message.from-user').getByText('演练交代：写清楚这些方法的适用边界。', { exact: true }).waitFor();
    const thread = service.store.list('collaborationThreads').find(entry => entry.question === '演练交代：写清楚这些方法的适用边界。');
    assert.ok(thread);
    assert.equal(thread.requesterId, 'user');
    assert.equal(thread.recipientId, project.ownerId);
    await saveDraft(composer, draftText);
  });
  await check('switching context keeps the conversation and persisted input draft', async () => {
    await page.locator('.team-conversation-header').getByRole('button', { name: '资料', exact: true }).click();
    await page.getByLabel('补充资料', { exact: true }).waitFor();
    assert.equal(await composer.inputValue(), draftText);
    await saveDraft(page.getByLabel('补充资料', { exact: true }), '演练资料草稿：具体方法需要根据工作节奏调整。');
    await page.getByRole('button', { name: '修正简报', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'resources-open.png') });
    await saveDraft(page.getByLabel('账号简报', { exact: true }), '演练简报草稿：项目会话在侧面板打开时保持可用。');
    await page.locator('.team-inspector-nav').getByRole('button', { name: '团队', exact: true }).click();
    await page.locator('.team-inspector-nav').getByRole('button', { name: '资料', exact: true }).click();
    assert.match(await page.getByLabel('账号简报', { exact: true }).inputValue(), /演练简报草稿/);
    await page.reload();
    await page.getByLabel('账号简报', { exact: true }).waitFor();
    await page.waitForFunction(expected => document.querySelector('[aria-label="告诉负责人新的要求"]')?.value === expected, draftText);
    assert.equal(await composer.inputValue(), draftText);
    assert.match(await page.getByLabel('补充资料', { exact: true }).inputValue(), /演练资料草稿/);
  });
  const item = service.contentRevisions.createItem(project.id, { title: '让今天的计划可以开始执行' });
  service.business.createWork({ projectId: project.id, contentId: item.id, memberId: owner.id, kind: 'integrate',
    title: '演练整稿责任项', objective: '界面演练：整合图文，接收后续修改要求。',
    output: { type: 'files', files: [{ path: 'note.json', format: 'json' }] } });
  const one = service.contentRevisions.createRevision(item.id, { title: '把一天的工作安排得更从容',
    body: '演练旧版本关键词：十五分钟起步。\n把第一步缩小成十五分钟内可以开始的动作，为临时工作保留空白。', tags: ['工作方法', '演练'], images,
    sources: [{ label: '界面演练素材', kind: 'user' }], inputRefs: [{ kind: 'project', id: project.id, revision: 1 }], authorMemberIds: [owner.id] });
  const two = service.contentRevisions.createRevision(item.id, { title: '让今天的计划可以开始执行',
    body: '界面演练稿件：先写下今天必须完成的一件事，把目标说具体。\n\n把第一步缩小到十五分钟内可以开始的动作。预留一段空白时间，接住临时任务和意外。\n\n结束前记录进展，再安排明天的第一步。方法要在真实工作中检验与调整，不保证适用于每一种场景。',
    tags: ['工作方法', '个人管理'], images: one.images.map(image => ({ assetId: image.id })), sources: one.sources,
    inputRefs: one.inputRefs, authorMemberIds: [owner.id], changeSummary: '演练版本改动：加入适用边界，避免泛化承诺。' });
  const review = service.contentRevisions.recordReview(item.id, two.id, { memberId: reviewer.id, verdict: 'approve', summary: '界面演练审稿状态：文案已说明适用边界，图文一致。此条由验收脚本种入，不是真实成员审稿。' });
  await check('a draft without a verified independent review is never advertised as ready for user approval', async () => {
    service.store.update('contentItems', item.id, { status: 'review' });
    service.emitChange('business.ui_fixture', { projectId: project.id });
    await page.getByLabel('搜索当前项目', { exact: true }).fill(two.title);
    await page.locator('.team-search-results button').filter({ hasText: `${two.title} · 版本 2` }).click();
    await page.locator(`[data-content-workbench="${item.id}"]`).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.business-image-button img').length === 2 &&
      [...document.querySelectorAll('.business-image-button img')].every(image => image.complete && image.naturalWidth === 1080));
    assert.equal(await page.locator('.team-approval-prompt').count(), 0);
    assert.equal(await page.locator('.team-other-statuses [data-project-state="awaiting"]').count(), 0,
      'a missing independent review cannot appear among actionable secondary review states');
    assert.notEqual(await page.locator('.team-next-step').getAttribute('data-project-state'), 'awaiting');
    await page.locator('.business-content-breadcrumb').getByText('等待独立审稿', { exact: true }).waitFor();
    assert.equal(await page.locator('.business-content-breadcrumb').getByText(/待批准整稿|可以确认发布|等待你确认整稿/).count(), 0);
    await assertApprovalUnavailable('a current draft without source-verified review cannot expose a publish action');
    await page.screenshot({ path: path.join(output, 'waiting-for-review-1440.png') });
  });
  service.store.update('reviews', review.id, { status: 'current', sourceRunId: 'ui-fixture-review-run', evidenceType: 'agent_review' });
  service.store.update('contentEligibilities', item.id, { status: 'eligible', valid: true, reason: '', reviewId: review.id, reviewIds: [review.id] });
  service.store.update('contentItems', item.id, { status: 'awaiting_approval', currentReviewVersionId: two.id });
  const stamp = new Date().toISOString();
  const seedWork = service.business.createWork({ projectId: project.id, contentId: item.id, memberId: owner.id, kind: 'copy',
    title: '演练返工：补充适用边界', objective: '演练交接目标：补充适用边界，写清可验证的具体场景。',
    acceptanceCriteria: ['每个建议包含适用边界', '来源与团队判断分开'] });
  const workId = seedWork.id;
  service.store.update('workItems', workId, {
    status: 'failed', handoffStatus: 'returned', error: '演练受阻：尚缺少可核对的真实使用案例。', resultDigest: 'a'.repeat(64), currentReceiptId: 'ui-receipt',
    acceptanceCriteria: ['每个建议包含适用边界', '来源与团队判断分开'], createdAt: stamp, updatedAt: stamp });
  service.store.put('workHandoffs', { id: 'ui-handoff', projectId: project.id, workItemId: workId, generation: 1, type: 'returned',
    actorId: reviewer.id, recipientId: owner.id, evidenceType: 'agent_review', message: '演练交接记录：缺少场景证据，退回补充。', createdAt: stamp });
  service.store.put('workReceipts', { id: 'ui-receipt', projectId: project.id, workItemId: workId, generation: 1,
    attemptId: 'ui-attempt-receipt', runId: 'ui-run', receiverId: reviewer.id, createdAt: stamp, inputDigest: 'b'.repeat(64), resultDigest: 'a'.repeat(64), manifestHash: 'c'.repeat(64),
    versionId: two.id, summary: '界面演练程序收件种子', files: [{ relativePath: 'manuscript.md', sha256: 'd'.repeat(64), size: 100 }],
    checks: ['input_integrity', 'declared_files'], evidenceType: 'machine' });
  service.store.put('businessActions', { id: 'ui-action', projectId: project.id, sourceWorkItemId: workId, sourceRunId: 'ui-run', generation: 1,
    type: 'contribute', input: { message: '演练成员贡献：通过真实结构化行动字段展示。' }, result: {}, status: 'processed', createdAt: stamp });
  service.emitChange('business.ui_fixture', { projectId: project.id });
  await check('focused defaults show one next step and one output while other issues and historical records remain reachable', async () => {
    assert.equal(service.settings().paused, true);
    assert.equal(service.store.get('workItems', workId).status, 'failed');
    assert.equal(service.store.get('contentItems', item.id).status, 'awaiting_approval');
    const activityProof = result.focusedMessageActivity = { source: 'Fixture contribution through BusinessCollaboration.thread, SQLite and the real /api/business/state response',
      realAgentReply: false, contentId: item.id, versionId: two.id, events: [] };
    const contribution = async message => {
      const counts = ['contentItems', 'contentRevisions', 'workItems', 'publicationApprovals', 'publicationAttempts']
        .map(table => [table, service.store.list(table).length]);
      const refreshed = page.waitForResponse(async response => response.url().endsWith('/api/business/state') && response.ok() &&
        (await response.json()).collaborationThreads.some(thread => thread.projectId === project.id && thread.question === message));
      const thread = service.business.collaboration.thread({ projectId: project.id, contentId: item.id, versionId: two.id,
        requesterId: owner.id, kind: 'contribution', question: message, status: 'resolved' });
      const snapshot = await (await refreshed).json();
      assert.equal(snapshot.collaborationThreads.find(entry => entry.id === thread.id)?.question, message);
      for (const [table, count] of counts) assert.equal(service.store.list(table).length, count, `${table} must not change for a message-only update`);
      const selector = `.team-conversation-timeline [data-project-focus="message-${thread.id}"]`;
      await page.locator(selector).waitFor({ state: 'attached' });
      await settlePaint();
      assert.equal(await page.locator('.team-featured-output').getAttribute('data-version-id'), two.id);
      return { selector, threadId: thread.id, apiObserved: true, preservedCounts: Object.fromEntries(counts) };
    };
    const conversationPosition = selector => page.locator(selector).evaluate(element => {
      const node = element.closest('.team-conversation-scroll'), bounds = node.getBoundingClientRect();
      const within = target => {
        const rect = target.getBoundingClientRect();
        return { rect: rect.toJSON(), fullyVisible: rect.width > 0 && rect.height > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom &&
          rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= 0 && rect.bottom <= innerHeight };
      };
      return { viewport: { width: innerWidth, height: innerHeight }, scroller: bounds.toJSON(), scrollTop: node.scrollTop,
        maximum: node.scrollHeight - node.clientHeight, target: within(element), body: within(element.querySelector('.team-message-body') || element),
        latestMessageId: node.querySelector('.team-conversation-timeline > li:last-child .team-message')?.getAttribute('data-project-focus') };
    });
    await page.getByRole('button', { name: '收起稿件面板', exact: true }).click();
    await page.locator(`.team-featured-output[data-content-id="${item.id}"]`).waitFor();
    for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await page.reload();
      await page.locator(`.team-featured-output[data-content-id="${item.id}"]`).waitFor();
      await page.locator('.team-other-statuses li[data-project-state="awaiting"]').waitFor({ state: 'attached' });
      await page.waitForFunction(() => [...document.querySelectorAll('.team-featured-output img')].every(image => image.complete && image.naturalWidth === 1080));
      const measurement = await inspectFocusedDefault(`daily-focused-${size.width}`, two.title);
      assert.match(measurement.otherStatuses[0].summary, /其他待处理\s*2/);
      await inspectVisuals(`daily-focused-${size.width}`, ['.team-workbench', '.team-conversation', '.team-featured-output'], { primaryRequired: true });
      await page.screenshot({ path: path.join(output, `daily-focused-${size.width}.png`) });
    }
    const followed = await contribution('新回复演练：稿件版本保持不变，负责人补充了适用范围。');
    const automatic = await conversationPosition(followed.selector);
    activityProof.events.push({ name: 'same-version-auto-follow-390', ...followed, ...automatic });
    assert.equal(automatic.viewport.width, 390);
    assert.equal(automatic.latestMessageId, `message-${followed.threadId}`);
    assert.equal(automatic.body.fullyVisible, true, 'a new reply on the same manuscript version must be visible when following latest activity');
    assert.equal(await page.locator('.team-new-activity').count(), 0);
    await page.screenshot({ path: path.join(output, 'same-version-auto-follow-390.png') });
    await page.locator(followed.selector).getByRole('button', { name: '查看关联内容', exact: true }).click();
    await page.locator(`[data-content-workbench="${item.id}"]`).waitFor();
    await page.getByRole('button', { name: '收起稿件面板', exact: true }).click();
    await page.locator('.team-featured-output').waitFor();
    await settlePaint();
    const afterInspector = await conversationPosition(followed.selector);
    activityProof.events.push({ name: 'same-version-close-inspector-390', ...afterInspector });
    assert.equal(afterInspector.body.fullyVisible, true, 'closing the manuscript must return to the latest reply without scrolling past it');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const otherStatuses = page.locator('.team-other-statuses');
    assert.equal(await otherStatuses.locator('li[data-project-state="blocked"]').isVisible(), false);
    assert.equal(await otherStatuses.locator('li[data-project-state="awaiting"]').isVisible(), false);
    await otherStatuses.locator(':scope > summary').click();
    const blockedStatus = otherStatuses.locator('li[data-project-state="blocked"]');
    const awaitingStatus = otherStatuses.locator('li[data-project-state="awaiting"]');
    await blockedStatus.getByText('1 项工作需要处理', { exact: true }).waitFor();
    await awaitingStatus.getByText('1 篇整稿可以审阅', { exact: true }).waitFor();
    await blockedStatus.getByRole('button').click();
    const focusedWork = page.locator(`[data-project-focus="work-${workId}"].is-focused`);
    await focusedWork.getByText('演练受阻：尚缺少可核对的真实使用案例。', { exact: true }).waitFor();
    assert.equal(await page.locator('.team-process-details').evaluate(element => element.open), true,
      'selecting a blocked work item must reveal the collapsed team records');
    assert.equal(await focusedWork.locator('.team-phase-toggle').getAttribute('aria-expanded'), 'true');
    await awaitingStatus.getByRole('button').click();
    await page.locator(`[data-content-workbench="${item.id}"]`).waitFor();
    assert.equal(await page.locator('.team-featured-output').count(), 0,
      'an opened manuscript must not be duplicated in the conversation');
    await assertApprovalUnavailable('the secondary review action must not bypass desktop approval');
    await page.getByRole('button', { name: '收起稿件面板', exact: true }).click();
    const historicalItem = service.contentRevisions.createItem(project.id, { title: '历史入口演练：每周复盘提纲' });
    const historicalVersion = service.contentRevisions.createRevision(historicalItem.id, { title: historicalItem.title,
      body: '这份本地演练草稿只验证历史入口。保留上一份稿件并按需打开，不运行成员或发布。', tags: ['界面演练'],
      images: two.images.map(image => ({ assetId: image.id })), sources: two.sources, inputRefs: two.inputRefs,
      authorMemberIds: [owner.id] });
    service.emitChange('business.ui_fixture', { projectId: project.id });
    const history = page.locator('.team-output-history');
    await history.waitFor();
    assert.equal(await history.evaluate(element => element.open), false, 'additional manuscripts enter a collapsed history');
    await history.locator(':scope > summary').click();
    const historicalRow = history.locator('.team-history-row').filter({ hasText: historicalItem.title });
    await historicalRow.waitFor();
    assert.equal(await history.getByText(two.title, { exact: true }).count(), 0,
      'the featured manuscript must not be duplicated among historical cards');
    await historicalRow.click();
    await page.locator(`[data-content-workbench="${historicalItem.id}"]`).waitFor();
    await page.waitForFunction(expected => document.querySelector('[aria-label="查看稿件版本"]')?.value === expected, historicalVersion.id);
    await page.getByLabel('搜索当前项目', { exact: true }).fill(two.title);
    await page.locator('.team-search-results button').filter({ hasText: `${two.title} · 版本 2` }).click();
    await page.locator(`[data-content-workbench="${item.id}"]`).waitFor();
    await page.getByRole('button', { name: '收起稿件面板', exact: true }).click();
    await page.reload();
    await page.locator(`.team-featured-output[data-content-id="${item.id}"]`).waitFor();
    await inspectFocusedDefault('daily-focused-with-history-1440', two.title);
    assert.equal(await composer.inputValue(), draftText);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator(`.team-featured-output[data-content-id="${item.id}"]`).waitFor();
    await history.locator(':scope > summary').click();
    await historicalRow.scrollIntoViewIfNeeded();
    await settlePaint();
    const historicalSelector = `.team-output-history [data-project-focus="content-${historicalItem.id}"]`;
    const readingBefore = await conversationPosition(historicalSelector);
    assert.equal(readingBefore.target.fullyVisible, true, 'the history row must be on screen before the reply arrives');
    const deferred = await contribution('历史阅读演练：这是同一稿件的新回复，请读完历史后再查看。');
    const activityButton = page.getByRole('button', { name: '有新进展，回到最新', exact: true });
    await activityButton.waitFor();
    await settlePaint();
    const readingAfter = await conversationPosition(historicalSelector);
    const deferredPosition = await conversationPosition(deferred.selector);
    const prompt = await activityButton.evaluate(element => {
      const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { rect: rect.toJSON(), fullyVisible: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
        acceptsClick: Boolean(hit && element.contains(hit)) };
    });
    activityProof.events.push({ name: 'same-version-history-preserved-390', ...deferred, readingBefore, readingAfter, deferredPosition, prompt });
    assert.equal(await history.evaluate(element => element.open), true);
    assert.equal(readingAfter.target.fullyVisible, true, 'incoming replies must preserve the visible history being read');
    assert.ok(Math.abs(readingAfter.target.rect.top - readingBefore.target.rect.top) <= 2,
      'new replies may adjust browser scroll anchoring but must not move the historical reading position');
    assert.equal(deferredPosition.body.fullyVisible, false, 'reading history must not jump to the new reply before the user chooses it');
    assert.equal(prompt.fullyVisible, true); assert.equal(prompt.acceptsClick, true);
    await page.screenshot({ path: path.join(output, 'same-version-history-preserved-390.png') });
    await activityButton.click();
    await activityButton.waitFor({ state: 'detached' });
    await settlePaint();
    const returned = await conversationPosition(deferred.selector);
    activityProof.events.push({ name: 'same-version-return-to-latest-390', ...returned });
    assert.equal(returned.latestMessageId, `message-${deferred.threadId}`);
    assert.equal(returned.body.fullyVisible, true, 'return to latest must reveal the newest reply instead of skipping to the manuscript');
    assert.equal(await page.locator('.team-featured-output').getAttribute('data-version-id'), two.id);
    await page.screenshot({ path: path.join(output, 'same-version-return-to-latest-390.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await page.locator(`.team-featured-output[data-content-id="${item.id}"]`).waitFor();
    result.focusedRecordAccess = { primary: 'paused', secondary: ['blocked', 'awaiting'], workId,
      secondaryWorkOpenedProcess: true, secondaryReviewOpenedManuscript: true, hiddenDuplicateManuscript: true,
      historicalContentId: historicalItem.id, historicalVersionId: historicalVersion.id, historicalCardOpenedVersion: true,
      currentRecoveredThroughSearch: true, conversationDraftPreserved: true };
  });
  await check('real ordered PNGs, fixed manuscript, version routing and disabled browser approval', async () => {
    await openFeaturedContent();
    await page.locator(`[data-content-workbench="${item.id}"]`).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.business-image-button img').length === 2 && [...document.querySelectorAll('.business-image-button img')].every(image => image.complete && image.naturalWidth === 1080));
    assert.equal(await composer.inputValue(), draftText);
    assert.equal(await page.locator('.business-image-strip figcaption').filter({ hasText: '模板制作' }).count(), 2);
    await assertApprovalUnavailable('browser-only rehearsal cannot approve a publication');
    await openInspection();
    await page.getByRole('tab', { name: '版本改动', exact: true }).click();
    await page.getByText('演练版本改动：加入适用边界，避免泛化承诺。', { exact: true }).waitFor();
    await page.locator('button[aria-label="刷新整稿状态"]:enabled').waitFor();
    await page.getByLabel('查看稿件版本', { exact: true }).selectOption(two.id);
    await settlePaint();
    assert.equal(await page.getByRole('button', { name: '刷新整稿状态', exact: true }).isDisabled(), false,
      'selecting the current version must not clear its preview or leave it loading forever');
    assert.equal(await page.locator('.business-image-button img').count(), 2);
    assert.equal(await page.locator('.content-authorization-summary').getByText('正在核对本版发布条件', { exact: true }).count(), 0);
    await page.getByLabel('查看稿件版本', { exact: true }).selectOption(one.id);
    await page.getByRole('button', { name: '查看最新整稿', exact: true }).waitFor();
    assert.ok(page.url().includes(`version=${one.id}`));
    await assertApprovalUnavailable('an older version cannot expose a publish action');
    await page.getByRole('button', { name: '查看最新整稿', exact: true }).click();
    await page.getByRole('tab', { name: '检查与审稿', exact: true }).click();
    await page.locator('[data-evidence="agent"]').getByText('独立审稿通过', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '协作与材料', exact: true }).click();
    const originalContribution = page.locator('.business-collaboration-list > li').filter({
      has: page.getByText('演练成员贡献：通过真实结构化行动字段展示。', { exact: true }) });
    await originalContribution.waitFor();
    assert.equal(await originalContribution.count(), 1);
    await originalContribution.getByText('演练负责人', { exact: true }).waitFor();
    await originalContribution.getByText('行动已登记，成果另行验收', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '检查与审稿', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'workbench-1440.png') });
    assert.equal(await page.locator('#root').evaluate(element => element.inert), false);
    await page.getByRole('button', { name: '放大第 1 张图片', exact: true }).click();
    await page.getByRole('dialog', { name: '查看第 1 张配图', exact: true }).waitFor();
    await settlePaint();
    await page.screenshot({ path: path.join(output, 'lightbox-1440.png') });
    const overlay = await page.evaluate(() => {
      const dialog = document.querySelector('.business-lightbox[role="dialog"]');
      const dock = document.querySelector('#workbench-navigation');
      const dockRect = dock?.getBoundingClientRect();
      const point = dockRect ? { x: dockRect.x + dockRect.width / 2, y: dockRect.y + dockRect.height / 2 } : null;
      const top = point && document.elementFromPoint(point.x, point.y);
      return { rootInert: document.querySelector('#root')?.inert, parentIsBody: dialog?.parentElement === document.body,
        dockRect: dockRect?.toJSON(), point, topElement: top ? { tag: top.tagName, className: top.className, role: top.getAttribute('role') } : null,
        dockCoveredByDialog: Boolean(top && dialog?.contains(top)), focusInsideDialog: Boolean(dialog?.contains(document.activeElement)), focusSamples: [] };
    });
    result.lightbox = overlay;
    assert.equal(overlay.rootInert, true, 'the application behind an image preview must be inert');
    assert.equal(overlay.parentIsBody, true, 'the image preview must escape the workbench stacking context');
    assert.equal(overlay.dockCoveredByDialog, true, 'the image preview must cover the desktop navigation dock');
    assert.equal(overlay.focusInsideDialog, true, 'opening the image preview must move focus into the dialog');
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      const sample = await page.evaluate(() => ({ insideDialog: Boolean(document.activeElement?.closest('.business-lightbox[role="dialog"]')),
        label: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim() }));
      overlay.focusSamples.push({ key, ...sample });
      assert.equal(sample.insideDialog, true, 'keyboard focus must stay inside the image preview');
    }
    await page.keyboard.press('ArrowRight');
    await page.getByRole('dialog', { name: '查看第 2 张配图', exact: true }).waitFor();
    assert.equal(await page.locator('#root').evaluate(element => element.inert), true);
    await page.keyboard.press('Escape');
    await page.locator('.business-lightbox').waitFor({ state: 'detached' });
    overlay.rootInertAfterClose = await page.locator('#root').evaluate(element => element.inert);
    overlay.focusReturnedToOpener = await page.getByRole('button', { name: '放大第 1 张图片', exact: true })
      .evaluate(element => element === document.activeElement);
    assert.equal(overlay.rootInertAfterClose, false, 'closing the preview must restore application interaction');
    assert.equal(overlay.focusReturnedToOpener, true, 'closing the preview must return focus to its opener');
  });
  await check('account setup preserves the second project and the exact manuscript through reload and return', async () => {
    const beforeProjects = structuredClone(service.projects.list());
    const beforeSettings = structuredClone(service.settings());
    readOnlyNavigation = true;
    const racingDraftText = `${draftText} 返回等待期间的独立草稿。`;
    const interceptedDraft = Promise.withResolvers(), releaseDraft = Promise.withResolvers();
    let heldDraft = false, heldAt = 0;
    const holdDraft = async route => {
      const request = route.request();
      if (request.method() === 'PUT' && !heldDraft && request.postDataJSON()?.scope?.kind === 'project-message' &&
          request.postDataJSON()?.scope?.projectId === project.id && request.postDataJSON()?.values?.body === racingDraftText) {
        heldDraft = true; heldAt = Date.now(); interceptedDraft.resolve();
        await releaseDraft.promise;
      }
      await route.fallback();
    };
    await page.route('**/api/ui-drafts', holdDraft);
    try {
      await Promise.all([
        page.waitForRequest(request => request.url().endsWith('/api/ui-drafts') && request.method() === 'PUT' &&
          request.postDataJSON()?.scope?.projectId === project.id && request.postDataJSON()?.values?.body === racingDraftText),
        composer.fill(racingDraftText),
      ]);
      await interceptedDraft.promise;
      await page.getByRole('button', { name: '接入发布账号', exact: true }).click();
      await page.locator('[data-business-settings-section="team"]').getByRole('button', { name: '配置成员能力', exact: true }).click();
      await page.locator('.members-view').waitFor();
      await page.getByRole('button', { name: '返回原稿件', exact: true }).click();
      await page.getByRole('button', { name: '正在保存草稿…', exact: true }).waitFor();
      await page.locator('.members-view').getByRole('button', { name: '添加代理成员', exact: true }).click();
      const memberDialog = page.getByRole('dialog', { name: '添加代理成员', exact: true });
      const memberName = '流程演练：返回等待期间的未保存成员';
      await memberDialog.getByPlaceholder('例如: 代码构建员', { exact: true }).fill(memberName);
      const savedResponse = page.waitForResponse(response => response.url().endsWith('/api/ui-drafts') &&
        response.request().method() === 'PUT' && response.request().postDataJSON()?.values?.body === racingDraftText);
      const heldDurationMs = Date.now() - heldAt;
      releaseDraft.resolve();
      assert.ok((await savedResponse).ok(), 'the delayed draft must finish saving successfully');
      await page.locator('.members-view .workflow-return button:enabled').waitFor();
      await settlePaint();
      assert.ok(page.url().includes('#/members'), 'a completed return request must not navigate away from a newer member editor');
      assert.equal(await memberDialog.isVisible(), true, 'a completed return request must not close the newer member editor');
      assert.equal(await memberDialog.getByPlaceholder('例如: 代码构建员', { exact: true }).inputValue(), memberName);
      await page.screenshot({ path: path.join(output, 'return-preserves-member-editor-1440.png') });
      await memberDialog.getByRole('button', { name: '关闭成员配置', exact: true }).click();
      await page.getByRole('alertdialog', { name: '放弃未保存的成员配置？', exact: true }).getByRole('button', { name: '放弃修改', exact: true }).click();
      await memberDialog.waitFor({ state: 'detached' });
      const memberReturn = await inspectReturnControl('member-editor-dismissed-1440', '返回原稿件');
      await page.mouse.click(memberReturn.center.x, memberReturn.center.y);
      await page.waitForFunction(expected => document.querySelector('[aria-label="告诉负责人新的要求"]')?.value === expected, racingDraftText);
      assert.equal(service.store.list('members').some(member => member.name === memberName), false, 'this race check must not create a member');
      result.returnWhileSaving = { heldDurationMs, draftSaved: true, remainedOnMembers: true, memberEditorPreserved: true,
        editorExplicitlyDiscarded: true, memberCreated: false, originalManuscriptRestored: true };
      await saveDraft(composer, draftText);
    } finally {
      releaseDraft.resolve();
      await page.unroute('**/api/ui-drafts', holdDraft);
    }
    await page.getByRole('button', { name: '接入发布账号', exact: true }).click();
    await page.locator('.settings-view:not([hidden])').waitFor();
    const params = new URLSearchParams(page.url().split('?').at(-1));
    assert.equal(params.get('project'), project.id);
    const returnParams = new URLSearchParams((params.get('return') || '').split('?').at(-1));
    assert.match(params.get('return') || '', new RegExp(project.id));
    assert.equal(returnParams.get('content'), item.id);
    assert.equal(returnParams.get('version'), two.id);
    assert.equal(await page.getByLabel('接入账号的项目', { exact: true }).inputValue(), project.id,
      'the account settings must not silently switch from project B to project A');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-business-settings-section') === 'account');
    await inspectReturnControl('account-settings-after-auto-position-1440', '返回原稿件');
    await page.reload();
    await page.getByLabel('接入账号的项目', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('接入账号的项目', { exact: true }).inputValue(), project.id);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-business-settings-section') === 'account');
    await inspectReturnControl('account-settings-after-reload-1440', '返回原稿件');
    await page.screenshot({ path: path.join(output, 'account-context-1440.png') });
    const teamEditor = page.locator('[data-business-settings-section="team"]');
    const researcherChoice = teamEditor.getByRole('checkbox', { name: '演练研究员', exact: true });
    await researcherChoice.uncheck();
    await page.locator('select[aria-label="接入账号的项目"]:disabled').waitFor();
    assert.equal(await teamEditor.getByRole('button', { name: '配置成员能力', exact: true }).isDisabled(), true,
      'leaving for member configuration must be unavailable while this project has unsaved team edits');
    // This lifecycle state is seeded only to verify editor retention; no project is actually archived through the UI.
    const projectBeforeArchive = service.store.get('projects', project.id);
    service.store.update('projects', project.id, { status: 'archived' });
    service.emitChange('business.ui_fixture', { projectId: project.id });
    await teamEditor.getByText('这个项目已不能继续配置。你的未保存编辑仍保留供核对，可以明确撤销；当前不能提交。', { exact: true }).waitFor();
    assert.equal(await researcherChoice.isChecked(), false, 'an incoming archive must preserve unsaved team values');
    assert.equal(await researcherChoice.isDisabled(), true);
    assert.equal(await teamEditor.getByRole('button', { name: '保存项目设置', exact: true }).isDisabled(), true);
    service.store.put('projects', projectBeforeArchive);
    service.emitChange('business.ui_fixture', { projectId: project.id });
    await teamEditor.getByText('这个项目已不能继续配置。你的未保存编辑仍保留供核对，可以明确撤销；当前不能提交。', { exact: true }).waitFor({ state: 'detached' });
    await teamEditor.getByRole('button', { name: '撤销未保存修改', exact: true }).click();
    await page.locator('select[aria-label="接入账号的项目"]:enabled').waitFor();
    assert.equal(await researcherChoice.isChecked(), true);
    result.settingsEditor = { projectId: project.id, dirtyNavigationPrevented: true,
      fixtureArchivePreservedDirtyValues: true, fixtureArchiveReverted: true, noTeamWriteSubmitted: true };
    const settingsUrl = page.url(), missingProject = 'ui-missing-project';
    const missingParams = new URLSearchParams(settingsUrl.split('?').at(-1));
    missingParams.set('project', missingProject);
    await page.goto(`${runtime.url}/#/settings?${missingParams.toString()}`);
    await page.getByText('指定的项目不存在。请选择要配置的项目。', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('接入账号的项目', { exact: true }).inputValue(), missingProject,
      'a missing project must not silently fall back to a different existing project');
    assert.equal(await page.locator('[data-business-settings-section="team"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: '绑定当前账号到项目', exact: true }).count(), 0);
    await page.goto(settingsUrl);
    await page.waitForFunction(expected => document.querySelector('[aria-label="接入账号的项目"]')?.value === expected, project.id);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-business-settings-section') === 'account');
    let accountReturn;
    for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      accountReturn = await inspectReturnAfterScroll(`account-settings-at-scroll-end-${size.width}`, '返回原稿件', '.settings-view:not([hidden])');
      assert.ok(accountReturn.scroll.top > 0, 'account settings must exercise actual scrolling');
      await inspectVisuals(`account-return-${size.width}`, ['.settings-view:not([hidden])', '.workflow-return']);
      await page.screenshot({ path: path.join(output, `account-return-${size.width}.png`) });
    }
    await page.mouse.click(accountReturn.center.x, accountReturn.center.y);
    await page.locator(`[data-content-workbench="${item.id}"]`).waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(expected => document.querySelector('[aria-label="查看稿件版本"]')?.value === expected, two.id);
    assert.equal(await composer.inputValue(), draftText);
    await startWork('project');
    await page.getByRole('dialog', { name: '持续运营内容', exact: true }).waitFor();
    await page.locator('.business-create-dialog input:not(:disabled)').first().waitFor();
    await page.getByRole('button', { name: '稍后继续', exact: true }).click();
    await page.getByRole('dialog', { name: '持续运营内容', exact: true }).waitFor({ state: 'detached' });
    await page.locator(`[data-content-workbench="${item.id}"]`).waitFor();
    assert.equal(await page.getByLabel('查看稿件版本', { exact: true }).inputValue(), two.id,
      'deferring a new project from a manuscript must preserve the original manuscript and selected version');
    assert.deepEqual(service.projects.list(), beforeProjects, 'opening settings must not change project account bindings');
    assert.deepEqual(service.settings(), beforeSettings, 'opening account setup must not restore all workspace scheduling');
    assert.deepEqual(result.configurationWrites, []);
    result.settingsRoundTrip = { projectId: project.id, differentProjectId: firstProject.id, contentId: item.id, versionId: two.id,
      reloadPreservedContext: true, missingProjectRejected: true, configurationWrites: 0 };
    readOnlyNavigation = false;
    await page.getByRole('button', { name: '收起稿件面板', exact: true }).click();
    assert.equal(await page.locator('.team-inspector').count(), 0);
    await inspectRestoredFocus('closing the desktop manuscript restores a visible connected control');
    assert.equal(await page.locator('.team-process-details').evaluate(element => element.open), false);
    await inspectVisuals('daily-workbench-1440', ['.team-workbench', '.team-sidebar', '.team-conversation'], { primaryRequired: true });
    await page.screenshot({ path: path.join(output, 'daily-workbench-1440.png') });
    await openFeaturedContent();
    await page.locator(`[data-content-workbench="${item.id}"]`).waitFor();
  });
  await check('project search locates exact messages, handoff details and historical versions', async () => {
    const search = page.getByLabel('搜索当前项目', { exact: true });
    await search.fill('演练交代');
    await page.locator('.team-search-results button').filter({ hasText: '你的交代' }).click();
    await page.locator('.team-message.is-focused').getByText('演练交代：写清楚这些方法的适用边界。', { exact: true }).waitFor();
    await search.fill('演练交接记录');
    await page.locator('.team-search-results button').filter({ hasText: '演练返工' }).click();
    await page.locator('.team-work-phase.is-focused .team-handoff-history').getByText('演练交接记录：缺少场景证据，退回补充。', { exact: true }).waitFor();
    assert.equal(await page.locator('.team-process-details').evaluate(element => element.open), true,
      'searching a work handoff must expand its detailed records');
    await search.fill('演练旧版本关键词');
    await page.locator('.team-search-results button').filter({ hasText: '版本 1' }).click();
    await page.waitForFunction(expected => document.querySelector('[aria-label="查看稿件版本"]')?.value === expected, one.id);
    assert.equal(await page.getByLabel('查看稿件版本', { exact: true }).inputValue(), one.id);
    assert.equal(await composer.inputValue(), draftText);
    await page.getByRole('button', { name: '查看最新整稿', exact: true }).click();
  });
  await check('folded failures remain visible with separate program receipt details', async () => {
    const process = page.locator('.team-process-details');
    if (!await process.evaluate(element => element.open)) await process.locator(':scope > summary').click();
    const phase = page.locator(`[data-project-focus="work-${workId}"]`);
    const toggle = phase.locator('.team-phase-toggle');
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await phase.getByText('演练受阻：尚缺少可核对的真实使用案例。', { exact: true }).waitFor();
    const otherStatuses = page.locator('.team-other-statuses');
    if (!await otherStatuses.evaluate(element => element.open)) await otherStatuses.locator(':scope > summary').click();
    await otherStatuses.getByText('1 项工作需要处理', { exact: true }).waitFor();
    await toggle.click();
    await phase.locator('.team-receipt summary').click();
    await phase.getByText('工作输入与约定版本一致', { exact: true }).waitFor();
    await phase.getByText('成员审查 · 演练审稿员', { exact: true }).waitFor();
    await inspectVisuals('project-1440', ['.team-workbench', '.team-sidebar', '.team-conversation', '.business-content-workbench'], { primaryRequired: true });
    await page.screenshot({ path: path.join(output, 'workbench-1440.png') });
    await inspectReducedMotion();
  });
  await check('responsive layouts keep manuscript accessible without horizontal overflow', async () => {
    const projectOptions = page.locator('.team-project-options');
    for (const size of [{ width: 1024, height: 850 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
      if (size.width === 768) {
        assert.equal(await projectOptions.evaluate(element => element.open), false);
        await projectOptions.locator(':scope > summary').click();
        await projectOptions.getByRole('group', { name: '项目选项', exact: true }).waitFor();
        assert.equal(await projectOptions.evaluate(element => element.open), true);
      }
      await page.setViewportSize(size);
      await settlePaint();
      if (size.width === 768) {
        await page.waitForFunction(() => document.querySelector('.team-project-options')?.open === false);
        assert.equal(await projectOptions.getByRole('group', { name: '项目选项', exact: true }).isVisible(), false,
          'a desktop project menu must close when the manuscript becomes a covering narrow panel');
        result.projectOptionsCoverage = { openedAtWidth: 1024, closedAtWidth: 768, menuHiddenWhileInspectorCovers: true };
      }
      const layout = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
        inspector: document.querySelector('.team-inspector').getBoundingClientRect().width }));
      result.layouts.push({ name: `project-${size.width}`, ...layout });
      assert.ok(layout.document <= layout.width + 1, JSON.stringify(layout));
      await inspectVisuals(`project-${size.width}`, ['.team-workbench', '.business-content-workbench']);
      await page.screenshot({ path: path.join(output, `workbench-${size.width}.png`) });
      if (size.width === 390) {
        const overlay = await page.evaluate(() => {
          const conversation = document.querySelector('.team-conversation');
          const rect = conversation?.getBoundingClientRect();
          const point = rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
          const top = point && document.elementFromPoint(point.x, point.y);
          const focusable = [...document.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [tabindex="0"], summary')]
            .filter(element => !element.closest('[inert],[hidden],[aria-hidden="true"]') && element.getBoundingClientRect().width && element.getBoundingClientRect().height);
          return { conversationInert: conversation?.inert, conversationRect: rect?.toJSON(), point,
            conversationCoveredByInspector: Boolean(top?.closest('.team-inspector')), focusableCount: focusable.length, focusSamples: [] };
        });
        result.mobileInspector = overlay;
        assert.equal(overlay.conversationInert, true, 'the conversation behind the mobile manuscript must be inert');
        assert.equal(overlay.conversationCoveredByInspector, true, 'the mobile manuscript must cover the underlying conversation');
        for (let step = 0; step < Math.min(overlay.focusableCount + 2, 80); step++) {
          await page.keyboard.press('Tab');
          const sample = await page.evaluate(() => ({
            coveredSurface: document.activeElement?.closest('.team-conversation,.team-sidebar,.team-command-strip')?.className || null,
            inertAncestor: Boolean(document.activeElement?.closest('[inert]')),
            label: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim()?.slice(0, 120),
          }));
          overlay.focusSamples.push(sample);
          assert.equal(sample.coveredSurface, null, 'Tab must not enter surfaces hidden behind the mobile manuscript');
          assert.equal(sample.inertAncestor, false, 'Tab must not focus an inert element');
        }
        await page.getByRole('button', { name: '收起稿件面板', exact: true }).click();
        await composer.waitFor();
        overlay.conversationInertAfterClose = await page.locator('.team-conversation').evaluate(element => element.inert);
        assert.equal(overlay.conversationInertAfterClose, false);
        overlay.restoredFocus = await inspectRestoredFocus('closing the mobile manuscript restores visible focus before any follow-up click');
        await composer.click();
        overlay.composerReceivesFocusAfterClose = await composer.evaluate(element => element === document.activeElement);
        assert.equal(overlay.composerReceivesFocusAfterClose, true, 'closing the mobile manuscript must restore conversation interaction');
        assert.equal(await composer.inputValue(), draftText);
        await page.getByLabel('搜索当前项目', { exact: true }).fill('演练交代');
        await page.locator('.team-search-results button').filter({ hasText: '你的交代' }).click();
        await page.locator('.team-message.is-focused').getByText('演练交代：写清楚这些方法的适用边界。', { exact: true }).waitFor();
        assert.equal(await page.locator('.team-inspector').count(), 0);
        await inspectVisuals('conversation-390', ['.team-workbench', '.team-conversation'], { primaryRequired: true });
        await page.screenshot({ path: path.join(output, 'conversation-390.png') });
        await openFeaturedContent();
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('revision request survives reload and reaches the real revision work endpoint', async () => {
    await page.getByRole('button', { name: '退回修改', exact: true }).click();
    await saveDraft(page.getByLabel('希望团队怎样修改', { exact: true }), '演练退回：增加一个接住临时任务的具体例子。');
    await page.reload();
    await page.getByRole('button', { name: '退回修改', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="希望团队怎样修改"]')?.value.includes('演练退回'));
    assert.match(await page.getByLabel('希望团队怎样修改', { exact: true }).inputValue(), /演练退回/);
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/revision-requests') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '退回团队修改', exact: true }).click(),
    ]);
    assert.ok(response.ok(), JSON.stringify(await response.json()));
    await page.getByText('修改要求已交给团队。新版本会重新检查与审稿，再送你确认。', { exact: true }).waitFor();
    assert.ok(service.business.works(project.id).some(work => work.contentId === item.id && (work.objective.includes('具体例子') || work.feedback?.includes('具体例子'))));
  });
  service.store.put('publicationApprovals', { id: 'ui-approval', projectId: project.id, contentId: item.id, versionId: two.id,
    status: 'verifying', revision: 1, approvalDigest: '0'.repeat(64), account: { id: 'rehearsal-account', name: '界面演练账号' }, createdAt: stamp });
  service.store.put('publicationAttempts', { id: 'ui-publication-attempt', approvalId: 'ui-approval', projectId: project.id, contentId: item.id, versionId: two.id,
    status: 'unknown', submissionMayHaveOccurred: true, account: { id: 'rehearsal-account', name: '界面演练账号' },
    payload: normalizePublicationPayload(two), resultWarning: '界面演练：提交结果未知，不执行真实发布', verificationBlocked: '界面演练：连接需要重新核对', createdAt: stamp });
  service.emitChange('business.ui_fixture', { projectId: project.id });
  await check('uncertain publication freezes approval and offers only result reconciliation', async () => {
    await navigateTab('待发布');
    await page.locator('[data-publication-group="unknown"]').getByText(two.title, { exact: true }).waitFor();
    const row = page.locator(`button.publication-queue-row[data-content-id="${item.id}"]`);
    await row.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll('.publication-row-preview img')]
      .every(image => image.complete && image.naturalWidth === 1080));
    for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size); await row.scrollIntoViewIfNeeded();
      await inspectVisuals(`publications-${size.width}`, ['.business-publications-view', '.business-page-header', '.publication-queue-row']);
      await page.screenshot({ path: path.join(output, `publications-${size.width}.png`) });
    }
    // Mobile tab changes use the visible menu toggle and actual navigation controls.
    await navigateTab('项目');
    await page.locator('.team-workbench').waitFor();
    await navigateTab('待发布');
    await row.waitFor(); await row.scrollIntoViewIfNeeded();
    result.publicationNavigation = { viewportWidth: page.viewportSize().width, roundTrip: ['projects', 'publications', 'projects', 'publications'] };
    assert.equal(await page.locator('.header-actions .runs-count-pill').count(), 0);
    assert.equal(await page.locator('.header-actions button[aria-label="恢复调度"],.header-actions button[aria-label="暂停调度"]').count(), 0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'publication-unknown.png') });
    await row.click();
    await page.getByText('这篇稿件可能已经提交，结果待核实。', { exact: true }).waitFor();
    assert.equal(await page.locator('.team-next-step').getAttribute('data-project-state'), 'unknown',
      'an unresolved publication must take priority over paused work and other failures');
    await assertApprovalUnavailable('an uncertain submission cannot expose a publish action');
    assert.equal(await page.getByRole('button', { name: /重新发布|重发|重试发布/ }).count(), 0);
    await page.getByRole('button', { name: '回读核实', exact: true }).waitFor();
  });
  await check('changing publication scope selects the returned version and retains review and approval gates', async () => {
    const scheduledItem = service.store.get('contentItems', result.focusedRecordAccess.historicalContentId);
    const scheduledVersion = service.store.get('contentRevisions', result.focusedRecordAccess.historicalVersionId);
    assert.ok(scheduledItem && scheduledVersion, 'reuse the unapproved historical draft within the existing project content limit');
    await page.goto(`${runtime.url}/#/projects/${project.id}?content=${scheduledItem.id}&version=${scheduledVersion.id}`);
    await page.locator(`[data-content-workbench="${scheduledItem.id}"]`).waitFor();
    await page.getByRole('button', { name: '调整发布时间与范围', exact: true }).click();
    const visibility = page.locator('.business-schedule-form').getByLabel(/^可见范围/);
    await visibility.waitFor();
    result.scheduleVisibilityLabel = await visibility.evaluate(select => [...select.labels].map(label => label.textContent));
    await visibility.selectOption('private');
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith(`/api/content/${scheduledItem.id}/schedule`) && response.request().method() === 'PUT'),
      page.getByRole('button', { name: '保存为新的发布版本', exact: true }).click(),
    ]);
    assert.ok(response.ok(), JSON.stringify(await response.json()));
    const next = await response.json();
    assert.notEqual(next.id, scheduledVersion.id);
    assert.equal(next.visibility, 'private');
    await page.waitForFunction(expected => document.querySelector('[aria-label="查看稿件版本"]')?.value === expected, next.id);
    assert.equal(new URLSearchParams(page.url().split('?').at(-1)).get('version'), next.id);
    await assertApprovalUnavailable('scope updates still require checks, review and native approval');
    assert.equal(service.store.list('publicationApprovals').some(approval => approval.contentId === scheduledItem.id), false);
    result.scheduleRoundTrip = { contentId: scheduledItem.id, previousVersion: scheduledVersion.id, currentVersion: next.id,
      selectedReturnedVersion: true, createdApproval: false, reusedHistoricalDraft: true };
    await page.screenshot({ path: path.join(output, 'schedule-new-version-1440.png') });
  });
  await check('existing room and task deep links still open', async () => {
    const task = service.createTask({ title: '演练旧任务访问验证', objective: '只验证旧任务深链接', assigneeId: owner.id, reviewerId: reviewer.id,
      requirements: [], verification: null, start: false });
    const settingsBefore = structuredClone(service.settings()), membersBefore = structuredClone(service.store.list('members'));
    readOnlyNavigation = true;
    await page.goto(`${runtime.url}/#/rooms/team`);
    await page.locator('.room-workbench:not([hidden])').waitFor();
    await inspectVisuals('room-1440', ['.room-workbench:not([hidden])']);
    await page.screenshot({ path: path.join(output, 'room-1440.png') });
    await page.goto(`${runtime.url}/#/tasks/${task.id}`);
    await page.locator('[data-task-detail]').waitFor();
    await page.locator('[data-task-detail]').getByText('演练旧任务访问验证', { exact: true }).first().waitFor();
    for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await inspectVisuals(`legacy-task-${size.width}`, ['.tasks-view', '[data-task-detail]']);
      await page.screenshot({ path: path.join(output, `legacy-task-${size.width}.png`) });
    }
    await page.goto(`${runtime.url}/#/members`);
    await page.locator('.members-view').waitFor();
    await page.locator('.members-view').getByText('演练负责人', { exact: true }).first().waitFor();
    for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await inspectVisuals(`members-${size.width}`, ['.members-view', '.member-card']);
      await page.screenshot({ path: path.join(output, `members-${size.width}.png`) });
    }
    await page.goto(`${runtime.url}/#/settings`);
    await page.locator('.settings-view:not([hidden])').waitFor();
    await page.getByRole('heading', { name: '工作区与系统设置', exact: true }).waitFor();
    for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await inspectVisuals(`settings-${size.width}`, ['.settings-view:not([hidden])', '.settings-container']);
      await page.screenshot({ path: path.join(output, `settings-${size.width}.png`) });
    }
    assert.deepEqual(service.settings(), settingsBefore, 'read-only navigation must not change workspace settings');
    assert.deepEqual(service.store.list('members'), membersBefore, 'read-only navigation must not change member settings');
    assert.deepEqual(result.configurationWrites, []);
    result.readOnlyNavigation = { settingsSha256: sha256(JSON.stringify(service.settings())), membersSha256: sha256(JSON.stringify(service.store.list('members'))),
      unexpectedConfigurationWrites: result.configurationWrites.length };
    readOnlyNavigation = false;
  });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(result.externalRequests, []);
  assert.equal(executorCalls, 0);
  assert.equal(service.store.list('runs').length, 0);
  assert.equal(service.settings().paused, true);
  assert.deepEqual(service.store.list('publicationApprovals').map(entry => entry.id), ['ui-approval']);
  assert.deepEqual(service.store.list('publicationAttempts').map(entry => entry.id), ['ui-publication-attempt']);
  assert.equal(result.checks.length, 17, 'all sixteen existing interactions and the focused-default check must finish');
  result.buildUnchanged = result.build.every(entry => sha256(fs.readFileSync(path.join(projectRoot, entry.path))) === entry.sha256);
  assert.equal(result.buildUnchanged, true, 'the compiled UI changed during verification');
  result.isolation = { workspaceRoot: service.root, executorCalls, runCount: service.store.list('runs').length,
    paused: service.settings().paused, approvalIds: ['ui-approval'], attemptIds: ['ui-publication-attempt'] };
  result.ok = true;
} catch (error) {
  result.ok = false; result.error = error.stack; console.error(error.stack);
  result.lastUrl = page?.url();
  result.notices = await page?.locator('.business-notice').allTextContents().catch(() => []);
  result.formDiagnostics = await page?.locator('.business-create-dialog').evaluateAll(dialogs => dialogs.map(dialog => ({
    labels: [...dialog.querySelectorAll('label')].map(label => label.outerHTML),
    inputs: [...dialog.querySelectorAll('input,textarea,select')].map(input => ({ tag: input.tagName, value: input.value,
      ariaLabel: input.getAttribute('aria-label'), ariaLabelledby: input.getAttribute('aria-labelledby'),
      disabled: input.disabled, labels: [...(input.labels || [])].map(label => label.textContent) })),
  }))).catch(() => []);
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await context?.close().catch(error => { result.browserCloseError = error.message; result.ok = false; process.exitCode = 1; });
  await runtime?.close().catch(error => { result.closeError = error.message; result.ok = false; process.exitCode = 1; });
  result.pageErrors = pageErrors; result.consoleErrors = consoleErrors;
  result.workspaceLockReleased = !fs.existsSync(path.join(workspace, '.team', 'service.lock'));
  if (!result.workspaceLockReleased) { result.ok = false; process.exitCode = 1; }
  result.completedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'ui-proof.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, output, checks: result.checks.length }));
}
