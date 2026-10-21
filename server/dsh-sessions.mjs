import fs from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { decompress, ZstdErrorCode } from 'fzstd';
import { redact, resolveInside } from './safety.mjs';

export function dshHome() {
  return path.resolve(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'));
}

const MAX_COMPRESSED = 32 * 1024 * 1024;
const MAX_DECODED = 128 * 1024 * 1024;
const clip = (value, limit = 800) => redact(String(value || '')).slice(0, limit);

function messageText(message) {
  const blocks = message?.content || message?.contentBlocks || [];
  return typeof blocks === 'string' ? blocks : Array.isArray(blocks)
    ? blocks.filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n') : '';
}

const isDescendant = (header) => Boolean(header.parentId || header.parentSession || header.delegationDepth > 0 || header.origin === 'subagent');

// DSH appends independent Zstandard frames. Node consumes one frame per call.
// Ignore only an incomplete final frame/row while another process is appending.
export function readSessionSnapshot(filename, { headerOnly = false } = {}) {
  const alternate = filename.endsWith('.zstd') ? filename.slice(0, -5) : `${filename}.zstd`;
  if (fs.existsSync(alternate)) throw new Error('DSH 同一会话版本存在多个编码，无法确定权威日志，未自动选择');
  const stat = fs.statSync(filename);
  if (stat.size > MAX_COMPRESSED) throw new Error('DSH 会话超过只读同步大小上限');
  const bytes = fs.readFileSync(filename);
  const decoder = new StringDecoder('utf8');
  let offset = 0;
  let decoded = 0;
  let pending = '';
  let partial = false;
  let header;
  let title = '';
  let userText = '';
  let assistantText = '';
  let activity = 'unknown';
  let lastTool = '';
  let lastEventAt = null;
  let eventCount = 0;
  let route = null;
  const consume = (chunk) => {
    decoded += chunk.length;
    if (decoded > MAX_DECODED) throw new Error('DSH 会话解压内容超过上限');
    pending += decoder.write(chunk);
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (!header) {
        if (event.type !== 'session' || typeof event.id !== 'string' || !path.isAbsolute(event.cwd || '')) {
          throw new Error('DSH 会话头无效');
        }
        if (![3, 4].includes(event.version)) throw new Error(`尚不支持 DSH 会话格式 v${event.version}，未迁移原文件`);
        header = event;
        if (headerOnly) return;
        continue;
      }
      eventCount++;
      const data = event.data || {};
      if (Number.isFinite(event.time)) lastEventAt = new Date(event.time).toISOString();
      if (event.type === 'session/title') title = clip(data.title, 180);
      if (event.type === 'user/message') userText = clip(messageText(header.version === 4 ? data : data.message), 1200);
      if (event.type === 'assistant/message') {
        const text = messageText(data.message);
        if (text) assistantText = clip(text, 1600);
      }
      if (event.type === 'turn/start' || event.type === 'step/start' || event.type === 'tool/call') activity = 'running';
      if (event.type === 'turn/end') activity = (data.reason?.kind || data.reason) === 'completed' ? 'idle' : 'stopped';
      if (event.type === 'tool/call') lastTool = clip(data.name, 120);
      if (event.type === 'session/title' && data.source?.model) route = data.source.model;
      if (event.type === 'request/context' && typeof data.provider === 'string' && typeof data.model === 'string') route = data;
    }
  };
  if (filename.endsWith('.zstd')) {
    while (offset < bytes.length && !(headerOnly && header)) {
      let result;
      try {
        result = zstdDecompressSync(bytes.subarray(offset), { info: true, maxOutputLength: MAX_DECODED - decoded });
      } catch (error) {
        if (header && error.code === 'Z_BUF_ERROR') { partial = true; break; }
        throw new Error(`DSH 会话压缩数据无法读取：${error.code || 'invalid_frame'}`);
      }
      if (!result.engine.bytesWritten) throw new Error('DSH 会话压缩帧没有前进');
      if (offset + result.engine.bytesWritten === bytes.length) {
        try { decompress(bytes.subarray(offset), new Uint8Array(result.buffer.length)); }
        catch (error) {
          if (header && error.code === ZstdErrorCode.UnexpectedEOF) { partial = true; break; }
          throw new Error('DSH 会话最后一个压缩帧损坏');
        }
      }
      offset += result.engine.bytesWritten;
      consume(result.buffer);
    }
  } else consume(bytes);
  if (!header) throw new Error('DSH 会话文件尚无完整头部');
  if (headerOnly) return header;
  partial ||= Boolean(pending || decoder.lastNeed);
  return {
    sessionId: header.id, title: title || userText.slice(0, 100) || header.id,
    workspace: header.cwd, formatVersion: header.version,
    parentId: header.parentSession || header.parentId || null, delegationDepth: header.delegationDepth || 0,
    createdAt: new Date(header.createdAt).toISOString(), updatedAt: stat.mtime.toISOString(),
    lastEventAt, activity, lastTool, eventCount, partial,
    summary: assistantText || userText, lastRequest: userText,
    model: clip(route?.model, 200), provider: clip(route?.provider, 200),
    mode: 'observe', ownership: 'desktop', canControl: false,
  };
}

