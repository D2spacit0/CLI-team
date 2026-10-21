import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Fixed protocol peer for local integration tests. This never invokes a model.
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const current = prompt.split('Current assignment:\n')[1]?.split('\nReturn ONLY')[0] || '';
const target = (name) => path.join(process.cwd(), name);
const read = (name) => JSON.parse(fs.readFileSync(target(name), 'utf8'));
const report = { summary: '', status: 'complete', verdict: 'none', findings: [], handoff: null };
if (current.startsWith('Delegation planning')) {
  assert.match(prompt, /read-only analysis/);
  const workers = JSON.parse(prompt.match(/Authorized workers: (\[[^\n]*?\])\./)[1]);
  report.summary = '将功能模块交给协作成员，主控负责审查与交付';
  report.delegation = { steps: [{ key: 'module', title: '完成目标模块', objective: '交付 ready 为 true 的 module.json',
    memberId: workers[0], dependsOn: [], output: { type: 'files', files: [{ path: 'module.json', format: 'json' }] } }] };
} else if (current.startsWith('Delegated step')) {
  assert.match(prompt, /File editing is allowed/);
  const ready = current.includes('CORRECTION_READY');
  fs.writeFileSync(target('module.json'), JSON.stringify({ feature: 'goal-intake', ready }));
  report.summary = ready ? '已按主控意见修正 ready 字段' : '成员提交了模块，等待主控审查';
} else if (current.startsWith('Review delegated step')) {
  assert.match(prompt, /read-only analysis/);
  const module = read('module.json');
  report.verdict = module.ready ? 'approve' : 'changes_requested';
  report.summary = module.ready ? '已检查 module.json，满足步骤要求' : '模块结构有效，但未满足 ready 要求';
  if (!module.ready) report.findings = [{ severity: 'major', text: 'CORRECTION_READY：请把 module.json 的 ready 修正为 true' }];
} else if (current.startsWith('Integrate the delegated results')) {
  assert.equal(read('module.json').ready, true);
  fs.writeFileSync(target('delivery.json'), JSON.stringify({ ready: true, module: read('module.json') }));
  report.summary = '完成模块集成，生成 delivery.json';
} else if (current.startsWith('Independently review')) {
  assert.match(prompt, /read-only analysis/);
  assert.equal(read('delivery.json').module.ready, true);
  report.verdict = 'approve';
  report.summary = '独立评审已核对集成文件';
} else if (current.startsWith('Final delivery review')) {
  assert.match(prompt, /read-only analysis/);
  assert.equal(read('delivery.json').ready, true);
  assert.match(prompt, /"passed":true/);
  report.verdict = 'approve';
  report.summary = '交付 module.json 和 delivery.json。主控已审查并完成一次返工，机器检查与独立评审通过。';
} else throw new Error('Unexpected managed fixture assignment');
process.stdout.write(JSON.stringify(report) + '\n');
