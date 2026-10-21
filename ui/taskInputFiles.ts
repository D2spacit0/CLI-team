import type { Material, MaterialList } from './types';

// Selection uses these defaults before a task exists; imports recheck the service's limits.
export const defaultMaterialLimits: MaterialList['limits'] = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024, maxTaskBytes: 32 * 1024 * 1024, maxFiles: 64,
});

export const formatMaterialBytes = (bytes: number) => bytes < 1024 ? `${bytes} B`
  : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;
const errorText = (error: unknown) => error instanceof Error ? error.message : '请求失败';
const nameKey = (name: string) => name.toLowerCase();
const privateName = /(^\.env($|\.)|credentials|^controller\.token$|\.pem$|\.key$|id_rsa|id_ed25519)/i;

export function materialNameError(name: string) {
  if (!name || name.length > 180 || name.split('/').some((part) => !part || part.startsWith('.') ||
    /[. ]$/.test(part) || ['node_modules', '__pycache__'].includes(part.toLowerCase()) ||
    /[\\<>:"|?*\u0000-\u001f\u007f]/.test(part) || privateName.test(part) ||
    /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\.|$)/i.test(part))) {
    return '材料名称无效：使用普通文件名，不能包含隐藏目录、凭据或特殊路径';
  }
  return '';
}

type NamedMaterial = { name: string; size?: number };
export function validateMaterialFiles(files: readonly NamedMaterial[], existing: readonly NamedMaterial[] = [],
  limits = defaultMaterialLimits) {
  const names = new Set<string>();
  for (const file of files) {
    const invalidName = materialNameError(file.name);
    if (invalidName) return `${file.name}：${invalidName}`;
    const name = nameKey(file.name);
    if (names.has(name)) return `同名材料 ${file.name} 重复选择，请保留一份或重命名`;
    names.add(name);
    if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0)) return `${file.name} 的大小无效`;
    if ((file.size || 0) > limits.maxFileBytes) return `${file.name} 超过 ${formatMaterialBytes(limits.maxFileBytes)} 上限`;
  }
  const additions = files.filter((file) => !existing.some((item) => nameKey(item.name) === nameKey(file.name)));
  if (existing.length + additions.length > limits.maxFiles) return `材料数量超过 ${limits.maxFiles} 份上限`;
  if ([...existing, ...additions].reduce((sum, item) => sum + (item.size || 0), 0) > limits.maxTaskBytes) {
    return `材料合计超过 ${formatMaterialBytes(limits.maxTaskBytes)} 上限`;
  }
  return '';
}

export async function encodeMaterialFile(file: File) {
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength !== file.size) throw new Error('读取时文件大小已变化，请重新选择文件');
  const bytes = new Uint8Array(buffer);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return { sha256, contentBase64: btoa(chunks.join('')) };
}

export type TaskInputStatus = 'selected' | 'uploading' | 'imported' | 'failed' | 'missing';
export interface TaskInputItem {
  id: string; name: string; size?: number; status: TaskInputStatus;
  file?: File; sha256?: string; materialId?: string; error?: string; verified?: boolean;
}
export interface TaskInputDraft {
  id: string; name: string; size?: number; status: 'selected' | 'imported' | 'failed';
  sha256?: string; materialId?: string;
}
const safeIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(value);
const safeHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeSize = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function serializeTaskInputs(items: readonly TaskInputItem[]): TaskInputDraft[] {
  return items.filter((item) => !materialNameError(item.name)).slice(0, defaultMaterialLimits.maxFiles).map((item) => ({
    id: safeIdentifier(item.id) ? item.id : crypto.randomUUID(), name: item.name,
    ...(safeSize(item.size) ? { size: item.size } : {}),
    ...(safeHash(item.sha256) ? { sha256: item.sha256 } : {}),
    ...(safeIdentifier(item.materialId) ? { materialId: item.materialId } : {}),
    status: item.status === 'imported' ? 'imported' : item.status === 'failed' ? 'failed' : 'selected',
  }));
}

export function restoreTaskInputs(value: unknown): TaskInputItem[] {
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  const ids = new Set<string>();
  return value.slice(0, defaultMaterialLimits.maxFiles).flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || materialNameError(raw.name) || names.has(nameKey(raw.name))) return [];
    names.add(nameKey(raw.name));
    const id = safeIdentifier(raw.id) && !ids.has(raw.id) ? raw.id : crypto.randomUUID();
    ids.add(id);
    const imported = raw.status === 'imported' && safeHash(raw.sha256);
    return [{ id, name: raw.name, status: imported ? 'imported' as const : 'missing' as const, verified: false,
      ...(safeSize(raw.size) ? { size: raw.size } : {}),
      ...(safeHash(raw.sha256) ? { sha256: raw.sha256 } : {}),
      ...(safeIdentifier(raw.materialId) ? { materialId: raw.materialId } : {}),
      ...(imported ? {} : { error: '需要重新选择文件，或核对上次导入结果' }) }];
  });
}

