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
const outputBase = path.join(projectRoot, 'work', 'scifi-ui-proof');
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
try {
  assert.ok(fs.existsSync(path.join(projectRoot, 'dist', 'index.html')), 'Run npm run build before smoke:business-ui.');
  const index = fs.readFileSync(path.join(projectRoot, 'dist', 'index.html'), 'utf8');
  const assets = [...index.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => `dist${match[1]}`);
  result.build = ['dist/index.html', ...assets].map(filename => ({ path: filename, sha256: sha256(fs.readFileSync(path.join(projectRoot, filename))) }));
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
  const reviewer = service.saveMember({ name: '演练审稿员', handle: 'rehearsal-reviewer', provider: 'custom', role: 'reviewer', executable: process.execPath, enabled: true, permission: 'plan' });
  const researcher = service.saveMember({ name: '演练研究员', handle: 'rehearsal-researcher', provider: 'custom', role: 'researcher', executable: process.execPath, enabled: true, permission: 'edit' });
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
      /^\/api\/(?:settings|members|discover|business\/connection)/.test(pathname)) {
      result.configurationWrites.push({ path: pathname, method: request.method() });
    }
  });
  await page.goto(runtime.url);
  await check('real project creation into the new single-page workbench', async () => {
    await page.getByRole('button', { name: '建立第一个项目', exact: true }).click();
    await page.getByLabel('项目名称', { exact: true }).fill('界面演练 · 工作方法');
    await page.getByLabel('希望团队持续做什么', { exact: true }).fill('演练数据：为刚开始管理个人工作的人制作实用方法图文，保留来源与实际使用限制。');
    await page.getByLabel('已有资料与内容要求', { exact: false }).fill('界面演练数据，不进行真实成员运行或发布。使用具体、自然的中文，标明模板制作。');
    await page.screenshot({ path: path.join(output, 'create-project.png') });
    await page.getByRole('button', { name: '建立项目并开始', exact: true }).click();
    await page.locator('.team-conversation').waitFor();
    assert.equal(service.projects.list().length, 1);
  });
  const project = service.projects.list()[0];
  const composer = page.getByLabel('告诉负责人新的要求', { exact: true });
  const draftText = '演练草稿：请补充怎样接住临时任务的具体例子。';
  await check('messages default to the owner and create an actual user conversation thread', async () => {
    assert.equal(await page.getByLabel('消息收件人', { exact: true }).inputValue(), '');
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
    await page.locator('.team-context-row').getByRole('button', { name: '资料', exact: true }).click();
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
  service.store.update('reviews', review.id, { status: 'current' });
  service.store.update('contentEligibilities', item.id, { status: 'eligible', reason: '', reviewId: review.id, reviewIds: [review.id] });
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
  await check('real ordered PNGs, fixed manuscript, version routing and disabled browser approval', async () => {
    await page.locator('.team-history-row').filter({ hasText: two.title }).click();
    await page.locator(`[data-content-workbench="${item.id}"]`).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.business-image-button img').length === 2 && [...document.querySelectorAll('.business-image-button img')].every(image => image.complete && image.naturalWidth === 1080));
    assert.equal(await composer.inputValue(), draftText);
    assert.equal(await page.locator('.business-image-strip figcaption').filter({ hasText: '模板制作' }).count(), 2);
    assert.equal(await page.getByRole('button', { name: '批准本版发布', exact: true }).isDisabled(), true);
    await page.getByRole('tab', { name: '版本改动', exact: true }).click();
    await page.getByText('演练版本改动：加入适用边界，避免泛化承诺。', { exact: true }).waitFor();
    await page.getByLabel('查看稿件版本', { exact: true }).selectOption(one.id);
    await page.getByRole('button', { name: '查看最新整稿', exact: true }).waitFor();
    assert.ok(page.url().includes(`version=${one.id}`));
    assert.equal(await page.getByRole('button', { name: '批准本版发布', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '查看最新整稿', exact: true }).click();
    await page.getByRole('tab', { name: '检查与审稿', exact: true }).click();
    await page.getByText('独立审稿通过', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '协作与材料', exact: true }).click();
    await page.locator('.business-collaboration-list').getByText('演练成员贡献：通过真实结构化行动字段展示。', { exact: true }).waitFor();
    await page.locator('.business-collaboration-list').getByText('演练负责人', { exact: true }).waitFor();
    await page.locator('.business-collaboration-list').getByText('行动已登记，成果另行验收', { exact: true }).waitFor();
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
  await check('project search locates exact messages, handoff details and historical versions', async () => {
    const search = page.getByLabel('搜索当前项目', { exact: true });
    await search.fill('演练交代');
    await page.locator('.team-search-results button').filter({ hasText: '你的交代' }).click();
    await page.locator('.team-message.is-focused').getByText('演练交代：写清楚这些方法的适用边界。', { exact: true }).waitFor();
    await search.fill('演练交接记录');
    await page.locator('.team-search-results button').filter({ hasText: '演练返工' }).click();
    await page.locator('.team-work-phase.is-focused .team-handoff-history').getByText('演练交接记录：缺少场景证据，退回补充。', { exact: true }).waitFor();
    await search.fill('演练旧版本关键词');
    await page.locator('.team-search-results button').filter({ hasText: '版本 1' }).click();
    await page.waitForFunction(expected => document.querySelector('[aria-label="查看稿件版本"]')?.value === expected, one.id);
    assert.equal(await page.getByLabel('查看稿件版本', { exact: true }).inputValue(), one.id);
    assert.equal(await composer.inputValue(), draftText);
    await page.getByRole('button', { name: '查看最新整稿', exact: true }).click();
  });
  await check('folded failures remain visible with separate program receipt details', async () => {
    const phase = page.locator(`[data-project-focus="work-${workId}"]`);
    const toggle = phase.locator('.team-phase-toggle');
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await phase.getByText('演练受阻：尚缺少可核对的真实使用案例。', { exact: true }).waitFor();
    await page.locator('.team-attention').getByText('演练返工：补充适用边界', { exact: true }).waitFor();
    await toggle.click();
    await phase.locator('.team-receipt summary').click();
    await phase.getByText('工作输入与约定版本一致', { exact: true }).waitFor();
    await phase.getByText('成员审查 · 演练审稿员', { exact: true }).waitFor();
    await inspectVisuals('project-1440', ['.team-workbench', '.team-sidebar', '.team-conversation', '.business-content-workbench'], { primaryRequired: true });
    await page.screenshot({ path: path.join(output, 'workbench-1440.png') });
    await inspectReducedMotion();
  });
  await check('responsive layouts keep manuscript accessible without horizontal overflow', async () => {
    for (const size of [{ width: 1024, height: 850 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await settlePaint();
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
        await page.getByRole('button', { name: '查看整稿', exact: true }).click();
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
    await page.setViewportSize({ width: 1440, height: 1000 });
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'publication-unknown.png') });
    await row.click();
    await page.getByText('这篇稿件可能已经提交，结果待核实。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '批准本版发布', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: /重新发布|重发|重试发布/ }).count(), 0);
    await page.getByRole('button', { name: '回读核实', exact: true }).waitFor();
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
  assert.equal(result.checks.length, 10, 'the original ten interaction scenarios must all finish');
  result.buildUnchanged = result.build.every(entry => sha256(fs.readFileSync(path.join(projectRoot, entry.path))) === entry.sha256);
  assert.equal(result.buildUnchanged, true, 'the compiled UI changed during verification');
  result.isolation = { workspaceRoot: service.root, executorCalls, runCount: service.store.list('runs').length,
    paused: service.settings().paused, approvalIds: ['ui-approval'], attemptIds: ['ui-publication-attempt'] };
  result.ok = true;
} catch (error) {
  result.ok = false; result.error = error.stack; console.error(error.stack);
  result.lastUrl = page?.url();
  result.notices = await page?.locator('.business-notice').allTextContents().catch(() => []);
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
