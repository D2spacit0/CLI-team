import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveInside, redact } from './safety.mjs';
import { materialName } from './materials.mjs';
import { protocolError } from './runtime-diagnostics.mjs';
import { discoverDshDesktop, dshDesktopInfo, dshInstalledVersion } from './dsh-installation.mjs';

export const providers = ['antigravity', 'dsh', 'claude', 'gemini', 'codex', 'opencode', 'custom'];
const sectionKeyPattern = '^[a-z][a-z0-9-]{0,39}$';
const sectionKey = z.string().regex(new RegExp(sectionKeyPattern));
const validOutputPath = (value) => {
  try { materialName(value); } catch { return false; }
  return value.split('/').every((part) => part.trim() === part &&
    !['inputs', 'relay-context.json'].includes(part.toLowerCase()) &&
    !/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])([ .]|$)/i.test(part));
};
export const stepOutputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('files'), files: z.array(z.object({
    path: z.string().min(1).max(180).refine(validOutputPath, '交付路径必须为普通任务相对路径，不能是输入、私有文件或特殊路径'),
    format: z.enum(['any', 'text', 'json']).default('any'),
  }).strict()).min(1).max(8).refine((files) => new Set(files.map((file) => file.path.toLowerCase())).size === files.length, '交付文件不能重复') }).strict(),
  z.object({ type: z.literal('analysis'), sections: z.array(sectionKey).min(1).max(8)
    .refine((sections) => new Set(sections).size === sections.length, '分析章节不能重复') }).strict(),
]);
export const analysisSchema = z.array(z.object({
  key: sectionKey.refine((key) => key !== 'summary', 'summary 使用报告的顶层 summary 字段'),
  content: z.string().min(1).max(8000).refine((content) => content.trim().length > 0, '分析章节内容不能为空'),
}).strict()).max(8).refine((sections) => new Set(sections.map((section) => section.key)).size === sections.length, '分析章节标识不能重复');
export const delegationSchema = z.object({
  steps: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    title: z.string().trim().min(1).max(120),
    objective: z.string().trim().min(1).max(3000),
    memberId: z.string().trim().min(1).max(200),
    dependsOn: z.array(z.string()).max(6).default([]),
    output: stepOutputSchema.nullable().default(null),
  }).strict()).min(1).max(6),
}).strict();

export const agentReport = z.object({
  summary: z.string().max(12000),
  status: z.enum(['complete', 'needs_help', 'blocked']),
  verdict: z.enum(['none', 'approve', 'changes_requested']).default('none'),
  findings: z.array(z.object({
    severity: z.enum(['critical', 'major', 'minor']),
    text: z.string().max(2000),
  })).max(20).default([]),
  handoff: z.object({ to: z.string().max(60), message: z.string().max(4000) }).nullable().default(null),
  delegation: delegationSchema.nullable().default(null),
  analysis: analysisSchema.default([]),
  helpRequest: z.object({ question: z.string().trim().min(1).max(3000) }).strict().nullable().default(null),
  consult: z.object({ memberId: z.string().trim().min(1).max(200), question: z.string().trim().min(1).max(3000) }).strict().nullable().default(null),
});

