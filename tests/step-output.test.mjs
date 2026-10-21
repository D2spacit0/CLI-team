import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { agentReport, delegationSchema, parseReport, reportSchema, stepOutputSchema } from '../server/adapters.mjs';
import { checkStepOutput, stepOutputUnchanged } from '../server/step-output.mjs';
import { temporary, cleanup } from './helpers.mjs';

const files = (...entries) => ({ output: { type: 'files', files: entries.map((entry) => typeof entry === 'string' ? { path: entry } : entry) } });
const analysis = (...sections) => ({ output: { type: 'analysis', sections } });
const taskAt = (workspace) => ({ workspace, materials: [] });
const report = (summary = '完成', extra = {}) => ({ report: { summary, ...extra } });
const digest = (value) => createHash('sha256').update(value).digest('hex');

test('legacy reports and steps explicitly retain missing delivery checks', () => {
  const parsed = agentReport.parse({ summary: '旧报告', status: 'complete' });
  assert.deepEqual(parsed.analysis, []);
  assert.equal(parsed.helpRequest, null);
  assert.equal(parsed.consult, null);
  const plan = delegationSchema.parse({ steps: [{ key: 'build', title: '实现', objective: '完成', memberId: 'worker' }] });
  assert.equal(plan.steps[0].output, null);
  const receipt = checkStepOutput({}, {}, report());
  assert.equal(receipt.status, 'not_configured');
  assert.equal(stepOutputUnchanged({}, {}, report(), receipt), false);
  for (const key of ['analysis', 'helpRequest', 'consult']) assert.equal(reportSchema.required.includes(key), false);
});

test('new structured outputs and questions parse with bounded content and strict fields', () => {
  const value = { summary: '交付', status: 'complete', analysis: [{ key: 'risks', content: '  保留分析缩进\n' }],
    helpRequest: { question: ' 请确认接口 ' }, consult: { memberId: ' peer ', question: ' 边界如何处理？ ' },
    delegation: { steps: [{ key: 'build', title: '实现', objective: '完成', memberId: 'worker', output: files('result.txt').output }] } };
  const parsed = parseReport(JSON.stringify(value));
  assert.equal(parsed.delegation.steps[0].output.files[0].format, 'any');
  assert.equal(parsed.analysis[0].content, '  保留分析缩进\n');
  assert.equal(parsed.helpRequest.question, '请确认接口');
  assert.equal(parsed.consult.memberId, 'peer');
  for (const invalid of [
    { analysis: [{ key: 'summary', content: '不能覆盖主摘要' }] },
    { analysis: [{ key: 'risks', content: 'a' }, { key: 'risks', content: 'b' }] },
    { analysis: [{ key: 'risks', content: ' '.repeat(3) }] },
    { analysis: [{ key: 'risks', content: 'a'.repeat(8001) }] },
    { analysis: Array.from({ length: 9 }, (_, index) => ({ key: `part-${index}`, content: 'a' })) },
    { helpRequest: { question: 'a', command: 'not authorized' } },
    { consult: { memberId: 'peer', question: 'a'.repeat(3001) } },
  ]) assert.equal(parseReport(JSON.stringify({ ...value, ...invalid })), null);
  assert.equal(stepOutputSchema.safeParse(analysis('summary', 'summary').output).success, false);
  assert.equal(stepOutputSchema.safeParse(files('result.txt', 'RESULT.txt').output).success, false);
  assert.equal(stepOutputSchema.safeParse(files(...Array.from({ length: 9 }, (_, index) => `${index}.txt`)).output).success, false);
});

test('files require real nonempty regular outputs matching text or JSON format', () => {
  const root = temporary();
  try {
    const task = taskAt(root);
    fs.mkdirSync(path.join(root, 'out'));
    fs.writeFileSync(path.join(root, 'out', 'data.json'), '{"value":42}\n');
    fs.writeFileSync(path.join(root, 'out', 'notes.txt'), '检查结果\n');
    const step = files({ path: 'out/data.json', format: 'json' }, { path: 'out/notes.txt', format: 'text' });
    const receipt = checkStepOutput(task, step, report());
    assert.equal(receipt.status, 'passed');
    assert.match(receipt.summary, /不代表/);
    assert.equal(receipt.files[0].sha256, digest('{"value":42}\n'));
    assert.equal(receipt.files[1].size, Buffer.byteLength('检查结果\n'));
    assert.equal(checkStepOutput(task, files('missing.txt'), report()).status, 'failed');
    assert.equal(checkStepOutput(task, files('out'), report()).status, 'failed');
    fs.writeFileSync(path.join(root, 'empty.txt'), '');
    assert.equal(checkStepOutput(task, files('empty.txt'), report()).status, 'failed');
    fs.writeFileSync(path.join(root, 'broken.json'), '{broken');
    assert.equal(checkStepOutput(task, files({ path: 'broken.json', format: 'json' }), report()).status, 'failed');
    fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 255, 12]));
    assert.equal(checkStepOutput(task, files({ path: 'binary.bin', format: 'text' }), report()).status, 'failed');
    assert.equal(checkStepOutput(task, files('binary.bin'), report()).status, 'passed');
  } finally { cleanup(root); }
});