export function addTaskInputFiles(items: readonly TaskInputItem[], files: readonly File[], limits = defaultMaterialLimits,
  replaceId?: string): { items: TaskInputItem[]; error?: string } {
  const invalid = validateMaterialFiles(files, [], limits);
  if (invalid) return { items: [...items], error: invalid };
  if (replaceId && (files.length !== 1 || !items.some((item) => item.id === replaceId && nameKey(item.name) === nameKey(files[0].name)))) {
    return { items: [...items], error: '请选择同名文件；如需使用其他文件，请先移除此项' };
  }
  const next = items.map((item) => ({ ...item }));
  for (const file of files) {
    const index = next.findIndex((item) => nameKey(item.name) === nameKey(file.name));
    if (index >= 0) {
      const previous = next[index];
      if (previous.status === 'imported' || (previous.file && previous.id !== replaceId)) {
        return { items: [...items], error: `已选择 ${file.name}，请移除原项或使用不同文件名` };
      }
      next[index] = { id: previous.id, name: previous.name, size: file.size, status: 'selected', file };
    } else next.push({ id: crypto.randomUUID(), name: file.name, size: file.size, status: 'selected', file });
  }
  const invalidTotal = validateMaterialFiles(next, [], limits);
  return invalidTotal ? { items: [...items], error: invalidTotal } : { items: next };
}

export interface TaskMaterialTransport {
  getMaterials: (taskId: string) => Promise<MaterialList>;
  importMaterial: (taskId: string, name: string, contentBase64: string, sha256: string) => Promise<Material>;
  removeMaterial: (taskId: string, materialId: string) => Promise<MaterialList>;
}
export interface TaskInputImportOptions {
  transport: TaskMaterialTransport; onlyId?: string; isCurrent?: () => boolean;
}
export interface TaskInputImportResult { items: TaskInputItem[]; complete: boolean; error?: string }

const importLocks = new Set<string>();
const findMaterial = (list: MaterialList, item: TaskInputItem) => list.materials.find((material) => nameKey(material.name) === nameKey(item.name));
const matchingMaterial = (list: MaterialList, item: TaskInputItem, sha256: string) => {
  const material = findMaterial(list, item);
  return material?.integrity === 'verified' && material.sha256 === sha256 &&
    (!item.materialId || item.materialId === material.id) ? material : undefined;
};
const importedItem = (item: TaskInputItem, material: Material): TaskInputItem => ({ ...item, status: 'imported',
  size: material.size, sha256: material.sha256, materialId: material.id, error: undefined, verified: true });

