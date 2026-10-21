import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Only the isolated official Electron smoke invokes this fixed protocol client.
// Prompt text is inspected as data; it can never supply commands or file paths.
const [ledgerFile, actor] = process.argv.slice(2);
assert.ok(['owner', 'worker'].includes(actor));
assert.ok(path.isAbsolute(ledgerFile));
const ledgerPath = fs.realpathSync(ledgerFile);
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
assert.equal(ledger.version, 1);
const root = fs.realpathSync(ledger.smokeRoot);
assert.match(root, /[\\/]work[\\/]desktop-smoke[\\/]run-[^\\/]+$/i);
const contained = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const workspace = fs.realpathSync(process.cwd());
assert.ok(contained(root, ledgerPath) && contained(root, workspace) && workspace !== root);
const scenario = ledger.tasks.find((task) => fs.realpathSync(task.workspace) === workspace);
assert.ok(scenario && ['help', 'review', 'materials'].includes(scenario.mode), 'Unregistered usability workspace');

let prompt = '';
for await (const bytes of process.stdin) {
  prompt += bytes;
  assert.ok(prompt.length < 512000, 'Usability fixture prompt exceeded its fixed limit');
}
const assignment = prompt.split(/Current assignment:\r?\n/)[1]?.split(/\r?\nReturn ONLY/)[0] || '';
const stepKey = assignment.match(/^Delegated step ([a-z][a-z0-9-]*):/)?.[1] || null;
const stage = assignment.startsWith('Delegation planning') ? 'plan'
  : stepKey ? 'delegate'
    : assignment.startsWith('Coordination assistance:') ? 'coordinate'
      : assignment.startsWith('Integrate the delegated results') || assignment.startsWith('Implement the task') ? 'implement' : null;
assert.ok(stage, 'Unexpected usability assignment');
assert.equal(actor, stage === 'delegate' ? 'worker' : 'owner');
// Planning and coordination downgrade permissions; the analysis contract alone
// does not change this fixed worker's configured editing permission.
const readOnly = ['plan', 'coordinate'].includes(stage);
assert.match(prompt, readOnly ? /read-only analysis/ : /File editing is allowed/);
assert.ok(!ledger.calls.some((call) => call.taskId === scenario.id && call.stage === stage), 'Unexpected duplicate usability dispatch');
ledger.calls.push({ taskId: scenario.id, mode: scenario.mode, stage, actor, pid: process.pid });
assert.ok(ledger.calls.length <= 20, 'Usability fixture exceeded its finite call budget');
fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

const report = { summary: '', status: 'complete', verdict: 'none', findings: [], handoff: null };
if (stage === 'plan') {
  assert.ok(['help', 'materials'].includes(scenario.mode));
  const authorized = JSON.parse(prompt.match(/Authorized workers: (\[[^\r\n]*?\])\./)?.[1] || 'null');
  assert.ok(Array.isArray(authorized) && authorized.length === 1);
  report.summary = '固定负责人按当前任务材料制定单步计划';
  report.delegation = { steps: [{ key: scenario.mode === 'help' ? 'clarify' : 'read-inputs',
    title: scenario.mode === 'help' ? '确认处理范围' : '读取选定材料',
    objective: scenario.mode === 'help' ? '缺少范围时提出具体问题' : '读取两份已导入材料并保留所有原始字节',
    memberId: authorized[0], dependsOn: [], output: scenario.mode === 'help'
      ? { type: 'analysis', sections: ['summary', 'evidence'] }
      : { type: 'files', files: [{ path: 'material-summary.json', format: 'json' }] } }] };
} else if (stage === 'delegate' && scenario.mode === 'help') {
  report.status = 'needs_help';
  report.summary = '处理范围需要用户确认';
  report.helpRequest = { question: '请确认只处理选定材料，并保留原文件。' };
} else if (stage === 'coordinate' && scenario.mode === 'help') {
  report.status = 'blocked';
  report.summary = '请由用户补充处理范围；这是固定执行器产生的草稿回归场景。';
} else if (stage === 'delegate' && scenario.mode === 'materials') {
  const inputs = [['first.txt', 'USABILITY_FIRST_INPUT\n'], ['second.txt', 'USABILITY_SECOND_INPUT\n']];
  const records = inputs.map(([name, expected]) => {
    const filename = fs.realpathSync(path.join(workspace, 'inputs', name));
    assert.ok(contained(workspace, filename));
    const content = fs.readFileSync(filename, 'utf8');
    assert.equal(content, expected, `Wrong material contents: ${name}`);
    return { name, sha256: createHash('sha256').update(content).digest('hex') };
  });
  fs.writeFileSync(path.join(workspace, 'material-summary.json'), `${JSON.stringify(records)}\n`);
  report.summary = '已读取两份成功导入的材料，未改写输入';
} else if (stage === 'implement' && scenario.mode === 'materials') {
  const records = JSON.parse(fs.readFileSync(path.join(workspace, 'material-summary.json'), 'utf8'));
  assert.deepEqual(records.map((item) => item.name), ['first.txt', 'second.txt']);
  fs.writeFileSync(path.join(workspace, 'usability-complete.txt'), 'USABILITY_MATERIALS_READY\n');
  report.summary = '已汇总选定材料，等待独立的机器验证和用户验收';
} else if (stage === 'implement' && scenario.mode === 'review') {
  fs.writeFileSync(path.join(workspace, 'review-output.txt'), `USABILITY_REVIEW_OUTPUT ${scenario.id}\n`);
  report.summary = '已生成可预览文本，等待用户核对；本场景未配置机器验收';
} else throw new Error('Unsupported fixed usability flow');
process.stdout.write(`${JSON.stringify(report)}\n`);