const insensitive = (pattern) => pattern.replace(/[a-z]/gi, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
const outputPathJsonSchema = {
  type: 'string', minLength: 1, maxLength: 180,
  pattern: '^[^/\\\\<>:"|?*\\u0000-\\u001f\\u007f]+(/[^/\\\\<>:"|?*\\u0000-\\u001f\\u007f]+)*$',
  allOf: [
    { not: { pattern: '(^|/)[.\\s]|[.\\s](/|$)' } },
    { not: { pattern: insensitive('(^|/)(inputs|relay-context\\.json|node_modules|__pycache__)(/|$)') } },
    { not: { pattern: insensitive('(^|/)(con|prn|aux|nul|conin\\$|conout\\$|clock\\$|com[0-9¹²³]|lpt[0-9¹²³])([ .]|/|$)') } },
    { not: { pattern: insensitive('credentials|id_rsa|id_ed25519|\\.pem(/|$)|\\.key(/|$)|(^|/)controller\\.token(/|$)') } },
  ],
  description: 'Canonical task-relative path using forward slashes; no inputs, private files, special paths, or links. File paths must be unique ignoring case.',
};
const outputJsonSchema = { anyOf: [{ type: 'null' }, {
  type: 'object', additionalProperties: false, required: ['type', 'files'], properties: {
    type: { type: 'string', const: 'files' },
    files: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: {
      type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: outputPathJsonSchema,
        format: { type: 'string', enum: ['any', 'text', 'json'], default: 'any' },
      },
    } },
  },
}, {
  type: 'object', additionalProperties: false, required: ['type', 'sections'], properties: {
    type: { type: 'string', const: 'analysis' },
    sections: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', pattern: sectionKeyPattern },
      description: 'Required section keys. The reserved key summary refers to the top-level report summary; other keys refer to report.analysis.' },
  },
}] };

export const reportSchema = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'status', 'verdict', 'findings', 'handoff'],
  properties: {
    summary: { type: 'string' },
    status: { type: 'string', enum: ['complete', 'needs_help', 'blocked'] },
    verdict: { type: 'string', enum: ['none', 'approve', 'changes_requested'] },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['severity', 'text'], properties: {
        severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, text: { type: 'string' },
      } } },
    handoff: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
      required: ['to', 'message'], properties: { to: { type: 'string' }, message: { type: 'string' } } }] },
    delegation: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
      required: ['steps'], properties: {
        steps: { type: 'array', minItems: 1, maxItems: 6, items: {
          type: 'object', additionalProperties: false,
          required: ['key', 'title', 'objective', 'memberId'], properties: {
            key: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' },
            title: { type: 'string', minLength: 1, maxLength: 120 },
            objective: { type: 'string', minLength: 1, maxLength: 3000 },
            memberId: { type: 'string', minLength: 1, maxLength: 200 },
            dependsOn: { type: 'array', maxItems: 6, items: { type: 'string' }, default: [] },
            output: outputJsonSchema,
          },
        } },
      } }] },
    analysis: { type: 'array', maxItems: 8, uniqueItems: true, default: [], description: 'Analysis sections with unique keys; at most 64000 content characters total.', items: {
      type: 'object', additionalProperties: false, required: ['key', 'content'], properties: {
        key: { type: 'string', pattern: sectionKeyPattern, not: { const: 'summary' } },
        content: { type: 'string', minLength: 1, maxLength: 8000 },
      },
    } },
    helpRequest: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['question'],
      properties: { question: { type: 'string', minLength: 1, maxLength: 3000 } } }] },
    consult: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['memberId', 'question'],
      properties: { memberId: { type: 'string', minLength: 1, maxLength: 200 }, question: { type: 'string', minLength: 1, maxLength: 3000 } } }] },
  },
};

const npmEntries = {
  codex: '@openai/codex/bin/codex.js',
  claude: '@anthropic-ai/claude-code/cli.js',
  gemini: '@google/gemini-cli/dist/index.js',
  dsh: '@deepseek-ai/dsh/lib/bin.js',
};

export function resolveDshDesktopMigration(member, sourceHome, detect = discoverProvider) {
  if (member?.provider !== 'dsh' || process.platform !== 'win32' || !sourceHome ||
      !/^node(?:[.]exe)?$/i.test(path.basename(member.executable || '')) || member.prefixArgs?.length !== 1) return null;
  const legacyEntry = path.resolve(sourceHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!path.isAbsolute(member.prefixArgs[0]) || path.resolve(member.prefixArgs[0]).toLowerCase() !== legacyEntry.toLowerCase()) return null;
  const version = dshInstalledVersion(member);
  if (!version || !/^0[.][01][.]/.test(version)) return null;
  const desktop = detect('dsh');
  const info = dshDesktopInfo({ provider: 'dsh', ...desktop });
  if (!info || Number(info.version.split('.')[0]) === 0 && Number(info.version.split('.')[1]) < 2) return null;
  return desktop;
}

