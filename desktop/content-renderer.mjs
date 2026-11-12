import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const TEMPLATE_VERSION = 'knowledge-cards-1';
export const cardSpecSchema = z.object({
  template: z.enum(['cover', 'list']), title: z.string().trim().min(1).max(72),
  subtitle: z.string().trim().max(240).default(''), eyebrow: z.string().trim().max(28).default('知识笔记'),
  items: z.array(z.string().trim().min(1).max(100)).max(6).default([]),
  footer: z.string().trim().max(70).default(''), accent: z.enum(['blue', 'orange', 'green']).default('blue'),
}).strict().superRefine((spec, ctx) => {
  if (spec.template === 'list' && !spec.items.length) ctx.addIssue({ code: 'custom', message: '信息卡需要至少一个内容条目', path: ['items'] });
});

/** The renderer loads only application-owned files and inert structured text. */
export async function renderContentCard(specification, { BrowserWindow, session } = {}) {
  const spec = cardSpecSchema.parse(specification);
  if (!BrowserWindow || !session) ({ BrowserWindow, session } = await import('electron'));
  const directory = fileURLToPath(new URL('./content-templates/', import.meta.url));
  const fontFile = path.join(directory, 'fonts', 'NotoSansCJKsc-Regular.otf');
  const fontSource = JSON.parse(fs.readFileSync(path.join(directory, 'fonts', 'source.json'), 'utf8'));
  if (createHash('sha256').update(fs.readFileSync(fontFile)).digest('hex') !== fontSource.sha256) throw new Error('内置中文字体校验失败，未制作图片。');
  const allowed = new Set(['card.html', 'card.js', 'card.css', 'fonts/NotoSansCJKsc-Regular.otf']
    .map(name => path.resolve(directory, name).toLowerCase()));
  const isolated = session.fromPartition(`content-render-${randomUUID()}`, { cache: false });
  isolated.setPermissionRequestHandler((_content, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((request, callback) => {
    let permitted = false;
    try { permitted = request.url.startsWith('file:') && allowed.has(fileURLToPath(request.url).toLowerCase()); } catch {}
    callback({ cancel: !permitted });
  });
  const window = new BrowserWindow({ width: 1080, height: 1440, useContentSize: true, show: false, frame: false,
    resizable: false, backgroundColor: '#f5f2eb',
    webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, webviewTag: false, backgroundThrottling: false, zoomFactor: 1, offscreen: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  const bounded = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('可信图文渲染超时。')), 20000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    await bounded(window.loadFile(path.join(directory, 'card.html')));
    window.webContents.debugger.attach('1.3');
    await bounded(window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1080, height: 1440, deviceScaleFactor: 1, mobile: false,
    }));
    const escaped = JSON.stringify(spec).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
    const result = await bounded(window.webContents.executeJavaScript(`window.renderCard(${escaped})`));
    if (!result?.fontLoaded || result.overflow?.length || result.width !== 1080 || result.height !== 1440) {
      throw new Error(result?.overflow?.length ? `文字超过画布容量，请缩短这些内容：${result.overflow.join('、')}` : '中文字体或画布尺寸未通过渲染检查');
    }
    // Capture the entire fixed canvas through Electron's private debugger channel.
    // This avoids cropping on Windows screens shorter than the 1440px artwork; no port is opened.
    const capture = await bounded(window.webContents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, fromSurface: true,
      clip: { x: 0, y: 0, width: 1080, height: 1440, scale: 1 },
    }));
    const buffer = Buffer.from(capture.data, 'base64');
    if (buffer.length < 24 || buffer.readUInt32BE(16) !== 1080 || buffer.readUInt32BE(20) !== 1440) throw new Error('图片捕获失败或尺寸不正确。');
    return { buffer, width: 1080, height: 1440, templateId: spec.template, templateVersion: TEMPLATE_VERSION,
      format: 'png', mime: 'image/png', fontSha256: fontSource.sha256, productionMethod: 'trusted_template',
      checks: { overflow: false, fontLoaded: true, sandbox: true, networkAllowed: false },
      renderCheck: { passed: true, overflow: false, fontLoaded: true, width: 1080, height: 1440, templateVersion: TEMPLATE_VERSION } };
  } finally { window.destroy(); await isolated.clearCache().catch(() => {}); }
}
