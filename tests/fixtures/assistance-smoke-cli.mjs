import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// This fixed protocol peer is used only by the isolated Electron smoke. It never
// executes a command or code obtained from a prompt.
const [scenario, stateFile, actor] = process.argv.slice(2);
assert.ok(['manual', 'direct'].includes(scenario));
assert.ok(['owner', 'worker', 'reviewer'].includes(actor));
assert.ok(path.isAbsolute(stateFile));
const statePath = fs.realpathSync(stateFile);
const workspace = fs.realpathSync(process.cwd());
const contained = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
assert.equal(state.version, 1);
assert.equal(state.scenario, scenario);
assert.equal(fs.realpathSync(state.workspace), workspace);
const root = fs.realpathSync(state.smokeRoot);
assert.match(root, /[\\/]work[\\/]desktop-smoke[\\/]run-[^\\/]+$/i);
assert.ok(contained(root, workspace) && root !== workspace);
assert.ok(contained(root, statePath));

let prompt = '';
for await (const chunk of process.stdin) {
  prompt += chunk;
  assert.ok(prompt.length < 512000, 'Smoke prompt exceeded its fixed input limit');
}
const assignment = prompt.split(/Current assignment:\r?\n/)[1]?.split(/\r?\nReturn ONLY/)[0] || '';
const stepKey = assignment.match(/^Delegated step ([a-z][a-z0-9-]*):/)?.[1] || null;
const stage = assignment.startsWith('Delegation planning') ? 'plan'
  : stepKey ? 'delegate'
    : assignment.startsWith('Coordination assistance:') ? 'coordinate'
      : assignment.startsWith('Integrate the delegated results') ? 'implement'
        : actor === 'reviewer' && assignment.startsWith('Independently review') ? 'review' : null;
assert.ok(stage, 'Unexpected smoke assignment');
assert.equal(actor, stage === 'delegate' ? 'worker' : stage === 'review' ? 'reviewer' : 'owner');
const readOnly = ['plan', 'coordinate', 'review'].includes(stage) || (scenario === 'direct' && stage === 'delegate');
assert.match(prompt, readOnly ? /read-only analysis/ : /File editing is allowed/);
const counterKey = `${stage}:${stepKey || '-'}`;
const attempt = (state.counts[counterKey] || 0) + 1;
state.counts[counterKey] = attempt;
state.calls.push({ stage, stepKey, attempt, actor, readOnly, pid: process.pid });
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

const report = { summary: '', status: 'complete', verdict: 'none', findings: [], handoff: null };
const manualAnswer = 'SMOKE_MANUAL_STABLE_ID';
const directAnswer = 'SMOKE_OWNER_STABLE_ID';
const writeJson = (name, value) => fs.writeFileSync(path.join(workspace, name), `${JSON.stringify(value)}\n`);
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(workspace, name), 'utf8'));
if (stage === 'plan') {
  const authorized = JSON.parse(prompt.match(/Authorized workers: (\[[^\r\n]*?\])\./)?.[1] || 'null');
  assert.ok(Array.isArray(authorized) && authorized.length === 1);
  const memberId = authorized[0];
  report.summary = '固定测试负责人按输入和依赖派工';
  report.delegation = { steps: scenario === 'manual' ? [
    { key: 'prepare', title: '整理接口说明', objective: '确认关联字段后交付 prepared.json', memberId, dependsOn: [],
      output: { type: 'files', files: [{ path: 'prepared.json', format: 'json' }] } },
    { key: 'finish', title: '生成最终结果', objective: '读取 prepared.json 并交付 finished.json', memberId, dependsOn: ['prepare'],
      output: { type: 'files', files: [{ path: 'finished.json', format: 'json' }] } },
  ] : [
    { key: 'inspect', title: '分析接口依据', objective: '确认关联字段并返回摘要和 evidence 分析', memberId, dependsOn: [],
      output: { type: 'analysis', sections: ['summary', 'evidence'] } },
  ] };
} else if (stage === 'coordinate') {
  assert.equal(attempt, 1, 'The fixed question must not be coordinated twice');
  report.summary = scenario === 'manual' ? '需要用户确认关联字段，请在任务内补充答复。'
    : `关联字段使用 stable_record_id。${directAnswer}`;
  report.status = scenario === 'manual' ? 'blocked' : 'complete';
} else if (stage === 'delegate' && ['prepare', 'inspect'].includes(stepKey)) {
  assert.ok(attempt <= 2, 'A completed first step was incorrectly executed again');
  if (attempt === 1) {
    report.summary = '缺少字段约定，先向负责人求助';
    report.status = 'needs_help';
    report.helpRequest = { question: '请确认关联记录应使用哪个字段？' };
  } else {
    assert.match(prompt, new RegExp(scenario === 'manual' ? manualAnswer : directAnswer));
    if (scenario === 'manual') {
      writeJson('prepared.json', { field: 'stable_record_id', answer: manualAnswer });
      report.summary = 'PREPARED_OUTPUT：已根据用户答复生成 prepared.json';
    } else {
      report.summary = 'DIRECT_ANALYSIS_SUMMARY：依据负责人答复，关联字段为 stable_record_id';
      report.analysis = [{ key: 'evidence', content: 'DIRECT_ANALYSIS_EVIDENCE：已取得负责人明确答复，字段与任务要求一致。' }];
    }
  }
} else if (stage === 'delegate' && stepKey === 'finish') {
  assert.equal(scenario, 'manual');
  assert.equal(readJson('prepared.json').field, 'stable_record_id');
  assert.ok(attempt <= 2, 'The failed successor was retried more than once');
  if (attempt === 1) {
    report.summary = 'SMOKE_NEXT_STEP_TEMPORARY_FAILURE：固定测试进程暂时不可用';
    process.exitCode = 1;
  } else {
    writeJson('finished.json', { field: readJson('prepared.json').field, ready: true });
    report.summary = '已读取保留的第一步产物并完成 finished.json';
  }
} else if (stage === 'implement') {
  assert.equal(attempt, 1);
  if (scenario === 'direct') {
    assert.match(prompt, /DIRECT_ANALYSIS_SUMMARY/);
    assert.match(prompt, /DIRECT_ANALYSIS_EVIDENCE/);
    writeJson('prepared.json', { field: 'stable_record_id', answer: directAnswer });
    writeJson('finished.json', { field: 'stable_record_id', ready: true });
  }
  assert.equal(readJson('prepared.json').field, 'stable_record_id');
  assert.equal(readJson('finished.json').ready, true);
  fs.writeFileSync(path.join(workspace, 'integration.txt'), 'ASSISTANCE_SMOKE_INTEGRATED\n');
  report.summary = '固定负责人已核对实际产物并完成汇总；等待独立验收。';
} else if (stage === 'review') {
  assert.equal(readJson('prepared.json').field, 'stable_record_id');
  assert.equal(readJson('finished.json').ready, true);
  assert.equal(fs.readFileSync(path.join(workspace, 'integration.txt'), 'utf8').trim(), 'ASSISTANCE_SMOKE_INTEGRATED');
  report.summary = '固定独立评审进程已读取并核对最终产物';
  report.verdict = 'approve';
} else {
  throw new Error('Unexpected fixed smoke step');
}
process.stdout.write(`${JSON.stringify(report)}\n`);
