import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TeamService } from '../server/service.mjs';
import { inside } from '../server/safety.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(project, 'work', 'tests');
fs.mkdirSync(testRoot, { recursive: true });
export function temporary() { return fs.mkdtempSync(path.join(testRoot, 'case-')); }
export function cleanup(directory) {
  const resolved = fs.realpathSync(directory);
  const base = fs.realpathSync(testRoot);
  if (resolved === base || !inside(base, resolved)) throw new Error('Refusing cleanup outside test workspace');
  fs.rmSync(resolved, { recursive: true, force: true });
}
export function success(summary = '完成', extra = {}) {
  const report = { summary, status: 'complete', verdict: 'none', findings: [], handoff: null, ...extra };
  return { success: true, report, response: JSON.stringify(report), riskFlags: [],
    exitCode: 0, error: null, conversationId: 'test-conversation' };
}
export function fixture(options = {}) {
  const root = temporary();
  const service = new TeamService({ root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }), ...options });
  const builder = service.saveMember({ name: '执行者', handle: 'builder', provider: 'custom',
    role: 'builder', executable: process.execPath, enabled: true, permission: 'edit' });
  const reviewer = service.saveMember({ name: '评审者', handle: 'reviewer', provider: 'custom',
    role: 'reviewer', executable: process.execPath, enabled: true, permission: 'plan' });
  return { root, service, builder, reviewer, async close() { await service.close(); cleanup(root); } };
}
export async function until(predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Synchronous SQLite work can delay timers past the deadline even after completion.
  const completed = predicate();
  if (completed) return completed;
  throw new Error('Condition did not become true before timeout');
}
export function writeDeliverable(workspace, content = 'export const value = 42;\n') {
  fs.writeFileSync(path.join(workspace, 'result.mjs'), content, 'utf8');
}
