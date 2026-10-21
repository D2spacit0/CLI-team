import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { materialLimits, materialName } from '../server/materials.mjs';
import { request } from './client.mjs';

export async function importLocalMaterial(taskId, filename, name) {
  if (!taskId || !filename) throw new Error('Specify a task and an explicitly selected file');
  const source = path.resolve(filename);
  const destination = materialName(name || path.basename(source));
  materialName(path.basename(source));
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Select a regular file, not a link or directory');
  if (stat.size > materialLimits.maxFileBytes) throw new Error('Selected file exceeds 8 MiB');
  const bytes = fs.readFileSync(source);
  return request(`/api/tasks/${encodeURIComponent(taskId)}/materials`, {
    name: destination, contentBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
