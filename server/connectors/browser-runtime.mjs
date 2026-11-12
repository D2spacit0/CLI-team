import fs from 'node:fs';
import path from 'node:path';

const problem = (message, code = 'browser_unavailable') => Object.assign(new Error(message), { code });

export function findStandardBrowser({ platform = process.platform, environment = process.env } = {}) {
  const candidates = platform === 'win32' ? [
    [environment.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe', 'Chrome'],
    [environment['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe', 'Edge'],
    [environment.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe', 'Edge'],
    [environment.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe', 'Chrome'],
  ] : platform === 'darwin' ? [
    ['/Applications', 'Google Chrome.app/Contents/MacOS/Google Chrome', 'Chrome'],
    ['/Applications', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Edge'],
  ] : [['/usr/bin', 'google-chrome', 'Chrome'], ['/usr/bin', 'microsoft-edge', 'Edge']];
  for (const [base, suffix, name] of candidates) {
    if (!base) continue;
    const executablePath = path.resolve(base, suffix);
    try { if (fs.statSync(executablePath).isFile()) return { executablePath, name }; } catch {}
  }
  return null;
}

/** The executable and flags are owned by this module, never by a model/tool request. */
export function standardBrowserOptions(browser, { visible = false } = {}) {
  if (!browser?.executablePath || !path.isAbsolute(browser.executablePath)) throw problem('未找到已安装的标准 Chrome 或 Edge。');
  return { executablePath: browser.executablePath, headless: !visible, chromiumSandbox: true,
    viewport: { width: 1360, height: 980 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    acceptDownloads: false, timeout: 25000, args: [],
  };
}

export function inspectBrowserArguments(args) {
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw problem('无法核验浏览器启动参数。', 'browser_verification_failed');
  if (args.some(arg => /^--(?:no-sandbox|disable-setuid-sandbox|disable-web-security|single-process)(?:=|$)/.test(arg)) ||
      args.some(arg => /^--remote-debugging-port(?:=|$)/.test(arg)) || !args.includes('--remote-debugging-pipe')) {
    throw problem('浏览器安全启动检查未通过；连接器已停止。', 'browser_verification_failed');
  }
  return { sandboxRequested: true, bypassFlagsPresent: false, transport: 'pipe', remoteDebuggingPort: false };
}

export class StandardBrowserRuntime {
  constructor({ root, browser, chromium } = {}) {
    this.profile = path.join(path.resolve(root), 'publishing-browser', 'xiaohongshu');
    this.browser = browser || findStandardBrowser();
    this.chromium = chromium;
    this.context = null;
    this.visible = false;
    this.launching = null;
    this.evidence = null;
  }

  async start({ visible = false } = {}) {
    if (this.launching) await this.launching;
    if (this.context && (!visible || this.visible)) return this.context;
    if (this.context) await this.close();
    this.launching = (async () => {
      if (!this.browser) throw problem('请先安装标准 Chrome 或 Edge；程序不会下载指纹浏览器。');
      fs.mkdirSync(this.profile, { recursive: true, mode: 0o700 });
      const chromium = this.chromium || (await import('playwright-core')).chromium;
      const context = await chromium.launchPersistentContext(this.profile, standardBrowserOptions(this.browser, { visible }));
      try {
        const browser = context.browser();
        if (!browser) throw problem('无法验证浏览器运行状态。', 'browser_verification_failed');
        const session = await browser.newBrowserCDPSession();
        const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
        const flags = inspectBrowserArguments(args);
        const version = await session.send('Browser.getVersion');
        await session.detach();
        this.evidence = { ...flags, browser: this.browser.name, product: version.product,
          verifiedAt: new Date().toISOString(), running: true };
        this.context = context;
        this.visible = visible;
        context.on('close', () => { if (this.context === context) { this.context = null; this.visible = false; } });
        return context;
      } catch (error) { await context.close().catch(() => {}); throw error; }
    })();
    try { return await this.launching; } finally { this.launching = null; }
  }

  async close() {
    const context = this.context;
    this.context = null;
    this.visible = false;
    if (context) await context.close();
  }
}
