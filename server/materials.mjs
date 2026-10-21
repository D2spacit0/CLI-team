import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveInside } from './safety.mjs';

export const materialLimits = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024, maxTaskBytes: 32 * 1024 * 1024, maxFiles: 64,
});
const maxBase64 = Math.ceil(materialLimits.maxFileBytes / 3) * 4;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const privateName = /(^\.env($|\.)|credentials|^controller\.token$|\.pem$|\.key$|id_rsa|id_ed25519)/i;

export function materialName(name) {
  if (typeof name !== 'string' || !name || name.length > 180 ||
      name.split('/').some((part) => !part || part.startsWith('.') || /[. ]$/.test(part) ||
        ['node_modules', '__pycache__'].includes(part.toLowerCase()) ||
        /[\\<>:"|?*\u0000-\u001f\u007f]/.test(part) || privateName.test(part) ||
        /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\.|$)/i.test(part))) {
    fail('材料名称无效：使用普通相对文件名，不能包含隐藏目录、凭据或特殊路径');
  }
  return name;
}

export function decodeMaterial(input) {
  const parsed = z.object({
    name: z.string().min(1).max(180), contentBase64: z.string().max(maxBase64),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().parse(input);
  materialName(parsed.name);
  if (parsed.contentBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.contentBase64)) {
    fail('材料内容不是有效的 Base64');
  }
  const bytes = Buffer.from(parsed.contentBase64, 'base64');
  if (bytes.length > materialLimits.maxFileBytes) fail('单份材料不能超过 8 MiB', 413);
  if (bytes.toString('base64') !== parsed.contentBase64) fail('材料 Base64 编码不规范');
  if (hash(bytes) !== parsed.sha256) fail('材料 SHA-256 不匹配，未导入');
  return { name: parsed.name, bytes, sha256: parsed.sha256 };
}

export function materialTarget(workspace, relativePath) {
  const target = resolveInside(workspace, relativePath);
  let current = workspace;
  for (const part of ['', ...path.relative(workspace, target).split(path.sep)]) {
    if (part) current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) fail('材料路径不能经过链接');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

export function inspectMaterials(task) {
  return (task.materials || []).map((material) => {
    let integrity;
    try {
      const filename = materialTarget(task.workspace, material.relativePath);
      const stat = fs.statSync(filename);
      integrity = stat.isFile() && stat.size === material.size && stat.size <= materialLimits.maxFileBytes &&
        hash(fs.readFileSync(filename)) === material.sha256 ? 'verified' : 'changed';
    } catch (error) { integrity = error.code === 'ENOENT' ? 'missing' : 'unsafe'; }
    return { ...material, integrity };
  });
}

export function isTaskInput(task, relativePath) {
  const name = relativePath.toLowerCase();
  return name === task.sourceContext?.file.toLowerCase() || name === 'inputs' || name.startsWith('inputs/') ||
    (task.materials || []).some((material) => material.relativePath.toLowerCase() === name);
}
