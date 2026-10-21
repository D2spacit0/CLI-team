import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { analysisSchema, stepOutputSchema } from './adapters.mjs';
import { isTaskInput, materialTarget } from './materials.mjs';
import { redact } from './safety.mjs';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };
const issueText = (value) => redact(String(value)).slice(0, 400);
const json = (value) => JSON.stringify(value);

function readOutput(task, relativePath, remainingBytes) {
  if (isTaskInput(task, relativePath)) fail('输入材料或接力上下文不能作为交付文件');
  const filename = materialTarget(task.workspace, relativePath);
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('交付文件必须是无链接的普通文件');
  if (!before.size) fail('交付文件为空');
  if (before.size > MAX_FILE_BYTES || before.size > remainingBytes) fail('交付文件超过检查大小上限');
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    // Recheck the entire path after opening, and verify that the handle still
    // refers to the regular file checked above before reading any content.
    materialTarget(task.workspace, relativePath);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail('交付文件在检查期间发生变化');
    }
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(descriptor, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
    const after = fs.fstatSync(descriptor);
    materialTarget(task.workspace, relativePath);
    const named = fs.lstatSync(filename);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs || after.nlink !== 1 || !named.isFile() || named.isSymbolicLink() ||
        named.nlink !== 1 || named.dev !== after.dev || named.ino !== after.ino || named.size !== after.size ||
        named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs) {
      fail('交付文件在检查期间发生变化');
    }
    return bytes.subarray(0, count);
  } finally { fs.closeSync(descriptor); }
}

export function checkStepOutput(task, step, run) {
  const checkedAt = new Date().toISOString();
  if (step.output === null || step.output === undefined) {
    return { status: 'not_configured', checkedAt, summary: '此步骤未配置交付契约，未执行结构或文件检查' };
  }
  const parsed = stepOutputSchema.safeParse(step.output);
  if (!parsed.success) return { status: 'failed', checkedAt, summary: '步骤交付契约无效',
    issues: parsed.error.issues.slice(0, 12).map((issue) => issueText(issue.message)) };
  const contract = parsed.data;
  const receipt = { status: 'passed', type: contract.type, checkedAt, contractHash: hash(json(contract)),
    summary: '交付结构检查通过；这不代表内容正确或任务最终验收通过' };
  const issues = [];
  if (contract.type === 'files') {
    receipt.files = [];
    let totalBytes = 0;
    for (const file of contract.files) {
      try {
        const bytes = readOutput(task, file.path, MAX_TOTAL_BYTES - totalBytes);
        totalBytes += bytes.length;
        if (file.format !== 'any') {
          let text;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
          catch { fail('交付文件不是有效的 UTF-8 文本'); }
          if (!text.trim() || text.includes('\0')) fail('交付文件不是非空文本');
          if (file.format === 'json') {
            try { JSON.parse(text); } catch { fail('交付文件不是有效的 JSON'); }
          }
        }
        receipt.files.push({ path: file.path, sha256: hash(bytes), size: bytes.length, format: file.format });
      } catch (error) {
        const reason = error.code === 'ENOENT' ? '交付文件不存在' : error.code ? '交付文件无法安全读取' : error.message;
        issues.push(issueText(`${file.path}：${reason}`));
      }
    }
  } else {
    receipt.sections = [];
    const analysis = analysisSchema.safeParse(run?.report?.analysis ?? []);
    if (!analysis.success) issues.push('报告分析章节无效、重复或超过大小上限');
    const sections = new Map(analysis.success ? analysis.data.map((section) => [section.key, section.content]) : []);
    for (const key of contract.sections) {
      const content = key === 'summary' ? run?.report?.summary : sections.get(key);
      if (typeof content !== 'string' || !content.trim() || content.length > (key === 'summary' ? 12000 : 8000)) {
        issues.push(`分析章节 ${key} 缺失、为空或超过大小上限`);
      } else receipt.sections.push({ key, sha256: hash(content) });
    }
  }
  if (issues.length) Object.assign(receipt, { status: 'failed', summary: '步骤交付结构检查未通过', issues });
  return receipt;
}

export function stepOutputUnchanged(task, step, run, receipt) {
  if (!step.output || receipt?.status !== 'passed' || !receipt.contractHash) return false;
  const current = checkStepOutput(task, step, run);
  return current.status === 'passed' && current.type === receipt.type && current.contractHash === receipt.contractHash &&
    json(current.files) === json(receipt.files) && json(current.sections) === json(receipt.sections);
}