export class DshSessionCatalog {
  constructor(home = dshHome()) {
    this.home = path.resolve(home);
    this.root = path.join(this.home, 'sessions');
    this.cache = new Map();
  }
  files(sessionId = null) {
    if (!fs.existsSync(this.root)) return [];
    const result = [];
    for (const project of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const projectPath = resolveInside(this.root, project.name);
      for (const session of fs.readdirSync(projectPath, { withFileTypes: true })) {
        if (!session.isDirectory() || session.isSymbolicLink()) continue;
        if (sessionId && session.name !== sessionId && session.name !== encodeURIComponent(sessionId)) continue;
        const directory = resolveInside(this.root, path.join(projectPath, session.name));
        const versions = fs.readdirSync(directory).filter((name) => /^session\.v\d+\.jsonl(?:\.zstd)?$/.test(name));
        // Never fall back to an older generation when an unsupported newer one exists.
        const latest = versions.sort((a, b) => Number(b.match(/\.v(\d+)/)[1]) - Number(a.match(/\.v(\d+)/)[1]))[0];
        if (latest) result.push(resolveInside(this.root, path.join(directory, latest)));
        if (!sessionId && result.length >= 1000) return result;
      }
    }
    return result;
  }
  list() {
    const sessions = [];
    const warnings = [];
    for (const filename of this.files()) {
      try {
        const stat = fs.statSync(filename);
        const alternate = filename.endsWith('.zstd') ? filename.slice(0, -5) : `${filename}.zstd`;
        const stamp = `${stat.size}:${stat.mtimeMs}:${fs.existsSync(alternate)}`;
        let cached = this.cache.get(filename);
        if (cached?.stamp !== stamp) {
          const header = readSessionSnapshot(filename, { headerOnly: true });
          const snapshot = isDescendant(header) ? null : readSessionSnapshot(filename);
          cached = { stamp, snapshot };
          this.cache.set(filename, cached);
        }
        if (cached.snapshot) sessions.push(cached.snapshot);
      } catch (error) {
        warnings.push({ session: path.basename(path.dirname(filename)), error: clip(error.message, 220) });
      }
    }
    return {
      home: this.home, sessions: sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100),
      warnings: warnings.slice(0, 20),
    };
  }
  get(sessionId) {
    for (const filename of this.files(sessionId)) {
      if (isDescendant(readSessionSnapshot(filename, { headerOnly: true }))) continue;
      const session = readSessionSnapshot(filename);
      if (session.sessionId === sessionId && !session.parentId && !session.delegationDepth) return session;
    }
    throw Object.assign(new Error('DSH 会话不存在或当前格式不可读取'), { status: 404 });
  }
}