test('file receipts reject changed contents, contracts and removals but ignore timestamp-only changes', () => {
  const root = temporary();
  try {
    const task = taskAt(root);
    const filename = path.join(root, 'result.txt');
    fs.writeFileSync(filename, 'original');
    const step = files({ path: 'result.txt', format: 'text' });
    const receipt = checkStepOutput(task, step, report());
    assert.equal(stepOutputUnchanged(task, step, report(), { ...receipt, checkedAt: 'old timestamp' }), true);
    fs.utimesSync(filename, new Date(0), new Date(0));
    assert.equal(stepOutputUnchanged(task, step, report(), receipt), true);
    assert.equal(stepOutputUnchanged(task, files('result.txt'), report(), receipt), false);
    fs.writeFileSync(filename, 'replaced');
    assert.equal(stepOutputUnchanged(task, step, report(), receipt), false);
    fs.unlinkSync(filename);
    assert.equal(stepOutputUnchanged(task, step, report(), receipt), false);
  } finally { cleanup(root); }
});

test('analysis receipts bind required summary and named sections to their exact report content', () => {
  const step = analysis('summary', 'risks');
  const run = report('总体结论', { analysis: [{ key: 'risks', content: '约束条件' }] });
  const receipt = checkStepOutput({}, step, run);
  assert.equal(receipt.status, 'passed');
  assert.deepEqual(receipt.sections, [{ key: 'summary', sha256: digest('总体结论') }, { key: 'risks', sha256: digest('约束条件') }]);
  assert.equal(stepOutputUnchanged({}, step, run, receipt), true);
  assert.equal(stepOutputUnchanged({}, step, report('修改结论', { analysis: run.report.analysis }), receipt), false);
  assert.equal(stepOutputUnchanged({}, step, report('总体结论', { analysis: [{ key: 'risks', content: '约束条件 ' }] }), receipt), false);
  assert.equal(checkStepOutput({}, step, report('总体结论')).status, 'failed');
  assert.equal(checkStepOutput({}, step, report(' ', { analysis: run.report.analysis })).status, 'failed');
  assert.equal(checkStepOutput({}, step, report('总体结论', { analysis: [{ key: 'risks', content: 'a' }, { key: 'risks', content: 'b' }] })).status, 'failed');
});

test('paths reject traversal, Windows devices, hidden or private names and input contracts before reading', () => {
  const paths = ['../outside.txt', '/root.txt', 'C:/secret.txt', 'dir\\file.txt', 'dir//file.txt', './file.txt',
    'dir/../file.txt', 'dir/file.txt:stream', 'out/NUL.txt', 'con .txt', 'CONIN$', 'COM¹.txt',
    'dir/name.', 'dir/name ', ' dir/file.txt', 'dir/na\0me.txt', '.env', 'dir/.env.local', 'out/private.key',
    'credentials.json', 'controller.token', '.team/server.json', 'node_modules/result.js',
    'inputs/source.txt', 'INPUTS/source.txt', 'relay-context.json', 'out/relay-context.json'];
  const pathSchema = reportSchema.properties.delegation.anyOf[1].properties.steps.items.properties.output.anyOf[1].properties.files.items.properties.path;
  for (const candidate of paths) {
    const step = files(candidate);
    assert.equal(stepOutputSchema.safeParse(step.output).success, false, candidate);
    assert.equal(checkStepOutput({}, step, report()).status, 'failed', candidate);
    const jsonAllows = new RegExp(pathSchema.pattern).test(candidate) && pathSchema.allOf.every((rule) => !new RegExp(rule.not.pattern).test(candidate));
    assert.equal(jsonAllows, false, `JSON schema must reject ${candidate}`);
  }
  for (const candidate of ['out/result.json', '分析 结果.txt']) {
    assert.equal(stepOutputSchema.safeParse(files(candidate).output).success, true);
    assert.equal(new RegExp(pathSchema.pattern).test(candidate) && pathSchema.allOf.every((rule) => !new RegExp(rule.not.pattern).test(candidate)), true);
  }
});

test('registered inputs, relay files and symlink or hardlink paths cannot count as outputs', () => {
  const root = temporary();
  try {
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'source.txt'), 'private outside data');
    fs.writeFileSync(path.join(workspace, 'reference.txt'), 'registered material');
    fs.writeFileSync(path.join(workspace, 'snapshot.json'), '{}');
    const task = { workspace, materials: [{ relativePath: 'reference.txt' }], sourceContext: { file: 'snapshot.json' } };
    assert.equal(checkStepOutput(task, files('reference.txt'), report()).status, 'failed');
    assert.equal(checkStepOutput(task, files('snapshot.json'), report()).status, 'failed');
    fs.symlinkSync(outside, path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(checkStepOutput(task, files('linked/source.txt'), report()).status, 'failed');
    fs.linkSync(path.join(outside, 'source.txt'), path.join(workspace, 'linked.txt'));
    assert.equal(checkStepOutput(task, files('linked.txt'), report()).status, 'failed');
    fs.mkdirSync(path.join(workspace, 'actual'));
    fs.writeFileSync(path.join(workspace, 'actual', 'inside.txt'), 'inside');
    fs.symlinkSync(path.join(workspace, 'actual'), path.join(workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(checkStepOutput(task, files('alias/inside.txt'), report()).status, 'failed');
    fs.writeFileSync(path.join(workspace, 'large.bin'), 'x');
    fs.truncateSync(path.join(workspace, 'large.bin'), 20 * 1024 * 1024 + 1);
    assert.equal(checkStepOutput(task, files('large.bin'), report()).status, 'failed');
  } finally { cleanup(root); }
});