function executableFile(filename) {
  try {
    if (!fs.statSync(filename).isFile()) return false;
    // npm writes extensionless POSIX shims on Windows too. They exist, but
    // CreateProcess cannot run them; discovery must continue to the JS entry.
    if (process.platform === 'win32' && !path.extname(filename)) {
      const file = fs.openSync(filename, 'r');
      try {
        const magic = Buffer.alloc(2);
        return fs.readSync(file, magic, 0, 2, 0) === 2 && magic.toString('ascii') === 'MZ';
      } finally { fs.closeSync(file); }
    }
    return true;
  } catch { return false; }
}

export function findExecutable(name) {
  if (!name) return '';
  if (path.isAbsolute(name)) return executableFile(name) ? name : '';
  const extensions = process.platform === 'win32' ? ['.exe', '.com', ''] : [''];
  for (const folder of (process.env.PATH || '').split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(folder.replace(/^"|"$/g, ''), name + extension);
      if (executableFile(candidate)) return candidate;
    }
  }
  return '';
}

export function inspectCliEntry(member) {
  let executable = '';
  let entryPoint = null;
  try {
    executable = findExecutable(member.executable);
    if (!executable) {
      if (process.platform === 'win32' && member.executable && path.isAbsolute(member.executable) &&
          fs.existsSync(member.executable) && fs.statSync(member.executable).isFile()) {
        throw new Error('CLI 文件存在，但不是可直接启动的 Windows 程序；请重新检测客户端或配置 node.exe 与 CLI 的 JS 入口');
      }
      throw new Error('CLI 可执行文件不存在，请检查成员配置');
    }
    if (/\.(cmd|bat|ps1)$/i.test(executable) || /^(cmd|powershell|pwsh|sh|bash|zsh)(\.exe)?$/i.test(path.basename(executable))) {
      throw new Error('请使用原生 CLI，或 node.exe 加 JS 入口参数，不使用 shell 包装脚本');
    }
    if (/^node(?:\.exe)?$/i.test(path.basename(executable))) {
      entryPoint = (member.prefixArgs || []).find((arg) => !arg.startsWith('-') && (/\.[cm]?js$/i.test(arg) || path.isAbsolute(arg))) || null;
      if (!entryPoint && member.provider !== 'custom') throw new Error('Node.js 已安装，但缺少 CLI 的 JS 入口参数，请重新检测客户端');
      if (entryPoint && (!path.isAbsolute(entryPoint) || !fs.existsSync(entryPoint) || !fs.statSync(entryPoint).isFile())) {
        throw new Error('Node.js 已安装，但 CLI 的 JS 入口不存在或不是绝对文件路径，请重新检测客户端');
      }
    }
    if ([...(member.prefixArgs || []), ...(member.customArgs || [])].some((arg) => /dangerously-skip|bypassPermissions|--yolo|dangerously-bypass/i.test(arg))) {
      throw new Error('禁止配置绕过审批的参数');
    }
    if (member.provider === 'dsh' && path.basename(executable).toLowerCase() === 'deepseek harness.exe') {
      const desktop = dshDesktopInfo(member);
      if (!desktop) throw new Error('DSH 桌面 CLI 入口不完整，请重新检测客户端；需要官方 app.asar 内的 cli.js 与 --expose-internals');
      entryPoint = desktop.entryPoint;
    }
    return { detected: true, executable, entryPoint, error: null };
  } catch (cause) { return { detected: false, executable, entryPoint, error: cause.message }; }
}

