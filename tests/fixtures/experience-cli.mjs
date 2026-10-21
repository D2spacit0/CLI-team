import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// One fixed local delivery for UI checks. No model or arbitrary command is used.
const root = fs.realpathSync(process.argv[2]);
assert.match(root, /[\\/]work[\\/]desktop-smoke[\\/]run-[^\\/]+$/i);
const workspace = fs.realpathSync(process.cwd());
assert.equal(path.dirname(path.dirname(workspace)), root);
assert.equal(path.basename(path.dirname(workspace)), 'workspaces');
assert.match(path.basename(workspace), /^task-[a-f0-9-]+$/);
let prompt = '';
for await (const bytes of process.stdin) {
  prompt += bytes;
  assert.ok(prompt.length < 512000);
}
assert.match(prompt, /File editing is allowed/);
assert.match(prompt, /EXPERIENCE_FIXED_DELIVERY/);
fs.writeFileSync(path.join(root, 'experience-cli-call.json'), JSON.stringify({ workspace, pid: process.pid }), { flag: 'wx' });
fs.writeFileSync(path.join(workspace, '交付说明.txt'), 'EXPERIENCE_FIXED_DELIVERY\n文件包含中文、空格和换行。\n');
process.stdout.write(JSON.stringify({ summary: '固定文件已写入，等待用户检查', status: 'complete', verdict: 'none', findings: [], handoff: null }) + '\n');
