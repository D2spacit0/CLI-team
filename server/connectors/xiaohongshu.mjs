import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StandardBrowserRuntime } from './browser-runtime.mjs';

export const XIAOHONGSHU_CONNECTOR_VERSION = 'xiaohongshu-web-1';
const HOME = 'https://creator.xiaohongshu.com/';
const COMPOSE = 'https://creator.xiaohongshu.com/publish/publish?source=official';
const NOTE = /^https:\/\/www\.xiaohongshu\.com\/(?:explore|discovery\/item)\/([a-f0-9]{24})(?:[?#].*)?$/i;
const identity = z.string().regex(/^[a-zA-Z0-9_-]{6,128}$/);
const noteIdentity = z.string().regex(/^[a-f0-9]{24}$/i);
const imageIdentity = z.string().min(1).max(512);
const noteReadbackSchema = z.object({ noteId: noteIdentity, accountId: identity, title: z.string().max(200), body: z.string().max(5000),
  tags: z.array(z.string().max(100)).max(30), imageIds: z.array(imageIdentity).max(18), metrics: z.record(z.unknown()).optional() });
const text = value => typeof value === 'string' ? value.normalize('NFC').replace(/\r\n?/g, '\n').trim() : '';
const fail = (message, code = 'connector_unavailable') => { throw Object.assign(new Error(message), { code }); };
const knownHost = host => host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com') ||
  host === 'xhscdn.com' || host.endsWith('.xhscdn.com') || host === 'xhscdn.net' || host.endsWith('.xhscdn.net') ||
  host === 'xiaohongshu.net' || host.endsWith('.xiaohongshu.net');

export function parseNoteUrl(url) {
  const match = typeof url === 'string' && url.length <= 2048 && url.match(NOTE);
  if (!match) fail('请提供完整的小红书笔记详情链接。', 'invalid_note_url');
  return { noteId: match[1].toLowerCase(), url };
}

export function normalizePublicationPayload(revision) {
  return { title: text(revision.title), body: text(revision.body), tags: (revision.tags || []).map(text),
    images: (revision.images || []).map((image, index) => ({ index, sha256: image.sha256 || image.hash,
      path: image.path, width: image.width, height: image.height, mime: image.mime })),
    visibility: revision.visibility || 'public' };
}

/** A candidate or a successful call is not a verified publication. */
export function verifyPublicationEvidence(attempt, evidence) {
  const findings = [];
  const expected = attempt.payload;
  const creation = evidence?.creation;
  const readback = evidence?.readback;
  const mappings = evidence?.uploads;
  if (!creation || !noteIdentity.safeParse(creation.noteId).success || creation.accountId !== attempt.account.id) findings.push('缺少绑定本次创建响应的笔记身份与账号');
  if (!Array.isArray(mappings) || mappings.length !== expected.images.length ||
      !expected.images.every((image, index) => mappings[index]?.sha256 === image.sha256 &&
        imageIdentity.safeParse(mappings[index]?.platformImageId).success && mappings[index]?.index === index)) findings.push('上传图片哈希到平台图片标识的映射不完整');
  if (!readback || readback.noteId !== creation?.noteId || readback.accountId !== attempt.account.id) findings.push('回读身份与本次发布不一致');
  if (readback && (text(readback.title) !== expected.title || text(readback.body) !== expected.body ||
      JSON.stringify((readback.tags || []).map(text)) !== JSON.stringify(expected.tags))) findings.push('回读文案或话题与批准稿件不一致');
  if (!readback || !Array.isArray(readback.imageIds) || !Array.isArray(mappings) ||
      JSON.stringify(readback.imageIds) !== JSON.stringify(mappings.map(item => item.platformImageId))) findings.push('回读图片标识与顺序无法核对');
  if (!readback?.source || !readback?.collectedAt) findings.push('缺少平台回读出处与采集时间');
  return { matched: findings.length === 0, findings, noteId: creation?.noteId || null,
    accountId: attempt.account.id, checkedAt: new Date().toISOString() };
}

export function metricsFromReadback(noteId, source, values = {}, collectedAt = new Date().toISOString()) {
  return ['likes', 'collects', 'comments', 'impressions', 'clicks', 'clickThroughRate'].map(name => ({
    noteId, name, value: typeof values[name] === 'number' && Number.isFinite(values[name]) && values[name] >= 0 ? values[name] : null,
    status: typeof values[name] === 'number' && Number.isFinite(values[name]) && values[name] >= 0 ? 'available' : 'unavailable',
    reason: typeof values[name] === 'number' ? null : ['impressions', 'clicks', 'clickThroughRate'].includes(name) ? '当前公开详情不提供该后台指标' : '平台未提供可核对数值',
    source, collectedAt, visibility: ['impressions', 'clicks', 'clickThroughRate'].includes(name) ? 'creator_analytics' : 'public_interactions',
  }));
}

/** Fixed, versioned website interactions. No caller URL, selector, script, cookie or headers are accepted. */
export class XiaohongshuConnector {
  constructor({ root, runtime } = {}) {
    this.runtime = runtime || new StandardBrowserRuntime({ root });
    this.version = XIAOHONGSHU_CONNECTOR_VERSION;
    this.state = { version: this.version, status: 'unavailable', account: null,
      reason: '尚未检测发布账号', capabilities: { read: false, template: true, publish: false, creationEvidence: 'unverified', metrics: 'unverified' } };
    this.tail = Promise.resolve();
    this.page = null;
  }
  status() { return structuredClone({ ...this.state, browserOpen: Boolean(this.runtime.visible && this.runtime.context), browser: this.runtime.evidence }); }
  serial(callback) { const operation = this.tail.then(callback); this.tail = operation.catch(() => {}); return operation; }

  async pageFor({ visible = false } = {}) {
    const context = await this.runtime.start({ visible });
    if (this.page && !this.page.isClosed() && this.page.context() === context) return this.page;
    await context.route('**/*', route => {
      let allowed = false;
      try { const url = new URL(route.request().url()); allowed = url.protocol === 'https:' && knownHost(url.hostname); } catch {}
      return allowed ? route.continue() : route.abort('blockedbyclient');
    });
    const restrictPage = page => {
      page.on('framenavigated', frame => {
        if (frame !== page.mainFrame() || frame.url() === 'about:blank') return;
        try { const url = new URL(frame.url()); if (url.protocol === 'https:' && knownHost(url.hostname)) return; } catch {}
        void page.close().catch(() => {});
        this.state = { ...this.state, status: 'unavailable', reason: '页面离开受控平台范围，操作已停止' };
      });
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    };
    context.on('page', restrictPage);
    for (const existing of context.pages()) restrictPage(existing);
    this.page = context.pages().find(page => !page.isClosed()) || await context.newPage();
    this.page.setDefaultTimeout(10000);
    this.page.setDefaultNavigationTimeout(25000);
    return this.page;
  }

  openLogin() {
    return this.serial(async () => {
      try {
        const page = await this.pageFor({ visible: true });
        await page.goto(HOME, { waitUntil: 'domcontentloaded' });
        this.state = { ...this.state, status: 'login_required', reason: '请在已打开的标准浏览器完成登录，再回工作台检测连接' };
        return this.status();
      } catch (error) { this.state = { ...this.state, status: 'unavailable', reason: error.message }; return this.status(); }
    });
  }

  probe() { return this.serial(() => this.probeUnlocked()); }
  async probeUnlocked() {
    try {
      const page = await this.pageFor();
      await page.goto(HOME, { waitUntil: 'domcontentloaded' });
      // Only the current account's explicit profile link or first-party state is accepted.
      const candidate = await page.evaluate(() => {
        const state = window.__INITIAL_STATE__;
        const user = state?.user?.userInfo || state?.userInfo || state?.user?.value?.userInfo;
        const link = document.querySelector('a[href*="/user/profile/"]');
        const id = user?.userId || user?.user_id || link?.getAttribute('href')?.match(/\/user\/profile\/([a-zA-Z0-9_-]+)/)?.[1];
        return { id: typeof id === 'string' ? id : '', name: typeof user?.nickname === 'string' ? user.nickname : link?.textContent?.trim() || '' };
      });
      if (!identity.safeParse(candidate.id).success) {
        this.state = { ...this.state, status: 'login_required', account: null, reason: '未读取到当前登录账号的可核对身份，请登录或处理平台验证',
          capabilities: { ...this.state.capabilities, read: false, publish: false } };
        return this.status();
      }
      const account = { id: candidate.id, name: candidate.name.slice(0, 100) || candidate.id, platform: 'xiaohongshu', connectorVersion: this.version };
      await page.goto(COMPOSE, { waitUntil: 'domcontentloaded' });
      const form = await page.locator('input[type="file"]').count() > 0 || await page.getByText('上传图文', { exact: true }).count() > 0;
      this.state = { ...this.state, status: form ? 'ready' : 'unavailable', account, checkedAt: new Date().toISOString(),
        reason: form ? '已核对账号；本版本的真实上传、创建与回读尚待发布验证' : '发布页结构与受控适配器不匹配',
        capabilities: { ...this.state.capabilities, read: true, publish: form } };
      return this.status();
    } catch (error) {
      this.state = { ...this.state, status: 'unavailable', reason: error.message, capabilities: { ...this.state.capabilities, publish: false } };
      return this.status();
    }
  }

  publish(attempt) {
    return this.serial(async () => {
      const connection = await this.probeUnlocked();
      if (connection.status !== 'ready' || connection.account?.id !== attempt.account.id) fail('发送阶段账号不可用或已改变；只能继续核实结果。', 'login_required');
      const page = await this.pageFor();
      const payload = attempt.payload;
      if (payload.visibility !== 'public') fail('当前连接器尚未验证非公开发布设置。', 'unsupported_visibility');
      const evidence = { uploads: [], creation: null, readback: null };
      const responseTasks = [];
      const receive = response => {
        const url = new URL(response.url());
        if (!knownHost(url.hostname) || response.request().method() !== 'POST') return;
        if (!/\/(?:note|image|upload)(?:\/|\?|$)/.test(url.pathname)) return;
        responseTasks.push((async () => {
          // Persist only explicit identifiers; never request headers, auth data, or full responses.
          const size = Number(response.headers()['content-length'] || 0);
          if (size > 262144) return;
          const bytes = await response.body().catch(() => null);
          if (!bytes || bytes.length > 262144) return;
          let raw;
          try { raw = JSON.parse(bytes.toString('utf8')); } catch { return; }
          const data = raw?.data;
          const noteId = data?.note_id || data?.noteId;
          const accountId = data?.user_id || data?.userId;
          if (noteIdentity.safeParse(noteId).success && accountId === attempt.account.id && /note/.test(url.pathname)) {
            evidence.creation = { noteId, accountId, source: `${url.origin}${url.pathname}`, collectedAt: new Date().toISOString() };
          }
          // A mapping must identify the uploaded local hash, never infer it from image similarity/order alone.
          const assetHash = data?.sha256;
          const platformImageId = data?.file_id || data?.image_id;
          const index = payload.images.findIndex(image => image.sha256 === assetHash);
          if (index >= 0 && imageIdentity.safeParse(platformImageId).success) evidence.uploads[index] = { index, sha256: assetHash, platformImageId };
        })());
      };
      page.on('response', receive);
      try {
        const tab = page.getByText('上传图文', { exact: true });
        if (await tab.count()) await tab.first().click();
        const upload = page.locator('input[type="file"]').first();
        for (const image of payload.images) {
          if (createHash('sha256').update(fs.readFileSync(image.path)).digest('hex') !== image.sha256) fail('发送前图片已改变。', 'asset_changed');
        }
        await upload.setInputFiles(payload.images.map(image => image.path));
        await page.locator('div.d-input input').fill(payload.title);
        const editor = page.locator('div[role="textbox"][contenteditable="true"], div.tiptap[contenteditable="true"]').first();
        const body = payload.body + (payload.tags.length ? '\n\n' + payload.tags.map(tag => `#${tag}`).join(' ') : '');
        await editor.fill(body);
        if (await page.locator('div.d-input input').inputValue() !== payload.title || text(await editor.innerText()) !== text(body)) fail('发布表单与批准稿件不一致。', 'payload_mismatch');
        const previews = await page.locator('.img-preview-area .pr').count();
        if (previews !== payload.images.length) fail('发布页图片数量尚未核对。', 'payload_mismatch');
        const button = page.locator('xhs-publish-btn[is-publish="true"], .publish-page-publish-btn button.bg-red').first();
        const creationReply = page.waitForResponse(response => {
          try { const parsed = new URL(response.url()); return knownHost(parsed.hostname) && /\/note(?:\/|$)/.test(parsed.pathname) && response.request().method() === 'POST'; }
          catch { return false; }
        }, { timeout: 30000 }).catch(() => null);
        await button.click();
        await creationReply;
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await Promise.allSettled(responseTasks);
        return { call: { completed: true, summary: '已执行网页发布动作，结果仍需平台身份与整稿核实' }, evidence };
      } finally { page.off('response', receive); }
    });
  }

  verify(attempt, { noteUrl } = {}) {
    return this.serial(async () => {
      const state = await this.probeUnlocked();
      if (state.status === 'login_required' || state.account?.id !== attempt.account.id) return { connection: state, blocked: true, reason: '需要恢复原账号后回读；不会重新提交' };
      const evidence = structuredClone(attempt.evidence || { uploads: [], creation: null });
      const noteId = noteUrl ? parseNoteUrl(noteUrl).noteId : evidence.creation?.noteId;
      if (!noteId) return { connection: state, evidence, reason: '缺少可靠创建响应的笔记ID；作品列表候选不能独自证明发布成功' };
      if (evidence.creation?.noteId && evidence.creation.noteId !== noteId) return { connection: state, evidence, reason: '提供的链接与创建响应的笔记身份不一致' };
      const page = await this.pageFor();
      const url = noteUrl || `https://www.xiaohongshu.com/explore/${noteId}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const note = await page.evaluate(expectedId => {
        const detail = window.__INITIAL_STATE__?.note?.noteDetailMap?.[expectedId];
        const value = detail?.note || detail;
        if (!value || (value.noteId || value.note_id) !== expectedId) return null;
        return { noteId: value.noteId || value.note_id, accountId: value.user?.userId || value.user?.user_id,
          title: value.title, body: value.desc, tags: (value.tagList || []).map(tag => tag.name),
          imageIds: (value.imageList || []).map(image => image.fileId || image.file_id),
          metrics: { likes: value.interactInfo?.likedCount, collects: value.interactInfo?.collectedCount, comments: value.interactInfo?.commentCount } };
      }, noteId);
      const parsedNote = noteReadbackSchema.safeParse(note);
      if (parsedNote.success) evidence.readback = { ...parsedNote.data, source: new URL(url).origin + new URL(url).pathname, collectedAt: new Date().toISOString() };
      const verification = verifyPublicationEvidence(attempt, evidence);
      return { connection: this.status(), evidence, verification,
        metrics: metricsFromReadback(noteId, evidence.readback?.source || new URL(url).origin + new URL(url).pathname, parsedNote.success ? parsedNote.data.metrics : {}) };
    });
  }
  async close() { await this.tail; await this.runtime.close(); }
}
