import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// A finite, registered local file producer for task UI checks. No model is used.
const root = fs.realpathSync(process.argv[2]);
assert.match(root, /[\\/]work[\\/]desktop-smoke[\\/]run-[^\\/]+$/i);
const workspace = fs.realpathSync(process.cwd());
assert.equal(path.dirname(path.dirname(workspace)), root);
assert.equal(path.basename(path.dirname(workspace)), 'workspaces');
const cases = JSON.parse(fs.readFileSync(path.join(root, 'task-actions-fixture.json'), 'utf8'));
assert.ok(Array.isArray(cases) && cases.length <= 6);
const task = cases.find(item => item.workspace === workspace);
assert.ok(task && /^task-[a-f0-9-]+$/.test(task.id));
let prompt = '';
for await (const chunk of process.stdin) { prompt += chunk; assert.ok(prompt.length < 512000); }
assert.match(prompt, /File editing is allowed/);
assert.match(prompt, /TASK_ACTIONS_FIXED_DELIVERY/);
fs.writeFileSync(path.join(root, `task-actions-call-${task.id}.json`), JSON.stringify({ taskId: task.id, workspace, pid: process.pid }), { flag: 'wx' });
fs.writeFileSync(path.join(workspace, '交付说明.txt'), `TASK_ACTIONS_FIXED_DELIVERY\n${task.id}\n`);
process.stdout.write(JSON.stringify({ summary: '固定文件已写入，等待用户验收', status: 'complete', verdict: 'none', findings: [], handoff: null }) + '\n');