export async function importTaskInputs(taskId: string, items: readonly TaskInputItem[], onUpdate: (items: TaskInputItem[]) => void,
  { transport, onlyId, isCurrent = () => true }: TaskInputImportOptions): Promise<TaskInputImportResult> {
  let current = items.map((item) => ({ ...item }));
  const result = (error?: string): TaskInputImportResult => ({ items: current, complete: false, ...(error ? { error } : {}) });
  if (onlyId && !items.some((item) => item.id === onlyId)) return result('材料选择已变化，请刷新后重试');
  if (importLocks.has(taskId)) return result('材料正在导入，请稍候');
  importLocks.add(taskId);
  const publish = () => { if (isCurrent()) onUpdate(current.map((item) => ({ ...item }))); };
  const put = (index: number, item: TaskInputItem) => { current = current.map((previous, position) => position === index ? item : previous); publish(); };
  const read = async () => {
    const list = await transport.getMaterials(taskId);
    if (list.taskId !== taskId) throw new Error('材料列表与当前任务不一致，请刷新后重试');
    if (list.locked) throw new Error('该任务已启动或已锁定，请在任务详情查看材料');
    const invalid = list.materials.filter((material) => material.integrity !== 'verified');
    if (invalid.length) {
      current = current.map((item) => invalid.some((material) => nameKey(material.name) === nameKey(item.name))
        ? { ...item, status: 'failed', verified: false, error: '已导入材料有变化或缺失，请在任务详情检查' } : item);
      publish();
      throw new Error('已导入材料有变化或缺失，请先在任务详情检查');
    }
    return list;
  };
  try {
    if (!isCurrent()) return result('材料准备已停止，已导入的材料会保留');
    let list = await read();
    if (!isCurrent()) return result('材料准备已停止，已导入的材料会保留');
    const invalid = validateMaterialFiles(current.map((item) => ({ name: item.name, size: item.file?.size ?? item.size })), list.materials, list.limits);
    if (invalid) return result(invalid);
    // Saved labels never authorize a start: reconcile every prior success with this task first.
    current = current.map((item) => {
      if (item.status !== 'imported') return item;
      const material = findMaterial(list, item);
      if (item.sha256) {
        const matched = matchingMaterial(list, item, item.sha256);
        if (matched) return importedItem(item, matched);
      }
      return { ...item, status: item.file ? 'failed' : 'missing', verified: false, error: '原材料已不在任务中或版本已变化，请重新核对',
        ...(material ? {} : { materialId: undefined }) };
    });
    publish();
    let failure = '';
    for (let index = 0; index < current.length; index++) {
      if (!isCurrent()) return result('材料准备已停止，已导入的材料会保留');
      const item = current[index];
      if (item.status === 'imported' || (onlyId && item.id !== onlyId)) continue;
      const savedMatch = item.sha256 && matchingMaterial(list, item, item.sha256);
      if (savedMatch) { put(index, importedItem(item, savedMatch)); continue; }
      if (!item.file) {
        put(index, { ...item, status: 'missing', error: '请选择这个文件后再导入' });
        failure ||= `${item.name} 需要重新选择`;
        continue;
      }
      put(index, { ...item, status: 'uploading', error: undefined });
      let sha256 = '';
      let attemptedImport = false;
      try {
        const encoded = await encodeMaterialFile(item.file);
        if (!isCurrent()) return result('材料准备已停止，已导入的材料会保留');
        sha256 = encoded.sha256;
        put(index, { ...current[index], sha256 });
        const existing = findMaterial(list, item);
        if (existing && existing.sha256 !== sha256) throw new Error('同名材料已存在且内容不同，请保留原材料或使用不同文件名');
        if (existing && item.materialId && existing.id !== item.materialId) throw new Error('原材料已被替换，请重新选择文件后核对');
        let material = matchingMaterial(list, item, sha256);
        if (!material) {
          attemptedImport = true;
          material = await transport.importMaterial(taskId, item.name, encoded.contentBase64, sha256);
          if (nameKey(material.name) !== nameKey(item.name) || material.sha256 !== sha256 || material.integrity !== 'verified') {
            throw new Error('未收到匹配的材料导入结果，将在重试时重新核对');
          }
          list = { ...list, materials: [...list.materials, material] };
        }
        if (!isCurrent()) return result('材料准备已停止，已导入的材料会保留');
        put(index, importedItem(current[index], material));
      } catch (error) {
        if (!isCurrent()) return result('材料准备已停止，已导入的材料会保留');
        // The POST may have succeeded even when its response was lost. Read before any retry.
        if (attemptedImport && sha256) {
          try {
            list = await read();
            const recovered = matchingMaterial(list, item, sha256);
            if (!isCurrent()) return result('材料准备已停止，已导入的材料会保留');
            if (recovered) { put(index, importedItem(current[index], recovered)); continue; }
          } catch { /* Keep the selected File for a later explicit retry. */ }
        }
        failure = `导入 ${item.name} 失败：${errorText(error)}`;
        put(index, { ...current[index], status: 'failed', error: errorText(error) });
        break;
      }
    }
    if (!isCurrent()) return result('材料准备已停止，已导入的材料会保留');
    list = await read();
    if (!isCurrent()) return result('材料准备已停止，已导入的材料会保留');
    current = current.map((item) => {
      if (item.status !== 'imported') return item;
      const material = item.sha256 && matchingMaterial(list, item, item.sha256);
      return material ? importedItem(item, material) : { ...item, status: 'failed', verified: false, error: '材料版本已变化，请刷新材料后再开始' };
    });
    publish();
    const complete = current.every((item) => item.status === 'imported');
    return { items: current, complete, ...(!complete && failure ? { error: failure } : {}) };
  } catch (error) {
    return result(errorText(error));
  } finally { importLocks.delete(taskId); }
}

export async function removeTaskInput(taskId: string, item: TaskInputItem, transport: TaskMaterialTransport) {
  if (importLocks.has(taskId)) throw new Error('材料正在导入，请稍候');
  importLocks.add(taskId);
  try {
    const list = await transport.getMaterials(taskId);
    if (list.taskId !== taskId || list.locked) throw new Error('该任务材料已锁定，无法移除');
    const material = findMaterial(list, item);
    if (!material) return;
    if ((item.materialId && item.materialId !== material.id) || (item.sha256 && item.sha256 !== material.sha256)) {
      throw new Error('该材料已经变化，请在任务详情检查后再移除');
    }
    await transport.removeMaterial(taskId, material.id);
  } finally { importLocks.delete(taskId); }
}