export function resolveNpmCliEntry(member) {
  if (process.platform !== 'win32' || !Object.hasOwn(npmEntries, member.provider) ||
      !member.executable || !path.isAbsolute(member.executable)) return null;
  const filename = path.basename(member.executable).toLowerCase();
  if (!['', '.cmd', '.bat', '.ps1'].some((suffix) => filename === member.provider + suffix) ||
      inspectCliEntry(member).detected) return null;
  try {
    if (!fs.statSync(member.executable).isFile()) return null;
    // Resolve beside the selected npm wrapper, never by executing/parsing it or
    // switching to a different installation found on the current process PATH.
    const entryPoint = path.join(path.dirname(member.executable), 'node_modules', npmEntries[member.provider]);
    const resolved = { executable: process.execPath, prefixArgs: [entryPoint, ...(member.prefixArgs || [])] };
    return inspectCliEntry({ ...member, ...resolved }).detected ? resolved : null;
  } catch { return null; }
}

export function discoverProvider(provider) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (provider === 'antigravity') {
    const known = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'agy', 'bin', 'agy.exe');
    return { executable: findExecutable(known) || findExecutable('agy'), prefixArgs: [] };
  }
  if (provider === 'dsh') {
    const desktop = discoverDshDesktop();
    if (desktop.executable) return desktop;
  }
  const native = findExecutable(provider);
  if (native) return { executable: native, prefixArgs: [] };
  const roots = [
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'node_modules'),
    path.join(path.dirname(process.execPath), 'node_modules'),
    path.join(home, '.npm-global', 'lib', 'node_modules'),
  ];
  if (provider === 'dsh') {
    const entry = path.join(process.env.DSH_HOME || path.join(home, '.dsh'), 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(entry)) return { executable: process.execPath, prefixArgs: [entry] };
  }
  for (const root of roots) {
    const entry = Object.hasOwn(npmEntries, provider) && path.join(root, npmEntries[provider]);
    if (entry && fs.existsSync(entry)) return { executable: process.execPath, prefixArgs: [entry] };
  }
  const localClaude = path.join(home, '.local', 'bin', 'claude.exe');
  if (provider === 'claude' && fs.existsSync(localClaude)) return { executable: localClaude, prefixArgs: [] };
  return { executable: '', prefixArgs: [] };
}

export function buildInvocation(member, prompt, { workspace, conversationId, logFile, timeoutMinutes = 10 }) {
  const entry = inspectCliEntry(member);
  if (!entry.detected) throw new Error(entry.error);
  const executable = entry.executable;
  const args = [...(member.prefixArgs || [])];
  let stdin = '';
  switch (member.provider) {
    case 'antigravity':
      args.push('--print', prompt, '--add-dir', workspace, '--output-format', 'stream-json',
        '--mode', member.permission === 'edit' ? 'accept-edits' : 'plan', '--disable-slash-commands',
        '--json-schema', JSON.stringify(reportSchema), '--print-timeout', `${timeoutMinutes}m`, '--log-file', logFile);
      if (member.model) args.push('--model', member.model);
      if (conversationId) args.push('--conversation', conversationId);
      break;
    case 'claude':
      args.push('-p', '--output-format', 'stream-json', '--verbose',
        '--permission-mode', member.permission === 'edit' ? 'acceptEdits' : 'plan');
      if (member.model) args.push('--model', member.model);
      if (conversationId) args.push('--resume', conversationId);
      stdin = prompt;
      break;
    case 'gemini':
      args.push('-p', prompt, '--output-format', 'stream-json', '--approval-mode',
        member.permission === 'edit' ? 'auto_edit' : 'plan');
      if (member.model) args.push('--model', member.model);
      if (conversationId) args.push('--resume', conversationId);
      break;
    case 'codex':
      // Separate Codex CLI sessions are opt-in; the controller never launches itself.
      args.push('exec');
      if (conversationId) args.push('resume', conversationId);
      args.push('--json', '--skip-git-repo-check');
      if (!conversationId) args.push('--sandbox', member.permission === 'edit' ? 'workspace-write' : 'read-only', '--cd', workspace);
      if (member.model) args.push('--model', member.model);
      args.push('-');
      stdin = prompt;
      break;
    case 'opencode':
      args.push('run', '--format', 'json');
      if (member.model) args.push('--model', member.model);
      if (conversationId) args.push('--session', conversationId);
      args.push(prompt);
      break;
    case 'dsh':
      args.push('--profile', 'acp');
      break;
    case 'custom':
      args.push(...(member.customArgs || []).map((arg) => arg.replaceAll('{prompt}', prompt).replaceAll('{workspace}', workspace)));
      if (member.inputMode === 'stdin') stdin = prompt;
      else if (!(member.customArgs || []).some((arg) => arg.includes('{prompt}'))) throw new Error('自定义成员需要 {prompt} 参数或 stdin 输入');
      break;
    default: throw new Error('此成员不能作为执行进程启动');
  }
  if ([...(member.prefixArgs || []), ...(member.customArgs || [])].some((arg) => /dangerously-skip|bypassPermissions|--yolo|--dangerously-bypass/i.test(arg))) {
    throw new Error('禁止配置绕过审批的参数');
  }
  // Conservative upper bound includes Windows argument quoting/escaping. Never
  // truncate collaborative results to make a command line fit.
  if (process.platform === 'win32' && executable.length + args.reduce((size, arg) => size + arg.length * 2 + 3, 0) > 30000) {
    throw Object.assign(new Error('CLI 参数超过 Windows 安全长度范围，未启动进程。请使用支持标准输入的 Claude、Codex、自定义 stdin 成员或 DSH，或缩小单次协作任务。分析结果未截断。'), { code: 'CLI_INPUT_TOO_LONG' });
  }
  return { executable, args, stdin };
}

