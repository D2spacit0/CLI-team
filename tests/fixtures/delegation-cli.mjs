import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const workspace = process.cwd();
const assignment = prompt.split('Current assignment:\n')[1]?.split('\nReturn ONLY')[0] || '';
const report = { summary: '', status: 'complete', verdict: 'none', findings: [], handoff: null };
if (assignment.startsWith('Delegation planning')) {
  assert.match(prompt, /read-only analysis/);
  const authorized = JSON.parse(prompt.match(/Authorized workers: (\[[^\n]*?\])\./)[1]);
  assert.equal(authorized.length, 1);
  report.summary = '已根据技能选择模块协作者';
  report.delegation = { steps: [{ key: 'module', title: '实现模块', objective: '生成模块文件', memberId: authorized[0], dependsOn: [] }] };
} else if (assignment.startsWith('Delegated step')) {
  assert.match(prompt, /File editing is allowed/);
  fs.writeFileSync(path.join(workspace, 'worker.mjs'), 'export const value = 21;\n');
  report.summary = 'WORKER_PROCESS_OUTPUT: worker.mjs exports value 21';
} else if (assignment.startsWith('Integrate the delegated results')) {
  assert.match(prompt, /WORKER_PROCESS_OUTPUT/);
  assert.match(fs.readFileSync(path.join(workspace, 'worker.mjs'), 'utf8'), /value = 21/);
  fs.writeFileSync(path.join(workspace, 'integrated.mjs'), 'import { value } from "./worker.mjs";\nexport const doubled = value * 2;\n');
  report.summary = '负责人已读取协作者产物并完成 integrated.mjs 集成';
} else if (prompt.includes('Your role: independent reviewer.')) {
  assert.match(prompt, /read-only analysis/);
  const result = await import(pathToFileURL(path.join(workspace, 'integrated.mjs')).href);
  assert.equal(result.doubled, 42);
  report.summary = '独立进程已读取最终模块并确认结果';
  report.verdict = 'approve';
} else {
  throw new Error('Unexpected fixture assignment');
}
process.stdout.write(`${JSON.stringify(report)}\n`);