export function parseReport(response) {
  const text = String(response).trim();
  try { return agentReport.parse(JSON.parse(text)); } catch {}
  // Antigravity may append schema-tool JSON after a fenced assistant reply.
  // Parse complete JSON frames and validate the last report, never repair JSON.
  const candidates = [];
  const remember = (value) => {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && 'summary' in parsed && 'status' in parsed) candidates.push(parsed);
    } catch {}
  };
  let fenced = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '```' || trimmed === '```json') {
      if (fenced) { remember(fenced.join('\n')); fenced = null; }
      else fenced = [];
      continue;
    }
    if (fenced) fenced.push(line);
    else remember(trimmed);
  }
  if (!candidates.length) return null;
  const result = agentReport.safeParse(candidates.at(-1));
  return result.success ? result.data : null;
}

export class OutputCollector {
  constructor(provider, workspace) {
    this.provider = provider;
    this.workspace = workspace;
    this.conversationId = null;
    this.response = '';
    this.riskFlags = new Set();
    this.terminalSeen = false;
    this.success = false;
    this.malformed = 0;
    this.usage = null;
    this.rawText = '';
    this.error = null;
  }
  line(line) {
    let event;
    try { event = JSON.parse(line); } catch {
      this.malformed++;
      if (this.rawText.length < 32000) this.rawText += `${line}\n`;
      return;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) { this.malformed++; return; }
    if (this.provider === 'antigravity') {
      // Antigravity releases emit both nested and flat event payloads. Deltas are
      // part of the answer, including whitespace inside a structured report.
      const payload = (key) => event[key] && typeof event[key] === 'object' && !Array.isArray(event[key]) ? event[key] : event;
      if (event.event === 'init') this.conversationId = payload('init').conversation_id || this.conversationId;
      if (event.event === 'step_update') {
        const step = payload('step_update');
        if (typeof step.text_delta === 'string') this.response += step.text_delta;
      }
      if (event.event === 'result') {
        const result = payload('result');
        this.terminalSeen = true;
        this.success = result.status === 'SUCCESS';
        // A terminal frame need not repeat the streamed answer. If it does, it
        // replaces the deltas instead of appending the same answer twice.
        if (result.response != null && result.response !== '') {
          this.response = typeof result.response === 'string' ? result.response : JSON.stringify(result.response);
        }
        this.conversationId = result.conversation_id || this.conversationId;
        this.usage = result.usage || null;
        if (typeof result.error === 'string' && result.error) {
          this.error = redact(result.error.slice(0, 2000));
          this.riskFlags.add('provider_error');
        }
        if (!this.success) {
          this.riskFlags.add('provider_error');
          this.error ||= 'Antigravity 终结事件未确认成功状态';
        }
      }
      if (event.event === 'step_update' && payload('step_update').step_type === 'tool') {
        const step = payload('step_update');
        const tool = step.tool_info || {};
        const name = tool.name || step.tool_name || '';
        const output = `${typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output || '')} ${JSON.stringify(tool.error || '')}`;
        if (/permission.?denied|denied permission|permission check failed|not approved|requires? approval|approval required|soft.?den(?:y|ied)|denied by|not allowed to/i.test(output) ||
            ['DENIED', 'REJECTED', 'BLOCKED'].includes(step.state)) this.riskFlags.add('permission_denied');
        if (/write|replace|edit|delete|move|create|append/i.test(name)) {
          for (const [key, value] of Object.entries(tool.parameters || {})) {
            if (/(path|file|directory|folder)/i.test(key) && typeof value === 'string' && path.isAbsolute(value)) {
              try { resolveInside(this.workspace, value); } catch { this.riskFlags.add('out_of_scope_write'); }
            }
          }
        }
      }
      if (this.response.length > 64000) { this.response = this.response.slice(0, 64000); this.riskFlags.add('output_limit'); }
      return;
    }
    if (event.type === 'thread.started') this.conversationId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') this.response = event.item.text || '';
    if (event.type === 'turn.completed') {
      this.terminalSeen = true; this.success = true; this.usage = event.usage || null;
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      this.riskFlags.add('provider_error'); this.terminalSeen = true; this.success = false;
      this.error = protocolError(event.error || event).text;
    }
    if (event.type === 'system' && event.session_id) this.conversationId = event.session_id;
    if (event.type === 'init' && event.session_id) this.conversationId = event.session_id;
    if (event.type === 'result') {
      this.terminalSeen = true;
      this.success = !event.is_error && event.status !== 'error';
      if (typeof event.result === 'string') this.response = event.result;
      this.conversationId = event.session_id || this.conversationId;
      this.usage = event.usage || event.stats || null;
      if (event.permission_denials?.length) this.riskFlags.add('permission_denied');
      if (!this.success || event.error) {
        this.riskFlags.add('provider_error');
        this.error = protocolError(event.error || { message: event.result || event.errors?.join('; ') || '客户端结果为失败' }).text;
        this.success = false;
      }
    }
    if (event.type === 'message' && event.role === 'assistant') this.response += event.content || '';
    if (event.type === 'text' && event.part?.text) {
      this.response += event.part.text; this.conversationId = event.sessionID || this.conversationId;
    }
    if (event.type === 'step_finish') { this.terminalSeen = true; this.success = true; }
    if (this.provider === 'custom' && event.summary !== undefined) {
      this.response = JSON.stringify(event); this.terminalSeen = true; this.success = true;
    }
    if (this.response.length > 64000) { this.response = this.response.slice(0, 64000); this.riskFlags.add('output_limit'); }
  }
  finish(exitCode) {
    if (!this.response && this.provider === 'custom') {
      this.response = this.rawText;
      this.terminalSeen = Boolean(this.rawText);
      this.success = exitCode === 0;
    }
    const report = parseReport(this.response);
    if (!this.terminalSeen) this.riskFlags.add('missing_terminal_event');
    if (!report) this.riskFlags.add('unstructured_report');
    return {
      response: redact(this.response), report, conversationId: this.conversationId, error: this.error,
      riskFlags: [...this.riskFlags], usage: this.usage,
      success: exitCode === 0 && this.terminalSeen && this.success && this.riskFlags.size === 0,
    };
  }
}
